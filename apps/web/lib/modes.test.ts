import assert from "node:assert/strict"
import { test } from "node:test"
import type { ModeInfo } from "./modes.ts"
import { cashbackChanceBps, finalPrice, MODES, pricedOutcomes, simpleQuote } from "./modes.ts"

const USDC = 1_000_000
const [normal, lite, classic, jackpot] = MODES as [ModeInfo, ModeInfo, ModeInfo, ModeInfo]
/** get_reserve at this Free Reserve under the starting Cashback Cap: the lower of $50 and 20% of it. */
const at = (free: number) => ({ free, max_cashback: Math.min(50 * USDC, free / 5) })

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
  const q = simpleQuote(classic, 100_000_000, at(1_000 * USDC))
  assert.deepEqual(q, { referencePrice: 100_000_000, luckyAmount: 41_666_666, maxPrice: 108_333_334 })
  assert.equal(pricedOutcomes(classic, q).at(-1)!.cashback, 50_000_000)
})

test("a $20 Classic buy: pay $24, then 20% to 100% back", () => {
  const outcomes = pricedOutcomes(classic, simpleQuote(classic, 20_000_000, at(1_000 * USDC)))
  assert.deepEqual(outcomes.map((o) => [o.pct, o.cashback, o.price, o.chanceBps]), [
    [0, 0, 24_000_000, 6_000],
    [20, 4_800_000, 19_200_000, 2_400],
    [30, 7_200_000, 16_800_000, 700],
    [40, 9_600_000, 14_400_000, 400],
    [50, 12_000_000, 12_000_000, 300],
    [100, 24_000_000, 0, 200]
  ])
})

// Hand-computed from quote_internal: lucky = min(r, max_cashback * 10000 / max_cashback_bps,
// free * 10000 / max_discount_bps), premium rounded up. Every live table's best row pays 0, so
// max_discount_bps is 10000 and max_cashback_bps is 10000 + premium.
test("a small reserve: at $60 free, 20% is $12 of cashback, so a $20 Classic card plays $10", () => {
  const r = at(60 * USDC)
  assert.deepEqual(simpleQuote(lite, 20 * USDC, r), { referencePrice: 20 * USDC, luckyAmount: 10_909_090, maxPrice: 21_090_909 })
  assert.deepEqual(simpleQuote(classic, 20 * USDC, r), { referencePrice: 20 * USDC, luckyAmount: 10 * USDC, maxPrice: 22 * USDC })
  assert.deepEqual(simpleQuote(jackpot, 20 * USDC, r), { referencePrice: 20 * USDC, luckyAmount: 8 * USDC, maxPrice: 24 * USDC })
  const best = pricedOutcomes(classic, simpleQuote(classic, 20 * USDC, r)).at(-1)!
  assert.deepEqual([best.price, best.cashback], [10 * USDC, 12 * USDC])
  // A $5 card still plays whole.
  assert.deepEqual(simpleQuote(classic, 5 * USDC, r), { referencePrice: 5 * USDC, luckyAmount: 5 * USDC, maxPrice: 6 * USDC })
  // Normal never needs the reserve.
  assert.deepEqual(simpleQuote(normal, 20 * USDC, undefined), { referencePrice: 20 * USDC, luckyAmount: 0, maxPrice: 20 * USDC })
})

test("matches the contract's own quote tests", () => {
  // big_purchases_only_play_the_lucky_amount: 165 USDC reserve, Lite on 1,000 USDC.
  assert.deepEqual(simpleQuote(lite, 1_000 * USDC, at(165 * USDC)), { referencePrice: 1_000 * USDC, luckyAmount: 30 * USDC, maxPrice: 1_003 * USDC })
  // small_purchases_get_the_full_game_version: 45 USDC reserve, 6 USDC.
  assert.deepEqual([lite, classic, jackpot].map((m) => simpleQuote(m, 6 * USDC, at(45 * USDC)).maxPrice), [6_600_000, 7_200_000, 9 * USDC])
  // no_lucky_buy_pays_back_more_than_50_usdc: 1,000 USDC reserve and price, the fixed $50 binds.
  assert.deepEqual([lite, classic, jackpot].map((m) => simpleQuote(m, 1_000 * USDC, at(1_000 * USDC)).luckyAmount), [45_454_545, 41_666_666, 33_333_333])
  // the_owner_raises_the_fixed_limit: $100.
  const raised = { free: 1_000 * USDC, max_cashback: 100 * USDC }
  assert.deepEqual([lite, classic, jackpot].map((m) => simpleQuote(m, 1_000 * USDC, raised).luckyAmount), [90_909_090, 83_333_333, 66_666_666])
  // a_fixed_only_cap_still_locks_no_more_than_free_reserve.
  assert.equal(simpleQuote(lite, 1_000 * USDC, { free: 30 * USDC, max_cashback: 100 * USDC }).luckyAmount, 30 * USDC)
  // lucky_buy_needs_a_reserve: nothing free, nothing plays.
  assert.equal(simpleQuote(lite, 6 * USDC, at(0)).luckyAmount, 0)
  // A reserve too big for doubles stays exact.
  assert.equal(simpleQuote(jackpot, 7 * USDC, { free: "100000000000000000000", max_cashback: "20000000000000000000" }).luckyAmount, 7 * USDC)
})
