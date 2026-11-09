import { ConfigProvider, Effect } from "effect"
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
const run = <A, E>(f: (b: Bitrefill["Service"]) => Effect.Effect<A, E>, env: Record<string, string> = {}) =>
  Effect.runPromise(Bitrefill.use(f).pipe(
    Effect.provide(Bitrefill.layer),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...(process.env as Record<string, string>), ...env } })))
  ))

// Bitrefill caps free test deliveries per account (they began failing after ~15 on 7 Nov), so this one is opt-in.
const liveBuy = { skip: !process.env.BITREFILL_LIVE_BUY && "set BITREFILL_LIVE_BUY=1 to spend a free test delivery" }
test("test card is delivered with Redemption Data", liveBuy, async () => {
  const d = await run((b) =>
    Effect.flatMap(b.order("test-gift-card-code", "10"), (o) =>
      o._tag === "Ordered" ? b.delivery(o.invoiceId) : Effect.die(o.reason)))
  assert.equal(d._tag, "Delivered")
  assert.ok(d._tag === "Delivered" && typeof d.redemption.code === "string")
})

test("real vouchers are priced in USD from Bitrefill, and amounts under $1 aren't for sale", live, async () => {
  // Real products are only priced on mainnet.
  const v = await run((b) => b.voucher("swiggy-money-india"), { NEAR_NETWORK: "mainnet" })
  const p500 = v.packages.find((p) => p.value === "500")
  // ₹500 is about $5.5; a sats-derived or face-value price would be far off.
  assert.ok(p500 && p500.priceMicroUsdc > 4_000_000 && p500.priceMicroUsdc < 8_000_000, String(p500?.priceMicroUsdc))
  assert.ok(v.packages.every((p) => p.priceMicroUsdc >= 1_000_000), "the contract refuses purchases under 1 USDC")
  assert.ok(v.tooSmall?.some((p) => p.value === "50"), "₹50 is listed as too small, not silently dropped")
})

test("on testnet only test cards are offered or priced", live, async () => {
  const found = await run((b) => b.search("gift card"), { NEAR_NETWORK: "testnet" })
  assert.ok(found.length > 0 && found.every((v) => v.id.startsWith("test-")), JSON.stringify(found.map((v) => v.id)))
  await assert.rejects(run((b) => b.voucher("swiggy-money-india"), { NEAR_NETWORK: "testnet" }), (e: { message?: string }) => /only Bitrefill's test cards/.test(e.message ?? ""))
})

test("test vouchers are priced at face value", live, async () => {
  const v = await run((b) => b.voucher("test-gift-card-code"))
  assert.equal(v.packages.find((p) => p.value === "10")?.priceMicroUsdc, 10_000_000)
})

// A package that doesn't exist is refused before any invoice, whatever the balance.
test("a refusal from Bitrefill is a definite Refused, not an unknown", live, async () => {
  const o = await run((b) => b.order("swiggy-money-india", "999999"))
  assert.equal(o._tag, "Refused", JSON.stringify(o))
})
