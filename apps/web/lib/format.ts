const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
/** micro-USDC → "$5.53" (display only; amounts stay integers everywhere else). */
export const usd = (micro: number | string) => fmt.format(Number(micro) / 1e6)
/** What the customer pays, rounded up to the cent: never show less than what leaves their balance. */
export const usdUp = (micro: number | string) => fmt.format(Math.ceil(Number(micro) / 10_000) / 100)
/** A balance, rounded down to the cent: never show more than is there (prices round up, so the two add up). */
export const usdDown = (micro: number | string) => fmt.format(Math.floor(Number(micro) / 10_000) / 100)
/** "12.5" USDC → micro-USDC, without floating point. NaN if it isn't an amount or is too big to be exact. */
export const toMicro = (usdc: string) => {
  const m = /^(\d+)(?:\.(\d{0,6}))?$/.exec(usdc.trim())
  const v = m ? Number(m[1]) * 1e6 + Number((m[2] ?? "").padEnd(6, "0")) : NaN
  return Number.isSafeInteger(v) ? v : NaN
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
