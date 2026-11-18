"use client"

import { MAX_CART, type Mode } from "@luckout/api"
import { useSyncExternalStore } from "react"

/** One card in the Cart: what to buy, in which mode, and how it looks. Kept in this browser only. */
export interface CartLine {
  /** Also its purchase's idempotency key, so a checkout sent twice never buys this card twice. */
  readonly key: string
  readonly voucherId: string
  readonly value: string
  readonly mode: Mode
  readonly name: string
  readonly currency: string
  readonly image?: string | undefined
  readonly background?: string | undefined
}

const KEY = "luckout.cart"
const EMPTY: ReadonlyArray<CartLine> = []
const listeners = new Set<() => void>()
// The same array until the stored cart changes, as useSyncExternalStore needs. Without storage (a private
// window), the cart lives in this copy until the page is closed.
let cache: { raw: string | null; lines: ReadonlyArray<CartLine> } = { raw: null, lines: EMPTY }

const read = () => {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw !== cache.raw) cache = { raw, lines: raw ? (JSON.parse(raw) as Array<CartLine>).slice(0, MAX_CART) : EMPTY }
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

/** False when the Cart is already full. */
export const addToCart = (line: Omit<CartLine, "key">) => {
  const lines = read()
  if (lines.length >= MAX_CART) return false
  write([...lines, { ...line, key: crypto.randomUUID() }])
  return true
}

export const removeFromCart = (keys: ReadonlyArray<string>) => write(read().filter((l) => !keys.includes(l.key)))
