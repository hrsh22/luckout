"use client"

import { CartQuoteRequest, NewCart, NewPurchase, type Quote } from "@luckout/api"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { api, TimedOut } from "./api"
import type { CartCard } from "./cart"
import { useSession } from "./session"

/** One card of a checkout, with the key that makes it one purchase however often the checkout is sent. */
export interface Unit {
  readonly line: CartCard
  readonly key: string
}

/**
 * Several cards priced together, as the contract would admit them now (ADR-0013): each Lucky card on the reserve the
 * cards before it left, Normal when there's none left for it. One quote per unit, in order. Renewed as it goes stale
 * while in sight.
 */
export const useCartQuote = (units: ReadonlyArray<Unit>, active = true) =>
  useQuery({
    queryKey: ["quote-cart", units.map(({ line }) => `${line.voucherId}|${line.value}|${JSON.stringify(line.mode)}`)],
    queryFn: () =>
      api((c) =>
        c.catalog.quoteCart({ payload: new CartQuoteRequest({ items: units.map(({ line }) => ({ voucherId: line.voucherId, value: line.value, mode: line.mode })) }) })
      ),
    enabled: units.length > 0 && active,
    staleTime: 20_000,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    select: (q) => (q.length === units.length ? q : undefined)
  })

/** What a cart quote adds up to: the prices, the Lucky extra on top, and the most any one card debits. */
export const totals = (quotes: ReadonlyArray<Quote> | undefined) => {
  const price = quotes?.reduce((s, q) => s + q.referencePrice, 0) ?? 0
  const pay = quotes?.reduce((s, q) => s + q.maxPrice, 0) ?? 0
  return { price, extra: pay - price, pay, largest: Math.max(0, ...(quotes ?? []).map((q) => q.maxPrice)) }
}

/**
 * Buys several cards as one checkout, exactly as each quote showed (its mode too, Normal when the reserve couldn't
 * cover a Lucky card), then shows the order. A checkout the server is still placing when the request times out is
 * sent again with the same keys, which returns the same purchases.
 */
export const useCheckout = (onBought?: (keys: ReadonlyArray<string>) => void) => {
  const { token, refresh } = useSession()
  const qc = useQueryClient()
  const router = useRouter()
  return useMutation({
    mutationFn: async (items: ReadonlyArray<Unit & { quote: Quote }>) => {
      const payload = new NewCart({
        items: items.map(({ line, key, quote: q }) =>
          new NewPurchase({
            voucherId: line.voucherId,
            value: line.value,
            mode: q.mode,
            maxPrice: q.maxPrice,
            ...(q.mode === "normal" ? {} : { luckyAmount: q.luckyAmount }),
            idempotencyKey: key
          })
        )
      })
      return api((c) => c.purchases.createCart({ payload }), token, "150 seconds").catch((e) => {
        if (!(e instanceof TimedOut)) throw e
        return api((c) => c.purchases.createCart({ payload }), token)
      })
    },
    onSuccess: (bought, items) => {
      onBought?.(items.map((i) => i.key))
      router.push(`/purchases?order=${bought[0]?.checkoutId ?? ""}`)
    },
    onSettled: () => {
      refresh().catch(() => {})
      qc.invalidateQueries({ queryKey: ["purchases"] })
      qc.invalidateQueries({ queryKey: ["checkout-email"] })
      qc.invalidateQueries({ queryKey: ["quote-cart"] })
    }
  })
}

/**
 * Each Cart line with its copies' quotes (units are in line order): what the line costs in all and each, whether the
 * reserve put a Lucky copy at Normal, and the smallest part of a copy that still plays when it covers only some.
 */
export const pricedLines = <L extends CartCard & { readonly keys: ReadonlyArray<string> }>(lines: ReadonlyArray<L>, quotes: ReadonlyArray<Quote> | undefined) => {
  let at = 0
  return lines.map((line) => {
    const mine = quotes?.slice(at, at + line.keys.length)
    at += line.keys.length
    const total = mine?.reduce((s, q) => s + q.maxPrice, 0)
    // "each" when every copy costs the same to the cent (what's shown), however the micro-USDC differ.
    const cents = (q: Quote) => Math.ceil(q.maxPrice / 10_000)
    const each = mine && mine.every((q) => cents(q) === cents(mine[0]!)) ? mine[0]!.maxPrice : undefined
    const lucky = line.mode !== "normal"
    const normal = !!mine && lucky && mine.some((q) => q.mode === "normal")
    const part = mine?.filter((q) => q.luckyAmount > 0 && q.luckyAmount < q.referencePrice).map((q) => q.luckyAmount)
    return { line, total, each, normal, plays: part && part.length > 0 ? Math.min(...part) : undefined }
  })
}
