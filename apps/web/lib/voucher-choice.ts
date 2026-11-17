import type { Mode } from "@luckout/api"
import { modeFromSlug, modeInfo } from "./modes.ts"

/**
 * The amount a card page opens on: the one in its link, priced at once while the card loads and kept if the card
 * sells it; otherwise the middle one. A shared or bookmarked link to an amount Bitrefill no longer sells must still
 * open a card that can be bought.
 */
export const openingAmount = (asked: string | null, packages: ReadonlyArray<{ value: string }> | undefined) =>
  asked !== null && (packages === undefined || packages.some((p) => p.value === asked))
    ? asked
    : packages?.[Math.floor((packages.length - 1) / 2)]?.value

/**
 * The mode a card page opens on: the link's, else the customer's Default Mode, else Normal. A Default Mode this
 * build doesn't know (a Game Version the owner registered after it was deployed) falls back to Normal, and
 * `unknownDefault` says so, so the page can tell the customer instead of failing.
 */
export const openingMode = (slug: string | null, preferred: Mode | undefined): { mode: Mode; unknownDefault: boolean } => {
  const linked = modeFromSlug(slug)
  if (linked) return { mode: linked, unknownDefault: false }
  if (preferred !== undefined && modeInfo(preferred)) return { mode: preferred, unknownDefault: false }
  return { mode: "normal", unknownDefault: preferred !== undefined }
}
