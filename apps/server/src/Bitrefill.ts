import { BitrefillUnavailable, CatalogPage, type Category, Voucher, VoucherSummary } from "@luckout/api"
import { decode as decodeToon } from "@toon-format/toon"
import { Cache, Config, Context, Data, Effect, Exit, flow, Layer, Option, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Network } from "./Near.ts"

// Our float is the USD store-credit sub-account (docs/research/bitrefill-funding.md).
// REST v2 only sees the primary sub-account (BTC), so real products are priced and
// bought through Bitrefill's MCP endpoint, which can target USD. MCP has no test
// products, so on testnet those stay on REST and are priced at face value.

const Product = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  country_code: Schema.String,
  country_name: Schema.optional(Schema.String),
  currency: Schema.String,
  /** The brand without its country: "Steam", "Amazon.de", "PlayStation Store". */
  base_name: Schema.optional(Schema.String),
  categories: Schema.optional(Schema.Array(Schema.String)),
  /** "none" for a code; "phone_number" or "account" for top-ups that need one, which we can't send. */
  recipient_type: Schema.optional(Schema.String),
  in_stock: Schema.optional(Schema.Boolean),
  image: Schema.optional(Schema.String),
  logo_background: Schema.optional(Schema.String),
  packages: Schema.optional(Schema.Array(Schema.Struct({ value: Schema.String, amount: Schema.optional(Schema.Number) })))
})
const Balances = Schema.Struct({
  balances: Schema.Array(Schema.Struct({ payment_method: Schema.String, balance_currency: Schema.String, amount: Schema.String })),
  /** How much more each sub-account may take before Bitrefill holds a deposit for review. */
  top_up: Schema.optional(Schema.Array(Schema.Struct({
    currency: Schema.String,
    max_amount: Schema.optional(Schema.Struct({ amount: Schema.String, currency: Schema.String }))
  })))
})
const Deposit = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  payment: Schema.Struct({
    method: Schema.String,
    address: Schema.String,
    currency: Schema.String,
    /** Base units of `currency`. */
    price: Schema.Number,
    commission: Schema.optional(Schema.Number)
  })
})
const InvoiceState = Schema.Struct({ id: Schema.String, status: Schema.String })

const McpProduct = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  country_code: Schema.String,
  currency: Schema.String,
  packages: Schema.Array(Schema.Struct({
    package_value: Schema.String,
    payment_price: Schema.String,
    payment_currency: Schema.Literal("USD")
  }))
})
const McpPurchase = Schema.Struct({ response: Schema.Struct({ invoice_id: Schema.String }) })
const Invoice = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  orders: Schema.Array(Schema.Struct({
    id: Schema.String,
    redemption_info: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
  }))
})
const data = <A, I>(s: Schema.Codec<A, I>) => Schema.Struct({ data: s })

/** Redemption Data exactly as Bitrefill sends it (code, link, pin, instructions…). */
export type Redemption = Readonly<Record<string, unknown>>

export type Delivery =
  | { readonly _tag: "Delivered"; readonly invoiceId: string; readonly orderId: string; readonly redemption: Redemption }
  /** Bitrefill definitely did not deliver, so the purchase can be failed and refunded. */
  | { readonly _tag: "Failed"; readonly reason: string }

export type Order =
  | { readonly _tag: "Ordered"; readonly invoiceId: string }
  /** Our USD credit can't cover it; nothing was created or paid, so it can be ordered again later. */
  | { readonly _tag: "NoCredit"; readonly reason: string }
  /** Bitrefill refused before creating or paying anything. */
  | { readonly _tag: "Refused"; readonly reason: string }

/** A USD credit deposit: sending exactly `price` (USDC base units) to `address` on Base buys `amount` of credit. */
export interface CreditDeposit {
  readonly invoiceId: string
  readonly address: string
  readonly price: number
}
/** Where a credit deposit is. "failed" means Bitrefill gave up on it after we may have paid: a human must look. */
export type DepositState = "pending" | "credited" | "failed"

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
/** Bitrefill's words for a balance that can't cover an order. */
const NO_CREDIT = /balance|insufficient|not enough|top ?up/i

/** Bitrefill refused before creating or paying anything (e.g. balance too low). */
class Rejected extends Data.TaggedError("Rejected")<{ readonly reason: string }> {}
// Only codes that mean "rejected before anything was paid" count as a refusal. Anything else,
// including codes we haven't seen, is an unknown outcome left to the reconciler: guessing
// "not paid" would refund the customer for a voucher we may already have paid for.
const REFUSED_BEFORE_PAYMENT = new Set(["INVALID_INPUT", "PRODUCT_NOT_FOUND", "NOT_FOUND", "OUT_OF_STOCK"])
// HTTP statuses that mean the MCP endpoint turned the request away without running the tool.
const REFUSED_STATUS = new Set([400, 401, 403, 404, 429])
const httpStatus = (e: unknown) => (HttpClientError.isHttpClientError(e) ? e.response?.status ?? 0 : 0)

// MCP allows 30 calls a minute per key, shared by price lookups and buys. Lookups get at most
// 20 of them, and browsing (catalog pages, quotes) at most 12, so junk lookups can never starve a
// customer's purchase or its price check.
const LOOKUPS_PER_MINUTE = 20
const BROWSE_LOOKUPS_PER_MINUTE = 12
/** What a customer chose to filter the catalog by; nothing chosen lists everything. */
export interface BrowseOptions {
  readonly q?: string | undefined
  readonly country?: string | undefined
  readonly category?: Category | undefined
  readonly start?: number | undefined
}

/**
 * Bitrefill's categories behind each of the shop's. Bitrefill refuses a whole request naming one it
 * doesn't know (music, pizza, voucher and other aren't), so only names checked against its API go here.
 */
const CATEGORY_MAP: Record<Category, ReadonlyArray<string>> = {
  shopping: ["online-marketplaces", "department-stores", "ecommerce", "retail", "apparel", "electronics", "home", "health-beauty", "cosmetics", "sports-n-outdoors", "gifts", "multi-brand"],
  food: ["food", "restaurants", "groceries", "food-delivery"],
  games: ["games", "game-stores"],
  entertainment: ["entertainment", "streaming", "experiences"],
  travel: ["travel", "accommodation", "flights", "online-travel-agencies", "cruises", "transportation"]
}
/** EU members: Bitrefill's Europe-wide cards ("EU") work in each of them too. */
const EU_MEMBERS = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split(" "))
/** Whose cards work in a country: its own, Europe-wide ones in an EU member, and worldwide ones ("XI"). */
export const regionsFor = (country: string) => [country, ...(EU_MEMBERS.has(country) ? ["EU"] : []), "XI"]

/** "All" is every gift card: these plus the rest, but not phone credit (pin, refill, data), which would fill the first pages. */
const ALL_GIFT_CARDS = [...Object.values(CATEGORY_MAP).flat(), "pets", "pharmacy", "payment-cards"]
/** Bitrefill's page size, and the fewest cards a catalog page tries to return after filtering. */
const PAGE = 50
const MIN_PAGE_ITEMS = 12

/**
 * The brands customers look for first, most wanted first. Bitrefill has no popularity data, so this list
 * is ours. Each pattern matches Bitrefill's brand name (`base_name`), leaving out look-alikes (Applebee's,
 * Steamrex), subscriptions, Uber's vouchers in another country's currency, and Riot's Latin America cards,
 * which Bitrefill marks worldwide. A country gets whichever of these Bitrefill sells there.
 */
const POPULAR_BRANDS: ReadonlyArray<RegExp> = [
  // Known everywhere.
  /^amazon(\.[a-z.]+)?$/i,
  /^steam( usd)?$/i,
  /^(apple( itunes| sa)?|app store & itunes( uae)?)$/i,
  /^google play\b/i,
  /^(sony )?playstation( store)?$/i,
  /^xbox( live)?$/i,
  /^netflix\b/i,
  /^uber( eats| money [a-z]{3})?$/i,
  /^airbnb\b/i,
  // Each country's own favourites.
  /^flipkart\b/i, /^swiggy\b/i, /^zomato\b/i, /^myntra\b/i, /^bigbasket\b/i, /^makemytrip\b/i,
  /^tesco\b/i, /^argos\b/i, /^deliveroo\b/i, /^just eat\b/i,
  /^zalando\b/i, /^media ?markt\b/i, /^lieferando\b/i,
  /^target\b/i, /^best buy\b/i, /^tim hortons\b/i, /^woolworths\b/i, /^coles\b/i,
  /^shopee\b/i, /^grab/i, /^carrefour\b/i, /^ikea\b/i,
  // Then games and other brands people know.
  /^nintendo eshop\b/i, /^roblox\b/i, /^valorant\b(?!.*latam)/i, /^league of legends\b(?!.*latam)/i, /^fortnite\b/i,
  /^minecraft\b/i, /^pubg\b/i, /^razer gold\b/i,
  /^starbucks\b/i, /^hotels\.com\b/i, /^nike\b/i, /^adidas\b/i, /^sephora\b/i, /^decathlon\b/i, /^disney\b/i
]
const POPULAR_LIMIT = 12

interface Branded {
  readonly name: string
  readonly base_name?: string | undefined
  readonly country_code: string
  readonly categories?: ReadonlyArray<string> | undefined
}
/** Gift cards grouped by popular brand, in POPULAR_BRANDS order. */
export const popularBrands = <P extends Branded>(cards: ReadonlyArray<P>) =>
  POPULAR_BRANDS.map((brand) => cards.filter((p) => brand.test(p.base_name ?? p.name)))

/**
 * Up to 12 popular cards, one per brand: the country's own card, else a Europe-wide one in an EU member,
 * else a worldwide one (as regionsFor). With no country, worldwide cards only.
 */
export const pickPopular = <P extends Branded>(brands: ReadonlyArray<ReadonlyArray<P>>, country?: string, category?: Category) => {
  const regions = country ? regionsFor(country) : ["XI"]
  const cats = category ? CATEGORY_MAP[category] : undefined
  const picks: Array<P> = []
  for (const brand of brands) {
    const cards = cats ? brand.filter((p) => (p.categories ?? []).some((c) => cats.includes(c))) : brand
    const pick = regions.map((r) => cards.find((p) => p.country_code === r)).find((p) => p !== undefined)
    if (pick) picks.push(pick)
    if (picks.length === POPULAR_LIMIT) break
  }
  return picks
}

/** Only cards delivered as a code can be bought here: top-ups need a phone number or account we can't send. */
const sellable = (p: { recipient_type?: string | undefined; in_stock?: boolean | undefined }) =>
  (p.recipient_type ?? "none") === "none" && p.in_stock !== false

/** What a Bitrefill product id looks like; anything else is refused before spending a lookup. */
const PRODUCT_ID = /^[a-z0-9][a-z0-9-]{0,99}$/

/** "5.53" → 5_530_000, with no floating point (ADR-0004). */
export const usdToMicro = (usd: string): number => {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(usd)
  if (!m) throw new Error(`Not a USD amount: ${usd}`)
  return Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"))
}

/** The contract refuses purchases under 0.5 USDC (MIN_REFERENCE_PRICE), so smaller amounts are never offered. */
export const MIN_PRICE = 500_000
export const forSale = <P extends { priceMicroUsdc: number }>(packages: ReadonlyArray<P>) => packages.filter((p) => p.priceMicroUsdc >= MIN_PRICE)
/** Amounts Bitrefill sells that Luckout can't, because they're under the minimum. */
export const tooSmall = <P extends { priceMicroUsdc: number }>(packages: ReadonlyArray<P>) => packages.filter((p) => p.priceMicroUsdc < MIN_PRICE)

export class Bitrefill extends Context.Service<Bitrefill, {
  search(q: string): Effect.Effect<ReadonlyArray<VoucherSummary>, BitrefillUnavailable>
  /** The catalog a page at a time, filtered only by what the customer chose. */
  browse(opts: BrowseOptions): Effect.Effect<CatalogPage, BitrefillUnavailable>
  /** Up to 12 popular cards that work in `country` (see pickPopular); none on testnet or before the first catalog copy. */
  popular(country?: string, category?: Category): Effect.Effect<ReadonlyArray<VoucherSummary>>
  /**
   * Packages with their current USD price, the Reference Price. `purchase`: a customer is buying, so
   * the lookup may use the whole budget, not just browsing's share.
   */
  voucher(id: string, options?: { readonly purchase?: boolean }): Effect.Effect<Voucher, BitrefillUnavailable>
  /** Places a paid order from the USD balance. Save the invoice id before awaiting delivery. */
  order(id: string, value: string): Effect.Effect<Order, BitrefillUnavailable>
  /** Polls an invoice for up to ~1 minute; still pending is an error (unknown, not failed). */
  delivery(invoiceId: string): Effect.Effect<Delivery, BitrefillUnavailable>
  /** Our USD store credit, and how much more Bitrefill lets us hold (micro-USDC). */
  readonly credit: Effect.Effect<{ readonly balance: number; readonly room: number }, BitrefillUnavailable>
  /** Asks for `amount` (micro-USDC, whole cents) of USD credit, paid 1:1 in USDC on Base. */
  deposit(amount: number): Effect.Effect<CreditDeposit, BitrefillUnavailable>
  depositState(invoiceId: string): Effect.Effect<{ readonly state: DepositState; readonly status: string }, BitrefillUnavailable>
}>()("luckout/Bitrefill") {
  static readonly layer = Layer.effect(
    Bitrefill,
    Effect.gen(function*() {
      const apiKey = yield* Config.option(Config.Redacted("BITREFILL_API_KEY"))
      const restUrl = yield* Config.String("BITREFILL_API_URL").pipe(Config.withDefault("https://api.bitrefill.com/v2"))
      const testnet = (yield* Network) === "testnet"
      const isTest = (id: string) => testnet && id.startsWith("test-")

      const base = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(Option.isSome(apiKey) ? HttpClientRequest.bearerToken(apiKey.value) : (r) => r),
        HttpClient.filterStatusOk
      )
      const rest = base.pipe(
        HttpClient.mapRequest(flow(HttpClientRequest.prependUrl(restUrl), HttpClientRequest.acceptJson)),
        HttpClient.timeout("15 seconds")
      )
      // A timed-out buy is an unknown outcome (left to the reconciler), so this one is generous.
      const mcpClient = base.pipe(HttpClient.timeout("45 seconds"))
      const mcpUrl = new URL("/mcp", restUrl).href
      // Only reads are retried: retrying a purchase could buy twice.
      const retry = <A, E>(self: Effect.Effect<A, E>) => Effect.retry(self, { schedule: Schedule.exponential(200), times: 3 })

      const unavailable = (cause: unknown) =>
        new BitrefillUnavailable({
          message: Option.isNone(apiKey) ? "BITREFILL_API_KEY is not set" : `Bitrefill request failed: ${cause}`
        })

      const get = <A, I>(path: string, schema: Schema.Codec<A, I>, urlParams?: Record<string, string>) =>
        rest.get(path, urlParams ? { urlParams } : undefined).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(data(schema))),
          Effect.map((r) => r.data),
          retry,
          Effect.mapError(unavailable)
        )

      // MCP tools reply over SSE with one text result: JSON for buy-products, TOON for the rest.
      const mcp = <A, I>(name: string, args: object, schema: Schema.Codec<A, I>) =>
        HttpClientRequest.post(mcpUrl).pipe(
          HttpClientRequest.setHeader("Accept", "application/json, text/event-stream"),
          HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
          mcpClient.execute,
          Effect.flatMap((r) => r.text),
          Effect.mapError((e) => (REFUSED_STATUS.has(httpStatus(e)) ? new Rejected({ reason: `HTTP ${httpStatus(e)}` }) : unavailable(e))),
          Effect.flatMap((body) =>
            Effect.try({
              try: () => {
                const line = body.split("\n").find((l) => l.startsWith("data: ")) ?? body
                const { result, error } = JSON.parse(line.replace(/^data: /, ""))
                const text: string = result?.content?.[0]?.text ?? ""
                const parse = () => (text.trimStart().startsWith("{") ? JSON.parse(text) : decodeToon(text))
                if (error) throw new Error(`${name}: ${error.message}`)
                if (result?.isError) {
                  // Tool errors read like `error: Balance too low / code: INVALID_INPUT`.
                  const e = (() => { try { return parse() } catch { return {} } })() as { error?: string; code?: string }
                  if (e.code && REFUSED_BEFORE_PAYMENT.has(e.code)) throw new Rejected({ reason: `${e.error ?? text} (${e.code})` })
                  throw new Error(`${name}: ${text}`)
                }
                return parse()
              },
              catch: (e) => (e instanceof Rejected ? e : unavailable(e))
            })
          ),
          Effect.flatMap((u) => Schema.decodeUnknownEffect(schema)(u).pipe(Effect.mapError(unavailable)))
        )

      const images = (p: { image?: string | undefined; logo_background?: string | undefined }) => ({
        ...(p.image ? { image: p.image } : {}),
        ...(p.logo_background ? { background: p.logo_background } : {})
      })

      const summary = (p: typeof Product.Type) =>
        new VoucherSummary({
          id: p.id,
          name: p.name,
          countryCode: p.country_code,
          ...(p.country_name ? { countryName: p.country_name } : {}),
          currency: p.currency,
          ...images(p)
        })
      // On testnet only test products can be bought, so nothing else is offered (web or bot).
      const offered = (p: typeof Product.Type) => (testnet ? p.id.startsWith("test-") : sellable(p))

      const search = Effect.fn("Bitrefill.search")(function*(q: string) {
        const products = yield* get("/products/search", Schema.Array(Product), { q, include_test_products: String(testnet) })
        return products.filter(offered).map(summary)
      })

      const browsePage = Effect.fn("Bitrefill.browse")(function*(opts: BrowseOptions) {
        const q = opts.q?.trim()
        // A country shows the cards that work there (regionsFor); nothing else is assumed.
        const regions = opts.country ? regionsFor(opts.country) : undefined
        const inCountry = (p: typeof Product.Type) => !regions || regions.includes(p.country_code)
        const cats = opts.category ? CATEGORY_MAP[opts.category] : undefined
        const inCategory = (p: typeof Product.Type) => !cats || (p.categories ?? []).some((c) => cats.includes(c))
        // Testnet sells only a handful of test cards: one search finds them all.
        if (testnet) return new CatalogPage({ items: (yield* search(q || "test")) })
        const items: Array<VoucherSummary> = []
        let start = opts.start ?? 0
        let next: number | undefined
        // Filtering drops top-ups, so a thin page is topped up from the next one or two.
        for (let i = 0; i < 3 && items.length < MIN_PAGE_ITEMS; i++) {
          const params: Record<string, string> = { start: String(start), limit: String(PAGE) }
          const products = yield* (q
            ? get("/products/search", Schema.Array(Product), { ...params, q })
            : get("/products", Schema.Array(Product), {
              ...params,
              ...(regions ? { country: regions.join(",") } : {}),
              category: (cats ?? ALL_GIFT_CARDS).join(",")
            }))
          // Search can't filter by country or category itself, so those are applied here.
          items.push(...products.filter((p) => offered(p) && inCountry(p) && inCategory(p)).map(summary))
          next = products.length === PAGE ? start + PAGE : undefined
          if (next === undefined) break
          start = next
        }
        return new CatalogPage({ items, ...(next !== undefined ? { next } : {}) })
      })
      // Pages are cached for 10 minutes: browsing must not use up Bitrefill's product quota.
      const browseCache = yield* Cache.makeWith((key: string) => browsePage(JSON.parse(key) as BrowseOptions), {
        capacity: 500,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? "10 minutes" : "10 seconds")
      })
      const browse = (opts: BrowseOptions) =>
        Cache.get(browseCache, JSON.stringify({ q: opts.q?.trim().toLowerCase() || undefined, country: opts.country, category: opts.category, start: opts.start ?? 0 }))

      // Popular cards come from our own copy of the gift-card catalog (about 100 pages), refreshed twice a
      // day instead of read on every visit. Testnet sells only test cards, so it has none.
      let brands: ReadonlyArray<ReadonlyArray<typeof Product.Type>> = []
      const copyCatalog = Effect.gen(function*() {
        const cards: Array<typeof Product.Type> = []
        for (let start = 0;; start += PAGE) {
          const page = yield* get("/products", Schema.Array(Product), { start: String(start), limit: String(PAGE), category: ALL_GIFT_CARDS.join(",") })
          cards.push(...page.filter(sellable))
          if (page.length < PAGE) break
        }
        brands = popularBrands(cards)
      })
      if (!testnet && Option.isSome(apiKey)) {
        yield* copyCatalog.pipe(
          Effect.tapCause((cause) => Effect.logWarning("copying Bitrefill's catalog for popular cards failed", cause)),
          Effect.retry({ schedule: Schedule.spaced("5 minutes") }),
          Effect.repeat(Schedule.spaced("12 hours")),
          Effect.forkScoped
        )
      }
      const popular = (country?: string, category?: Category) => Effect.sync(() => pickPopular(brands, country, category).map(summary))

      // ponytail: fixed one-minute window in memory, one process.
      let budget = { used: 0, resetAt: 0 }
      const spendLookup = (limit: number) =>
        Effect.suspend(() => {
          const now = Date.now()
          if (budget.resetAt < now) budget = { used: 0, resetAt: now + 60_000 }
          if (budget.used >= limit) return Effect.fail(new BitrefillUnavailable({ message: "Prices are busy right now; try again in a minute" }))
          budget.used++
          return Effect.void
        })
      const lookup = (id: string, limit: number) =>
        spendLookup(limit).pipe(
          Effect.andThen(mcp("get-product-details", { product_id: id, currency: "USD" }, McpProduct)),
          Effect.mapError((e) => (e._tag === "Rejected" ? unavailable(e.reason) : e))
        )

      // Prices are cached for a minute; failures only briefly, so a busy minute doesn't stick.
      const mcpPrices = yield* Cache.makeWith((id: string) => lookup(id, BROWSE_LOOKUPS_PER_MINUTE), {
        capacity: 1_000,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? "1 minute" : "5 seconds")
      })
      // A purchase takes a cached price if there is one, and otherwise looks it up on the whole budget:
      // a browsing failure cached for this id never blocks it.
      const purchasePrice = (id: string) =>
        Effect.flatMap(Cache.getSuccess(mcpPrices, id), (cached) =>
          Option.isSome(cached)
            ? Effect.succeed(cached.value)
            : Effect.tap(lookup(id, LOOKUPS_PER_MINUTE), (p) => Cache.set(mcpPrices, id, p)))

      const voucher = Effect.fn("Bitrefill.voucher")(function*(id: string, options?: { readonly purchase?: boolean }) {
        // Refused before anything is spent, so junk ids can't use up the lookups.
        if (!PRODUCT_ID.test(id)) return yield* new BitrefillUnavailable({ message: "No such voucher" })
        if (testnet && !isTest(id)) {
          return yield* new BitrefillUnavailable({ message: "This is the testnet demo: only Bitrefill's test cards can be bought here." })
        }
        if (isTest(id)) {
          const p = yield* get(`/products/${encodeURIComponent(id)}`, Product)
          return new Voucher({
            id: p.id,
            name: p.name,
            countryCode: p.country_code,
            currency: p.currency,
            ...images(p),
            // Test products are free on Bitrefill; price them at their USD face value.
            packages: forSale((p.packages ?? []).flatMap((pkg) =>
              pkg.amount === undefined ? [] : [{ value: pkg.value, priceMicroUsdc: Math.round(pkg.amount * 1_000_000) }]
            ))
          })
        }
        const p = yield* (options?.purchase ? purchasePrice(id) : Cache.get(mcpPrices, id))
        const all = p.packages.map((pkg) => ({ value: pkg.package_value, priceMicroUsdc: usdToMicro(pkg.payment_price) }))
        return new Voucher({
          id: p.id,
          name: p.name,
          countryCode: p.country_code,
          currency: p.currency,
          packages: forSale(all),
          tooSmall: tooSmall(all)
        })
      })

      const createInvoice = (id: string, value: string) =>
        isTest(id)
          ? HttpClientRequest.post("/invoices").pipe(
            HttpClientRequest.bodyJsonUnsafe({
              products: [{ product_id: id, package_id: `${id}<&>${value}`, quantity: 1 }],
              payment_method: "balance",
              auto_pay: true
            }),
            rest.execute,
            Effect.flatMap(HttpClientResponse.schemaBodyJson(data(Invoice))),
            Effect.map((r) => r.data.id),
            Effect.mapError((e) => {
              // A 4xx (e.g. 403 not_available) means no invoice was created.
              const status = httpStatus(e)
              return status >= 400 && status < 500 ? new Rejected({ reason: `HTTP ${status}` }) : unavailable(e)
            })
          )
          : mcp("buy-products", {
            cart_items: [{ product_id: id, package_value: value }],
            payment_method: "balance",
            balance_currency: "USD"
          }, McpPurchase).pipe(Effect.map((r) => r.response.invoice_id))

      const order = Effect.fn("Bitrefill.order")(function*(id: string, value: string) {
        return yield* createInvoice(id, value).pipe(
          Effect.map((invoiceId): Order => ({ _tag: "Ordered", invoiceId })),
          Effect.catchTag("Rejected", (e) =>
            Effect.succeed<Order>(NO_CREDIT.test(e.reason) ? { _tag: "NoCredit", reason: e.reason } : { _tag: "Refused", reason: e.reason }))
        )
      })

      const delivery = Effect.fn("Bitrefill.delivery")(function*(invoiceId: string) {
        // Delivery normally takes well under a second; poll for up to ~1 minute.
        const invoice = yield* get(`/invoices/${invoiceId}`, Invoice).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (i) => i.status !== "not_delivered",
            times: 60
          })
        )
        const o = invoice.orders[0]
        if (invoice.status === "all_delivered" && o?.redemption_info) {
          return { _tag: "Delivered", invoiceId, orderId: o.id, redemption: o.redemption_info } as const
        }
        if (invoice.status === "all_error") return { _tag: "Failed", reason: `invoice ${invoiceId} is all_error` } as const
        return yield* Effect.fail(unavailable(`invoice ${invoiceId} is still ${invoice.status}`))
      })

      // Only MCP sees the USD sub-account; REST reports the primary (BTC) one.
      const credit = mcp("get-balances", {}, Balances).pipe(
        Effect.mapError((e) => (e instanceof BitrefillUnavailable ? e : unavailable(e.reason))),
        Effect.flatMap((r) =>
          Effect.try({
            try: () => {
              const usd = r.balances.find((b) => b.payment_method === "balance" && b.balance_currency === "USD")
              const room = r.top_up?.find((t) => t.currency === "USD")?.max_amount
              return {
                balance: usdToMicro(usd?.amount ?? "0"),
                // Without a reported room, assume Bitrefill's usual $2,000 limit on what the account holds.
                room: room?.currency === "USD" ? usdToMicro(room.amount) : Math.max(0, 2_000_000_000 - usdToMicro(usd?.amount ?? "0"))
              }
            },
            catch: (e) => unavailable(`unreadable balances: ${e}`)
          })
        )
      )

      // Never retried: each call creates an invoice. An unpaid one simply expires.
      const deposit = Effect.fn("Bitrefill.deposit")(function*(amount: number) {
        if (!Number.isInteger(amount) || amount <= 0 || amount % 10_000 !== 0) {
          return yield* unavailable(`a credit deposit must be whole cents, not ${amount}`)
        }
        const d = yield* HttpClientRequest.post("/accounts/deposit").pipe(
          HttpClientRequest.bodyJsonUnsafe({ currency: "USD", payment_method: "usdc_base", amount: amount / 1_000_000 }),
          rest.execute,
          // The response echoes the account's email; it's decoded here and never logged.
          Effect.flatMap(HttpClientResponse.schemaBodyJson(data(Deposit))),
          Effect.map((r) => r.data),
          Effect.mapError(unavailable)
        )
        // Pay only what buys exactly this much credit, in USDC on Base, to a well-formed address.
        if (d.payment.method !== "usdc_base" || d.payment.currency !== "USDC") {
          return yield* unavailable(`deposit ${d.id} wants ${d.payment.method}/${d.payment.currency}, not USDC on Base`)
        }
        if (d.payment.price !== amount || (d.payment.commission ?? 0) !== 0) {
          return yield* unavailable(`deposit ${d.id} costs ${d.payment.price} for ${amount} of credit; refusing to pay more than 1:1`)
        }
        if (!EVM_ADDRESS.test(d.payment.address)) return yield* unavailable(`deposit ${d.id} has a malformed address`)
        return { invoiceId: d.id, address: d.payment.address, price: d.payment.price }
      })

      const depositState = (invoiceId: string) =>
        get(`/invoices/${encodeURIComponent(invoiceId)}`, InvoiceState).pipe(
          Effect.map((i) => ({
            status: i.status,
            state: (["all_delivered", "complete", "delivered"].includes(i.status)
              ? "credited"
              : ["all_error", "payment_error", "refunded"].includes(i.status)
              ? "failed"
              : "pending") as DepositState
          }))
        )

      return Bitrefill.of({ search, browse, popular, voucher, order, delivery, credit, deposit, depositState })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
}
