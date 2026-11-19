import type { TopUpAsset } from "@luckout/api"

/** What an EVM or Solana wallet holds of one token we can top up with: in the token's own units, and in dollars. */
export interface Holding {
  readonly amount: number
  readonly usd: number
}

/** One entry of Reown's balance lookup. */
export interface ReownBalance {
  readonly symbol: string
  /** CAIP-2, e.g. "eip155:8453" or "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp". */
  readonly chainId: string
  /** CAIP-10 for a token ("eip155:8453:0x8335…"); absent (or null) for the chain's own coin. */
  readonly address?: string | null
  /** In dollars; without it, the amount at 1Click's price for the token. */
  readonly value?: number
  readonly quantity: { readonly numeric: string }
}

const CHAIN_IDS: Record<string, string> = {
  "eip155:1": "eth",
  "eip155:8453": "base",
  "eip155:42161": "arb",
  "eip155:137": "pol",
  "eip155:56": "bsc",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "sol"
}

/** The coin each chain's transfer fee is paid in. */
export const GAS_COIN: Record<string, string> = { eth: "ETH", base: "ETH", arb: "ETH", pol: "POL", bsc: "BNB", sol: "SOL" }

/**
 * Solana, in SOL: a token Top-Up also pays rent for the deposit address's token account (0.00149 SOL), and a wallet
 * must keep 0.00065 SOL to stay open (both as of 2026-11-19), so less than this can't send a token at all.
 */
const SOL_FOR_TOKEN_SEND = 0.0022
/** What a SOL Top-Up leaves in the wallet: the 0.00065 SOL it must keep, plus the fee, with room to spare. */
const SOL_KEPT = 0.001

/**
 * Each top-up token's holding in this wallet, by asset id, and the chains where it has some of the chain's own coin
 * to pay a transfer's fee. Balances only order and hint: a failed read just means none.
 */
export const matchHoldings = (assets: ReadonlyArray<TopUpAsset>, balances: ReadonlyArray<ReownBalance>) => {
  const holdings = new Map<string, Holding>()
  for (const a of assets) {
    const b = balances.find((x) =>
      CHAIN_IDS[x.chainId] === a.chain &&
      (a.contract ? x.address?.toLowerCase().endsWith(`:${a.contract.toLowerCase()}`) : !x.address && x.symbol === a.symbol)
    )
    const amount = b ? Number(b.quantity.numeric) : 0
    if (amount > 0) holdings.set(a.assetId, { amount, usd: b?.value ?? amount * (a.price ?? 0) })
  }
  const gas = new Set(
    balances
      .filter((x) => !x.address && Number(x.quantity.numeric) > (CHAIN_IDS[x.chainId] === "sol" ? SOL_FOR_TOKEN_SEND : 0))
      .map((x) => CHAIN_IDS[x.chainId])
      .filter((c): c is string => !!c)
  )
  return { holdings, gas }
}

const STABLE = new Set(["USDC", "USDT"])
/**
 * The most USDC a holding can top up, roughly: what it's worth less 1Click's spread, and for a chain's own coin
 * something left for gas. Only a shortcut: the live quote says exactly what it costs.
 */
export const maxTopUp = (a: Pick<TopUpAsset, "symbol" | "chain">, h: Holding) => {
  // SOL's reserve is kept in SOL: a flat $0.05 left Max a cent above what Solana requires (staging, 2026-11-19).
  const gas = STABLE.has(a.symbol) ? 0 : a.chain === "eth" ? 3 : a.chain === "sol" ? Math.max(0.05, (h.usd / h.amount) * SOL_KEPT) : 0.05
  return Math.max(0, Math.floor((h.usd - gas) * 0.985 * 100) / 100)
}
