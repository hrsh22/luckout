import type { Mode } from "@luckout/api"
import type { CSSProperties } from "react"

export interface Palette {
  /** Gradient for big tiles. */
  tile: string
  /** Text on the tile. */
  ink: string
  /** Pale wash for chips and selected states on white. */
  soft: string
  /** Flat colour for dots and bars. */
  solid: string
  orb: readonly [string, string, string]
}

const sky: Palette = { tile: "linear-gradient(160deg,#C2E6FF,#7CC7FF 60%,#4AA8EE)", ink: "#0B2A45", soft: "#E2F4FF", solid: "#7CC7FF", orb: ["#E0F7FF", "#7CC7FF", "#3A8FD8"] }
const lime: Palette = { tile: "linear-gradient(160deg,#E4FFAE,#C4F26A 58%,#A7E23E)", ink: "#243300", soft: "#EEFBD6", solid: "#B5E655", orb: ["#F4FFD9", "#C4F26A", "#7FB81F"] }
const lilac: Palette = { tile: "linear-gradient(160deg,#CDBCFF,#A98BFF 60%,#8C67FF)", ink: "#1D1240", soft: "#EEE8FF", solid: "#A98BFF", orb: ["#F1EBFF", "#A98BFF", "#6F4BEA"] }
const tang: Palette = { tile: "linear-gradient(160deg,#FFB788,#FF8A4C 58%,#FF6F3D)", ink: "#2A1206", soft: "#FFF1E8", solid: "#FF8A4C", orb: ["#FFE3CC", "#FF8A4C", "#E2561C"] }
const pink: Palette = { tile: "linear-gradient(160deg,#FFC6E2,#FF90C9 58%,#FF6FB5)", ink: "#3D0F26", soft: "#FFE3F1", solid: "#FF90C9", orb: ["#FFE4F3", "#FF90C9", "#E0539A"] }

/** Each mode keeps its colour on every screen: shop, onboarding, receipts, history. */
export const modePalette = (m: Mode | undefined): Palette =>
  m === undefined || m === "normal" ? sky : [lime, lilac, tang][m.lucky] ?? lilac

const all = [tang, lilac, lime, sky, pink]

/** A stable colour for an account id, for its avatar. */
export function keyPalette(key: string) {
  let hash = 0
  for (const char of key.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return all[hash % all.length]!
}

export const orbVars = (p: Palette) => ({ "--orb-hi": p.orb[0], "--orb": p.orb[1], "--orb-lo": p.orb[2] }) as CSSProperties
