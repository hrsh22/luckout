import type { Mode } from "@luckout/api"

const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
/** micro-USDC → "$5.53" (display only; amounts stay integers everywhere else). */
export const usd = (micro: number | string) => fmt.format(Number(micro) / 1e6)
/** "12.5" USDC → micro-USDC, without floating point. */
export const toMicro = (usdc: string) => {
  const m = /^(\d+)(?:\.(\d{0,6}))?$/.exec(usdc.trim())
  return m ? Number(m[1]) * 1e6 + Number((m[2] ?? "").padEnd(6, "0")) : NaN
}

export const MODES = [
  { mode: "normal" as Mode, name: "Normal", premium: "", line: "Pay the price. No draw." },
  { mode: { lucky: 0 } as Mode, name: "Classic", premium: "+10%", line: "4% chance to pay less, best case half price." },
  { mode: { lucky: 1 } as Mode, name: "Bold", premium: "+25%", line: "18% chance to pay less, best case free." },
  { mode: { lucky: 2 } as Mode, name: "Jackpot", premium: "+50%", line: "25% chance to pay less, best case free." }
]
export const modeName = (m: Mode | undefined) =>
  MODES.find((x) => JSON.stringify(x.mode) === JSON.stringify(m))?.name ?? "Default"
export const sameMode = (a: Mode | undefined, b: Mode | undefined) => JSON.stringify(a) === JSON.stringify(b)
