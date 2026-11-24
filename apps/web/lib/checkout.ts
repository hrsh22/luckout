"use client"

import { CartQuoteRequest, type Quote } from "@luckout/api"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { api, TimedOut } from "./api"
import type { CartCard } from "./cart"
import { checkoutRequest } from "./checkout-terms.ts"
import { playable } from "./modes"
import { useSession } from "./session"

/** One card of a checkout, with the key that makes it one purchase however often the checkout is sent. */
export interface Unit {
  readonly line: CartCard
  readonly key: string
}

/**
 * Several cards priced together, as the contract would admit them now (ADR-0013): each Lucky card on the reserve the
 * cards before it left, Normal when there's none left for it, or too little for a cent of Cashback (playable). One quote
 * per unit, in order. Renewed as it goes stale while in sight.
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
    select: (q) => (q.length === units.length ? q.map(playable) : undefined)
  })

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
      const payload = checkoutRequest(items)
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
