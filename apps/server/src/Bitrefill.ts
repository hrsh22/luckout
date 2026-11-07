import { BitrefillUnavailable, Voucher, VoucherSummary } from "@luckout/api"
import { decode as decodeToon } from "@toon-format/toon"
import { Cache, Config, Context, Data, Effect, flow, Layer, Option, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"

// Our float is the USD store-credit sub-account (docs/research/bitrefill-funding.md).
// REST v2 only sees the primary sub-account (BTC), so real products are priced and
// bought through Bitrefill's MCP endpoint, which can target USD. MCP has no test
// products, so on testnet those stay on REST and are priced at face value.

const Product = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  country_code: Schema.String,
  currency: Schema.String,
  packages: Schema.optional(Schema.Array(Schema.Struct({ value: Schema.String, amount: Schema.optional(Schema.Number) })))
})
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
  /** Bitrefill refused before creating or paying anything (e.g. balance too low). */
  | { readonly _tag: "Refused"; readonly reason: string }

/** Bitrefill refused before creating or paying anything (e.g. balance too low). */
class Rejected extends Data.TaggedError("Rejected")<{ readonly reason: string }> {}
// Only codes that mean "rejected before anything was paid" count as a refusal. Anything else,
// including codes we haven't seen, is an unknown outcome left to the reconciler: guessing
// "not paid" would refund the customer for a voucher we may already have paid for.
const REFUSED_BEFORE_PAYMENT = new Set(["INVALID_INPUT", "PRODUCT_NOT_FOUND", "NOT_FOUND", "OUT_OF_STOCK"])

/** "5.53" → 5_530_000, with no floating point (ADR-0004). */
export const usdToMicro = (usd: string): number => {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(usd)
  if (!m) throw new Error(`Not a USD amount: ${usd}`)
  return Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"))
}

export class Bitrefill extends Context.Service<Bitrefill, {
  search(q: string): Effect.Effect<ReadonlyArray<VoucherSummary>, BitrefillUnavailable>
  /** Packages with their current USD price, the Reference Price. */
  voucher(id: string): Effect.Effect<Voucher, BitrefillUnavailable>
  /** Places a paid order from the USD balance. Save the invoice id before awaiting delivery. */
  order(id: string, value: string): Effect.Effect<Order, BitrefillUnavailable>
  /** Polls an invoice for up to ~1 minute; still pending is an error (unknown, not failed). */
  delivery(invoiceId: string): Effect.Effect<Delivery, BitrefillUnavailable>
}>()("luckout/Bitrefill") {
  static readonly layer = Layer.effect(
    Bitrefill,
    Effect.gen(function*() {
      const apiKey = yield* Config.option(Config.Redacted("BITREFILL_API_KEY"))
      const restUrl = yield* Config.String("BITREFILL_API_URL").pipe(Config.withDefault("https://api.bitrefill.com/v2"))
      const testnet = (yield* Config.String("NEAR_NETWORK").pipe(Config.withDefault("testnet"))) === "testnet"
      const isTest = (id: string) => testnet && id.startsWith("test-")

      const base = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(Option.isSome(apiKey) ? HttpClientRequest.bearerToken(apiKey.value) : (r) => r),
        HttpClient.filterStatusOk
      )
      const rest = base.pipe(HttpClient.mapRequest(flow(HttpClientRequest.prependUrl(restUrl), HttpClientRequest.acceptJson)))
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
          base.execute,
          Effect.flatMap((r) => r.text),
          Effect.mapError(unavailable),
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

      const search = Effect.fn("Bitrefill.search")(function*(q: string) {
        const products = yield* get("/products/search", Schema.Array(Product), { q, include_test_products: String(testnet) })
        return products.map((p) => new VoucherSummary({ id: p.id, name: p.name, countryCode: p.country_code, currency: p.currency }))
      })

      // MCP allows 30 calls a minute per key, so prices are cached for a minute.
      const mcpPrices = yield* Cache.make({
        lookup: (id: string) =>
          mcp("get-product-details", { product_id: id, currency: "USD" }, McpProduct).pipe(
            Effect.mapError((e) => (e._tag === "Rejected" ? unavailable(e.reason) : e)),
            retry
          ),
        capacity: 1_000,
        timeToLive: "1 minute"
      })

      const voucher = Effect.fn("Bitrefill.voucher")(function*(id: string) {
        if (isTest(id)) {
          const p = yield* get(`/products/${encodeURIComponent(id)}`, Product)
          return new Voucher({
            id: p.id,
            name: p.name,
            countryCode: p.country_code,
            currency: p.currency,
            // Test products are free on Bitrefill; price them at their USD face value.
            packages: (p.packages ?? []).flatMap((pkg) =>
              pkg.amount === undefined ? [] : [{ value: pkg.value, priceMicroUsdc: Math.round(pkg.amount * 1_000_000) }]
            )
          })
        }
        const p = yield* Cache.get(mcpPrices, id)
        return new Voucher({
          id: p.id,
          name: p.name,
          countryCode: p.country_code,
          currency: p.currency,
          packages: p.packages.map((pkg) => ({ value: pkg.package_value, priceMicroUsdc: usdToMicro(pkg.payment_price) }))
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
              const status = HttpClientError.isHttpClientError(e) ? e.response?.status ?? 0 : 0
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
          Effect.catchTag("Rejected", (e) => Effect.succeed<Order>({ _tag: "Refused", reason: e.reason }))
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

      return Bitrefill.of({ search, voucher, order, delivery })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
}
