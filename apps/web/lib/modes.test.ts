import assert from "node:assert/strict"
import { test } from "node:test"
import { cashbackChanceBps, finalPrice, MODES, pricedOutcomes, simpleQuote } from "./modes.ts"

test("every mirrored table sums to 100% and averages exactly 105.6%, like the contract's", () => {
  for (const m of MODES.filter((x) => x.premiumBps > 0)) {
    assert.equal(m.outcomes.reduce((s, o) => s + o.chanceBps, 0), 10_000, m.name)
    assert.equal(m.outcomes.reduce((s, o) => s + o.chanceBps * o.finalBps, 0), 10_560 * 10_000, m.name)
    // Any Cashback leaves the price below normal.
    assert.ok(m.outcomes.every((o) => o.finalBps < 10_000 || o.finalBps === 10_000 + m.premiumBps), m.name)
  }
  assert.deepEqual(MODES.slice(1).map((m) => m.name), ["Lite", "Classic", "Jackpot"])
  assert.deepEqual(MODES.slice(1).map(cashbackChanceBps), [2_300, 4_000, 5_600])
})

test("prices match the contract's rounding: up, never above the maximum", () => {
  assert.equal(finalPrice(6_000_000, 6_000_000, 9_000_000, 15_000), 9_000_000)
  assert.equal(finalPrice(1_000_001, 1_000_001, 1_100_002, 11_000), 1_100_002)
})

test("the Cashback Cap: a $100 Classic buy plays $41.67, so the best result pays back exactly $50", () => {
  const classic = MODES[2]!
  const q = simpleQuote(classic, 100_000_000)
  assert.deepEqual(q, { referencePrice: 100_000_000, luckyAmount: 41_666_666, maxPrice: 108_333_334 })
  assert.equal(pricedOutcomes(classic, q).at(-1)!.cashback, 50_000_000)
})

test("a $20 Classic buy: pay $24, then 20% to 100% back", () => {
  const classic = MODES[2]!
  const outcomes = pricedOutcomes(classic, simpleQuote(classic, 20_000_000))
  assert.deepEqual(outcomes.map((o) => [o.pct, o.cashback, o.price, o.chanceBps]), [
    [0, 0, 24_000_000, 6_000],
    [20, 4_800_000, 19_200_000, 2_400],
    [30, 7_200_000, 16_800_000, 700],
    [40, 9_600_000, 14_400_000, 400],
    [50, 12_000_000, 12_000_000, 300],
    [100, 24_000_000, 0, 200]
  ])
})
