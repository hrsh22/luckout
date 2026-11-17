import type { TopUpAsset, TopUpQuote } from "@luckout/api"

/**
 * What the wallet is asked to transfer for an EVM Top-Up. The token comes from the asset the quote was asked for
 * and everything else from the quote; a pair that doesn't belong together is refused, because the wrong token at a
 * deposit address is the customer's money sent where nothing credits it.
 */
export const transferFor = (
  asset: Pick<TopUpAsset, "symbol" | "chain" | "contract">,
  q: Pick<TopUpQuote, "symbol" | "chain" | "depositAddress" | "amountIn">
) => {
  if (asset.symbol !== q.symbol || asset.chain !== q.chain) throw new Error("This price was for another token. Nothing was sent: start the top-up again.")
  return { chain: q.chain, contract: asset.contract, to: q.depositAddress, amount: q.amountIn }
}

type Priced = Pick<TopUpQuote, "symbol" | "chain" | "amountInFormatted">

/**
 * Whether the real quote is the price the customer was shown: the same token on the same chain, at most half a
 * percent dearer. Only then is it sent without asking again; amounts of two different tokens are never compared.
 */
export const pricedAsShown = (shown: Priced | undefined, real: Priced) =>
  !!shown && shown.symbol === real.symbol && shown.chain === real.chain && Number(real.amountInFormatted) <= Number(shown.amountInFormatted) * 1.005
