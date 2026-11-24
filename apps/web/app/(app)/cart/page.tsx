"use client"

import { ClearCart } from "@/components/cart-drawer"
import { GiftCard } from "@/components/gift-card"
import { Money } from "@/components/money"
import { Quantity } from "@/components/quantity"
import { Button, buttonVariants } from "@/components/ui/button"
import { BuyButton, JumpToBuy } from "@/components/voucher-page"
import { errorMessage } from "@/lib/api"
import { cartCount, cartRoom, cartUnits, removeKeys, removeLine, setMode, setQuantity, useCart } from "@/lib/cart"
import { pricedLines, totals, useCartQuote, useCheckout } from "@/lib/checkout"
import { cartCents, usd, usdCents, usdUp } from "@/lib/format"
import { MODES, modeSlug } from "@/lib/modes"
import { modePalette } from "@/lib/palette"
import { MAX_CART } from "@luckout/api"
import { ArrowLeft, ShieldCheck, Trash2 } from "lucide-react"
import Link from "next/link"
import { useRef } from "react"

/**
 * Checkout for the Cart (ADR-0013): every card in one go, one confirmation, one payment. Each card is still its own
 * purchase, with its own Draw and its own refund if it fails.
 */
export default function Cart() {
  const lines = useCart()
  const units = cartUnits(lines)
  const checkout = useCheckout(removeKeys)
  // Not renewed while the cart is being bought.
  const quotes = useCartQuote(units, !checkout.isPending)
  const q = quotes.data
  const t = totals(q)
  const count = cartCount(lines)
  const room = cartRoom(lines)
  const summary = useRef<HTMLElement>(null)
  const cards = (n: number) => `${n} ${n === 1 ? "card" : "cards"}`
  const priced = pricedLines(lines, q)
  // In cents that add up to what you pay now: the lines, and the summary's price and Lucky extra.
  const shown = q ? cartCents(priced.map((l) => ({ total: l.total ?? 0, count: l.line.keys.length, each: l.each }))) : undefined
  const [priceCents, extraCents] = cartCents([{ total: t.price, count: 1 }, { total: t.extra, count: 1 }]).map((l) => l.cents)

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between gap-4">
        <Link href="/shop" className="inline-flex items-center gap-2 font-semibold text-muted hover:text-ink">
          <ArrowLeft size={18} />Keep shopping
        </Link>
        {count > 0 && <ClearCart disabled={checkout.isPending} />}
      </div>
      <div>
        <h1 className="font-display text-5xl leading-[0.95] font-extrabold tracking-[-0.03em] sm:text-[64px]">Your cart</h1>
        <p className="mt-3 text-lg text-ink-soft">{count > 0 ? `${cards(count)}, bought in one go.` : `Up to ${MAX_CART} cards, bought in one go.`}</p>
      </div>

      {lines.length === 0
        ? (
          <div className="card flex flex-col items-start gap-4 p-8 sm:p-10">
            <p className="font-display text-3xl font-extrabold">Your cart is empty</p>
            <p className="max-w-md text-ink-soft">Pick a card, an amount and how many, then Add to cart.</p>
            <Link href="/shop" className={buttonVariants({ size: "lg" })}>Find a card</Link>
          </div>
        )
        : (
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
            <ul className="flex flex-col gap-3">
              {priced.map(({ line, normal, plays }, i) => (
                <li key={line.id} className="card flex gap-4 p-4 sm:p-5">
                  <Link href={`/shop/${encodeURIComponent(line.voucherId)}?value=${encodeURIComponent(line.value)}&mode=${modeSlug(line.mode)}`} className="w-20 shrink-0 sm:w-28">
                    <GiftCard v={line} notch={6} />
                  </Link>
                  <div className="flex min-w-0 flex-1 flex-col gap-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="line-clamp-2 leading-tight font-semibold">{line.name}</p>
                        <p className="mt-1 text-sm text-ink-soft">{line.value} {line.currency}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-display text-xl font-extrabold">{shown ? <Money micro={shown[i]!.cents * 10_000} up /> : <span className="skeleton inline-block h-6 w-16 rounded-full" />}</p>
                        {shown?.[i]?.each !== undefined && <p className="text-sm whitespace-nowrap text-muted">{usdCents(shown[i]!.each!)} each</p>}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Quantity label={`Quantity of ${line.name} ${line.value}`} value={line.keys.length} max={line.keys.length + room} onChange={(n) => setQuantity(line.id, n)} disabled={checkout.isPending} />
                      {/* The mode, changeable here: no need to go back to the card for it. */}
                      <label className="relative">
                        <span className="sr-only">Mode for {line.name} {line.value}</span>
                        <select
                          value={modeSlug(line.mode)}
                          disabled={checkout.isPending}
                          onChange={(e) => {
                            const m = MODES.find((x) => x.name.toLowerCase() === e.target.value)
                            if (m) setMode(line.id, m.mode)
                          }}
                          // In the mode's own colour, as everywhere else.
                          style={{ background: modePalette(line.mode).soft, color: modePalette(line.mode).ink }}
                          className="h-12 cursor-pointer appearance-none rounded-full pr-9 pl-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
                        >
                          {MODES.map((m) => <option key={m.name} value={m.name.toLowerCase()}>{m.name}</option>)}
                        </select>
                        <span className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-xs text-muted" aria-hidden="true">▾</span>
                      </label>
                      <button
                        type="button"
                        onClick={() => removeLine(line.id)}
                        disabled={checkout.isPending}
                        className="ml-auto inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-muted hover:bg-soft hover:text-bad"
                      >
                        <Trash2 size={16} />Remove
                      </button>
                    </div>
                    {normal && <p className="text-sm text-warn">The Cashback Reserve is used up right now, so {line.keys.length > 1 ? "some of these are" : "this one is"} bought at the normal price.</p>}
                    {!normal && plays !== undefined && (
                      <p className="text-sm text-muted">
                        Cashback is capped right now: {line.keys.length > 1 ? `at least ${usd(plays)} of each plays` : `${usd(plays)} of it plays`}, the rest is at the normal price.
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            <aside ref={summary} className="card flex flex-col gap-5 p-6 lg:sticky lg:top-28" aria-live="polite">
              <h2 className="font-display text-2xl font-extrabold">Order summary</h2>
              <dl className="flex flex-col gap-2 text-[15px]">
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-soft">{cards(count)}</dt>
                  <dd className="tabular-nums">{q ? usdCents(priceCents!) : <span className="skeleton inline-block h-4 w-14 rounded-full" />}</dd>
                </div>
                {q && t.extra > 0 && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-soft">For a chance at cashback</dt>
                    <dd className="tabular-nums">+{usdCents(extraCents!)}</dd>
                  </div>
                )}
                <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-line pt-3">
                  <dt className="font-semibold">You pay now</dt>
                  <dd className="font-display text-4xl font-extrabold">{q ? <Money micro={t.pay} up /> : <span className="skeleton inline-block h-9 w-28 rounded-full align-middle" />}</dd>
                </div>
              </dl>
              {checkout.error && <p role="alert" className="text-sm font-medium text-bad">{errorMessage(checkout.error)}</p>}
              {quotes.error && !q
                ? (
                  <div className="flex flex-col items-start gap-3 rounded-2xl bg-warn-soft p-4 text-[15px] text-warn">
                    <p className="font-medium">{errorMessage(quotes.error)}</p>
                    <Button variant="light" loading={quotes.isFetching} onClick={() => void quotes.refetch()}>Try again</Button>
                  </div>
                )
                : checkout.isPending
                ? <Button size="lg" loading>Buying {cards(count)}</Button>
                : (
                  <BuyButton
                    need={t.pay}
                    largest={t.largest}
                    label={q && `Pay ${usdUp(t.pay)}`}
                    onBuy={() => q && checkout.mutate(units.map((u, i) => ({ ...u, quote: q[i]! })))}
                  />
                )}
              <ul className="flex flex-col gap-2 text-sm text-muted">
                <li className="flex gap-2"><ShieldCheck size={16} className="mt-0.5 shrink-0" />One payment from your balance. Every card is its own purchase{t.extra > 0 ? ", each Lucky one with its own Draw" : ""}.</li>
                <li className="flex gap-2"><ShieldCheck size={16} className="mt-0.5 shrink-0" />A card that can't be delivered goes back to your balance in full.</li>
              </ul>
            </aside>
          </div>
        )}
      {lines.length > 0 && q && !checkout.isPending && <JumpToBuy panel={summary} name={cards(count)} amount={t.pay} />}
    </div>
  )
}
