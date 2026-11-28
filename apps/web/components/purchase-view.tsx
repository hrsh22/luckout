"use client"

import { GiftCard } from "@/components/gift-card"
import { HelpLink } from "@/components/help-link"
import { Button, buttonVariants } from "@/components/ui/button"
import { useWalletActions } from "@/lib/actions"
import { api, errorMessage } from "@/lib/api"
import { backText, usd, usdDown, usdUp } from "@/lib/format"
import { modeName } from "@/lib/modes"
import { explorer } from "@/lib/chain"
import { useSession } from "@/lib/session"
import { modePalette } from "@/lib/palette"
import { purchasePollMs } from "@/lib/purchase-poll"
import { redemptionShown } from "@/lib/redemption"
import { marked, withPurchase } from "@/lib/used"
import type { Purchase, PurchasePage } from "@luckout/api"
import { type InfiniteData, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, CheckCheck, ChevronDown, Copy, ExternalLink, LifeBuoy, Link2, LoaderCircle, ShieldCheck, Undo2 } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import Link from "next/link"
import { useEffect, useState } from "react"
import { toast } from "sonner"

/** "50 INR": the Face Value with its currency, when the purchase kept it (older ones didn't). */
const faceValue = (p: Purchase) => (p.currency ? `${p.value} ${p.currency}` : p.value)

/**
 * Follows a purchase until it settles, starting from what the buy returned, so the page never shows a stale
 * "in progress". A failed check is tried again at the next interval: one network error must not leave a
 * charged customer on "Getting your code".
 */
export function usePolledPurchase(p: Purchase | undefined, token: string | undefined) {
  return useQuery({
    // Under "purchases", so whatever re-reads the list (a cancel, a reclaim, a new buy) re-reads this too.
    queryKey: ["purchases", token, p?.id],
    queryFn: () => api((c) => c.purchases.get({ params: { id: p!.id } }), token),
    enabled: !!p && !!token,
    initialData: p,
    refetchInterval: (q) => purchasePollMs(q.state.data)
  }).data
}

/**
 * The program admitted it, so its price has left the Balance. A card waiting for our gift card supply may have been
 * admitted already (the server's restock): then it can't be cancelled, and if it can't be delivered the full amount
 * returns to the Balance.
 */
export const charged = (p: Purchase) => p.contractPurchaseId !== undefined

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
    ? "100% off!"
    : p.draw.cashback > 0
    ? backText(p.draw.cashback)
    : "No cashback this time"

/** The card right after buying: the result as a voucher with a cashback stub, then the code. */
export function PurchaseResult({ p, onAgain }: { p: Purchase; onAgain: () => void }) {
  // Until its Draw is recorded, a Lucky Buy has cost its Maximum Price.
  const paid = p.draw?.finalPrice ?? p.maxPrice ?? p.referencePrice
  // Below the price by a whole cent or more, rounded down: a saving is never shown as more than it is, nor as $0.00.
  const below = p.draw && p.referencePrice - p.draw.finalPrice >= 10_000
  const pal = modePalette(p.mode)
  const r = redemptionShown(p.redemption)
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
        <p className={`pill ${refunded ? "!bg-soft" : ""}`}>{p.voucherName}, {faceValue(p)}</p>
        <h2 className="font-display mt-4 text-5xl leading-none font-extrabold">{headline(p)}</h2>
        {p.status === "delivered" && (
          <p className="mt-2 text-[17px] opacity-85">
            You paid <b>{usdUp(paid)}</b> for a {usd(p.referencePrice)} card{below ? `, ${usdDown(p.referencePrice - paid)} less than the price` : ""}.
            {drawPending(p) && " Draw result pending."}
          </p>
        )}
        {p.status === "pending" && <Progress />}
        {p.status === "waiting" && <Waiting p={p} />}
        {p.error && <p className="mt-2 text-[15px] opacity-85">{p.error}</p>}
        {p.draw && (
          <>
            <div className="perforation mt-6 -mx-6 opacity-70" aria-hidden="true" />
            <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
              <div><dt className="opacity-70">Paid up front</dt><dd className="text-base font-semibold">{usdUp(p.maxPrice ?? paid)}</dd></div>
              <div><dt className="opacity-70">Cashback</dt><dd className="text-base font-semibold">{usdDown(p.draw.cashback)}</dd></div>
              <div><dt className="opacity-70">{modeName(p.mode)} roll</dt><dd className="text-base font-semibold">{p.draw.seed ? p.draw.roll : "—"}</dd></div>
            </dl>
          </>
        )}
      </div>

      <SafetyNet p={p} />

      {r.any && <CodeBlock p={p} />}

      {p.status === "delivered" && <UsedToggle p={p} />}

      {p.draw?.proof && <ProofLinks p={p} proof={p.draw.proof} />}

      <div className="flex flex-wrap gap-2">
        <Button variant="light" onClick={onAgain}>Buy another</Button>
        <Link href="/purchases" className={buttonVariants({ variant: "ghost" })}>All purchases</Link>
      </div>
    </motion.div>
  )
}

/** An honest wait: no fake steps, just time passing. Bitrefill sends the code once it sees our payment on Solana, usually within a minute (ADR-0015). */
export function Progress() {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="mt-4 flex flex-col gap-2">
      <div className="h-1.5 overflow-hidden rounded-full bg-white/50">
        <motion.div className="h-full rounded-full bg-current" initial={{ width: "4%" }} animate={{ width: "88%" }} transition={{ duration: 50, ease: [0.1, 0.6, 0.3, 1] }} />
      </div>
      <p className="text-sm opacity-80">Bitrefill sends the code once it sees our payment, usually within a minute. Then the Draw runs on Solana. {seconds}s</p>
    </div>
  )
}

const WAITING_TEXT =
  "We're topping up our gift card supply for this one: usually a few minutes, longer for big cards. You're only charged once it's ready, and you can cancel until then."
const CHARGED_WAITING_TEXT =
  "Paid from your balance. We're topping up our gift card supply for this one: usually a few minutes, longer for big cards. If it can't be delivered, the full amount returns to your balance."

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
 * We're topping up our gift card supply for this card: usually minutes, longer for a big card. Not yet admitted, the
 * customer is charged only once it's ready and can cancel until then; already admitted, it's paid and goes on by itself.
 */
function Waiting({ p }: { p: Purchase }) {
  return (
    <div className="mt-4 flex flex-col gap-2">
      <div className="relative h-1.5 overflow-hidden rounded-full bg-white/50">
        <motion.div
          className="absolute inset-y-0 w-1/3 rounded-full bg-current"
          animate={{ left: ["-33%", "100%"] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>
      <p className="text-[15px] opacity-85">{charged(p) ? CHARGED_WAITING_TEXT : WAITING_TEXT}</p>
      {!charged(p) && <CancelWaiting id={p.id} />}
    </div>
  )
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A paid card open longer than it should be. Neither delivered nor failed 24 hours after it was admitted, the full
 * amount is the customer's to take back (Reclaim), signed by them with no fee. The program checks the time itself, so
 * one asked a little early is refused, and nothing moves. A Draw needs nothing from them: anyone can finish it, and
 * our server does.
 */
function SafetyNet({ p }: { p: Purchase }) {
  const actions = useWalletActions()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const since = Date.now() - new Date(p.createdAt).getTime()
  if (p.status !== "pending" || !charged(p) || since < 10 * 60_000) return null
  const opens = new Date(p.createdAt).getTime() + DAY_MS
  if (since < DAY_MS) {
    return (
      <p className="flex items-start gap-2 text-sm text-muted">
        <LifeBuoy size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          Taking longer than usual. If it isn't delivered by {new Date(opens).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}, you can take back the full amount right here.{" "}
          <HelpLink href="/docs/refunds#reclaim">How Reclaim works</HelpLink>
        </span>
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-3 rounded-[1.25rem] bg-warn-soft p-4 text-warn sm:flex-row sm:items-center">
      <p className="flex-1 text-[15px] font-medium">This wasn't delivered within 24 hours, so the full amount you paid is yours to take back. <HelpLink href="/docs/refunds#reclaim">How Reclaim works</HelpLink></p>
      <Button size="sm" loading={busy} onClick={async () => {
        setBusy(true)
        if (await actions.reclaim(p.id)) await qc.invalidateQueries({ queryKey: ["purchases"] })
        setBusy(false)
      }}><LifeBuoy />Reclaim it</Button>
    </div>
  )
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" })
/** "Nov 20", with the year only when it isn't this one: short enough for a chip on a phone. */
const shortDay = (iso: string) => {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) })
}

/**
 * The customer's own note that they've used a delivered card, and its undo. It changes nothing about money or the Draw
 * and is one tap to reverse, so there's no confirmation: the toast offers Undo instead. While the request is out the
 * button stays focusable (aria-disabled, not disabled), so a keyboard user keeps their place as its label flips.
 */
function UsedToggle({ p, onChange }: { p: Purchase; onChange?: ((id: string) => void) | undefined }) {
  const { token } = useSession()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const used = !!p.usedAt
  const set = async (to: boolean) => {
    setBusy(true)
    try {
      const fresh = await api((c) => c.purchases.setUsed({ params: { id: p.id }, payload: { used: to } }), token)
      marked()
      qc.setQueriesData<InfiniteData<PurchasePage, string> | Purchase>({ queryKey: ["purchases"] }, (d) => withPurchase(d, fresh))
      onChange?.(p.id)
      const card = `${p.voucherName}, ${faceValue(p)}`
      // One toast per card: Undo replaces "Marked as used" rather than stacking under it. Sonner keeps a replaced
      // toast's fields, so "Marked as unused" clears the Undo explicitly (null).
      if (to) toast.success("Marked as used", { id: `used-${p.id}`, description: card, action: { label: "Undo", onClick: () => void set(false) } })
      else toast.success("Marked as unused", { id: `used-${p.id}`, description: card, action: null })
    } catch (e) {
      toast.error(errorMessage(e))
    }
    setBusy(false)
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-[1.25rem] bg-soft p-3 pl-4">
      <p className="flex min-w-0 items-center gap-2 text-sm text-ink-soft">
        {used
          ? <><CheckCheck size={16} className="shrink-0 text-ink" aria-hidden="true" /><span>You marked it used on <b className="font-semibold text-ink">{day(p.usedAt!)}</b>.</span></>
          : "Used this card? Mark it, to keep it apart from the ones you haven't."}
      </p>
      <Button
        size="sm"
        variant={used ? "light" : "primary"}
        aria-disabled={busy || !token || undefined}
        aria-busy={busy || undefined}
        onClick={() => !busy && token && void set(!used)}
        // The shared button turns the outline off; keyboard focus gets the app's ring back here.
        className="max-sm:w-full"
      >
        {busy ? <LoaderCircle className="animate-spin" /> : used ? <Undo2 /> : <Check />}
        {used ? "Mark as unused" : "Mark as used"}
      </Button>
    </div>
  )
}

export function CodeBlock({ p }: { p: Purchase }) {
  const r = redemptionShown(p.redemption)
  return (
    <div className="card flex flex-col gap-3 p-5">
      {r.secrets.map((f, i) => <Secret key={i} label={f.label} value={f.value} />)}
      {r.link && (
        <a href={r.link} target="_blank" rel="noreferrer noopener" className={`${buttonVariants({ variant: "soft", size: "sm" })} self-start`}>
          Open the voucher<ExternalLink />
        </a>
      )}
      {r.other && <p className="text-sm text-muted break-all">{r.other}</p>}
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

function ProofLinks({ p, proof: { tx, card } }: { p: Purchase; proof: { tx: string; card: number } }) {
  // One transaction can finish a whole Checkout's Draws (ADR-0013): the link names this card's.
  const proof = `/draw/${tx}?card=${card}`
  const share = () => {
    const url = `${window.location.origin}${proof}`
    navigator.clipboard.writeText(url).then(() => toast.success("Draw Proof link copied", { description: "Anyone can open it and check the Draw." }))
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link href={proof} className={buttonVariants({ variant: "soft", size: "sm" })}>
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

/** The mode a purchase was bought on, in that mode's colour. */
export function ModeChip({ mode }: { mode: Purchase["mode"] }) {
  const pal = modePalette(mode)
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold" style={{ background: pal.soft, color: pal.ink }}>
      <span className="size-2 rounded-full" style={{ background: pal.solid }} />{modeName(mode)}
    </span>
  )
}

/**
 * One line of history; open it for the code and the proof. A card marked used reads as done: greyed and stamped with a
 * check, its price quiet, and a "Used" mark with the day. Opened, its code is all there, as on any other card.
 */
export function PurchaseRow({ p, open, onToggle, onUsed }: { p: Purchase; open: boolean; onToggle: () => void; onUsed?: (id: string) => void }) {
  const used = !!p.usedAt
  const paid = p.draw?.finalPrice ?? p.maxPrice ?? p.referencePrice
  // Delivered, or still on its way after the program took its price: either way it has left the Balance, but the
  // second only for now (a card that can't be delivered returns it in full).
  const onItsWay = (p.status === "pending" || p.status === "waiting") && charged(p)
  return (
    <li className={`card overflow-hidden transition-[background-color,box-shadow] duration-300 ${used ? "bg-white/60 shadow-none ring-1 ring-line" : ""}`}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-4 p-4 text-left sm:p-5">
        <span className="relative shrink-0">
          <GiftCard
            v={{ name: p.voucherName, image: p.image, background: p.background }}
            notch={6}
            className={`h-12 w-[76px] rounded-xl text-[8px] transition-[filter,opacity] duration-300 ${used ? "opacity-55 grayscale" : ""}`}
          />
          {used && (
            <span className="absolute -right-1.5 -bottom-1.5 grid size-6 place-items-center rounded-full bg-ink text-white ring-[3px] ring-white" aria-hidden="true">
              <Check size={13} strokeWidth={3} />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`line-clamp-2 font-semibold break-words ${used ? "text-ink-soft" : ""}`}>{p.voucherName}, {faceValue(p)}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            {used && (
              <span className="inline-flex items-center gap-1 rounded-full bg-ink px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-white">
                <CheckCheck size={12} aria-hidden="true" />Used {shortDay(p.usedAt!)}
              </span>
            )}
            <ModeChip mode={p.mode} />
            {new Date(p.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          {p.status === "delivered"
            ? <span className={`font-display text-xl font-extrabold ${used ? "text-muted" : ""}`}>{usdUp(paid)}</span>
            : <span className={`text-sm font-semibold ${p.status === "pending" || p.status === "waiting" ? "animate-pulse text-ink" : "text-muted"}`}>{STATUS[p.status]}</span>}
          {p.draw && p.draw.cashback > 0 && (
            <span className={`rounded-full px-2 py-0.5 text-xs font-bold text-gold-ink ${used ? "bg-gold-soft" : "bg-gold"}`}>
              {p.draw.finalPrice === 0 ? "100% off" : backText(p.draw.cashback)}
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
                <div><dt className="text-muted">Cashback</dt><dd className="font-semibold">{p.draw ? usdDown(p.draw.cashback) : drawPending(p) ? "Draw result pending" : "None"}</dd></div>
                <div><dt className="text-muted">{onItsWay ? "Paid for now" : "You paid"}</dt><dd className="font-semibold">{p.status === "delivered" || onItsWay ? usdUp(paid) : "Nothing"}</dd></div>
              </dl>
              {p.error && <p className="text-sm text-muted">{p.error}</p>}
              <SafetyNet p={p} />
              {p.status === "pending" && <p className="text-sm text-muted">Bitrefill is delivering the code, usually within a minute. This updates by itself.</p>}
              {p.status === "waiting" && (
                <>
                  <p className="text-sm text-muted">{charged(p) ? CHARGED_WAITING_TEXT : WAITING_TEXT}</p>
                  {!charged(p) && <CancelWaiting id={p.id} />}
                </>
              )}
              {redemptionShown(p.redemption).any ? <CodeBlock p={p} /> : null}
              {p.status === "delivered" && <UsedToggle p={p} onChange={onUsed} />}
              {p.draw?.proof ? <ProofLinks p={p} proof={p.draw.proof} /> : p.settleTx && (
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
