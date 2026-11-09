import { usd, usdUp } from "@/lib/format"
import { loadDraw } from "@/lib/proof"
import { ImageResponse } from "next/og"

export const size = { width: 1200, height: 630 }
export const contentType = "image/png"
export const alt = "A Luckout Draw"

const INK = "#13161D"
const PAPER = "#F5F2EA"
const GOLD = "#E9B949"
const MUTED = "#B9BDC7"

/** Space Grotesk Bold as TTF (next/og can't read woff2); falls back to the default font. */
const grotesk = () =>
  fetch("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700")
    .then((r) => r.text())
    .then((css) => fetch(/src: url\((.+?)\) format\('(?:truetype|opentype)'\)/.exec(css)![1]!))
    .then((r) => r.arrayBuffer())
    .catch(() => undefined)

// Win Card (ADR-0005): shared link previews show the price paid, never Redemption Data.
export default async function Image({ params }: { params: Promise<{ tx: string }> }) {
  const [draw, font] = await Promise.all([loadDraw((await params).tx).then((d) => d.draw, () => undefined), grotesk()])
  const ref = draw ? Number(draw.reference_price) : 0
  const paid = draw ? Number(draw.final_price) : 0
  const win = draw !== undefined && paid < ref

  return new ImageResponse(
    (
      <div style={{ fontFamily: font ? "Space Grotesk" : undefined, width: "100%", height: "100%", background: INK, color: PAPER, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 72 }}>
        <div style={{ fontSize: 30, letterSpacing: 6, color: GOLD, fontWeight: 700 }}>LUCKOUT</div>
        {win
          ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ fontSize: 120, fontWeight: 800, color: GOLD, lineHeight: 1 }}>{paid === 0 ? "Free." : `Paid ${usdUp(paid)}`}</div>
              <div style={{ fontSize: 48, color: PAPER }}>{`for a ${usd(ref)} gift card.`}</div>
            </div>
          )
          : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ fontSize: 96, fontWeight: 800, lineHeight: 1 }}>Checkout, but lucky.</div>
              <div style={{ fontSize: 44, color: MUTED }}>Every draw can be recomputed by anyone.</div>
            </div>
          )}
        <div style={{ fontSize: 28, color: MUTED }}>Draw Proof · recompute it in your browser</div>
      </div>
    ),
    { ...size, ...(font ? { fonts: [{ name: "Space Grotesk", data: font, weight: 700 as const }] } : {}) }
  )
}
