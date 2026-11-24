// Only Effect-free entry points here: the landing page formats prices, and the root of @luckout/api would
// pull the whole API schema into it.
import { tokenAmount } from "@luckout/api/intents"
import { noLimit } from "@luckout/api/limits"

const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
/** micro-USDC → "$5.53" (display only; amounts stay integers everywhere else). */
export const usd = (micro: number | string) => fmt.format(Number(micro) / 1e6)
/** micro-USDC → whole cents, rounded up, in integers only: how every price is shown. */
export const centsUp = (micro: number) => (micro - (micro % 10_000)) / 10_000 + (micro % 10_000 > 0 ? 1 : 0)
/** Whole cents → "$5.53". */
export const usdCents = (cents: number) => fmt.format(cents / 100)
/** What the customer pays, rounded up to the cent: never show less than what leaves their balance. */
export const usdUp = (micro: number | string) => usdCents(centsUp(Number(micro)))
/** A balance, rounded down to the cent: never show more than is there (prices round up, so the two add up). */
export const usdDown = (micro: number | string) => fmt.format(Math.floor(Number(micro) / 10_000) / 100)

/** One row of a Lucky Buy's outcome list as shown, in whole cents. `samePct`: every outcome in it has `pct`. */
export interface ShownOutcome {
  price: number
  cashback: number
  pct: number
  samePct: boolean
  chanceBps: number
}

/**
 * The outcome list in whole cents that add up: "you pay" rounds up like every price, and the cashback is what's left of
 * the Maximum Price shown, so pay now minus cashback is always what you pay (never more cashback than comes back).
 * Outcomes that land on the same cent read the same, so they're one row with their chances summed. Input is ordered
 * most expensive first, as pricedOutcomes gives it; so is the result.
 */
export const shownOutcomes = (maxPrice: number, outcomes: ReadonlyArray<{ price: number; pct: number; chanceBps: number }>) => {
  const now = centsUp(maxPrice)
  const rows: Array<ShownOutcome> = []
  for (const o of outcomes) {
    const price = centsUp(o.price)
    const same = rows.find((r) => r.price === price)
    if (same) {
      same.chanceBps += o.chanceBps
      same.samePct &&= same.pct === o.pct
    } else rows.push({ price, cashback: now - price, pct: o.pct, samePct: true, chanceBps: o.chanceBps })
  }
  return rows
}

/**
 * Cart lines in whole cents that add up to the cart's total shown (rounded up): each line is its exact amount rounded
 * up, then the lines closest to their lower cent give a cent back until the sum matches, so each stays within a cent of
 * exact. "Each" (rounded up, like the line) only where count × each is the line shown.
 */
export const cartCents = (lines: ReadonlyArray<{ total: number; count: number; each?: number | undefined }>) => {
  const cents = lines.map((l) => centsUp(l.total))
  let over = cents.reduce((s, c) => s + c, 0) - centsUp(lines.reduce((s, l) => s + l.total, 0))
  const byRemainder = lines.map((_, i) => i).filter((i) => lines[i]!.total % 10_000 > 0).sort((a, b) => (lines[a]!.total % 10_000) - (lines[b]!.total % 10_000))
  for (const i of byRemainder) {
    if (over <= 0) break
    cents[i]!--
    over--
  }
  return lines.map((l, i) => {
    const each = l.each === undefined ? undefined : centsUp(l.each)
    return { cents: cents[i]!, each: each !== undefined && l.count > 1 && each * l.count === cents[i] ? each : undefined }
  })
}

export { tokenAmount }
/** What arrives, rounded down like tokenAmount; an amount below a stablecoin's cent reads "under 0.01", never "0.00". */
export const receivedAmount = (formatted: string, symbol: string) => {
  const shown = tokenAmount(formatted, symbol, "down")
  return Number(shown) === 0 && Number(formatted) > 0 ? "under 0.01" : shown
}
/** "$200.00 a purchase, $1,000.00 a day"; a limit that's off says so instead of an amount. */
export const limitsText = (per: number | string, daily: number | string) =>
  noLimit(per) && noLimit(daily)
    ? "No limits"
    : `${noLimit(per) ? "No per-purchase limit" : `${usd(per)} a purchase`}, ${noLimit(daily) ? "no daily limit" : `${usd(daily)} a day`}`
/** "12.5" USDC → micro-USDC, without floating point. NaN if it isn't an amount or is too big to be exact. */
export const toMicro = (usdc: string) => {
  const m = /^(\d+)(?:\.(\d{0,6}))?$/.exec(usdc.trim())
  const v = m ? Number(m[1]) * 1e6 + Number((m[2] ?? "").padEnd(6, "0")) : NaN
  return Number.isSafeInteger(v) ? v : NaN
}
/**
 * What an amount field keeps of what was typed: digits and the decimal point. Phones set to a region that writes
 * "12,5" show only "," on the decimal keypad, so a lone comma is the decimal point; so is the Arabic decimal mark
 * (U+066B) or a full-width comma (U+FF0C), which would otherwise be dropped and make the amount ten times larger. A
 * comma with any other separator is left as typed for toMicro to refuse: a wrong guess at thousands separators
 * changes an amount a thousandfold.
 */
export const typedAmount = (typed: string) => {
  const kept = typed.replace(/[\u066B\uFF0C]/g, ",").replace(/[^\d.,]/g, "")
  return /^[^.,]*,[^.,]*$/.test(kept) ? kept.replace(",", ".") : kept
}
const YOCTO = 10n ** 24n
/** "1.5" NEAR → yoctoNEAR, without floating point; undefined if it isn't an amount. */
export const toYocto = (near: string) => {
  const m = /^(\d+)(?:\.(\d{0,24}))?$/.exec(near.trim())
  return m ? BigInt(m[1]!) * YOCTO + BigInt((m[2] ?? "").padEnd(24, "0")) : undefined
}
/** micro-USDC → "5.555555" for an amount field: exact, trailing zeros trimmed, so toMicro(dollars(m)) === m. */
export const dollars = (micro: number) => {
  const s = String(micro).padStart(7, "0")
  const frac = s.slice(-6).replace(/0+$/, "")
  return s.slice(0, -6) + (frac ? `.${frac}` : "")
}

/** Bitrefill's product logo on its brand colour, from their image CDN. */
export const productImage = (image: string, background: string | undefined, size = 160) =>
  `https://www.bitrefill.com/content/cn/b_rgb%3A${(background ?? "#FFFFFF").replace("#", "")}%2Cc_pad%2Ch_${size}%2Cw_${size}/v1/${image}.webp`

/** Only plain https links from Redemption Data become clickable. */
export const safeLink = (link: string | undefined) => {
  try {
    return link && new URL(link).protocol === "https:" ? link : undefined
  } catch {
    return undefined
  }
}
