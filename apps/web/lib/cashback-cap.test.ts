import assert from "node:assert/strict"
import { test } from "node:test"
import { capText, maxCashbackAt } from "./cashback-cap.ts"

test("the most Cashback one Lucky Buy can get is the lower of the cap's two limits, rounded down like the contract", () => {
  const cap = { fixed: 50_000_000, reserveBps: 2_000 }
  assert.equal(maxCashbackAt(cap, 1_000_000_000), 50_000_000, "a big reserve: the fixed limit binds")
  assert.equal(maxCashbackAt(cap, 100_000_000), 20_000_000, "a small reserve: the share binds")
  assert.equal(maxCashbackAt(cap, 999_999), 199_999, "199,999.8 rounds down, as the contract's integer division does")
  assert.equal(maxCashbackAt({ fixed: null, reserveBps: 2_000 }, 1_000_000_000), 200_000_000, "no fixed limit: only the share")
  assert.equal(maxCashbackAt({ fixed: 50_000_000, reserveBps: null }, 0), 50_000_000)
  assert.equal(maxCashbackAt(cap, 0), 0, "no free reserve, no Cashback")
  assert.equal(maxCashbackAt({ fixed: null, reserveBps: 5_000 }, Number.MAX_SAFE_INTEGER), Math.floor(Number.MAX_SAFE_INTEGER / 2), "exact past 2^53 / 10,000")
})

test("the Cashback Cap reads as the owner set it", () => {
  assert.equal(capText({ fixed: 50_000_000, reserveBps: 2_000 }), "the lower of $50.00 and 20% of free reserve")
  assert.equal(capText({ fixed: null, reserveBps: 2_000 }), "20% of free reserve")
  assert.equal(capText({ fixed: null, reserveBps: 1_250 }), "12.5% of free reserve")
  assert.equal(capText({ fixed: 50_000_000, reserveBps: null }), "$50.00")
})
