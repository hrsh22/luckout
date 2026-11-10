"use client"

import { Button, buttonVariants } from "@/components/ui/button"
import { api } from "@/lib/api"
import { safeLink, usd, usdUp } from "@/lib/format"
import { modeName } from "@/lib/modes"
import { explorer } from "@/lib/near"
import { keyPalette, modePalette } from "@/lib/palette"
import type { Purchase } from "@luckout/api"
import { Check, ChevronDown, Copy, ExternalLink, Link2, ShieldCheck } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import Link from "next/link"
import { useEffect, useState } from "react"
import { toast } from "sonner"

/** Follows a pending purchase until it settles, so the page never shows a stale "in progress". */
export function usePolledPurchase(p: Purchase | undefined, token: string | undefined) {
  const [live, setLive] = useState(p)
  useEffect(() => setLive(p), [p])
  useEffect(() => {
    if (!live || (live.status !== "pending" && live.status !== "waiting") || !token) return
    const t = setTimeout(() => {
      api((c) => c.purchases.get({ params: { id: live.id } }), token).then(setLive, () => {})
    }, live.status === "waiting" ? 5000 : 3000)
    return () => clearTimeout(t)
  }, [live, token])
  return live
}

const redemption = (p: Purchase) => {
  const text = (k: string) => (typeof p.redemption?.[k] === "string" ? (p.redemption[k] as string) : undefined)
  return { code: text("code"), pin: text("pin"), link: safeLink(text("link")), instructions: text("instructions") }
}

/** What happened, in one line: the result first, then the price it's measured against. */
const headline = (p: Purchase) =>
  p.status === "pending"
    ? "Getting your code"
    : p.status === "waiting"
    ? "A few minutes"
    : p.status === "failed"
    ? "Not delivered, refunded"
    : p.status === "rejected"
    ? "Not bought"
    : !p.draw
    ? "Delivered"
    : p.draw.finalPrice === 0
    ? "Free!"
    : p.draw.cashback > 0
    ? `${usd(p.draw.cashback)} back`
    : "No cashback this time"

/** The card right after buying: the result as a voucher with a cashback stub, then the code. */
export function PurchaseResult({ p, onAgain }: { p: Purchase; onAgain: () => void }) {
  const paid = p.draw ? p.draw.finalPrice : p.referencePrice
  const below = p.draw && p.draw.finalPrice < p.referencePrice
  const pal = modePalette(p.mode)
  const r = redemption(p)
  const refunded = p.status === "failed" || p.status === "rejected"
  return (
    <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 260, damping: 26 }} className="flex flex-col gap-4">
      <div
        className={`voucher relative overflow-hidden rounded-[1.75rem] p-6 ${refunded ? "shadow-card" : ""}`}
        style={{
          background: refunded ? "#fff" : below ? "linear-gradient(160deg,#FFE7A3,#FFC53D 60%,#FFB21F)" : pal.tile,
          color: refunded ? undefined : below ? "#3d2800" : pal.ink,
          ["--notch-y" as string]: "68%"
        }}
      >
        <p className={`pill ${refunded ? "!bg-soft" : ""}`}>{p.voucherName}, {p.value}</p>
        <h2 className="font-display mt-4 text-5xl leading-none font-extrabold">{headline(p)}</h2>
        {p.status === "delivered" && (
          <p className="mt-2 text-[17px] opacity-85">
            You paid <b>{usdUp(paid)}</b> for a {usd(p.referencePrice)} card{below ? `, ${usd(p.referencePrice - paid)} less than the price` : ""}.
          </p>
        )}
        {p.status === "pending" && <Progress />}
        {p.status === "waiting" && <Waiting />}
        {p.error && <p className="mt-2 text-[15px] opacity-85">{p.error}</p>}
        {p.draw && (
          <>
            <div className="perforation mt-6 -mx-6 opacity-70" aria-hidden="true" />
            <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
              <div><dt className="opacity-70">Paid up front</dt><dd className="text-base font-semibold">{usdUp(p.maxPrice ?? paid)}</dd></div>
              <div><dt className="opacity-70">Cashback</dt><dd className="text-base font-semibold">{usd(p.draw.cashback)}</dd></div>
              <div><dt className="opacity-70">{modeName(p.mode)} roll</dt><dd className="text-base font-semibold">{p.draw.roll}</dd></div>
            </dl>
          </>
        )}
      </div>

      {(r.code || r.pin || r.link) && <CodeBlock p={p} />}

      {p.draw && p.settleTx && <ProofLinks p={p} />}

      <div className="flex flex-wrap gap-2">
        <Button variant="light" onClick={onAgain}>Buy another</Button>
        <Link href="/purchases" className={buttonVariants({ variant: "ghost" })}>All purchases</Link>
      </div>
    </motion.div>
  )
}

/** An honest wait: no fake steps, just time passing. Purchases usually take 5 to 15 seconds. */
export function Progress() {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="mt-4 flex flex-col gap-2">
      <div className="h-1.5 overflow-hidden rounded-full bg-white/50">
        <motion.div className="h-full rounded-full bg-current" initial={{ width: "4%" }} animate={{ width: "88%" }} transition={{ duration: 14, ease: [0.1, 0.6, 0.3, 1] }} />
      </div>
      <p className="text-sm opacity-80">Bitrefill sends the code, then the Draw runs on NEAR. {seconds}s</p>
    </div>
  )
}

/**
 * We're topping up our Bitrefill credit for this card (ADR-0009). Usually a minute or two; the
 * customer pays nothing if it can't be done in time.
 */
function Waiting() {
  return (
    <div className="mt-4 flex flex-col gap-2">
      <div className="relative h-1.5 overflow-hidden rounded-full bg-white/50">
        <motion.div
          className="absolute inset-y-0 w-1/3 rounded-full bg-current"
          animate={{ left: ["-33%", "100%"] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>
      <p className="text-[15px] opacity-85">
        We're topping up our gift card supply for this one. This page updates by itself, and if it can't be done in time you won't pay anything.
      </p>
    </div>
  )
}

export function CodeBlock({ p }: { p: Purchase }) {
  const r = redemption(p)
  return (
    <div className="card flex flex-col gap-3 p-5">
      {r.code && <Secret label="Code" value={r.code} />}
      {r.pin && <Secret label="PIN" value={r.pin} />}
      {r.link && (
        <a href={r.link} target="_blank" rel="noreferrer noopener" className={`${buttonVariants({ variant: "soft", size: "sm" })} self-start`}>
          Open the voucher<ExternalLink />
        </a>
      )}
      {r.instructions && <p className="text-sm text-muted">{r.instructions}</p>}
    </div>
  )
}

function Secret({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm text-muted">{label}</p>
        <p className="font-mono text-lg font-semibold break-all select-all">{value}</p>
      </div>
      <Button
        variant={copied ? "soft" : "light"}
        size="sm"
        onClick={() => navigator.clipboard.writeText(value).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1800)))}
        aria-label={`Copy ${label.toLowerCase()}`}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={String(copied)} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} className="flex items-center gap-1.5">
            {copied ? <><Check />Copied</> : <><Copy />Copy</>}
          </motion.span>
        </AnimatePresence>
      </Button>
    </div>
  )
}

function ProofLinks({ p }: { p: Purchase }) {
  const share = () => {
    const url = `${window.location.origin}/draw/${p.settleTx}`
    navigator.clipboard.writeText(url).then(() => toast.success("Draw Proof link copied", { description: "Anyone can open it and check the Draw." }))
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link href={`/draw/${p.settleTx}`} className={buttonVariants({ variant: "soft", size: "sm" })}>
        <ShieldCheck />Check this Draw
      </Link>
      {p.draw && p.draw.cashback > 0 && (
        <Button variant="soft" size="sm" onClick={share}><Link2 />Copy share link</Button>
      )}
      {p.settleTx && (
        <a href={explorer(p.settleTx)} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          Transaction<ExternalLink />
        </a>
      )}
    </div>
  )
}

const STATUS: Record<Purchase["status"], string> = {
  pending: "In progress",
  waiting: "Getting it ready",
  delivered: "Delivered",
  failed: "Refunded",
  rejected: "Not bought"
}

/** One line of history; open it for the code and the proof. */
export function PurchaseRow({ p, open, onToggle }: { p: Purchase; open: boolean; onToggle: () => void }) {
  const paid = p.draw ? p.draw.finalPrice : p.referencePrice
  const pal = modePalette(p.mode)
  const tile = keyPalette(p.voucherName)
  return (
    <li className="card overflow-hidden">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-4 p-4 text-left sm:p-5">
        <span className="voucher font-display grid h-12 w-[76px] shrink-0 place-items-center rounded-xl text-xl font-extrabold" style={{ background: tile.tile, color: tile.ink, ["--notch" as string]: "6px" }} aria-hidden="true">
          {p.voucherName.trim()[0]?.toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{p.voucherName}, {p.value}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold" style={{ background: pal.soft, color: pal.ink }}>
              <span className="size-2 rounded-full" style={{ background: pal.solid }} />{modeName(p.mode)}
            </span>
            {new Date(p.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          {p.status === "delivered"
            ? <span className="font-display text-xl font-extrabold">{usdUp(paid)}</span>
            : <span className={`text-sm font-semibold ${p.status === "pending" || p.status === "waiting" ? "animate-pulse text-ink" : "text-muted"}`}>{STATUS[p.status]}</span>}
          {p.draw && p.draw.cashback > 0 && (
            <span className="rounded-full bg-gold px-2 py-0.5 text-xs font-bold text-gold-ink">
              {p.draw.finalPrice === 0 ? "Free" : `${usd(p.draw.cashback)} back`}
            </span>
          )}
        </span>
        <ChevronDown size={18} className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 34 }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-4 border-t border-line p-4 sm:p-5">
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div><dt className="text-muted">Price</dt><dd className="font-semibold">{usd(p.referencePrice)}</dd></div>
                <div><dt className="text-muted">Paid up front</dt><dd className="font-semibold">{usdUp(p.maxPrice ?? p.referencePrice)}</dd></div>
                <div><dt className="text-muted">Cashback</dt><dd className="font-semibold">{p.draw ? usd(p.draw.cashback) : "None"}</dd></div>
                <div><dt className="text-muted">You paid</dt><dd className="font-semibold">{p.status === "delivered" ? usdUp(paid) : "Nothing"}</dd></div>
              </dl>
              {p.error && <p className="text-sm text-muted">{p.error}</p>}
              {p.status === "pending" && <p className="text-sm text-muted">Bitrefill is delivering the code. This updates by itself.</p>}
              {p.status === "waiting" && (
                <p className="text-sm text-muted">We're topping up our gift card supply for this one; usually a few minutes. If it can't be done in time you won't pay anything.</p>
              )}
              {redemption(p).code || redemption(p).pin || redemption(p).link ? <CodeBlock p={p} /> : null}
              {p.draw && p.settleTx ? <ProofLinks p={p} /> : p.settleTx && (
                <a href={explorer(p.settleTx)} target="_blank" rel="noreferrer" className={`${buttonVariants({ variant: "ghost", size: "sm" })} self-start`}>
                  Delivery transaction<ExternalLink />
                </a>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  )
}
