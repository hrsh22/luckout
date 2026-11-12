import type { TopUpAsset } from "@luckout/api"

/** What an EVM wallet holds of one token we can top up with: in the token's own units, and in dollars. */
export interface Holding {
  readonly amount: number
  readonly usd: number
}

/** One entry of Reown's balance lookup. */
export interface ReownBalance {
  readonly symbol: string
  /** CAIP-2, e.g. "eip155:8453". */
  readonly chainId: string
  /** CAIP-10 for a token ("eip155:8453:0x8335…"), null for the chain's own coin. */
  readonly address: string | null
  readonly value?: number
  readonly quantity: { readonly numeric: string }
}

const CHAIN_IDS: Record<string, string> = { "eip155:1": "eth", "eip155:8453": "base", "eip155:42161": "arb", "eip155:137": "pol", "eip155:56": "bsc" }

/** The coin each chain's transfer fee is paid in. */
export const GAS_COIN: Record<string, string> = { eth: "ETH", base: "ETH", arb: "ETH", pol: "POL", bsc: "BNB" }

/**
 * Each top-up token's holding in this wallet, by asset id, and the chains where it has some of the chain's own coin
 * to pay a transfer's fee. Balances only order and hint: a failed read just means none.
 */
export const matchHoldings = (assets: ReadonlyArray<TopUpAsset>, balances: ReadonlyArray<ReownBalance>) => {
  const holdings = new Map<string, Holding>()
  for (const a of assets) {
    const b = balances.find((x) =>
      CHAIN_IDS[x.chainId] === a.chain &&
      (a.contract ? x.address?.toLowerCase().endsWith(`:${a.contract.toLowerCase()}`) : x.address === null && x.symbol === a.symbol)
    )
    const amount = b ? Number(b.quantity.numeric) : 0
    if (amount > 0) holdings.set(a.assetId, { amount, usd: b?.value ?? 0 })
  }
  const gas = new Set(
    balances.filter((x) => x.address === null && Number(x.quantity.numeric) > 0).map((x) => CHAIN_IDS[x.chainId]).filter((c): c is string => !!c)
  )
  return { holdings, gas }
}

const STABLE = new Set(["USDC", "USDT"])
/**
 * The most USDC a holding can top up, roughly: what it's worth less 1Click's spread, and for a chain's own coin
 * something left for gas. Only a shortcut: the live quote says exactly what it costs.
 */
export const maxTopUp = (a: Pick<TopUpAsset, "symbol" | "chain">, h: Holding) => {
  const gas = STABLE.has(a.symbol) ? 0 : a.chain === "eth" ? 3 : 0.05
  return Math.max(0, Math.floor((h.usd - gas) * 0.985 * 100) / 100)
}
