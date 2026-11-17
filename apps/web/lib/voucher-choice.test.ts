import assert from "node:assert/strict"
import { test } from "node:test"
import { openingAmount, openingMode } from "./voucher-choice.ts"

const packages = [{ value: "10" }, { value: "25" }, { value: "50" }, { value: "100" }]

test("a card opens on the amount in its link while it loads, and on its middle amount when the link's isn't sold", () => {
  assert.equal(openingAmount("50", packages), "50", "a link to an amount the card sells keeps it")
  assert.equal(openingAmount("50", undefined), "50", "while the card loads, the link's amount is priced at once")
  assert.equal(openingAmount("75", packages), "25", "an amount no longer sold falls back to the middle one, not a grey block")
  assert.equal(openingAmount(null, packages), "25", "no amount in the link: the middle one, as before")
  assert.equal(openingAmount(null, [{ value: "10" }]), "10")
  assert.equal(openingAmount("75", []), undefined, "a card that sells no amount right now has none to show")
  assert.equal(openingAmount(null, undefined), undefined)
})

test("a card opens on the link's mode, else the Default Mode, and a Default Mode this build doesn't know falls back to Normal", () => {
  assert.deepEqual(openingMode("jackpot", { lucky: 1 }), { mode: { lucky: 2 }, unknownDefault: false }, "the link decides")
  assert.deepEqual(openingMode(null, { lucky: 1 }), { mode: { lucky: 1 }, unknownDefault: false }, "then the Default Mode")
  assert.deepEqual(openingMode(null, "normal"), { mode: "normal", unknownDefault: false })
  assert.deepEqual(openingMode(null, undefined), { mode: "normal", unknownDefault: false }, "signed out: Normal")
  // A Game Version the owner registered after this web build: Normal, and the page says why.
  assert.deepEqual(openingMode(null, { lucky: 3 }), { mode: "normal", unknownDefault: true })
  assert.deepEqual(openingMode("classic", { lucky: 3 }), { mode: { lucky: 1 }, unknownDefault: false }, "the link's mode needs no excuse")
  assert.deepEqual(openingMode("no-such-mode", { lucky: 3 }), { mode: "normal", unknownDefault: true })
})
