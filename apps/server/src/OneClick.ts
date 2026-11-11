import { Cache, Config, Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

// NEAR Intents 1Click (https://1click.chaindefuser.com/docs/v0/openapi.yaml): swaps between chains
// through a one-time deposit address. Top-ups use it inward (any chain → USDC on NEAR) and refills
// outward (USDC on NEAR → exactly the USDC Bitrefill asked for, on Base).

export class OneClickUnavailable extends Data.TaggedError("OneClickUnavailable")<{ readonly message: string }> {}

const Token = Schema.Struct({
  assetId: Schema.String,
  blockchain: Schema.String,
  symbol: Schema.String,
  contractAddress: Schema.optional(Schema.NullOr(Schema.String)),
  decimals: Schema.optional(Schema.Number)
})
export type Token = typeof Token.Type

const Quote = Schema.Struct({
  depositAddress: Schema.optional(Schema.String),
  depositMemo: Schema.optional(Schema.String),
  amountIn: Schema.String,
  amountInFormatted: Schema.String,
  minAmountIn: Schema.optional(Schema.String),
  amountOut: Schema.String,
  amountOutFormatted: Schema.optional(Schema.String),
  minAmountOut: Schema.optional(Schema.String),
  timeEstimate: Schema.Number,
  deadline: Schema.optional(Schema.String)
})
const QuoteResponse = Schema.Struct({
  /** 1Click's id for the quote; support asks for it. */
  correlationId: Schema.optional(Schema.String),
  quote: Quote,
  /** 1Click's echo of what it will do, checked against what we asked for. */
  quoteRequest: Schema.optional(Schema.Struct({
    originAsset: Schema.String,
    destinationAsset: Schema.String,
    recipient: Schema.String,
    swapType: Schema.String,
    amount: Schema.String,
    refundTo: Schema.String,
    depositType: Schema.optional(Schema.String),
    recipientType: Schema.optional(Schema.String),
    refundType: Schema.optional(Schema.String)
  }))
})
export type QuoteResponse = typeof QuoteResponse.Type

export interface QuoteRequest {
  readonly dry: boolean
  readonly swapType: "EXACT_INPUT" | "EXACT_OUTPUT"
  /** Basis points. */
  readonly slippageTolerance: number
  readonly originAsset: string
  readonly destinationAsset: string
  /** Base units: the output for EXACT_OUTPUT, the input for EXACT_INPUT. */
  readonly amount: string
  readonly recipient: string
  readonly refundTo: string
  readonly refundType: "ORIGIN_CHAIN" | "INTENTS"
  readonly deadline: string
  /** Default ORIGIN_CHAIN: a deposit on the origin chain. INTENTS: a transfer inside NEAR Intents. */
  readonly depositType?: "ORIGIN_CHAIN" | "INTENTS"
  /** Default DESTINATION_CHAIN. INTENTS: delivered to `recipient`'s NEAR Intents account. */
  readonly recipientType?: "DESTINATION_CHAIN" | "INTENTS"
}

/** Where a swap is: PENDING_DEPOSIT, KNOWN_DEPOSIT_TX, INCOMPLETE_DEPOSIT, PROCESSING, SUCCESS, REFUNDED or FAILED. */
export type SwapStatus = string

const Hashes = Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ hash: Schema.String }))))
const StatusResponse = Schema.Struct({
  status: Schema.String,
  swapDetails: Schema.optional(Schema.NullOr(Schema.Struct({
    amountOutFormatted: Schema.optional(Schema.NullOr(Schema.String)),
    refundedAmount: Schema.optional(Schema.NullOr(Schema.String)),
    refundedAmountFormatted: Schema.optional(Schema.NullOr(Schema.String)),
    refundReason: Schema.optional(Schema.NullOr(Schema.String)),
    destinationChainTxHashes: Hashes
  })))
})

/** A swap's status with what a customer cares about: what arrived, where, and anything sent back. */
export interface SwapDetails {
  readonly status: SwapStatus
  readonly amountOut?: string | undefined
  readonly refunded?: string | undefined
  readonly refundReason?: string | undefined
  readonly deliveredTx?: string | undefined
}

export class OneClick extends Context.Service<OneClick, {
  readonly tokens: Effect.Effect<ReadonlyArray<Token>, OneClickUnavailable>
  quote(request: QuoteRequest): Effect.Effect<QuoteResponse, OneClickUnavailable>
  status(depositAddress: string): Effect.Effect<SwapStatus, OneClickUnavailable>
  details(depositAddress: string): Effect.Effect<SwapDetails, OneClickUnavailable>
  /** Tells 1Click about our deposit so it doesn't wait to notice it; best effort. */
  submitDeposit(input: { txHash: string; depositAddress: string; nearSenderAccount: string }): Effect.Effect<void>
}>()("luckout/OneClick") {
  static readonly layer = Layer.effect(
    OneClick,
    Effect.gen(function*() {
      const baseUrl = yield* Config.String("ONECLICK_API_URL").pipe(Config.withDefault("https://1click.chaindefuser.com/v0"))
      // Optional partner key from partners.near-intents.org; quotes are priced the same without it.
      const key = yield* Config.option(Config.Redacted("ONECLICK_API_KEY"))
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest((r) => {
          const req = HttpClientRequest.acceptJson(HttpClientRequest.prependUrl(r, baseUrl))
          // X-API-Key is 1Click's recommended partner header (Authorization: Bearer is the legacy one).
          return Option.isSome(key) ? HttpClientRequest.setHeader(req, "X-API-Key", Redacted.value(key.value)) : req
        }),
        HttpClient.timeout("20 seconds")
      )
      const fail = (message: string) => new OneClickUnavailable({ message })
      const read = <A, I>(schema: Schema.Codec<A, I>) => (res: HttpClientResponse.HttpClientResponse) =>
        Effect.gen(function*() {
          if (res.status >= 400) {
            const text = yield* res.text
            const message = (() => {
              try {
                return JSON.parse(text || "{}").message
              } catch {
                return undefined
              }
            })()
            return yield* fail(`1Click: ${message ?? res.status}`)
          }
          return yield* HttpClientResponse.schemaBodyJson(schema)(res)
        })
      const wrap = <A, E, R>(e: Effect.Effect<A, E, R>) =>
        e.pipe(Effect.mapError((err) => (err instanceof OneClickUnavailable ? err : fail(`1Click unavailable: ${err}`))))

      const tokenCache = yield* Cache.make({
        lookup: (_: "all") => wrap(http.get("/tokens").pipe(Effect.flatMap(read(Schema.Array(Token))))),
        capacity: 1,
        timeToLive: "10 minutes"
      })

      const quote = (request: QuoteRequest) =>
        wrap(HttpClientRequest.post("/quote").pipe(
          HttpClientRequest.bodyJsonUnsafe({ depositType: "ORIGIN_CHAIN", recipientType: "DESTINATION_CHAIN", ...request }),
          http.execute,
          Effect.flatMap(read(QuoteResponse))
        ))

      const details = (depositAddress: string) =>
        wrap(http.get("/status", { urlParams: { depositAddress } }).pipe(
          Effect.flatMap(read(StatusResponse)),
          Effect.map((s): SwapDetails => {
            const d = s.swapDetails
            const refunded = d?.refundedAmount && d.refundedAmount !== "0" ? d.refundedAmountFormatted ?? undefined : undefined
            return {
              status: s.status,
              amountOut: d?.amountOutFormatted ?? undefined,
              refunded,
              refundReason: refunded ? d?.refundReason ?? undefined : undefined,
              deliveredTx: d?.destinationChainTxHashes?.[0]?.hash
            }
          })
        ))
      const status = (depositAddress: string) => details(depositAddress).pipe(Effect.map((d) => d.status))

      const submitDeposit = (input: { txHash: string; depositAddress: string; nearSenderAccount: string }) =>
        HttpClientRequest.post("/deposit/submit").pipe(
          HttpClientRequest.bodyJsonUnsafe(input),
          http.execute,
          Effect.asVoid,
          Effect.catchCause((cause) => Effect.logWarning("1Click deposit/submit failed (it will notice the deposit anyway)", cause))
        )

      return OneClick.of({ tokens: Cache.get(tokenCache, "all"), quote, status, details, submitDeposit })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
}
