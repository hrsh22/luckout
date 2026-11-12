import type { Mode } from "@luckout/api"

// The live Game Versions, mirrored from default_game_versions() in contract/src/lib.rs.
// They are immutable onchain; the Draw Proof reads the real table from the chain.
export interface Outcome {
  /** Final Price on the Lucky Amount, in basis points: 5_000 pays half. */
  finalBps: number
  chanceBps: number
}

export interface ModeInfo {
  mode: Mode
  name: string
  premiumBps: number
  outcomes: ReadonlyArray<Outcome>
}

/** (Cashback as a % of what you paid, chance in bps); the rest of the chance gets no Cashback. */
const lucky = (n: number, name: string, premiumBps: number, cashback: Array<[number, number]>): ModeInfo => {
  const paid = 10_000 + premiumBps
  const none = 10_000 - cashback.reduce((s, [, c]) => s + c, 0)
  const outcomes = [...cashback.map(([pct, chanceBps]) => ({ finalBps: (paid * (100 - pct)) / 100, chanceBps })), { finalBps: paid, chanceBps: none }]
  return { mode: { lucky: n }, name, premiumBps, outcomes }
}

export const MODES: ReadonlyArray<ModeInfo> = [
  { mode: "normal", name: "Normal", premiumBps: 0, outcomes: [{ finalBps: 10_000, chanceBps: 10_000 }] },
  lucky(0, "Lite", 1_000, [[100, 100], [50, 100], [30, 100], [20, 200], [10, 1_800]]),
  lucky(1, "Classic", 2_000, [[100, 200], [50, 300], [40, 400], [30, 700], [20, 2_400]]),
  lucky(2, "Jackpot", 5_000, [[100, 1_000], [50, 1_200], [40, 3_400]])
]

/** The longest outcome table: lists reserve this many rows so switching modes doesn't move the page. */
export const MOST_OUTCOMES = Math.max(...MODES.map((m) => m.outcomes.length))

/** What the quote needs from the contract's get_reserve, in micro-USDC: Free Reserve and the most Cashback one Lucky Buy can pay now. */
export interface ReserveView {
  free: number | string
  max_cashback: number | string
}
/** Room for any example price: shows a mode at its best, whatever today's reserve. */
export const AMPLE_RESERVE: ReserveView = { free: Number.MAX_SAFE_INTEGER, max_cashback: Number.MAX_SAFE_INTEGER }

export const sameMode = (a: Mode | undefined, b: Mode | undefined) => JSON.stringify(a) === JSON.stringify(b)
export const modeInfo = (m: Mode | undefined) => MODES.find((x) => sameMode(x.mode, m))
export const modeName = (m: Mode | undefined) => modeInfo(m)?.name ?? "Default"
/** "classic": how a mode appears in URLs. */
export const modeSlug = (m: Mode | undefined) => (modeInfo(m) ?? MODES[0]!).name.toLowerCase()
export const modeFromSlug = (s: string | null | undefined) => MODES.find((m) => m.name.toLowerCase() === s)?.mode
/** The mode we suggest to new customers. Normal stays the contract's default until they choose. */
export const RECOMMENDED = "Classic"

/** Chance, in basis points, of any Cashback; every Cashback leaves the price below normal. */
export const cashbackChanceBps = (m: ModeInfo) => m.outcomes.filter((x) => x.finalBps < 10_000).reduce((s, x) => s + x.chanceBps, 0)

/** Cashback as a whole % of what was paid, from a table row: 9_600 on Classic (+20%) is 20. */
export const cashbackPct = (premiumBps: number, finalBps: number) => Math.round(100 - (finalBps * 100) / (10_000 + premiumBps))

/** What one Draw outcome costs, exactly as the contract computes it (rounded up, capped). */
export const finalPrice = (reference: number, lucky: number, max: number, finalBps: number) =>
  Math.min(reference - lucky + Math.ceil((lucky * finalBps) / 10_000), max)

export interface PricedOutcome {
  price: number
  /** What comes back to the balance: the Maximum Price minus this price. */
  cashback: number
  pct: number
  chanceBps: number
}

/** Every price this purchase can end at, most expensive (no Cashback) first. */
export const pricedOutcomes = (m: ModeInfo, q: { referencePrice: number; luckyAmount: number; maxPrice: number }): Array<PricedOutcome> =>
  [...m.outcomes]
    .sort((a, b) => b.finalBps - a.finalBps)
    .map((x) => {
      const price = m.premiumBps === 0 ? q.referencePrice : finalPrice(q.referencePrice, q.luckyAmount, q.maxPrice, x.finalBps)
      return { price, cashback: q.maxPrice - price, pct: cashbackPct(m.premiumBps, x.finalBps), chanceBps: x.chanceBps }
    })

/** The single most likely price. */
export const mostLikely = (outcomes: ReadonlyArray<PricedOutcome>) => outcomes.reduce((a, b) => (b.chanceBps > a.chanceBps ? b : a))

const minFinalBps = (m: ModeInfo) => BigInt(Math.min(...m.outcomes.map((o) => o.finalBps)))

/**
 * quote_internal in contract/src/lib.rs, in exact integers: the whole price plays, up to what keeps the
 * best result within the Cashback Cap and its lock within Free Reserve. A lucky mode with luckyAmount 0
 * can't be bought right now (the contract refuses it: "Reserve too small"). Normal needs no reserve.
 */
export const simpleQuote = (m: ModeInfo, referencePrice: number, reserve: ReserveView | undefined) => {
  if (m.premiumBps === 0) return { referencePrice, luckyAmount: 0, maxPrice: referencePrice }
  const minFinal = minFinalBps(m)
  const lucky = [
    BigInt(referencePrice),
    (BigInt(reserve?.max_cashback ?? 0) * 10_000n) / (10_000n + BigInt(m.premiumBps) - minFinal),
    (BigInt(reserve?.free ?? 0) * 10_000n) / (10_000n - minFinal)
  ].reduce((a, b) => (b < a ? b : a))
  const premium = (lucky * BigInt(m.premiumBps) + 9_999n) / 10_000n
  return { referencePrice, luckyAmount: Number(lucky), maxPrice: referencePrice + Number(premium) }
}

export const percent = (bps: number) => `${bps % 100 === 0 ? bps / 100 : (bps / 100).toFixed(1)}%`
