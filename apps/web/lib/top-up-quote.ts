import type { TopUpAsset, TopUpQuote } from "@luckout/api"

/**
 * What the wallet is asked to transfer for an EVM or Solana Top-Up. The token comes from the asset the quote was asked for
 * and everything else from the quote; a pair that doesn't belong together is refused, because the wrong token at a
 * deposit address is the customer's money sent where nothing credits it.
 */
export const transferFor = (
  asset: Pick<TopUpAsset, "symbol" | "chain" | "contract" | "decimals">,
  q: Pick<TopUpQuote, "symbol" | "chain" | "depositAddress" | "amountIn" | "swap">
) => {
  // A swap-paid Top-Up's deposit address takes only USDC: the token itself sent there would be lost.
  if (q.swap) throw new Error("This Top-Up is paid through a swap. Nothing was sent: start the top-up again.")
  if (asset.symbol !== q.symbol || asset.chain !== q.chain) throw new Error("This price was for another token. Nothing was sent: start the top-up again.")
  return { chain: q.chain, contract: asset.contract, decimals: asset.decimals, to: q.depositAddress, amount: q.amountIn }
}

type Priced = Pick<TopUpQuote, "symbol" | "chain" | "amountInFormatted" | "swap">

/**
 * Whether the real quote is the price the customer was shown: the same token on the same chain, at most half a
 * percent dearer, or no dearer at all for a swap (it takes exactly what it says). Only then is it sent without
 * asking again; amounts of two different tokens are never compared.
 */
export const pricedAsShown = (shown: Priced | undefined, real: Priced) =>
  !!shown && shown.symbol === real.symbol && shown.chain === real.chain &&
  Number(real.amountInFormatted) <= Number(shown.amountInFormatted) * (real.swap ? 1 : 1.005)
