const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
/** micro-USDC → "$5.53" (display only; amounts stay integers everywhere else). */
export const usd = (micro: number | string) => fmt.format(Number(micro) / 1e6)
/** "12.5" USDC → micro-USDC, without floating point. */
export const toMicro = (usdc: string) => {
  const m = /^(\d+)(?:\.(\d{0,6}))?$/.exec(usdc.trim())
  return m ? Number(m[1]) * 1e6 + Number((m[2] ?? "").padEnd(6, "0")) : NaN
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
