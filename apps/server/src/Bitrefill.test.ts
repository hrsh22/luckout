import { ConfigProvider, Context, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Bitrefill, GUEST_POLL_GAP_MS, isTestMerchant, matchOrders, nextGuestPoll, NO_SUCH_VOUCHER, ORDER_LIMIT, orderRoom, pickPopular, popularBrands, readableText, regionsFor, usdToMicro } from "./Bitrefill.ts"
import { DbMemory } from "./Db.ts"

test("USD strings convert to micro-USDC exactly", () => {
  assert.equal(usdToMicro("5.53"), 5_530_000)
  assert.equal(usdToMicro("110"), 110_000_000)
  assert.equal(usdToMicro("0.000001"), 1)
  assert.throws(() => usdToMicro("1e3"))
})

test("Bitrefill's 15 orders are counted over a rolling 24 hours, and the next one fits when the oldest ages out", () => {
  const H = 60 * 60 * 1000
  const now = Date.parse("2026-11-13T16:20:00Z")
  // Fourteen in the last day, one older than a day: room for one more.
  const day = Array.from({ length: 14 }, (_, i) => now - 20 * H + i * H)
  assert.deepEqual(orderRoom([now - 25 * H, ...day], 0, now), { used: 14, reopensAt: undefined })
  // The fifteenth (here, one admitted but not yet placed) fills it until the oldest is 24 hours old.
  assert.deepEqual(orderRoom(day, 1, now), { used: 15, reopensAt: day[0]! + 24 * H })
  // Over by two (say, an order placed elsewhere): the second-oldest has to age out too. Order of the list doesn't matter.
  assert.deepEqual(orderRoom([...day].reverse(), 2, now), { used: 16, reopensAt: day[1]! + 24 * H })
  // Bitrefill's refusal, over REST (testnet) or as an MCP tool error.
  assert.ok(ORDER_LIMIT.test(`HTTP 400 {"error_code":"purchase_limit_reached"}`) && ORDER_LIMIT.test("Purchase limit reached"))
})

// Live calls, only when asked for (pnpm --filter @luckout/server test:live). Test products are free; real
// ones are only priced, never bought.
const live = { skip: !(process.env.LIVE_TESTS && process.env.BITREFILL_API_KEY) && "set LIVE_TESTS=1 with BITREFILL_API_KEY to call Bitrefill" }
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
    Effect.flatMap(b.order([{ id: "test-gift-card-code", value: "10" }]), (o) =>
      o._tag === "Ordered" ? b.delivery(o.invoiceId, undefined, [{ id: "test-gift-card-code", value: "10" }]) : Effect.die("reason" in o ? o.reason : o._tag)))
  assert.equal(d[0]!._tag, "Delivered")
  assert.ok(d[0]!._tag === "Delivered" && typeof d[0]!.redemption.code === "string")
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

// Bitrefill's answers to an order, faked: a refusal refunds the customer, so only an answer that means
// "nothing was created" may count as one. Anything else stays unknown, for the reconciler.
test("a refusal from Bitrefill is a definite Refused; an answer we don't recognise stays unknown", async () => {
  const realFetch = globalThis.fetch
  let answer: () => Response = () => new Response("", { status: 500 })
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input)
    // Only the MCP endpoint is under test; anything else the layer fetches gets an empty catalog page.
    return url.endsWith("/mcp") ? answer() : Response.json({ meta: {}, data: [] })
  }) as typeof fetch
  const toolError = (error: string, code: string) =>
    new Response(`data: ${JSON.stringify({ result: { isError: true, content: [{ text: JSON.stringify({ error, code }) }] } })}\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    })
  // No guest client (an empty value counts as unset), so the order goes out with the API key.
  const env = { NEAR_NETWORK: "mainnet", BITREFILL_API_KEY: "test-key", BITREFILL_CLIENT_ID: "" }
  const order = () => run((b) => b.order([{ id: "swiggy-money-india", value: "999999" }]), env)
  try {
    answer = () => new Response(JSON.stringify({ error: "Unknown package" }), { status: 400 })
    assert.equal((await order())._tag, "Refused", "an HTTP 4xx: the tool never ran")
    answer = () => toolError("Unknown package", "INVALID_INPUT")
    assert.equal((await order())._tag, "Refused", "a tool error that means nothing was created")
    answer = () => toolError("Could not confirm payment", "PAYMENT_UNCERTAIN")
    await assert.rejects(order(), (e: { message?: string }) => /Bitrefill request failed/.test(e.message ?? ""), "unknown: never refunded on a guess")
  } finally {
    globalThis.fetch = realFetch
  }
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
        const underscored = yield* b.voucher("papa-john_s-usa", { purchase: true })
        return { junk, busy, bought, browsed, underscored }
      }), { NEAR_NETWORK: "mainnet", BITREFILL_API_KEY: "test-key" })
    assert.match(r.junk.message, /No such voucher/)
    assert.equal(r.underscored.id, "papa-john_s-usa", "Bitrefill's own ids can hold an underscore")
    assert.match(r.busy.message, /busy/)
    assert.equal(r.bought.packages[0]?.priceMicroUsdc, 10_000_000)
    assert.equal(r.browsed.id, "amazon-us")
    assert.equal(looked.length, 14, "twelve for browsing, one for each purchase, none for the junk id or the cached price")
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

test("a card's brand colour from Bitrefill is passed on only when it is a hex colour; anything else is dropped", async () => {
  const colours = ["#1A2B3C", "#fff", "#11223344", "url(https://tracker.example/pixel.png)", "red", "#12345", "#1A2B3C;background-image:url(//tracker.example)"]
  const realFetch = globalThis.fetch
  // Bitrefill's REST catalog, faked: one card per colour, each with a logo.
  globalThis.fetch = (async () =>
    Response.json({
      meta: {},
      data: colours.map((logo_background, i) => ({ id: `card-${i}`, name: `Card ${i}`, country_code: "US", currency: "USD", recipient_type: "none", in_stock: true, image: "logos/card", logo_background }))
    })) as typeof fetch
  try {
    const found = await run((b) => b.search("card"), { NEAR_NETWORK: "mainnet", BITREFILL_API_KEY: "test-key" })
    assert.deepEqual(found.map((v) => v.background), ["#1A2B3C", "#fff", "#11223344", undefined, undefined, undefined, undefined])
    assert.ok(found.every((v) => v.image === "logos/card"), "the logo itself is kept")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("a logo colour saved before the check existed is dropped when the server starts", async () => {
  const logo = await Effect.runPromise(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const saved = { "card-1": { image: "logos/one", background: "url(https://tracker.example/pixel.png)" }, "card-2": { image: "logos/two", background: "#0A0B0C" } }
      yield* sql`INSERT INTO settings (key, value, updated_by) VALUES ('card_logos', ${JSON.stringify(saved)}::jsonb, 'server')`
      // Testnet never copies the catalog, so what `logo` answers is exactly what was saved.
      const b = Context.get(yield* Layer.build(Bitrefill.layer), Bitrefill)
      return [b.logo("card-1"), b.logo("card-2")]
    }).pipe(
      Effect.scoped,
      Effect.provide(DbMemory),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { NEAR_NETWORK: "testnet" } })))
    )
  )
  assert.deepEqual(logo, [{ image: "logos/one" }, { image: "logos/two", background: "#0A0B0C" }])
})

// Guest checkout (ADR-0012), with Bitrefill faked: the guest login, then whatever `tool` answers each MCP call.
const guestEnv = { NEAR_NETWORK: "mainnet", BITREFILL_API_KEY: "test-key", BITREFILL_CLIENT_ID: "client", BITREFILL_CLIENT_SECRET: "secret" }
const withGuestBitrefill = async <A>(tool: (name: string, args: Record<string, unknown>) => Response, body: () => Promise<A>) => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/oauth/mcp/token")) return Response.json({ access_token: "guest-login", expires_in: 21_600 })
    const sent = typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body as Uint8Array)
    const { name, arguments: args } = JSON.parse(sent).params
    return tool(name, args)
  }) as typeof fetch
  try {
    return await body()
  } finally {
    globalThis.fetch = realFetch
  }
}
const toolResult = (result: unknown) =>
  new Response(`data: ${JSON.stringify({ result: { content: [{ text: JSON.stringify(result) }] } })}\n`, { status: 200, headers: { "content-type": "text/event-stream" } })

test("a guest order Bitrefill rate-limits is an unknown to try again, never a refusal; a real refusal still is one", async () => {
  let status = 429
  const r = await withGuestBitrefill(
    () => new Response("Too Many Requests", { status }),
    () => run((b) =>
      Effect.gen(function*() {
        const limited = yield* b.order([{ id: "amazon-us", value: "10" }], { email: "alice@example.com" }).pipe(Effect.flip)
        status = 400
        return { limited, refused: yield* b.order([{ id: "amazon-us", value: "10" }], { email: "alice@example.com" }) }
      }), guestEnv)
  )
  assert.equal(r.limited._tag, "BitrefillUnavailable")
  assert.match(r.limited.message, /rate limiting/)
  assert.equal(r.refused._tag, "Refused")
})

test("Bitrefill's HTML keeps its shape as lines: titles, numbered steps, nested items; links name their site", () => {
  assert.equal(
    readableText("<p><strong>On the app:</strong></p><ol><li><span>Open it</span></li><li>Enter:<ul><li>Card number</li><li>PIN</li></ul></li><li>Tap &ldquo;Add&#8221; &amp; done&#x2026; &bogus;</li></ol><span>&nbsp;</span><p><strong>On the website:</strong></p><ol><li>Go to <a href=\"http://example.com\">example.com</a></li></ol>"),
    "# On the app\n1. Open it\n2. Enter:\n  - Card number\n  - PIN\n3. Tap “Add” & done… &bogus;\n# On the website\n1. Go to example.com"
  )
  assert.equal(
    readableText("Validity:<br>12 months.\n<br>1. Open the app.<br>2) Add it.<p>Start <a href=\"https://store.example.com/redeem\">here</a>, or see https://www.example.org/terms</p><script>alert(1)</script>"),
    "# Validity\n12 months.\n1. Open the app.\n2. Add it.\nStart here (store.example.com), or see example.org\nalert(1)"
  )
})

test("a card's page gets Bitrefill's pitch, steps, terms and rating", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const id: string = JSON.parse(String(init?.body)).params.arguments.product_id
    const product = {
      id,
      name: id,
      country_code: "IN",
      currency: "INR",
      packages: [{ package_value: "50", payment_price: "0.56", payment_currency: "USD" }],
      subtitles: "Order meals.",
      instructions: "1. Open the app.<br>2. Add the voucher.",
      termsConditions: "Validity:<br>12 months.",
      ratings: { rating_value: 5, rating_count: 132, review_count: 59 }
    }
    return new Response(`data: ${JSON.stringify({ result: { content: [{ text: JSON.stringify(product) }] } })}\n`, { status: 200, headers: { "content-type": "text/event-stream" } })
  }) as typeof fetch
  try {
    const [swiggy, other] = await run((b) => Effect.all([b.voucher("swiggy-money-india"), b.voucher("other-card")]), { NEAR_NETWORK: "mainnet", BITREFILL_API_KEY: "test-key" })
    assert.equal(swiggy.subtitle, "Order meals.")
    assert.equal(swiggy.howToRedeem, "1. Open the app.\n2. Add the voucher.")
    assert.equal(swiggy.terms, "# Validity\n12 months.")
    assert.deepEqual(swiggy.rating, { value: 5, count: 132 })
    assert.equal(other.name, "other-card")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("prices on pages and in quotes: fresh while lookups are free, the last one we had when they're used up; made-up ids answer 404 for 3 a minute, then busy", async () => {
  const looked: Array<string> = []
  let price = "10.00"
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    // A search finds a card our catalog copy doesn't have; the copy itself can't be read, so it stays as saved below.
    if (url.pathname === "/v2/products/search") {
      return Response.json({ meta: {}, data: [{ id: "phone-pin", name: "Phone PIN", country_code: "US", currency: "USD", recipient_type: "none" }] })
    }
    if (url.pathname !== "/mcp") return new Response("", { status: 500 })
    const id: string = JSON.parse(String(init?.body)).params.arguments.product_id
    looked.push(id)
    // Bitrefill's words for a product it doesn't have.
    if (id.startsWith("made-up")) {
      return new Response(`data: ${JSON.stringify({ result: { isError: true, content: [{ text: `Product '${id}' was not found.` }] } })}\n`, { status: 200 })
    }
    return toolResult({ id, name: id, country_code: "US", currency: "USD", packages: [{ package_value: "10", payment_price: price, payment_currency: "USD" }] })
  }) as typeof fetch
  const cards = Array.from({ length: 12 }, (_, i) => `card-${i}`)
  try {
    const r = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const copy = Object.fromEntries(["amazon-us", ...cards].map((id) => [id, {}]))
        yield* sql`INSERT INTO settings (key, value, updated_by) VALUES ('card_logos', ${JSON.stringify(copy)}::jsonb, 'server')`
        const b = Context.get(yield* Layer.build(Bitrefill.layer), Bitrefill)
        const usd = (v: { packages: ReadonlyArray<{ priceMicroUsdc: number }> }) => v.packages[0]?.priceMicroUsdc
        // The card's page; a quote (what the customer confirms) asks without options, as Purchases does; then Buy.
        const page = (id: string) => b.voucher(id, { page: true }).pipe(Effect.map(usd))
        const quote = (id: string) => b.voucher(id).pipe(Effect.map(usd))
        const buy = (id: string) => b.voucher(id, { purchase: true }).pipe(Effect.map(usd))
        const refused = (id: string) => b.voucher(id, { page: true }).pipe(Effect.flip, Effect.map((e) => e.message))

        // Minute 0.
        const first = yield* page("amazon-us")
        // Made-up ids: Bitrefill is asked about 3 a minute, from their own budget (404); the rest are busy, unasked.
        const madeUp = yield* Effect.forEach([0, 1, 2, 3, 4], (i) => refused(`made-up-${i}`))
        // A card a search showed counts as listed, though the copy doesn't have it.
        yield* b.search("pin")
        const pin = yield* page("phone-pin")
        // So browsing still has all 12 of its lookups: amazon-us, phone-pin and ten more.
        for (const id of cards.slice(0, 10)) yield* page(id)
        // A card never priced can't be shown without a lookup...
        const cold = yield* refused("card-10")
        // ...but a purchase still gets its price: browsing can't use the last 8. A price from this minute is reused.
        const bought = yield* buy("card-10")
        yield* buy("card-0")
        yield* quote("amazon-us")
        const lookedFirst = [...looked]

        // Five minutes on, an ordinary minute, and Bitrefill's price has moved. The page still shows the one we had, with
        // no lookup; a quote and Buy each take one at most a minute old, as before.
        yield* TestClock.adjust("5 minutes")
        price = "10.50"
        const later = yield* page("amazon-us")
        const quoted = yield* quote("amazon-us")
        const repriced = yield* buy("card-0")
        const lookedOrdinary = looked.length

        // Eleven minutes in, a busy minute, and the price has gone up again. Open pages refresh their quotes: once
        // 8 have, the rest show the last price we had instead of failing...
        yield* TestClock.adjust("6 minutes")
        price = "11.00"
        for (const id of cards.slice(1, 9)) yield* quote(id)
        const staleQuote = yield* quote("card-9")
        // ...and so does a page whose price is past its 10 minutes...
        const stalePage = yield* page("phone-pin")
        // ...while a card never priced still loads: 4 of browsing's 12 are kept for first views.
        const firstView = yield* page("card-11")
        // Buy prices it live, and the next quote shows that price.
        const buying = yield* buy("card-9")
        const after = yield* quote("card-9")
        return { first, madeUp, pin, cold, bought, lookedFirst, later, quoted, repriced, lookedOrdinary, staleQuote, stalePage, firstView, buying, after }
      }).pipe(
        Effect.scoped,
        Effect.provide(DbMemory),
        Effect.provideService(FetchHttpClient.Fetch, (input, init) => globalThis.fetch(input, init)),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { NEAR_NETWORK: "mainnet", BITREFILL_API_KEY: "test-key" } }))),
        Effect.provide(TestClock.layer())
      )
    )
    assert.equal(r.first, 10_000_000)
    assert.deepEqual(r.madeUp.slice(0, 3), [NO_SUCH_VOUCHER, NO_SUCH_VOUCHER, NO_SUCH_VOUCHER], "Bitrefill doesn't have them: the page answers 404")
    assert.ok(r.madeUp.slice(3).every((m) => /busy/.test(m)), r.madeUp.join(" | "))
    assert.equal(r.lookedFirst.filter((id) => id.startsWith("made-up")).length, 3, "made-up ids never cost more than their own 3")
    assert.equal(r.pin, 10_000_000)
    assert.match(r.cold, /busy/)
    assert.equal(r.bought, 10_000_000)
    assert.equal(r.lookedFirst.length, 16, "amazon-us, 3 made-up, phone-pin, 10 cards, the new card's purchase")
    assert.equal(r.later, 10_000_000, "a page shows a price up to 10 minutes old")
    assert.equal(r.quoted, 10_500_000, "a quote takes a price at most a minute old while lookups are free")
    assert.equal(r.repriced, 10_500_000, "so does Buy")
    assert.equal(r.lookedOrdinary, 18)
    assert.equal(r.staleQuote, 10_000_000, "the last price, not an error")
    assert.equal(r.stalePage, 10_000_000)
    assert.equal(r.firstView, 11_000_000)
    assert.equal(r.buying, 11_000_000)
    assert.equal(r.after, 11_000_000)
    assert.equal(looked.length, 18 + 8 + 1 + 1, "the 8 refreshes, the first view, the purchase")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("a guest's cart is one order, every card also emailed to their Checkout Email as a gift", async () => {
  const sent: Array<Record<string, unknown>> = []
  await withGuestBitrefill(
    (_, args) => (sent.push(args), new Response("Bad Request", { status: 400 })),
    () => run((b) => b.order([{ id: "amazon-us", value: "10" }, { id: "swiggy-money-india", value: "50" }], { email: "alice+cards@example.com" }), guestEnv)
  )
  assert.equal(sent.length, 1, "one invoice for the whole cart")
  assert.equal(sent[0]!.email, "alice+cards@example.com")
  const gift = { recipient_email: "alice+cards@example.com", recipient_name: "alice+cards", sender_name: "Luckout" }
  assert.deepEqual(sent[0]!.cart_items, [
    { product_id: "amazon-us", package_value: "10", gift },
    { product_id: "swiggy-money-india", package_value: "50", gift }
  ])
})

test("each card's code is matched to its own order: by product and amount, in cart order, the same card twice in turn", async () => {
  const cards = [{ id: "swiggy-money-india", value: "50" }, { id: "amazon-fresh-india", value: "50" }, { id: "swiggy-money-india", value: "50" }]
  const order = (id: string, value: string, code?: string, status = "delivered") => ({
    order_id: `o-${code ?? status}`,
    status,
    product: { id, name: id, value, currency: "INR" },
    ...(code ? { redemption_info: { code } } : {})
  })
  // Bitrefill lists them in cart order; here they come back shuffled, and one was refunded.
  const found = await withGuestBitrefill(
    () => toolResult({ invoice_status: "complete", orders: [order("amazon-fresh-india", "50", "AMZ"), order("swiggy-money-india", "50", "SW1"), order("swiggy-money-india", "50", undefined, "refunded")] }),
    () => run((b) => b.delivery("inv-1", "token-1", cards), guestEnv)
  )
  assert.deepEqual(found.map((d) => (d._tag === "Delivered" ? d.redemption.code : d._tag)), ["SW1", "AMZ", "Failed"])
  // An order that names no product (REST) is taken by its place.
  const rest: Array<{ readonly n: number; readonly product?: undefined }> = [{ n: 1 }, { n: 2 }, { n: 3 }]
  assert.deepEqual(matchOrders(cards, rest).map((o) => o?.n), [1, 2, 3])
  // An order for a card nobody asked for is left alone: that card stays pending, for a human.
  assert.deepEqual(matchOrders([{ id: "a", value: "1" }], [{ product: { id: "b", value: "1" } }]), [undefined])
  // A card delivered in an earlier round takes the order it holds first, wherever Bitrefill lists it now, and the
  // other copy is matched among the orders left; one whose order isn't listed takes no other.
  const listed = [{ order_id: "o-2", product: { id: "swiggy-money-india", value: "50" } }, { order_id: "o-1", product: { id: "swiggy-money-india", value: "50" } }]
  const sw = { id: "swiggy-money-india", value: "50" }
  assert.deepEqual(matchOrders([{ ...sw, orderId: "o-1" }, sw], listed).map((o) => o?.order_id), ["o-1", "o-2"])
  assert.deepEqual(matchOrders([{ ...sw, orderId: "o-9" }, sw], listed).map((o) => o?.order_id), [undefined, "o-2"])
})

test("an order whose Redemption Data is null doesn't hold up the codes of the rest of its cart", async () => {
  const cards = [{ id: "amazon-us", value: "10" }, { id: "steam-usa", value: "20" }, { id: "netflix-us", value: "25" }]
  const found = await withGuestBitrefill(
    () =>
      toolResult({
        invoice_status: "complete",
        orders: [
          { order_id: "o-1", status: "delivered", product: { id: "amazon-us", value: "10" }, redemption_info: { code: "AMZ" } },
          { order_id: "o-2", status: "refunded", product: { id: "steam-usa", value: "20" }, redemption_info: null },
          { order_id: "o-3", status: "delivered", product: { id: "netflix-us", value: "25" }, redemption_info: { code: "NFX" } }
        ]
      }),
    () => run((b) => b.delivery("inv-1", "token-1", cards), guestEnv)
  )
  assert.deepEqual(found.map((d) => (d._tag === "Delivered" ? d.redemption.code : d._tag)), ["AMZ", "Failed", "NFX"])
})

test("a guest invoice is refused unless it asks for USDC on Base, to a well-formed address, a usable amount", async () => {
  const invoice = (payment: Record<string, unknown>) => () =>
    toolResult({
      response: {
        invoice_id: "inv-1",
        invoice_access_token: "token-1",
        payment_info: { address: `0x${"ab".repeat(20)}`, altBasePrice: 10_000_000, contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", ...payment }
      }
    })
  const order = (payment: Record<string, unknown>) =>
    withGuestBitrefill(invoice(payment), () => run((b) => b.order([{ id: "amazon-us", value: "10" }], { email: "alice@example.com" }), guestEnv))
  assert.deepEqual(await order({}), { _tag: "Invoiced", invoiceId: "inv-1", accessToken: "token-1", payTo: `0x${"ab".repeat(20)}`, amount: 10_000_000 })
  const refused = async (payment: Record<string, unknown>, why: RegExp) => {
    const o = await order(payment)
    assert.equal(o._tag, "Refused", JSON.stringify(payment))
    assert.match("reason" in o ? o.reason : "", why)
  }
  // USDC on another chain (Ethereum's), or another token on Base.
  await refused({ contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }, /not USDC on Base/)
  await refused({ address: "0x1234" }, /malformed address/)
  await refused({ address: `0x${"ab".repeat(20)} ` }, /malformed address/)
  await refused({ altBasePrice: 0 }, /no usable amount/)
  await refused({ altBasePrice: -5 }, /no usable amount/)
  await refused({ altBasePrice: 1.5 }, /no usable amount/)
  await refused({ altBasePrice: 2 ** 53 }, /no usable amount/)
})

test("a guest login Bitrefill stops taking (401) is renewed once and the call made again; a second 401 is a refusal", async () => {
  const logins: Array<string> = []
  const used: Array<string> = []
  let refuseAll = false
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/oauth/mcp/token")) {
      logins.push(`login-${logins.length + 1}`)
      return Response.json({ access_token: logins.at(-1), expires_in: 21_600 })
    }
    // Only the MCP calls: the catalog copy that starts with the service reads elsewhere.
    if (!String(url).endsWith("/mcp")) return new Response("Not Found", { status: 404 })
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? ""
    used.push(token)
    // The first login stops working (as when Bitrefill ends it early); the second works, until everything is refused.
    if (refuseAll || token === "login-1") return new Response("invalid_token", { status: 401 })
    return toolResult({ response: { invoice_id: "inv-1", invoice_access_token: "t", payment_info: { address: `0x${"ab".repeat(20)}`, altBasePrice: 1, contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" } } })
  }) as typeof fetch
  try {
    const r = await run((b) =>
      Effect.gen(function*() {
        const renewed = yield* b.order([{ id: "amazon-us", value: "10" }], { email: "alice@example.com" })
        const usedBefore = used.length
        refuseAll = true
        const refused = yield* b.order([{ id: "amazon-us", value: "10" }], { email: "alice@example.com" })
        return { renewed, refused, triesAfter: used.length - usedBefore }
      }), guestEnv)
    assert.equal(r.renewed._tag, "Invoiced")
    assert.deepEqual(used.slice(0, 2), ["login-1", "login-2"], "the same call, once more, on a fresh login")
    assert.equal(r.refused._tag, "Refused")
    assert.equal(r.triesAfter, 2, "renewed once, never in a loop")
    assert.deepEqual(logins, ["login-1", "login-2", "login-3"])
  } finally {
    globalThis.fetch = realFetch
  }
})

test("delivery polls from every guest purchase share one pace, leaving the login's other calls for orders", async () => {
  // The rule itself: never sooner than the gap after the last poll allowed, and at once when it has been quiet.
  assert.equal(nextGuestPoll(0, 1_000_000), 1_000_000)
  assert.equal(nextGuestPoll(1_000_000, 1_000_500), 1_000_000 + GUEST_POLL_GAP_MS)
  assert.ok(60_000 / GUEST_POLL_GAP_MS <= 20, "at most 20 of Bitrefill's 30 calls a minute")
  // Two cards on their way at once: the second is asked about one gap after the first.
  const polled: Array<number> = []
  const delivered = await withGuestBitrefill(
    (name) => {
      assert.equal(name, "get-invoice-by-id")
      polled.push(Date.now())
      return toolResult({ invoice_status: "complete", orders: [{ order_id: "o-1", status: "delivered", redemption_info: { code: "ABC-123" } }] })
    },
    () => run((b) => Effect.all([b.delivery("inv-1", "token-1", [{ id: "amazon-us", value: "10" }]), b.delivery("inv-2", "token-2", [{ id: "amazon-us", value: "10" }])], { concurrency: 2 }), guestEnv)
  )
  assert.deepEqual(delivered.map((d) => d[0]!._tag), ["Delivered", "Delivered"])
  assert.equal(polled.length, 2)
  assert.ok(polled[1]! - polled[0]! >= GUEST_POLL_GAP_MS - 100, `polled ${polled[1]! - polled[0]!} ms apart`)
})
