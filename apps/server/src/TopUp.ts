import { TopUpAsset, TopUpQuote, TopUpUnavailable } from "@luckout/api"
import { Cache, Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

// Top-ups (ADR-0001): a NEAR Intents 1Click swap from any supported chain that lands native
// USDC in the customer's own NEAR account; one deposit then moves it into their Balance.
// The server pins the destination (USDC) and the recipient (the signed-in account), so this
// endpoint can't be used to swap anything else or pay anyone else.

export const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
const DESTINATION = `nep141:${MAINNET_USDC}`
const SYMBOLS = new Set(["USDC", "USDT", "ETH", "BTC", "SOL", "wNEAR"])
const CHAINS = new Set(["eth", "arb", "base", "sol", "btc", "pol", "bsc", "near"])

const Token = Schema.Struct({ assetId: Schema.String, blockchain: Schema.String, symbol: Schema.String })
const QuoteResponse = Schema.Struct({
  quote: Schema.Struct({
    depositAddress: Schema.optional(Schema.String),
    depositMemo: Schema.optional(Schema.String),
    amountIn: Schema.String,
    amountInFormatted: Schema.String,
    amountOut: Schema.String,
    timeEstimate: Schema.Number,
    deadline: Schema.optional(Schema.String)
  })
})
const Status = Schema.Struct({ status: Schema.String })

export class TopUp extends Context.Service<TopUp, {
  readonly assets: Effect.Effect<ReadonlyArray<TopUpAsset>, TopUpUnavailable>
  quote(accountId: string, originAsset: string, usdc: number, dry?: boolean): Effect.Effect<TopUpQuote, TopUpUnavailable>
  status(depositAddress: string): Effect.Effect<{ status: string }, TopUpUnavailable>
}>()("luckout/TopUp") {
  static readonly layer = Layer.effect(
    TopUp,
    Effect.gen(function*() {
      const baseUrl = yield* Config.String("ONECLICK_API_URL").pipe(Config.withDefault("https://1click.chaindefuser.com/v0"))
      // Optional: without a key 1Click charges an extra 0.25%.
      const key = yield* Config.option(Config.Redacted("ONECLICK_API_KEY"))
      const mainnet = (yield* Config.String("NEAR_NETWORK").pipe(Config.withDefault("testnet"))) === "mainnet"

      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest((r) => {
          const req = HttpClientRequest.acceptJson(HttpClientRequest.prependUrl(r, baseUrl))
          return Option.isSome(key) ? HttpClientRequest.bearerToken(req, Redacted.value(key.value)) : req
        })
      )
      const fail = (message: string) => new TopUpUnavailable({ message })
      const read = <A, I>(schema: Schema.Codec<A, I>) =>
      (res: HttpClientResponse.HttpClientResponse): Effect.Effect<A, TopUpUnavailable> =>
        Effect.gen(function*() {
          if (res.status >= 400) {
            const text = yield* res.text
            return yield* fail(`1Click: ${JSON.parse(text || "{}").message ?? res.status}`)
          }
          return yield* HttpClientResponse.schemaBodyJson(schema)(res)
        }).pipe(Effect.mapError((e) => (e instanceof TopUpUnavailable ? e : fail(`1Click unavailable: ${e}`))))

      const tokens = yield* Cache.make({
        lookup: (_: "all") =>
          http.get("/tokens").pipe(
            Effect.flatMap(read(Schema.Array(Token))),
            Effect.map((ts) =>
              ts.filter((t) => SYMBOLS.has(t.symbol) && CHAINS.has(t.blockchain) && t.assetId !== DESTINATION)
                .map((t) => new TopUpAsset({ assetId: t.assetId, symbol: t.symbol, chain: t.blockchain }))
            ),
            Effect.mapError((e) => (e instanceof TopUpUnavailable ? e : fail(`1Click unavailable: ${e}`)))
          ),
        capacity: 1,
        timeToLive: "10 minutes"
      })

      const quote = Effect.fn("TopUp.quote")(function*(accountId: string, originAsset: string, usdc: number, dry = false) {
        if (!mainnet && !dry) return yield* fail("Top-ups from other chains run on mainnet. On testnet, use the test USDC faucet.")
        if (!Number.isInteger(usdc) || usdc < 1_000_000 || usdc > 2_000_000_000) return yield* fail("Top up between 1 and 2,000 USDC")
        const asset = (yield* Cache.get(tokens, "all")).find((t) => t.assetId === originAsset)
        if (!asset) return yield* fail("That token isn't supported for top-ups")
        const res = yield* HttpClientRequest.post("/quote").pipe(
          HttpClientRequest.bodyJsonUnsafe({
            dry,
            swapType: "EXACT_OUTPUT",
            slippageTolerance: 100,
            originAsset,
            depositType: "ORIGIN_CHAIN",
            destinationAsset: DESTINATION,
            amount: String(usdc),
            recipient: accountId,
            recipientType: "DESTINATION_CHAIN",
            // We don't know the customer's address on the origin chain, so refunds go to
            // their own NEAR account inside Intents.
            refundTo: accountId,
            refundType: "INTENTS",
            deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString()
          }),
          http.execute,
          Effect.flatMap(read(QuoteResponse)),
          Effect.mapError((e) => (e instanceof TopUpUnavailable ? e : fail(`1Click unavailable: ${e}`)))
        )
        const q = res.quote
        if (!dry && !q.depositAddress) return yield* fail("1Click returned no deposit address")
        return new TopUpQuote({
          depositAddress: q.depositAddress ?? "",
          ...(q.depositMemo ? { depositMemo: q.depositMemo } : {}),
          amountIn: q.amountIn,
          amountInFormatted: q.amountInFormatted,
          symbol: asset.symbol,
          chain: asset.chain,
          usdcOut: Number(q.amountOut),
          timeEstimateSeconds: q.timeEstimate,
          deadline: q.deadline ?? ""
        })
      })

      const status = (depositAddress: string) =>
        http.get("/status", { urlParams: { depositAddress } }).pipe(
          Effect.flatMap(read(Status)),
          Effect.map((s) => ({ status: s.status })),
          Effect.mapError((e) => (e instanceof TopUpUnavailable ? e : fail(`1Click unavailable: ${e}`)))
        )

      return TopUp.of({ assets: Cache.get(tokens, "all"), quote, status })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
}
