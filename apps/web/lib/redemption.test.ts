import assert from "node:assert/strict"
import { test } from "node:test"
import { redemptionShown } from "./redemption.ts"

test("a delivered card shows its Redemption Data whatever field Bitrefill put it in, and only https links become links", () => {
  assert.equal(redemptionShown({ code: "C0DE" }).any, true)
  assert.equal(redemptionShown({ link: "https://www.bitrefill.com/r/abc" }).any, true)
  // Some cards come with nothing but free text or instructions: still shown, never just "Delivered".
  assert.equal(redemptionShown({ other: "Card number: 1234 5678" }).any, true)
  assert.equal(redemptionShown({ instructions: "Redeem at checkout with your phone number." }).any, true)
  assert.equal(redemptionShown({}).any, false)
  assert.equal(redemptionShown(undefined).any, false)
  const r = redemptionShown({ link: "javascript:alert(1)", expiration_date: "2027-01-31" })
  assert.equal(r.link, undefined)
  assert.equal(r.any, false, "a link that isn't https shows nothing to click")
  assert.equal(r.expires?.toISOString(), "2027-01-31T00:00:00.000Z")
  assert.equal(redemptionShown({ code: "C0DE", expiration_date: "soon" }).expires, undefined)
})
