"use client"

import { GiftCard } from "@/components/gift-card"
import { Button, buttonVariants } from "@/components/ui/button"
import { useWalletActions } from "@/lib/actions"
import { api, errorMessage } from "@/lib/api"
import { safeLink, usd, usdUp } from "@/lib/format"
import { modeName } from "@/lib/modes"
import { contractId, explorer, view } from "@/lib/near"
import { useSession } from "@/lib/session"
import { modePalette } from "@/lib/palette"
import type { Purchase } from "@luckout/api"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ChevronDown, Copy, ExternalLink, LifeBuoy, Link2, ShieldCheck } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import Link from "next/link"
import { useEffect, useState } from "react"
import { toast } from "sonner"

/** Follows a pending purchase until it settles, so the page never shows a stale "in progress"; once a minute after 15 minutes (stuck). */
export function usePolledPurchase(p: Purchase | undefined, token: string | undefined) {
  const [live, setLive] = useState(p)
  useEffect(() => setLive(p), [p])
  useEffect(() => {
    if (!live || (live.status !== "pending" && live.status !== "waiting") || !token) return
    const t = setTimeout(() => {
      api((c) => c.purchases.get({ params: { id: live.id } }), token).then(setLive, () => {})
    }, Date.now() - new Date(live.createdAt).getTime() > 15 * 60_000 ? 60_000 : live.status === "waiting" ? 5000 : 3000)
    return () => clearTimeout(t)
  }, [live, token])
  return live
}

const redemption = (p: Purchase) => {
  const text = (k: string) => (typeof p.redemption?.[k] === "string" ? (p.redemption[k] as string) : undefined)
  // Bitrefill's expiry date, when the card has one.
  const expiry = text("expiration_date")
  const expires = expiry && !Number.isNaN(Date.parse(expiry)) ? new Date(expiry) : undefined
  return { code: text("code"), pin: text("pin"), link: safeLink(text("link")), instructions: text("instructions"), expires }
}

/** A delivered Lucky Buy whose Draw isn't recorded yet. */
const drawPending = (p: Purchase) => p.status === "delivered" && !p.draw && typeof p.mode === "object"

/** What happened, in one line: the result first, then the price it's measured against. */
const headline = (p: Purchase) =>
  p.status === "pending"
    ? "Getting your code"
    : p.status === "waiting"
    ? "Getting it ready"
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
  // Until its Draw is recorded, a Lucky Buy has cost its Maximum Price.
  const paid = p.draw?.finalPrice ?? p.maxPrice ?? p.referencePrice
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
            {drawPending(p) && " Draw result pending."}
          </p>
        )}
        {p.status === "pending" && <Progress />}
        {p.status === "waiting" && <Waiting id={p.id} />}
        {p.error && <p className="mt-2 text-[15px] opacity-85">{p.error}</p>}
        {p.draw && (
          <>
            <div className="perforation mt-6 -mx-6 opacity-70" aria-hidden="true" />
            <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
              <div><dt className="opacity-70">Paid up front</dt><dd className="text-base font-semibold">{usdUp(p.maxPrice ?? paid)}</dd></div>
              <div><dt className="opacity-70">Cashback</dt><dd className="text-base font-semibold">{usd(p.draw.cashback)}</dd></div>
              <div><dt className="opacity-70">{modeName(p.mode)} roll</dt><dd className="text-base font-semibold">{p.draw.seed ? p.draw.roll : "—"}</dd></div>
            </dl>
          </>
        )}
      </div>

      <SafetyNet p={p} />

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

const WAITING_TEXT =
  "We're topping up our gift card supply for this one: usually a few minutes, longer for big cards. You're only charged once it's ready, and you can cancel until then."

/** Cancels a purchase still waiting for credit; nothing was charged. The page's polling shows the result. */
function CancelWaiting({ id }: { id: string }) {
  const { token } = useSession()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  return (
    <Button size="sm" variant="light" className="self-start" loading={busy} disabled={!token} onClick={async () => {
      setBusy(true)
      try {
        await api((c) => c.purchases.cancel({ params: { id } }), token)
        toast.success("Cancelled. You weren't charged.")
        await qc.invalidateQueries({ queryKey: ["purchases"] })
      } catch (e) {
        toast.error(errorMessage(e))
      }
      setBusy(false)
    }}>
      Cancel
    </Button>
  )
}

/**
 * We're topping up our Bitrefill credit for this card (ADR-0009): usually minutes, longer for a big
 * card. The customer is charged only once it's ready, and can cancel until then.
 */
function Waiting({ id }: { id: string }) {
  return (
    <div className="mt-4 flex flex-col gap-2">
      <div className="relative h-1.5 overflow-hidden rounded-full bg-white/50">
        <motion.div
          className="absolute inset-y-0 w-1/3 rounded-full bg-current"
          animate={{ left: ["-33%", "100%"] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>
      <p className="text-[15px] opacity-85">{WAITING_TEXT}</p>
      <CancelWaiting id={id} />
    </div>
  )
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A purchase open longer than it should be: read what the contract says, then offer the customer's
 * own way out. Undelivered for 24 hours → reclaim the full amount; delivered but its Draw never ran →
 * run it again. Both are the customer's own calls, which our relayer sends for free.
 */
function SafetyNet({ p }: { p: Purchase }) {
  const actions = useWalletActions()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const id = p.contractPurchaseId
  const late = Date.now() - new Date(p.createdAt).getTime() > 10 * 60_000
  const onchain = useQuery({
    queryKey: ["onchain-purchase", id],
    queryFn: () => view<{ status: string; created_at: number } | null>(contractId, "get_purchase", { purchase_id: id }),
    enabled: p.status === "pending" && id !== undefined && late,
    staleTime: 30_000
  })
  const o = onchain.data
  if (!o || id === undefined) return null
  const act = async (f: () => Promise<boolean>) => {
    setBusy(true)
    if (await f()) await Promise.all([qc.invalidateQueries({ queryKey: ["purchases"] }), qc.invalidateQueries({ queryKey: ["onchain-purchase", id] })])
    setBusy(false)
  }
  if (o.status === "Pending") {
    const opens = o.created_at / 1e6 + DAY_MS
    if (Date.now() < opens) {
      return (
        <p className="flex items-start gap-2 text-sm text-muted">
          <LifeBuoy size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          Taking longer than usual. If it isn't delivered by {new Date(opens).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}, you can take back the full amount right here.
        </p>
      )
    }
    return (
      <div className="flex flex-col gap-3 rounded-[1.25rem] bg-warn-soft p-4 text-warn sm:flex-row sm:items-center">
        <p className="flex-1 text-[15px] font-medium">This wasn't delivered within 24 hours, so the full amount you paid is yours to take back.</p>
        <Button size="sm" loading={busy} onClick={() => act(() => actions.reclaim(id))}><LifeBuoy />Reclaim it</Button>
      </div>
    )
  }
  if (o.status === "Drawing") {
    return (
      <div className="flex flex-col gap-3 rounded-[1.25rem] bg-lilac-soft p-4 sm:flex-row sm:items-center">
        <p className="flex-1 text-[15px] font-medium">Your card is delivered, but its Draw didn't run. Run it now: it's free.</p>
        <Button size="sm" loading={busy} onClick={() => act(() => actions.retryDraw(id))}>Run the Draw</Button>
      </div>
    )
  }
  return null
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
      {r.expires && <p className="text-sm text-muted">Use it by {r.expires.toLocaleDateString(undefined, { dateStyle: "long" })}.</p>}
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
  const paid = p.draw?.finalPrice ?? p.maxPrice ?? p.referencePrice
  const pal = modePalette(p.mode)
  return (
    <li className="card overflow-hidden">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-4 p-4 text-left sm:p-5">
        <GiftCard v={{ name: p.voucherName, image: p.image, background: p.background }} notch={6} className="h-12 w-[76px] shrink-0 rounded-xl text-[8px]" />
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
          {p.draw && p.draw.cashback === 0 && <span className="text-xs text-muted">No cashback</span>}
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
                <div><dt className="text-muted">Cashback</dt><dd className="font-semibold">{p.draw ? usd(p.draw.cashback) : drawPending(p) ? "Draw result pending" : "None"}</dd></div>
                <div><dt className="text-muted">You paid</dt><dd className="font-semibold">{p.status === "delivered" ? usdUp(paid) : "Nothing"}</dd></div>
              </dl>
              {p.error && <p className="text-sm text-muted">{p.error}</p>}
              <SafetyNet p={p} />
              {p.status === "pending" && <p className="text-sm text-muted">Bitrefill is delivering the code. This updates by itself.</p>}
              {p.status === "waiting" && (
                <>
                  <p className="text-sm text-muted">{WAITING_TEXT}</p>
                  <CancelWaiting id={p.id} />
                </>
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
