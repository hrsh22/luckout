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

test("real vouchers are priced in USD from Bitrefill, and amounts under $0.50 aren't for sale", live, async () => {
  // Real products are only priced on mainnet.
  const v = await run((b) => b.voucher("swiggy-money-india"), { NEAR_NETWORK: "mainnet" })
  const p500 = v.packages.find((p) => p.value === "500")
  // ₹500 is about $5.5; a sats-derived or face-value price would be far off.
  assert.ok(p500 && p500.priceMicroUsdc > 4_000_000 && p500.priceMicroUsdc < 8_000_000, String(p500?.priceMicroUsdc))
  assert.ok(v.packages.every((p) => p.priceMicroUsdc >= 500_000), "the contract refuses purchases under 0.5 USDC")
  assert.ok(v.tooSmall?.every((p) => p.priceMicroUsdc < 500_000) ?? true, "only amounts under the minimum are listed as too small")
  assert.ok(v.packages.some((p) => p.value === "50"), "₹50 (about $0.56) is for sale")
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

test("junk ids spend no lookups, and browsing can never use up the ones a purchase needs", async () => {
  const looked: Array<string> = []
  const realFetch = globalThis.fetch
  // Bitrefill's MCP endpoint, faked: every product costs $10.
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body as Uint8Array)
    const id: string = JSON.parse(body).params.arguments.product_id
    looked.push(id)
    const product = { id, name: id, country_code: "US", currency: "USD", packages: [{ package_value: "10", payment_price: "10.00", payment_currency: "USD" }] }
    return new Response(`data: ${JSON.stringify({ result: { content: [{ text: JSON.stringify(product) }] } })}\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    })
  }) as typeof fetch
  try {
    const r = await run((b) =>
      Effect.gen(function*() {
        const junk = yield* b.voucher("../admin").pipe(Effect.flip)
        // Browsing (catalog pages, quotes) uses its share of the minute's lookups...
        for (let i = 0; i < 12; i++) yield* b.voucher(`card-${i}`)
        const busy = yield* b.voucher("amazon-us").pipe(Effect.flip)
        // ...and a purchase still gets its price, even for the id browsing was just refused.
        const bought = yield* b.voucher("amazon-us", { purchase: true })
        // That price is then cached for browsing too.
        const browsed = yield* b.voucher("amazon-us")
        return { junk, busy, bought, browsed }
      }), { NEAR_NETWORK: "mainnet", BITREFILL_API_KEY: "test-key" })
    assert.match(r.junk.message, /No such voucher/)
    assert.match(r.busy.message, /busy/)
    assert.equal(r.bought.packages[0]?.priceMicroUsdc, 10_000_000)
    assert.equal(r.browsed.id, "amazon-us")
    assert.equal(looked.length, 13, "twelve for browsing, one for the purchase, none for the junk id or the cached price")
  } finally {
    globalThis.fetch = realFetch
  }
})
