import { Effect } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Bitrefill, usdToMicro } from "./Bitrefill.ts"

test("USD strings convert to micro-USDC exactly", () => {
  assert.equal(usdToMicro("5.53"), 5_530_000)
  assert.equal(usdToMicro("110"), 110_000_000)
  assert.equal(usdToMicro("0.000001"), 1)
  assert.throws(() => usdToMicro("1e3"))
})

// Live calls. Test products are free; real ones are only priced, never bought.
const live = { skip: !process.env.BITREFILL_API_KEY && "BITREFILL_API_KEY not set" }
const run = <A, E>(f: (b: Bitrefill["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(Bitrefill.use(f).pipe(Effect.provide(Bitrefill.layer)))

test("test card is delivered with Redemption Data", live, async () => {
  const d = await run((b) => b.buy("test-gift-card-code", "10"))
  assert.equal(d._tag, "Delivered")
  assert.ok(d._tag === "Delivered" && typeof d.redemption.code === "string")
})

test("real vouchers are priced in USD from Bitrefill", live, async () => {
  const v = await run((b) => b.voucher("swiggy-money-india"))
  const p500 = v.packages.find((p) => p.value === "500")
  // ₹500 is about $5.5; a sats-derived or face-value price would be far off.
  assert.ok(p500 && p500.priceMicroUsdc > 4_000_000 && p500.priceMicroUsdc < 8_000_000, String(p500?.priceMicroUsdc))
})

test("test vouchers are priced at face value", live, async () => {
  const v = await run((b) => b.voucher("test-gift-card-code"))
  assert.equal(v.packages.find((p) => p.value === "10")?.priceMicroUsdc, 10_000_000)
})

// A package that doesn't exist is refused before any invoice, whatever the balance.
test("a refusal from Bitrefill is a definite Failed, not an unknown", live, async () => {
  const d = await run((b) => b.buy("swiggy-money-india", "999999"))
  assert.equal(d._tag, "Failed", JSON.stringify(d))
})
