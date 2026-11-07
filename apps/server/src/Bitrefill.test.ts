import { Effect } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Bitrefill, satsToMicroUsdc } from "./Bitrefill.ts"

test("sats convert to micro-USDC, rounding up", () => {
  assert.equal(satsToMicroUsdc(13819, 13819), 10_000_000)
  assert.equal(satsToMicroUsdc(1, 13819), 724) // 723.6… rounds up
})

// Bitrefill test products deliver instantly and cost nothing.
const live = { skip: !process.env.BITREFILL_API_KEY && "BITREFILL_API_KEY not set" }
const run = <A, E>(f: (b: Bitrefill["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(Bitrefill.use(f).pipe(Effect.provide(Bitrefill.layer)))

test("test card is delivered with Redemption Data", live, async () => {
  const d = await run((b) => b.buy("test-gift-card-code<&>10"))
  assert.equal(d._tag, "Delivered")
  assert.ok(d._tag === "Delivered" && typeof d.redemption.code === "string")
})

// The "-fail" test products go not_available after one use, so the Failed path
// is covered by the purchase workflow tests instead.

test("catalog search prices packages in micro-USDC", live, async () => {
  const [v] = await run((b) => b.search("swiggy"))
  assert.ok(v && v.packages.every((p) => Number.isInteger(p.priceMicroUsdc) && p.priceMicroUsdc > 0))
})
