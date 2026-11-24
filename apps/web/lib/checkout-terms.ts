// A checkout's terms, worked out without React, the server or a wallet, so node --test can check them: what a cart
// quote adds up to, what each Cart line costs, the request that buys exactly what the quotes showed, and the Spending
// Limits it must pass. lib/checkout.ts and the buy button use these.

import { NewCart, NewPurchase, type Quote } from "@luckout/api"
import { DEFAULT_LIMITS } from "@luckout/api/limits"
import type { ContractAccount } from "./session.tsx"

/** What a cart quote adds up to: the prices, the Lucky extra on top, and the most any one card debits. */
export const totals = (quotes: ReadonlyArray<Quote> | undefined) => {
  const price = quotes?.reduce((s, q) => s + q.referencePrice, 0) ?? 0
  const pay = quotes?.reduce((s, q) => s + q.maxPrice, 0) ?? 0
  return { price, extra: pay - price, pay, largest: Math.max(0, ...(quotes ?? []).map((q) => q.maxPrice)) }
}

/**
 * Each Cart line with its copies' quotes (units are in line order): what the line costs in all and each, whether the
 * reserve put a Lucky copy at Normal, and the smallest part of a copy that still plays when it covers only some.
 */
export const pricedLines = <L extends { readonly mode: Quote["mode"]; readonly keys: ReadonlyArray<string> }>(lines: ReadonlyArray<L>, quotes: ReadonlyArray<Quote> | undefined) => {
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

/**
 * One card bought exactly as its quote showed: the quote's mode (Normal when the reserve couldn't cover a Lucky card),
 * its maximum, and a Lucky Buy's Lucky Amount, which the contract plays exactly or refuses. The key makes it one
 * purchase however often it's sent.
 */
export const purchaseRequest = (card: { readonly voucherId: string; readonly value: string }, key: string, q: Quote) =>
  new NewPurchase({
    voucherId: card.voucherId,
    value: card.value,
    mode: q.mode,
    maxPrice: q.maxPrice,
    ...(q.mode === "normal" ? {} : { luckyAmount: q.luckyAmount }),
    idempotencyKey: key
  })

/** Several cards as one checkout, each as its quote showed. A class instance: the client refuses a plain object. */
export const checkoutRequest = (items: ReadonlyArray<{ readonly line: { readonly voucherId: string; readonly value: string }; readonly key: string; readonly quote: Quote }>) =>
  new NewCart({ items: items.map(({ line, key, quote }) => purchaseRequest(line, key, quote)) })

/** The customer's Spending Limits as the contract keeps them (micro-USDC strings; a limit that's off is u128::MAX). */
type Limits = Pick<ContractAccount, "per_purchase_limit" | "daily_limit" | "day" | "spent_today">

/**
 * Whether buying `need` in all, at most `largest` for any one card, passes the Spending Limits, as the contract checks
 * them (each card against the per-purchase limit, the whole against what's left of today's), and what to raise them to
 * if not: up to the new defaults, or what this needs (to the whole dollar) if that's more. A limit that isn't in the
 * way stays as it is, exactly, so "No limit" (u128::MAX) is never rounded through a number.
 */
export const spendingCheck = (limits: Limits, need: number, largest: number, now = Date.now()) => {
  const today = limits.day === Math.floor(now / 86_400_000) ? Number(limits.spent_today) : 0
  // A limit that's off is u128::MAX, so it's never "over".
  const overPer = largest > Number(limits.per_purchase_limit)
  const overDay = today + need > Number(limits.daily_limit)
  const raised = (floor: number, needed: number) => String(Math.max(floor, Math.ceil(needed / 1e6) * 1e6))
  return {
    today,
    overPer,
    overDay,
    per: overPer ? raised(DEFAULT_LIMITS.perPurchase, largest) : limits.per_purchase_limit,
    daily: overDay ? raised(DEFAULT_LIMITS.daily, today + need) : limits.daily_limit
  }
}
