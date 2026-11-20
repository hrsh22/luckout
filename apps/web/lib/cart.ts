"use client"

import { MAX_CART, type Mode } from "@luckout/api"
import { useSyncExternalStore } from "react"

/** A card as the Cart shows it: what to buy, in which mode, and how it looks. */
export interface CartCard {
  readonly voucherId: string
  readonly value: string
  readonly mode: Mode
  readonly name: string
  readonly currency: string
  readonly image?: string | undefined
  readonly background?: string | undefined
}

/**
 * One line of the Cart: a card, amount and mode, as many times as it has keys. Each key is one purchase's idempotency
 * key, made when that copy was added, so a checkout sent twice never buys a card twice. Kept in this browser only.
 */
export interface CartLine extends CartCard {
  readonly id: string
  readonly keys: ReadonlyArray<string>
}

const sameCard = (a: CartCard, b: CartCard) => a.voucherId === b.voucherId && a.value === b.value && JSON.stringify(a.mode) === JSON.stringify(b.mode)
const fresh = (n: number) => Array.from({ length: n }, () => crypto.randomUUID())

/** Cards in the Cart, every copy counted. */
export const cartCount = (lines: ReadonlyArray<CartLine>) => lines.reduce((n, l) => n + l.keys.length, 0)
/** How many more cards fit. */
export const cartRoom = (lines: ReadonlyArray<CartLine>) => Math.max(0, MAX_CART - cartCount(lines))

/** `quantity` more of this card: onto its line if it has one, else a new line at the end. Unchanged if they don't fit. */
export const withAdded = (lines: ReadonlyArray<CartLine>, card: CartCard, quantity: number): ReadonlyArray<CartLine> => {
  if (quantity < 1 || quantity > cartRoom(lines)) return lines
  const at = lines.findIndex((l) => sameCard(l, card))
  if (at < 0) return [...lines, { ...card, id: crypto.randomUUID(), keys: fresh(quantity) }]
  return lines.map((l, i) => (i === at ? { ...l, keys: [...l.keys, ...fresh(quantity)] } : l))
}

/** The line at `quantity` (0 removes it). New copies get new keys; fewer drops the last ones. Capped by the Cart's room. */
export const withQuantity = (lines: ReadonlyArray<CartLine>, id: string, quantity: number): ReadonlyArray<CartLine> => {
  const line = lines.find((l) => l.id === id)
  if (!line) return lines
  if (quantity < 1) return lines.filter((l) => l.id !== id)
  const n = Math.min(quantity, line.keys.length + cartRoom(lines))
  const keys = n <= line.keys.length ? line.keys.slice(0, n) : [...line.keys, ...fresh(n - line.keys.length)]
  return lines.map((l) => (l.id === id ? { ...l, keys } : l))
}

/** The line in another mode: new keys (it's another purchase now), joined to that mode's line if there is one. */
export const withMode = (lines: ReadonlyArray<CartLine>, id: string, mode: Mode): ReadonlyArray<CartLine> => {
  const line = lines.find((l) => l.id === id)
  if (!line || JSON.stringify(line.mode) === JSON.stringify(mode)) return lines
  const moved = { ...line, mode, keys: fresh(line.keys.length) }
  const other = lines.find((l) => l.id !== id && sameCard(l, moved))
  if (!other) return lines.map((l) => (l.id === id ? moved : l))
  return lines.filter((l) => l.id !== id).map((l) => (l.id === other.id ? { ...l, keys: [...l.keys, ...moved.keys] } : l))
}

/** Every copy in Cart order, one per purchase: what a checkout buys and a cart quote prices. */
export const cartUnits = (lines: ReadonlyArray<CartLine>) => lines.flatMap((line) => line.keys.map((key) => ({ line, key })))

/** A Cart saved before quantities (one line per copy) read as lines with quantities. */
const upgrade = (saved: ReadonlyArray<CartLine & { key?: string }>): ReadonlyArray<CartLine> =>
  saved.reduce<ReadonlyArray<CartLine>>((lines, l) => {
    if (l.keys) return [...lines, l]
    const at = lines.findIndex((x) => sameCard(x, l))
    return at < 0 ? [...lines, { ...l, id: l.key!, keys: [l.key!] }] : lines.map((x, i) => (i === at ? { ...x, keys: [...x.keys, l.key!] } : x))
  }, [])

const KEY = "luckout.cart"
const EMPTY: ReadonlyArray<CartLine> = []
const listeners = new Set<() => void>()
// The same array until the stored cart changes, as useSyncExternalStore needs. Without storage (a private
// window), the cart lives in this copy until the page is closed.
let cache: { raw: string | null; lines: ReadonlyArray<CartLine> } = { raw: null, lines: EMPTY }

const read = () => {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw !== cache.raw) cache = { raw, lines: raw ? upgrade(JSON.parse(raw)) : EMPTY }
  } catch {}
  return cache.lines
}

const write = (lines: ReadonlyArray<CartLine>) => {
  const raw = JSON.stringify(lines)
  cache = { raw, lines }
  try {
    localStorage.setItem(KEY, raw)
  } catch {}
  for (const l of listeners) l()
}

// Another tab's change shows here too.
const subscribe = (listener: () => void) => {
  const onStorage = (e: StorageEvent) => e.key === KEY && listener()
  listeners.add(listener)
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

export const useCart = () => useSyncExternalStore(subscribe, read, () => EMPTY)

/** False when they don't fit. */
export const addToCart = (card: CartCard, quantity = 1) => {
  const before = read()
  const after = withAdded(before, card, quantity)
  if (after === before) return false
  write(after)
  justAdded = after.find((l) => sameCard(l, card))?.id
  setDrawer(true)
  return true
}
export const setQuantity = (id: string, quantity: number) => write(withQuantity(read(), id, quantity))
export const setMode = (id: string, mode: Mode) => write(withMode(read(), id, mode))
export const removeLine = (id: string) => write(read().filter((l) => l.id !== id))
export const clearCart = () => write(EMPTY)
/** After a checkout: the copies it bought leave the Cart (others added meanwhile stay). */
export const removeKeys = (keys: ReadonlyArray<string>) =>
  write(read().map((l) => ({ ...l, keys: l.keys.filter((k) => !keys.includes(k)) })).filter((l) => l.keys.length > 0))

// The Cart drawer: opened by the nav and by Add to cart, from anywhere in the app.
let drawer = false
/** The line Add to cart just added to, shown as such while the drawer is open. */
let justAdded: string | undefined
const drawerListeners = new Set<() => void>()
const setDrawer = (open: boolean) => {
  drawer = open
  if (!open) justAdded = undefined
  for (const l of drawerListeners) l()
}
export const openCart = () => setDrawer(true)
export const closeCart = () => setDrawer(false)
export const useCartDrawer = () => ({
  open: useSyncExternalStore((l) => (drawerListeners.add(l), () => void drawerListeners.delete(l)), () => drawer, () => false),
  justAdded
})
