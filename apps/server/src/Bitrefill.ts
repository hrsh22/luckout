import { BitrefillUnavailable, Voucher } from "@luckout/api"
import { Config, Context, Duration, Effect, flow, Layer, Option, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

const Package = Schema.Struct({ id: Schema.String, value: Schema.String, price: Schema.Int })
const Product = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  country_code: Schema.String,
  currency: Schema.String,
  image: Schema.String,
  packages: Schema.optional(Schema.Array(Package))
})
const Order = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  redemption_info: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
})
const Invoice = Schema.Struct({ id: Schema.String, status: Schema.String, orders: Schema.Array(Order) })
const data = <A, I>(s: Schema.Codec<A, I>) => Schema.Struct({ data: s })

/** Redemption Data exactly as Bitrefill sends it (code, link, pin, instructions…). */
export type Redemption = Readonly<Record<string, unknown>>

export type Delivery =
  | { readonly _tag: "Delivered"; readonly invoiceId: string; readonly orderId: string; readonly redemption: Redemption }
  | { readonly _tag: "Failed"; readonly invoiceId: string; readonly status: string }

// Bitrefill prices in satoshis (our account balance is BTC). The test card is a
// fixed $10 USD package, so its sat price is Bitrefill's own BTC/USD rate.
// ponytail: rate from a test product; switch if Bitrefill moves the balance to USD.
const RATE_PACKAGE = "test-gift-card-code<&>10"
const RATE_MICRO_USDC = 10_000_000

/** Rounds up, so the Reference Price never undercuts what the voucher costs us. */
export const satsToMicroUsdc = (sats: number, satsPer10Usd: number) =>
  Math.ceil((sats * RATE_MICRO_USDC) / satsPer10Usd)

export class Bitrefill extends Context.Service<Bitrefill, {
  search(q: string): Effect.Effect<ReadonlyArray<Voucher>, BitrefillUnavailable>
  /** Creates an invoice paid from the prepaid balance and waits for the outcome. */
  buy(packageId: string): Effect.Effect<Delivery, BitrefillUnavailable>
}>()("luckout/Bitrefill") {
  static readonly layer = Layer.effect(
    Bitrefill,
    Effect.gen(function*() {
      const apiKey = yield* Config.option(Config.Redacted("BITREFILL_API_KEY"))
      const baseUrl = yield* Config.String("BITREFILL_API_URL").pipe(Config.withDefault("https://api.bitrefill.com/v2"))
      const testnet = (yield* Config.String("NEAR_NETWORK").pipe(Config.withDefault("testnet"))) === "testnet"

      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(flow(
          HttpClientRequest.prependUrl(baseUrl),
          HttpClientRequest.acceptJson,
          Option.isSome(apiKey) ? HttpClientRequest.bearerToken(apiKey.value) : (r) => r
        )),
        HttpClient.filterStatusOk,
        HttpClient.retryTransient({ schedule: Schedule.exponential(200), times: 3 })
      )

      const unavailable = (cause: unknown) =>
        new BitrefillUnavailable({
          message: Option.isNone(apiKey) ? "BITREFILL_API_KEY is not set" : `Bitrefill request failed: ${cause}`
        })

      const get = <A, I>(path: string, schema: Schema.Codec<A, I>, urlParams?: Record<string, string>) =>
        http.get(path, urlParams ? { urlParams } : undefined).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(data(schema))),
          Effect.map((r) => r.data),
          Effect.mapError(unavailable)
        )

      const satsPer10Usd = yield* Effect.cachedWithTTL(
        get(`/products/test-gift-card-code`, Product).pipe(
          Effect.flatMap((p) => {
            const pkg = p.packages?.find((x) => x.id === RATE_PACKAGE)
            return pkg ? Effect.succeed(pkg.price) : Effect.fail(unavailable("rate package missing"))
          })
        ),
        Duration.minutes(1)
      )

      const search = Effect.fn("Bitrefill.search")(function*(q: string) {
        const [products, rate] = yield* Effect.all([
          get("/products/search", Schema.Array(Product), { q, include_test_products: String(testnet) }),
          satsPer10Usd
        ], { concurrency: 2 })
        return products.map((p) =>
          new Voucher({
            id: p.id,
            name: p.name,
            countryCode: p.country_code,
            currency: p.currency,
            image: p.image,
            packages: (p.packages ?? []).map((pkg) => ({
              value: pkg.value,
              priceMicroUsdc: satsToMicroUsdc(pkg.price, rate)
            }))
          })
        )
      })

      const buy = Effect.fn("Bitrefill.buy")(function*(packageId: string) {
        const productId = packageId.split("<&>")[0]!
        const created = yield* HttpClientRequest.post("/invoices").pipe(
          HttpClientRequest.bodyJsonUnsafe({
            products: [{ product_id: productId, package_id: packageId, quantity: 1 }],
            payment_method: "balance",
            auto_pay: true
          }),
          http.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(data(Invoice))),
          Effect.map((r) => r.data),
          Effect.mapError(unavailable)
        )
        // Delivery normally takes well under a second; poll for up to ~1 minute.
        // Still pending after that = unknown, left to the reconciler (never "failed").
        const invoice = yield* get(`/invoices/${created.id}`, Invoice).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (i) => i.status !== "not_delivered",
            times: 60
          })
        )
        const order = invoice.orders[0]
        if (invoice.status === "all_delivered" && order?.redemption_info) {
          return { _tag: "Delivered", invoiceId: invoice.id, orderId: order.id, redemption: order.redemption_info } as const
        }
        if (invoice.status === "all_error") return { _tag: "Failed", invoiceId: invoice.id, status: invoice.status } as const
        return yield* Effect.fail(unavailable(`invoice ${invoice.id} is still ${invoice.status}`))
      })

      return Bitrefill.of({ search, buy })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
}
