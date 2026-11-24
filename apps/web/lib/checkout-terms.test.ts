import assert from "node:assert/strict"
import { test } from "node:test"
import { NewCart, NewPurchase, Quote } from "@luckout/api"
import { NO_LIMIT } from "@luckout/api/limits"
import { checkoutRequest, pricedLines, spendingCheck, totals } from "./checkout-terms.ts"

const classic = { lucky: 1 } as const
const q = (referencePrice: number, maxPrice: number, luckyAmount = 0, mode: Quote["mode"] = luckyAmount > 0 ? classic : "normal") =>
  new Quote({ mode, referencePrice, luckyAmount, maxPrice })

test("a cart quote adds up to its prices, the Lucky extra on top, and the most any one card debits", () => {
  assert.deepEqual(totals([q(10_000_000, 12_000_000, 10_000_000), q(5_000_000, 5_000_000)]), { price: 15_000_000, extra: 2_000_000, pay: 17_000_000, largest: 12_000_000 })
  assert.deepEqual(totals(undefined), { price: 0, extra: 0, pay: 0, largest: 0 })
})

test("each line gets its own copies' quotes, and says when the reserve put a Lucky copy at Normal or let only part of it play", () => {
  const lines = [
    { mode: classic, keys: ["a", "b", "c"] },
    { mode: "normal" as const, keys: ["d"] }
  ]
  // The reserve covers the first copy whole, the second in part, and the third not at all.
  const quotes = [q(10_000_000, 12_000_000, 10_000_000), q(10_000_000, 10_800_000, 4_000_000), q(10_000_000, 10_000_000), q(5_000_000, 5_000_000)]
  const [lucky, normal] = pricedLines(lines, quotes)
  assert.equal(lucky!.total, 32_800_000)
  assert.equal(lucky!.each, undefined, "the copies cost different amounts")
  assert.equal(lucky!.normal, true, "one Lucky copy is bought at Normal")
  assert.equal(lucky!.plays, 4_000_000, "the smallest part that still plays")
  assert.deepEqual(normal, { line: lines[1], total: 5_000_000, each: 5_000_000, normal: false, plays: undefined })
  // Copies a few micro-USDC apart cost the same to the cent: shown as "each".
  assert.equal(pricedLines([{ mode: classic, keys: ["a", "b"] }], [q(1, 12_000_001, 1), q(1, 12_000_004, 1)])[0]!.each, 12_000_001)
  // Before the quote is in: nothing is claimed.
  assert.deepEqual(pricedLines(lines, undefined)[0], { line: lines[0], total: undefined, each: undefined, normal: false, plays: undefined })
})

test("a checkout buys each card exactly as its quote showed, a Lucky card the reserve put at Normal as Normal, each with its own key", () => {
  const card = { voucherId: "amazon-in", value: "100" }
  const body = checkoutRequest([
    { line: card, key: "key-00001", quote: q(10_000_000, 12_000_000, 6_000_000) },
    { line: card, key: "key-00002", quote: q(10_000_000, 10_000_000, 0, "normal") }
  ])
  assert.ok(body instanceof NewCart && body.items.every((i) => i instanceof NewPurchase), "class instances: the client refuses plain objects")
  assert.deepEqual(body.items.map((i) => ({ ...i })), [
    { voucherId: "amazon-in", value: "100", mode: classic, maxPrice: 12_000_000, luckyAmount: 6_000_000, idempotencyKey: "key-00001" },
    { voucherId: "amazon-in", value: "100", mode: "normal", maxPrice: 10_000_000, idempotencyKey: "key-00002" }
  ])
})

test("Spending Limits: each card against the per-purchase limit, the whole against today's, raised to what's needed or the defaults", () => {
  const now = Date.parse("2026-11-25T12:00:00Z")
  const day = Math.floor(now / 86_400_000)
  const limits = { per_purchase_limit: "200000000", daily_limit: "1000000000", day, spent_today: "900000000" }
  // $50 cards, $150 in all, with $900 spent today: within the per-purchase limit, over the daily one.
  const c = spendingCheck(limits, 150_000_000, 50_000_000, now)
  assert.deepEqual(c, { today: 900_000_000, overPer: false, overDay: true, per: "200000000", daily: "1050000000" })
  // Spent on an earlier day doesn't count today.
  assert.equal(spendingCheck({ ...limits, day: day - 1 }, 150_000_000, 50_000_000, now).overDay, false)
  // One card over: raised to the default, or to what it needs (to the whole dollar) if that's more.
  assert.equal(spendingCheck({ ...limits, per_purchase_limit: "20000000" }, 30_000_000, 30_000_000, now).per, "200000000")
  assert.equal(spendingCheck(limits, 250_500_000, 250_500_000, now).per, "251000000")
  // A limit that's off is never over, and is sent back exactly.
  const off = spendingCheck({ ...limits, per_purchase_limit: NO_LIMIT, daily_limit: NO_LIMIT }, 5_000_000_000, 5_000_000_000, now)
  assert.deepEqual([off.overPer, off.overDay, off.per, off.daily], [false, false, NO_LIMIT, NO_LIMIT])
})
