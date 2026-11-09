import assert from "node:assert/strict"
import { test } from "node:test"
import { chanceLessBps, finalPrice, MODES, pricedOutcomes, simpleQuote } from "./modes.ts"

test("every mirrored table sums to 100% and averages exactly 106%, like the contract's", () => {
  for (const m of MODES.filter((x) => x.premiumBps > 0)) {
    assert.equal(m.outcomes.reduce((s, o) => s + o.chanceBps, 0), 10_000, m.name)
    assert.equal(m.outcomes.reduce((s, o) => s + o.chanceBps * o.finalBps, 0), 10_600 * 10_000, m.name)
  }
  assert.deepEqual(MODES.slice(1).map(chanceLessBps), [400, 1_800, 2_500])
})

test("prices match the contract's rounding: up, never above the maximum", () => {
  assert.equal(finalPrice(6_000_000, 6_000_000, 9_000_000, 15_000), 9_000_000)
  assert.equal(finalPrice(1_000_001, 1_000_001, 1_100_002, 11_000), 1_100_002)
  const jackpot = MODES[3]!
  assert.deepEqual(pricedOutcomes(jackpot, simpleQuote(jackpot, 20_000_000)).map((o) => o.price), [30_000_000, 20_000_000, 10_000_000, 0])
})
