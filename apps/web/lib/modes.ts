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

/** The most Cashback one Lucky Buy can pay: MAX_CASHBACK in the contract. */
export const MAX_CASHBACK = 50_000_000

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

/** Quote with no Discount Cap in play: the whole price plays, up to what the Cashback Cap allows (as in the contract). */
export const simpleQuote = (m: ModeInfo, referencePrice: number) => {
  const maxBackBps = 10_000 + m.premiumBps - Math.min(...m.outcomes.map((o) => o.finalBps))
  const luckyAmount = m.premiumBps === 0 ? 0 : Math.min(referencePrice, Math.floor((MAX_CASHBACK * 10_000) / maxBackBps))
  return { referencePrice, luckyAmount, maxPrice: referencePrice + Math.ceil((luckyAmount * m.premiumBps) / 10_000) }
}

export const percent = (bps: number) => `${bps % 100 === 0 ? bps / 100 : (bps / 100).toFixed(1)}%`
