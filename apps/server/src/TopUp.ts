import { TopUpAsset, TopUpQuote, TopUpUnavailable } from "@luckout/api"
import { Context, Effect, Layer } from "effect"
import { Network } from "./Near.ts"
import { OneClick } from "./OneClick.ts"

// Top-ups (ADR-0001): a NEAR Intents 1Click swap from any supported chain that lands native
// USDC in the customer's own NEAR account; one deposit then moves it into their Balance.
// The server pins the destination (USDC) and the recipient (the signed-in account), so this
// endpoint can't be used to swap anything else or pay anyone else.

export const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
export const NEAR_USDC_ASSET = `nep141:${MAINNET_USDC}`
const SYMBOLS = new Set(["USDC", "USDT", "ETH", "BTC", "SOL", "wNEAR"])
const CHAINS = new Set(["eth", "arb", "base", "sol", "btc", "pol", "bsc", "near"])

export class TopUp extends Context.Service<TopUp, {
  readonly assets: Effect.Effect<ReadonlyArray<TopUpAsset>, TopUpUnavailable>
  quote(accountId: string, originAsset: string, usdc: number, dry?: boolean): Effect.Effect<TopUpQuote, TopUpUnavailable>
  status(depositAddress: string): Effect.Effect<{ status: string }, TopUpUnavailable>
}>()("luckout/TopUp") {
  static readonly layer = Layer.effect(
    TopUp,
    Effect.gen(function*() {
      const oneClick = yield* OneClick
      const mainnet = (yield* Network) === "mainnet"
      const fail = (message: string) => new TopUpUnavailable({ message })
      const unavailable = (e: { message: string }) => fail(e.message)

      const assets = oneClick.tokens.pipe(
        Effect.map((ts) =>
          ts.filter((t) => SYMBOLS.has(t.symbol) && CHAINS.has(t.blockchain) && t.assetId !== NEAR_USDC_ASSET)
            .map((t) => new TopUpAsset({ assetId: t.assetId, symbol: t.symbol, chain: t.blockchain }))
        ),
        Effect.mapError(unavailable)
      )

      const quote = Effect.fn("TopUp.quote")(function*(accountId: string, originAsset: string, usdc: number, dry = false) {
        if (!mainnet && !dry) return yield* fail("Top-ups from other chains run on mainnet. On testnet, use the test USDC faucet.")
        if (!Number.isInteger(usdc) || usdc < 1_000_000 || usdc > 2_000_000_000) return yield* fail("Top up between 1 and 2,000 USDC")
        const asset = (yield* assets).find((t) => t.assetId === originAsset)
        if (!asset) return yield* fail("That token isn't supported for top-ups")
        const { quote: q } = yield* oneClick.quote({
          dry,
          swapType: "EXACT_OUTPUT",
          slippageTolerance: 100,
          originAsset,
          destinationAsset: NEAR_USDC_ASSET,
          amount: String(usdc),
          recipient: accountId,
          // We don't know the customer's address on the origin chain, so refunds go to
          // their own NEAR account inside Intents.
          refundTo: accountId,
          refundType: "INTENTS",
          deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString()
        }).pipe(Effect.mapError(unavailable))
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
        oneClick.status(depositAddress).pipe(Effect.map((status) => ({ status })), Effect.mapError(unavailable))

      return TopUp.of({ assets, quote, status })
    })
  )
}
