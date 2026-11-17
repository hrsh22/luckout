// Only Effect-free entry points here: the landing page formats prices, and the root of @luckout/api would
// pull the whole API schema into it.
import { noLimit } from "@luckout/api/limits"

const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
/** micro-USDC → "$5.53" (display only; amounts stay integers everywhere else). */
export const usd = (micro: number | string) => fmt.format(Number(micro) / 1e6)
/** What the customer pays, rounded up to the cent: never show less than what leaves their balance. */
export const usdUp = (micro: number | string) => fmt.format(Math.ceil(Number(micro) / 10_000) / 100)
/** A balance, rounded down to the cent: never show more than is there (prices round up, so the two add up). */
export const usdDown = (micro: number | string) => fmt.format(Math.floor(Number(micro) / 10_000) / 100)

export { tokenAmount } from "@luckout/api/intents"
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
