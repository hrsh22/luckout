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

const o = (finalBps: number, chanceBps: number): Outcome => ({ finalBps, chanceBps })

export const MODES: ReadonlyArray<ModeInfo> = [
  { mode: "normal", name: "Normal", premiumBps: 0, outcomes: [o(10_000, 10_000)] },
  { mode: { lucky: 0 }, name: "Classic", premiumBps: 1_000, outcomes: [o(5_000, 100), o(8_000, 300), o(10_000, 2_500), o(11_000, 7_100)] },
  { mode: { lucky: 1 }, name: "Bold", premiumBps: 2_500, outcomes: [o(0, 200), o(5_000, 600), o(8_000, 1_000), o(10_000, 3_000), o(12_500, 5_200)] },
  { mode: { lucky: 2 }, name: "Jackpot", premiumBps: 5_000, outcomes: [o(0, 1_000), o(5_000, 1_500), o(10_000, 2_800), o(15_000, 4_700)] }
]

export const sameMode = (a: Mode | undefined, b: Mode | undefined) => JSON.stringify(a) === JSON.stringify(b)
export const modeInfo = (m: Mode | undefined) => MODES.find((x) => sameMode(x.mode, m))
export const modeName = (m: Mode | undefined) => modeInfo(m)?.name ?? "Default"

/** Chance, in basis points, of paying less than the price. */
export const chanceLessBps = (m: ModeInfo) => m.outcomes.filter((x) => x.finalBps < 10_000).reduce((s, x) => s + x.chanceBps, 0)

/** What one Draw outcome costs, exactly as the contract computes it (rounded up, capped). */
export const finalPrice = (reference: number, lucky: number, max: number, finalBps: number) =>
  Math.min(reference - lucky + Math.ceil((lucky * finalBps) / 10_000), max)

export interface PricedOutcome {
  price: number
  chanceBps: number
}

/** Every price this purchase can end at, most expensive first. */
export const pricedOutcomes = (m: ModeInfo, q: { referencePrice: number; luckyAmount: number; maxPrice: number }): Array<PricedOutcome> =>
  [...m.outcomes]
    .sort((a, b) => b.finalBps - a.finalBps)
    .map((x) => ({ price: m.premiumBps === 0 ? q.referencePrice : finalPrice(q.referencePrice, q.luckyAmount, q.maxPrice, x.finalBps), chanceBps: x.chanceBps }))

/** The single most likely price. */
export const mostLikely = (outcomes: ReadonlyArray<PricedOutcome>) => outcomes.reduce((a, b) => (b.chanceBps > a.chanceBps ? b : a))

/** Quote for a whole price with no Discount Cap in play: the Lucky Amount is the whole price. */
export const simpleQuote = (m: ModeInfo, referencePrice: number) => ({
  referencePrice,
  luckyAmount: m.premiumBps === 0 ? 0 : referencePrice,
  maxPrice: referencePrice + Math.ceil((referencePrice * m.premiumBps) / 10_000)
})

export const percent = (bps: number) => `${bps % 100 === 0 ? bps / 100 : (bps / 100).toFixed(1)}%`
