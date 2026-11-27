import type { TopUpAsset, TopUpQuote } from "@luckout/api"

// TODO(phase3-wallet): written for Top-Ups sent from a connected EVM or Solana wallet; rework for the Deposit Address.

/** The wallet's transfer was mined and reverted: nothing left the wallet, so sending it again is safe. */
export class TransferReverted extends Error {
  constructor() {
    super("Your wallet's transfer failed on its chain. Nothing reached Luckout.")
  }
}

/**
 * What the wallet is asked to transfer for an EVM or Solana Top-Up. The token comes from the asset the quote was asked for
 * and everything else from the quote; a pair that doesn't belong together is refused, because the wrong token at a
 * deposit address is the customer's money sent where nothing credits it.
 */
export const transferFor = (
  asset: Pick<TopUpAsset, "symbol" | "chain" | "contract" | "decimals">,
  q: Pick<TopUpQuote, "symbol" | "chain" | "depositAddress" | "amountIn"> & { swap?: boolean | undefined }
) => {
  // A swap-paid Top-Up's deposit address takes only USDC: the token itself sent there would be lost.
  if (q.swap) throw new Error("This Top-Up is paid through a swap. Nothing was sent: start the top-up again.")
  if (asset.symbol !== q.symbol || asset.chain !== q.chain) throw new Error("This price was for another token. Nothing was sent: start the top-up again.")
  return { chain: q.chain, contract: asset.contract, decimals: asset.decimals, to: q.depositAddress, amount: q.amountIn }
}

type Priced = Pick<TopUpQuote, "symbol" | "chain" | "amountInFormatted"> & { swap?: boolean | undefined }

/**
 * Whether the real quote is the price the customer was shown: the same token on the same chain, at most half a
 * percent dearer, or no dearer at all for a swap (it takes exactly what it says). Only then is it sent without
 * asking again; amounts of two different tokens are never compared.
 */
export const pricedAsShown = (shown: Priced | undefined, real: Priced) =>
  !!shown && shown.symbol === real.symbol && shown.chain === real.chain &&
  Number(real.amountInFormatted) <= Number(shown.amountInFormatted) * (real.swap ? 1 : 1.005)

/**
 * After the wallet's send threw: whether this Top-Up's Send may be offered again, and the error to show. Once the
 * wallet has sent it, only a transfer mined and reverted (TransferReverted) left nothing on its way; any other failure
 * (a timeout waiting for it, a wallet that lost its connection) may still land, and a second send would pay twice.
 */
export const afterSendFailed = (e: unknown, asset: Pick<TopUpAsset, "symbol" | "swap">): { sendAgain: boolean; error: unknown } =>
  !(e instanceof TransferReverted)
    ? { sendAgain: false, error: e }
    : asset.swap
    // A swap fails whole when the price moved past its room before it landed: only Solana's fee was spent.
    ? {
      sendAgain: true,
      error: new Error(
        `The swap didn't go through: ${asset.symbol}'s price moved past what this swap allowed before it landed, or it took too long. Only Solana's network fee left your wallet. Send it again; if the price has moved too far, you'll be asked for a new Top-Up.`
      )
    }
    : { sendAgain: true, error: e }
