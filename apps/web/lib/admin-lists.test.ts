import assert from "node:assert/strict"
import { test } from "node:test"
import { heldByAll, purchaseIdIn } from "./admin-lists.ts"

test("a purchase id pasted into the filter is looked up, whatever its case or spaces; anything else is only a filter", () => {
  assert.equal(purchaseIdIn("  4EA83EEC-1D2B-4C3A-9F00-0123456789AB "), "4ea83eec-1d2b-4c3a-9f00-0123456789ab")
  assert.equal(purchaseIdIn("4ea83eec"), undefined, "the start of an id only filters what is loaded")
  assert.equal(purchaseIdIn("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"), undefined, "an account id only filters")
  assert.equal(purchaseIdIn(""), undefined)
})

test("the total held is a floor, and says so, when Solana didn't answer for a customer", () => {
  assert.deepEqual(heldByAll([{ balance: 120_000_000 }, { balance: 0 }]), { micro: 120_000_000, partial: false })
  assert.deepEqual(heldByAll([{ balance: 120_000_000 }, {}]), { micro: 120_000_000, partial: true })
  assert.deepEqual(heldByAll([]), { micro: 0, partial: false })
})
