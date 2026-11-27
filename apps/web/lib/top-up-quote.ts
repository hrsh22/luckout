import type { HeldToken, TopUpAsset, TopUpQuote } from "@luckout/api"

// Pure helpers for adding funds (ADR-0015): the Deposit Address's QR, the swap-paid tokens sitting there, and 1Click
// Top-Ups from other chains.

/**
 * The Deposit Address as a Solana Pay link for USDC: a wallet app that scans it opens a USDC transfer to it. The plain
 * address is shown beside it for exchanges.
 */
export const solanaPayUri = (address: string, usdcMint: string) => `solana:${address}?spl-token=${usdcMint}`

/** Base units → "12.5": exact, trailing zeros trimmed. */
export const formatUnits = (amount: string, decimals: number) => {
  const s = amount.replace(/^0+(?=\d)/, "").padStart(decimals + 1, "0")
  const whole = s.slice(0, s.length - decimals)
  const frac = s.slice(s.length - decimals).replace(/0+$/, "")
  return frac ? `${whole}.${frac}` : whole
}

/**
 * The least a FLEX_INPUT quote swaps, formatted like `amountInFormatted`; undefined when 1Click gave none. The token's
 * decimals come from the asset, or else from the quote's own amount and its formatted form.
 */
export const minimumOf = (q: Pick<TopUpQuote, "amountIn" | "amountInFormatted" | "minAmountIn">, decimals?: number) => {
  if (!q.minAmountIn) return undefined
  const d = decimals ?? Math.round(Math.log10(Number(q.amountIn) / Number(q.amountInFormatted)))
  return Number.isInteger(d) && d >= 0 ? formatUnits(q.minAmountIn, d) : undefined
}

/** What one tap would swap into the Balance: a held token, what it's worth (when its price is known), and whether that's enough. */
export interface Tap {
  readonly held: HeldToken
  /** "12.5" */
  readonly amount: string
  readonly usd: number | undefined
  /** Worth at least the program's 1 USDC minimum deposit, or of unknown worth (the server then decides). */
  readonly enough: boolean
}

/**
 * The swap-paid tokens at the Deposit Address that this server swaps now (an asset with `swap`), each with its worth
 * at the asset's price.
 */
export const tapsFor = (held: ReadonlyArray<HeldToken>, assets: ReadonlyArray<Pick<TopUpAsset, "assetId" | "swap" | "price">>): Array<Tap> =>
  held.flatMap((h) => {
    const asset = assets.find((a) => a.assetId === h.assetId && a.swap)
    if (!asset) return []
    const amount = formatUnits(h.amount, h.decimals)
    const usd = asset.price === undefined ? undefined : Number(amount) * asset.price
    return [{ held: h, amount, usd, enough: usd === undefined || usd >= 1 }]
  })

/** What a card still needs (at least the 1 USDC Top-Up minimum), rounded up to the cent; or nothing. */
const needed = (need: number | undefined) => (need ? Math.ceil(Math.max(need, 1_000_000) / 10_000) * 10_000 : undefined)

/** A Top-Up's starting amount, in micro-USDC: what a card needs, or $20. */
export const topUpMicro = (need?: number) => needed(need) ?? 20_000_000

/** One row of quick picks: "Exactly …" takes $50's place when a card needs a set amount. */
export const topUpPicks = (need?: number) => {
  const n = needed(need)
  return [
    ...(n ? [{ label: `Exactly $${(n / 1e6).toFixed(2)}`, micro: n }] : []),
    { label: "$10", micro: 10_000_000 },
    { label: "$25", micro: 25_000_000 },
    ...(n ? [] : [{ label: "$50", micro: 50_000_000 }])
  ]
}

/**
 * Why `to` can't take a withdrawal, or undefined: it must look like a Solana address (the server checks it fully), and
 * not be the customer's own Deposit Address, where USDC moves straight back into the Balance.
 */
export const withdrawProblem = (to: string, depositAddress: string | undefined) =>
  !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to)
    ? "That isn't a Solana address."
    : to === depositAddress
    ? "That's your own Deposit Address: what lands there moves back into your balance."
    : undefined
