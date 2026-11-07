import { BitrefillUnavailable, Voucher, VoucherSummary } from "@luckout/api"
import { decode as decodeToon } from "@toon-format/toon"
import { Config, Context, Effect, flow, Layer, Option, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

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
  | { readonly _tag: "Failed"; readonly invoiceId: string; readonly status: string }

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
  /** Buys one package from the USD balance and waits for the outcome. */
  buy(id: string, value: string): Effect.Effect<Delivery, BitrefillUnavailable>
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
          Effect.flatMap((body) =>
            Effect.try(() => {
              const line = body.split("\n").find((l) => l.startsWith("data: ")) ?? body
              const { result, error } = JSON.parse(line.replace(/^data: /, ""))
              const text: string = result?.content?.[0]?.text ?? ""
              if (error || result?.isError) throw new Error(`${name}: ${error?.message ?? text}`)
              return text.trimStart().startsWith("{") ? JSON.parse(text) : decodeToon(text)
            })
          ),
          Effect.flatMap(Schema.decodeUnknownEffect(schema)),
          Effect.mapError(unavailable)
        )

      const search = Effect.fn("Bitrefill.search")(function*(q: string) {
        const products = yield* get("/products/search", Schema.Array(Product), { q, include_test_products: String(testnet) })
        return products.map((p) => new VoucherSummary({ id: p.id, name: p.name, countryCode: p.country_code, currency: p.currency }))
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
        const p = yield* mcp("get-product-details", { product_id: id, currency: "USD" }, McpProduct).pipe(retry)
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
            Effect.mapError(unavailable)
          )
          : mcp("buy-products", {
            cart_items: [{ product_id: id, package_value: value }],
            payment_method: "balance",
            balance_currency: "USD"
          }, McpPurchase).pipe(Effect.map((r) => r.response.invoice_id))

      const buy = Effect.fn("Bitrefill.buy")(function*(id: string, value: string) {
        const invoiceId = yield* createInvoice(id, value)
        // Delivery normally takes well under a second; poll for up to ~1 minute.
        // Still pending after that = unknown, left to the reconciler (never "failed").
        const invoice = yield* get(`/invoices/${invoiceId}`, Invoice).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (i) => i.status !== "not_delivered",
            times: 60
          })
        )
        const order = invoice.orders[0]
        if (invoice.status === "all_delivered" && order?.redemption_info) {
          return { _tag: "Delivered", invoiceId, orderId: order.id, redemption: order.redemption_info } as const
        }
        if (invoice.status === "all_error") return { _tag: "Failed", invoiceId, status: invoice.status } as const
        return yield* Effect.fail(unavailable(`invoice ${invoiceId} is still ${invoice.status}`))
      })

      return Bitrefill.of({ search, voucher, buy })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
}
