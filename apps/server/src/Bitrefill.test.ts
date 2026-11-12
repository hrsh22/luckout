import { ConfigProvider, Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Bitrefill, isTestMerchant, pickPopular, popularBrands, regionsFor, usdToMicro } from "./Bitrefill.ts"
import { DbMemory } from "./Db.ts"

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
    Effect.provide(DbMemory),
    // The client otherwise keeps the first fetch it saw; tests swap in their own fakes.
    Effect.provideService(FetchHttpClient.Fetch, (input, init) => globalThis.fetch(input, init)),
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

test("the catalog lists only cards we can deliver, filtered just by what the customer chose, and pages are cached", async () => {
  const asked: Array<URL> = []
  const realFetch = globalThis.fetch
  // Bitrefill's REST catalog, faked: a full page of 50, then a last short one.
  const product = (i: number, extra: Record<string, unknown> = {}) =>
    ({ id: `card-${i}`, name: `Card ${i}`, country_code: "IN", country_name: "India", currency: "INR", categories: ["games"], recipient_type: "none", in_stock: true, ...extra })
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    asked.push(url)
    const start = Number(url.searchParams.get("start"))
    const data = start === 0
      ? Array.from({ length: 50 }, (_, i) =>
        i < 30 ? product(i, { recipient_type: "phone_number" }) : i < 32 ? product(i, { in_stock: false }) : product(i, i === 40 ? { country_code: "XI", country_name: "International" } : {}))
      : [product(100)]
    return Response.json({ meta: {}, data })
  }) as typeof fetch
  try {
    const r = await run((b) =>
      Effect.gen(function*() {
        const first = yield* b.browse({ country: "IN", category: "games" })
        const again = yield* b.browse({ country: "IN", category: "games" })
        const second = yield* b.browse({ country: "IN", category: "games", start: first.next })
        return { first, again, second }
      }), { NEAR_NETWORK: "mainnet", BITREFILL_API_KEY: "test-key" })
    // 50 listed: 30 top-ups needing a phone number and 2 out of stock are left out.
    assert.equal(r.first.items.length, 18)
    assert.ok(r.first.items.every((v) => v.countryCode === "IN" || v.countryCode === "XI"))
    assert.equal(r.first.items.find((v) => v.id === "card-40")?.countryCode, "XI", "worldwide cards show with a country's own")
    assert.equal(r.first.next, 50)
    assert.deepEqual(r.second.items.map((v) => v.id), ["card-100"])
    assert.equal(r.second.next, undefined, "a short page is the last")
    const listed = asked[0]!
    assert.equal(listed.pathname, "/v2/products")
    assert.equal(listed.searchParams.get("country"), "IN,XI")
    assert.deepEqual(regionsFor("DE"), ["DE", "EU", "XI"], "an EU member also gets Europe-wide cards")
    assert.equal(listed.searchParams.get("category"), "games,game-stores")
    assert.ok(!asked.some((u) => /\b(pin|refill|data)\b/.test(u.searchParams.get("category") ?? "")), "never phone credit")
    assert.equal(asked.length, 2, "the repeated first page came from the cache")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("popular cards: the brands people know, one each, from the visitor's own country first", () => {
  const card = (id: string, base_name: string, country_code: string, categories = ["games"]) => ({ id, name: id, base_name, country_code, categories })
  const brands = popularBrands([
    card("applebees-usa", "Applebee's", "US", ["restaurants"]),
    card("steamrex-denmark", "Steamrex", "DK"),
    card("uber-aed-international", "Uber Rides Voucher United Arab Emirates", "XI", ["travel"]),
    card("amazon-prime-india", "Amazon Prime Subscription", "IN", ["streaming"]),
    card("netflix-eu", "Netflix Europe", "EU", ["streaming"]),
    card("netflix-germany", "Netflix", "DE", ["streaming"]),
    card("steam-usa", "Steam", "US"),
    card("steam-india", "Steam", "IN"),
    card("roblox-usa", "Roblox USD", "XI"),
    card("flipkart-india", "Flipkart", "IN", ["online-marketplaces"]),
    card("apple-united-kingdom", "Apple", "GB", ["entertainment"]),
    card("itunes-india", "App Store & iTunes", "IN", ["entertainment"])
  ])
  const ids = (country?: string, category?: "games") => pickPopular(brands, country, category).map((p) => p.id)

  // Look-alikes, subscriptions and Uber's vouchers in dirhams aren't the brands people mean.
  assert.deepEqual(ids("IN"), ["steam-india", "itunes-india", "flipkart-india", "roblox-usa"], "India's own, most wanted first, then worldwide")
  assert.deepEqual(ids("US"), ["steam-usa", "roblox-usa"])
  assert.deepEqual(ids("FR"), ["netflix-eu", "roblox-usa"], "an EU member gets Europe-wide cards")
  assert.deepEqual(ids("DE"), ["netflix-germany", "roblox-usa"], "a country's own card beats the Europe-wide one")
  assert.deepEqual(ids("IN", "games"), ["steam-india", "roblox-usa"], "a category narrows it")
  assert.deepEqual(ids(), ["roblox-usa"], "no country: worldwide cards only")
  const many = popularBrands(Array.from({ length: 30 }, (_, i) => card(`steam-${i}`, "Steam", "XI")))
  assert.deepEqual(pickPopular(many, "US").map((p) => p.id), ["steam-0"], "one card per brand")
})

test("Bitrefill's own test merchants are never listed or sold; a real brand named Test isn't one of them", () => {
  const card = (id: string, name: string, country_code: string) => ({ id, name, country_code })
  assert.ok(isTestMerchant(card("delos-syldavia", "Delos-Test Vouchers X0!", "KN")))
  assert.ok(isTestMerchant(card("health-check-syldavia", "Health check test product", "KN")))
  assert.ok(isTestMerchant(card("affiliate-tester", "Affiliate Tester", "KN")))
  assert.ok(!isTestMerchant(card("test-kitchen-philippines", "Test Kitchen Philippines", "PH")))
  assert.ok(!isTestMerchant(card("amazon-us", "Amazon", "US")))
})
