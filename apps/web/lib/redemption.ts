import { redemptionFields } from "@luckout/api"
import { safeLink } from "./format.ts"

/**
 * A card's Redemption Data as the purchase view shows it: its labelled secrets, a link only if it's plain https, and
 * Bitrefill's expiry date when it has one. `any` says there's something to show: some cards carry nothing but free
 * text or instructions, and a paid card must never show just "Delivered".
 */
export const redemptionShown = (data: Readonly<Record<string, unknown>> | undefined) => {
  const r = redemptionFields(data)
  const expires = r.expires && !Number.isNaN(Date.parse(r.expires)) ? new Date(r.expires) : undefined
  const link = safeLink(r.link)
  return { ...r, link, expires, any: r.secrets.length > 0 || !!link || !!r.other || !!r.instructions }
}
