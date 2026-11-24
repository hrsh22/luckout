"use client"

import { GiftCard } from "@/components/gift-card"
import { Money } from "@/components/money"
import { Quantity } from "@/components/quantity"
import { Button, buttonVariants } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { cartCount, cartRoom, cartUnits, clearCart, closeCart, openCart, removeLine, setQuantity, useCart, useCartDrawer } from "@/lib/cart"
import { pricedLines, totals, useCartQuote } from "@/lib/checkout"
import { cartCents } from "@/lib/format"
import { modeName } from "@/lib/modes"
import { modePalette } from "@/lib/palette"
import { Dialog } from "@base-ui/react/dialog"
import type { Mode } from "@luckout/api"
import { Trash2, X } from "lucide-react"
import Link from "next/link"
import { useState } from "react"

/** The Cart at a glance, from anywhere: what's in it, how many, the total, and the way to checkout. */
export function CartDrawer() {
  const { open, justAdded } = useCartDrawer()
  const lines = useCart()
  const quotes = useCartQuote(cartUnits(lines), open).data
  const count = cartCount(lines)
  const room = cartRoom(lines)
  const priced = pricedLines(lines, quotes)
  // In cents that add up to what you pay.
  const shown = quotes ? cartCents(priced.map((l) => ({ total: l.total ?? 0, count: l.line.keys.length }))) : undefined
  return (
    <Dialog.Root open={open} onOpenChange={(o) => (o ? openCart() : closeCart())}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-ink/35 backdrop-blur-[6px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup className="fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] flex-col rounded-t-[2rem] bg-white shadow-pop outline-none transition-[translate] duration-300 ease-[cubic-bezier(.2,.9,.25,1)] data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full sm:inset-y-3 sm:right-3 sm:left-auto sm:max-h-none sm:w-[420px] sm:rounded-[2rem] sm:data-[ending-style]:translate-x-[110%] sm:data-[ending-style]:translate-y-0 sm:data-[starting-style]:translate-x-[110%] sm:data-[starting-style]:translate-y-0">
          <div className="mx-auto mt-3 h-1.5 w-10 shrink-0 rounded-full bg-line sm:hidden" aria-hidden="true" />
          {/* One line on a 390px phone: the title, its count and Clear cart don't wrap. */}
          <div className="flex items-center justify-between gap-2 px-6 pt-4 sm:gap-4 sm:pt-6">
            <Dialog.Title className="font-display text-2xl leading-tight font-extrabold whitespace-nowrap sm:text-[28px]">
              Your cart{count > 0 && <span className="ml-2 align-middle text-base font-semibold text-muted">{count} {count === 1 ? "card" : "cards"}</span>}
            </Dialog.Title>
            {count > 0 && <ClearCart className="ml-auto" />}
            <Dialog.Close className="-mr-2 grid size-10 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-soft hover:text-ink" aria-label="Close">
              <X size={20} />
            </Dialog.Close>
          </div>

          {lines.length === 0
            ? (
              <div className="flex flex-col items-start gap-4 px-6 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
                <p className="text-ink-soft">Nothing here yet. Pick a card and an amount, then Add to cart.</p>
                <Link href="/shop" onClick={closeCart} className={buttonVariants({ size: "lg" })}>Find a card</Link>
              </div>
            )
            : (
              <>
                <ul className="scroll-soft mt-4 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3">
                  {priced.map(({ line }, i) => (
                    <li key={line.id} className={`flex items-center gap-3 rounded-3xl p-3 transition-colors ${line.id === justAdded ? "bg-gold-soft/60" : ""}`}>
                      <GiftCard v={line} className="w-16 shrink-0" notch={5} />
                      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <p className="truncate leading-tight font-semibold">{line.name}</p>
                        <p className="flex flex-wrap items-center gap-1.5 text-sm text-ink-soft">
                          {line.value} {line.currency}
                          <ModeChip mode={line.mode} />
                          {line.id === justAdded && <span className="text-xs font-semibold text-gold-ink">Just added</span>}
                        </p>
                        <Quantity size="sm" className="self-start" label={`Quantity of ${line.name} ${line.value}`} value={line.keys.length} max={line.keys.length + room} onChange={(n) => setQuantity(line.id, n)} />
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <p className="font-semibold tabular-nums">{shown ? <Money micro={shown[i]!.cents * 10_000} up /> : <span className="skeleton block h-5 w-12 rounded-full" />}</p>
                        <button type="button" onClick={() => removeLine(line.id)} aria-label={`Remove ${line.name} ${line.value}`} className="grid size-8 place-items-center rounded-full text-muted hover:bg-soft hover:text-bad">
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-col gap-3 border-t border-line px-6 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
                  <div className="flex items-baseline justify-between">
                    <span className="text-ink-soft">You pay</span>
                    <span className="font-display text-3xl font-extrabold">{quotes ? <Money micro={totals(quotes).pay} up /> : <span className="skeleton inline-block h-8 w-24 rounded-full align-middle" />}</span>
                  </div>
                  {room === 0 && <p className="text-sm text-muted">That's a full cart: 15 cards is the most one checkout holds.</p>}
                  <Link href="/cart" onClick={closeCart} className={buttonVariants({ size: "lg" })}>Checkout</Link>
                  <Dialog.Close className={buttonVariants({ variant: "ghost" })}>Keep shopping</Dialog.Close>
                </div>
              </>
            )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Empties the Cart in one go, after a yes. */
export function ClearCart({ disabled, className = "" }: { disabled?: boolean; className?: string }) {
  const [open, setOpen] = useState(false)
  const count = cartCount(useCart())
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} disabled={disabled} className={`inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-sm font-medium whitespace-nowrap text-muted hover:bg-soft hover:text-bad disabled:opacity-45 ${className}`}>
        <Trash2 size={16} />Clear cart
      </button>
      <Sheet open={open} onOpenChange={setOpen} title="Clear your cart?" description={`${count === 1 ? "The card" : `All ${count} cards`} will be taken out.`}>
        <div className="flex flex-col gap-2">
          <Button variant="danger" size="lg" onClick={() => (clearCart(), setOpen(false))}>Clear cart</Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>Keep them</Button>
        </div>
      </Sheet>
    </>
  )
}

export function ModeChip({ mode }: { mode: Mode }) {
  const pal = modePalette(mode)
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold" style={{ background: pal.soft, color: pal.ink }}>
      <span className="size-2 rounded-full" style={{ background: pal.solid }} />{modeName(mode)}
    </span>
  )
}
