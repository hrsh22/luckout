"use client"

import { shortAccount } from "@/components/avatar"
import { errorMessage } from "@/lib/api"
import { explorerAccount } from "@/lib/chain"
import { motion } from "motion/react"
import Link from "next/link"
import { usePathname } from "next/navigation"

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

/** A refresh failed: what is on screen is what last loaded, and the next refresh tries again. */
export function LastFigures({ error, className = "" }: { error: unknown; className?: string }) {
  return <p role="status" className={`text-sm text-warn ${className}`}>Couldn't refresh just now, so these are the last figures. {errorMessage(error)}</p>
}

export const TONE = {
  good: "bg-good-soft! text-good",
  warn: "bg-warn-soft! text-warn",
  bad: "bg-bad-soft! text-bad",
  muted: "bg-soft! text-muted",
  busy: "bg-lilac-soft! text-ink"
} as const

/** A purchase's step as the server names it, except a guest order paying Bitrefill from the Pay Wallet (ADR-0015). */
export const stepLabel = (step: string) => (step === "pay" ? "Paying Bitrefill" : step)

/** lamports → "0.0512" SOL */
export const sol = (lamports: string | number) => (Number(lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 })

/** A Solana address shortened, linked to Solana Explorer on this cluster. */
export const AddressLink = ({ address, full = false }: { address: string; full?: boolean }) => (
  <a href={explorerAccount(address)} target="_blank" rel="noreferrer" className="break-all underline underline-offset-2">{full ? address : shortAccount(address)}</a>
)

export function AdminTabs() {
  const path = usePathname()
  const tabs = [["/admin", "Control room"], ["/admin/purchases", "Purchases"], ["/admin/users", "Users"]] as const
  return (
    <nav aria-label="Admin" className="flex flex-wrap gap-2">
      {tabs.map(([href, label]) => (
        <Link key={href} href={href} aria-current={path === href ? "page" : undefined}
          className={`pill transition-colors ${path === href ? "bg-ink! text-white" : "bg-white/60! text-muted hover:bg-white! hover:text-ink"}`}>
          {label}
        </Link>
      ))}
    </nav>
  )
}
