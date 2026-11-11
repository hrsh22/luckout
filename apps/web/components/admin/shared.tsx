"use client"

import { network } from "@/lib/chain"
import { motion } from "motion/react"

/** Signs with the admin's own wallet, toasts the result with a link, and refreshes. True if it went through. */
export type Tx = (pending: string, done: string, f: (accountId: string) => Promise<unknown>) => Promise<boolean>

/** Runs `f` if the signed-in account owns the contract; otherwise explains who must do it. */
export type AsOwner = (f: () => void) => () => void

export const ago = (iso: string) => {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  return min < 1 ? "just now" : min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`
}

export function Bar({ value, tone }: { value: number; tone: "good" | "warn" | "ink" }) {
  const bg = tone === "good" ? "bg-good" : tone === "warn" ? "bg-warn" : "bg-ink"
  return (
    <div className="h-2 overflow-hidden rounded-full bg-soft">
      <motion.div className={`h-full rounded-full ${bg}`} initial={{ width: 0 }} animate={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} transition={{ duration: 0.6 }} />
    </div>
  )
}

export function Toggle({ on, onChange, label, busy }: { on: boolean; onChange: (v: boolean) => void; label: string; busy?: boolean | undefined }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={busy}
      onClick={() => onChange(!on)}
      className={`relative h-8 w-14 shrink-0 rounded-full transition-colors duration-200 ${on ? "bg-good" : "bg-[#d6d3e2]"} disabled:opacity-60`}
    >
      <motion.span layout transition={{ type: "spring", stiffness: 600, damping: 35 }} className={`absolute top-1 size-6 rounded-full bg-white shadow ${on ? "right-1" : "left-1"}`} />
    </button>
  )
}

export const TONE = {
  good: "bg-good-soft! text-good",
  warn: "bg-warn-soft! text-warn",
  bad: "bg-bad-soft! text-bad",
  muted: "bg-soft! text-muted",
  busy: "bg-lilac-soft! text-ink"
} as const

/** wei → "0.0012" (ETH, at most 5 decimals). */
export const eth = (wei: string) => (Number(BigInt(wei) / 10n ** 12n) / 1e6).toFixed(5).replace(/0+$/, "").replace(/\.$/, "")

/** An address or transaction on Basescan (Base Sepolia on testnet), e.g. basescan(`tx/${hash}`). */
export const basescan = (path: string) => `https://${network === "testnet" ? "sepolia." : ""}basescan.org/${path}`
