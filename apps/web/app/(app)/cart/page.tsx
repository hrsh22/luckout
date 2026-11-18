"use client"

import { GiftCard } from "@/components/gift-card"
import { Money } from "@/components/money"
import { Button, buttonVariants } from "@/components/ui/button"
import { BuyButton } from "@/components/voucher-page"
import { api, errorMessage, TimedOut } from "@/lib/api"
import { type CartLine, removeFromCart, useCart } from "@/lib/cart"
import { usd, usdUp } from "@/lib/format"
import { modeName, modeSlug } from "@/lib/modes"
import { modePalette } from "@/lib/palette"
import { useSession } from "@/lib/session"
import { CartQuoteRequest, MAX_CART, NewCart, NewPurchase, type Quote } from "@luckout/api"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

/**
 * Several cards bought in one checkout (ADR-0013): one confirmation, one payment. Each card is still its own purchase,
 * with its own Draw and its own refund if it fails.
 */
export default function Cart() {
  const lines = useCart()
  const { token, refresh } = useSession()
  const router = useRouter()
  const qc = useQueryClient()
  const buy = useMutation({
    mutationFn: async (items: ReadonlyArray<{ line: CartLine; quote: Quote }>) => {
      // Exactly what each card's quote showed, its mode included (Normal when the reserve couldn't cover a Lucky card);
      // each line's key makes a resend return the same purchases.
      const payload = new NewCart({
        items: items.map(({ line, quote: q }) =>
          new NewPurchase({
            voucherId: line.voucherId,
            value: line.value,
            mode: q.mode,
            maxPrice: q.maxPrice,
            ...(q.mode === "normal" ? {} : { luckyAmount: q.luckyAmount }),
            idempotencyKey: line.key
          })
        )
      })
      return api((c) => c.purchases.createCart({ payload }), token, "150 seconds").catch((e) => {
        if (!(e instanceof TimedOut)) throw e
        // Still running on the server: the same keys return the same purchases.
        return api((c) => c.purchases.createCart({ payload }), token)
      })
    },
    onSuccess: (bought, items) => {
      removeFromCart(items.map((i) => i.line.key))
      const ready = bought.filter((p) => p.status === "delivered").length
      toast.success(ready === bought.length ? `${cards(bought.length)} ready` : `${cards(bought.length)} on the way`)
      router.push("/purchases")
    },
    onSettled: () => {
      refresh().catch(() => {})
      qc.invalidateQueries({ queryKey: ["purchases"] })
      qc.invalidateQueries({ queryKey: ["checkout-email"] })
      qc.invalidateQueries({ queryKey: ["quote-cart"] })
    }
  })
  // The whole cart priced at once, as the contract would admit it: each Lucky card on the reserve the cards before it
  // left. Renewed as it goes stale while in sight, but not while it's being bought.
  const quotes = useQuery({
    queryKey: ["quote-cart", lines.map((l) => `${l.voucherId}|${l.value}|${modeSlug(l.mode)}`)],
    queryFn: () =>
      api((c) => c.catalog.quoteCart({ payload: new CartQuoteRequest({ items: lines.map(({ voucherId, value, mode }) => ({ voucherId, value, mode })) }) })),
    enabled: lines.length > 0 && !buy.isPending,
    staleTime: 20_000,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true
  })
  const q = quotes.data?.length === lines.length ? quotes.data : undefined
  const total = q?.reduce((s, x) => s + x.maxPrice, 0) ?? 0
  const largest = Math.max(0, ...(q ?? []).map((x) => x.maxPrice))
  const lucky = !!q?.some((x) => x.luckyAmount > 0)

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-display text-5xl leading-[0.95] font-extrabold tracking-[-0.03em] sm:text-[64px]">Cart</h1>
        <p className="mt-3 text-lg text-ink-soft">Up to {MAX_CART} cards, bought in one go. Each one is its own purchase.</p>
      </div>

      {lines.length === 0
        ? (
          <div className="card flex flex-col items-start gap-4 p-8 sm:p-10">
            <p className="font-display text-3xl font-extrabold">Your cart is empty</p>
            <p className="max-w-md text-ink-soft">Pick a card, an amount and a mode, then tap Add to cart.</p>
            <Link href="/shop" className={buttonVariants({ size: "lg" })}>Find a card</Link>
          </div>
        )
        : (
          <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
            <ul className="flex flex-col gap-3">
              {lines.map((line, i) => <Line key={line.key} line={line} quote={q?.[i]} busy={buy.isPending} />)}
            </ul>

            <aside className="card flex flex-col gap-5 p-6 lg:sticky lg:top-28" aria-live="polite">
              <div>
                <p className="text-ink-soft">{cards(lines.length)}, {lucky ? "you pay now" : "you pay"}</p>
                <p className="font-display text-6xl leading-none font-extrabold tracking-[-0.03em]">
                  {q ? <Money micro={total} up /> : <span className="skeleton block h-14 w-40 rounded-full" />}
                </p>
                {lucky && <p className="mt-2 text-[15px] text-ink-soft">Each Lucky card gets its own Draw; any cashback lands in your balance right after it's delivered.</p>}
              </div>
              {buy.error && <p role="alert" className="text-sm font-medium text-bad">{errorMessage(buy.error)}</p>}
              {quotes.error && !q
                ? (
                  <div className="flex flex-col items-start gap-3 rounded-2xl bg-warn-soft p-4 text-[15px] text-warn">
                    <p className="font-medium">{errorMessage(quotes.error)}</p>
                    <Button variant="light" loading={quotes.isFetching} onClick={() => void quotes.refetch()}>Try again</Button>
                  </div>
                )
                : buy.isPending
                ? <Button size="lg" loading>Buying {cards(lines.length)}</Button>
                : (
                  <BuyButton
                    need={total}
                    largest={largest}
                    label={q && `Buy ${cards(lines.length)} for ${usdUp(total)}`}
                    onBuy={() => q && buy.mutate(lines.map((line, i) => ({ line, quote: q[i]! })))}
                  />
                )}
              <p className="text-sm text-muted">If a card can't be delivered, its full amount goes back to your balance.</p>
            </aside>
          </div>
        )}
    </div>
  )
}

const cards = (n: number) => `${n} ${n === 1 ? "card" : "cards"}`

/** One card: its price in the cart's quote, and how much of it plays when the reserve can't cover all of it. */
function Line({ line, quote, busy }: { line: CartLine; quote: Quote | undefined; busy: boolean }) {
  // The mode it will be bought in: a Lucky card the reserve can't cover comes back Normal.
  const mode = quote?.mode ?? line.mode
  const pal = modePalette(mode)
  const reserveFull = quote && line.mode !== "normal" && quote.mode === "normal"
  const part = quote && quote.luckyAmount > 0 && quote.luckyAmount < quote.referencePrice
  return (
    <li className="card flex items-center gap-4 p-4">
      <Link href={`/shop/${encodeURIComponent(line.voucherId)}?value=${encodeURIComponent(line.value)}&mode=${modeSlug(line.mode)}`} className="w-20 shrink-0 sm:w-24">
        <GiftCard v={line} notch={6} />
      </Link>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="line-clamp-2 leading-tight font-semibold">{line.name}</p>
        <p className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
          {line.value} {line.currency}
          <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold" style={{ background: pal.soft, color: pal.ink }}>
            <span className="size-2 rounded-full" style={{ background: pal.solid }} />{modeName(mode)}
          </span>
        </p>
        {reserveFull && <p className="text-sm text-warn">The cashback reserve is full right now, so this one is bought at the normal price.</p>}
        {part && <p className="text-sm text-muted">Only {usd(quote.luckyAmount)} of it plays; the rest is at the normal price.</p>}
      </div>
      <p className="font-display text-xl font-extrabold">
        {quote ? <Money micro={quote.maxPrice} up /> : <span className="skeleton block h-6 w-16 rounded-full" />}
      </p>
      <Button variant="ghost" size="icon" aria-label={`Remove ${line.name} ${line.value}`} disabled={busy} onClick={() => removeFromCart([line.key])}>
        <X />
      </Button>
    </li>
  )
}
