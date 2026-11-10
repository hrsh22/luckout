"use client"

import { shortAccount } from "@/components/avatar"
import { AmountField } from "@/components/funds"
import { Money } from "@/components/money"
import { Button } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { api, errorMessage } from "@/lib/api"
import { network } from "@/lib/chain"
import { toMicro, usd } from "@/lib/format"
import { type Call, explorer, explorerAccount, send } from "@/lib/near"
import { useSession } from "@/lib/session"
import { type AdminOverview, CreditSettings, type RefillView } from "@luckout/api"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowUpRight, CircleAlert, Landmark, RefreshCw, Settings2, Store } from "lucide-react"
import { motion } from "motion/react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

// Bitrefill credit, the treasury and refills (ADR-0009). Credit settings and "refill now" are server
// actions any admin can take; the treasury's mode and moving proceeds into it are contract calls the
// owner signs in their own wallet.

/** Signs with the admin's own wallet, toasts the result with a link, and refreshes. True if it went through. */
export type Tx = (pending: string, done: string, f: (accountId: string) => Promise<unknown>) => Promise<boolean>

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

type Credit = AdminOverview["credit"]
type Treasury = AdminOverview["treasury"]

const STEP: Record<string, { label: string; tone: "good" | "warn" | "bad" | "muted" | "busy" }> = {
  invoice: { label: "Asking Bitrefill", tone: "busy" },
  quote: { label: "Getting a quote", tone: "busy" },
  fund: { label: "Funding the treasury", tone: "warn" },
  send: { label: "Sending to NEAR Intents", tone: "busy" },
  swapping: { label: "Swapping into our Base wallet", tone: "busy" },
  pay: { label: "Paying Bitrefill", tone: "busy" },
  crediting: { label: "Waiting for Bitrefill", tone: "busy" },
  done: { label: "Credited", tone: "good" },
  refunded: { label: "Refunded to the treasury", tone: "warn" },
  failed: { label: "Didn't go ahead", tone: "muted" },
  stuck: { label: "Needs a look", tone: "bad" },
  resolved: { label: "Resolved", tone: "muted" }
}
const TONE = {
  good: "bg-good-soft! text-good",
  warn: "bg-warn-soft! text-warn",
  bad: "bg-bad-soft! text-bad",
  muted: "bg-soft! text-muted",
  busy: "bg-lilac-soft! text-ink"
} as const

/** What the treasury is set to do, from what the server signs with and what the contract allows. */
const treasuryMode = (t: Treasury) =>
  !t.accountId ? "none" : t.contractTreasury !== t.accountId ? "mismatch" : t.dailyCap > 0 ? "auto" : "manual"

/** Saves credit settings (server-side, any admin) and announces the change. */
function useSaveCredit() {
  const { token } = useSession()
  const qc = useQueryClient()
  return async (next: CreditSettings, done: string) => {
    try {
      await api((c) => c.admin.credit({ payload: next }), token)
      toast.success(done)
      await qc.invalidateQueries({ queryKey: ["admin"] })
      return true
    } catch (e) {
      toast.error(errorMessage(e))
      return false
    }
  }
}

/** Runs `f` if the signed-in account owns the contract; otherwise explains who must do it. */
type AsOwner = (f: () => void) => () => void

export function CreditSection({ o, asOwner, tx }: { o: AdminOverview; asOwner: AsOwner; tx: Tx }) {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="font-display text-3xl font-extrabold">Bitrefill credit</h2>
        <p className="mt-1 max-w-[66ch] text-ink-soft">
          Every real card is paid from our USD credit at Bitrefill, which can't be refunded, so we keep only what recent sales need and refill it from the
          treasury through NEAR Intents.
        </p>
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-[1.5fr_1fr]">
        {o.network === "testnet"
          ? (
            <div className="card flex flex-col gap-3 p-7">
              <p className="flex items-center gap-2 text-ink-soft"><Store size={18} aria-hidden="true" />USD credit at Bitrefill</p>
              <p className="font-display text-3xl font-extrabold">Not used on testnet</p>
              <p className="text-ink-soft">
                Testnet sells only Bitrefill's test cards, which are free, so there's no credit to track, refill or alert on. On mainnet this shows the
                credit against its target, purchases waiting for it, and the settings.
              </p>
            </div>
          )
          : <CreditCard c={o.credit} ordersToday={o.purchases.bitrefillOrders} cap={o.purchases.bitrefillCap} />}
        <TreasuryCard o={o} asOwner={asOwner} tx={tx} />
      </div>
      {o.refills.length > 0 && <RefillsCard refills={o.refills} />}
    </section>
  )
}

function CreditCard({ c, ordersToday, cap }: { c: Credit; ordersToday: number; cap: number }) {
  const save = useSaveCredit()
  const [busy, setBusy] = useState(false)
  const [sheet, setSheet] = useState<"settings" | "refill">()
  const s = c.settings
  const balance = c.balance
  const scale = Math.max(s.ceiling, balance ?? 0, 1)
  const at = (v: number) => `${Math.min(100, Math.max(0, (v / scale) * 100))}%`
  const low = balance !== undefined && c.free < c.refillBelow

  return (
    <div className="card flex flex-col gap-6 p-7">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="flex items-center gap-2 text-ink-soft"><Store size={18} aria-hidden="true" />USD credit at Bitrefill</p>
          <p className="font-display mt-1 text-5xl font-extrabold tracking-[-0.03em]">
            {balance === undefined ? <span className="text-3xl text-muted">No answer yet</span> : <Money micro={balance} />}
          </p>
          <p className="mt-1 text-sm text-muted">
            {c.readAt ? `Read ${ago(c.readAt)}. ` : ""}
            {usd(c.free)} free to spend{c.held > 0 ? `, ${usd(c.held)} held for orders in progress` : ""}.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Toggle
            on={s.autoRefill}
            busy={busy}
            label="Refill automatically"
            onChange={async (autoRefill) => {
              setBusy(true)
              await save(new CreditSettings({ ...s, autoRefill }), autoRefill ? "Automatic refills on" : "Automatic refills off: you'll be told when to refill")
              setBusy(false)
            }}
          />
          <span className="text-xs text-muted">Auto</span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="relative h-3 rounded-full bg-soft">
          <motion.div
            className={`absolute inset-y-0 left-0 rounded-full ${low ? "bg-warn" : "bg-good"}`}
            initial={{ width: 0 }}
            animate={{ width: at(balance ?? 0) }}
            transition={{ duration: 0.7 }}
          />
          <span className="absolute -top-1 h-5 w-0.5 rounded-full bg-ink/40" style={{ left: at(c.refillBelow) }} aria-hidden="true" />
          <span className="absolute -top-1 h-5 w-0.5 rounded-full bg-ink" style={{ left: at(c.target) }} aria-hidden="true" />
        </div>
        <p className="flex flex-wrap justify-between gap-x-4 text-xs text-muted">
          <span>Refills under {usd(c.refillBelow)}</span>
          <span className="font-semibold text-ink">Aims for {usd(c.target)}</span>
          <span>Never above {usd(s.ceiling)}</span>
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <div><dt className="text-muted">Sales a day</dt><dd className="text-base font-semibold">{usd(c.avgDaily)}</dd></div>
        <div><dt className="text-muted">Refilled today</dt><dd className="text-base font-semibold">{usd(c.refilledToday)} <span className="text-muted">of {usd(s.dailyRefill)}</span></dd></div>
        <div><dt className="text-muted">Waiting for credit</dt><dd className="text-base font-semibold">{c.waitingCount}{c.waitingCount > 0 ? ` (${usd(c.waitingTotal)})` : ""}</dd></div>
        <div><dt className="text-muted">Bitrefill orders</dt><dd className="text-base font-semibold">{ordersToday} <span className="text-muted">of {cap} today</span></dd></div>
      </dl>

      {!c.refillsAvailable
        ? <p className="rounded-[1.25rem] bg-soft p-4 text-sm text-ink-soft">{c.paused ?? "Refills aren't available here."}</p>
        : c.paused && (
          <p className="flex items-start gap-2 rounded-[1.25rem] bg-warn-soft p-4 text-sm text-warn">
            <CircleAlert size={18} className="mt-0.5 shrink-0" aria-hidden="true" />{c.paused}
          </p>
        )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!c.refillsAvailable} onClick={() => setSheet("refill")}><RefreshCw />Refill now</Button>
        <Button size="sm" variant="soft" onClick={() => setSheet("settings")}><Settings2 />Settings</Button>
      </div>

      <CreditSettingsSheet open={sheet === "settings"} onClose={() => setSheet(undefined)} s={s} />
      <RefillNowSheet open={sheet === "refill"} onClose={() => setSheet(undefined)} c={c} />
    </div>
  )
}

function CreditSettingsSheet({ open, onClose, s }: { open: boolean; onClose: () => void; s: CreditSettings }) {
  const save = useSaveCredit()
  const dollars = (m: number) => String(m / 1e6)
  const [f, setF] = useState({ floor: "", ceiling: "", dailyRefill: "", waitMinutes: "" })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setF({ floor: dollars(s.floor), ceiling: dollars(s.ceiling), dailyRefill: dollars(s.dailyRefill), waitMinutes: String(s.waitMinutes) })
  }, [open, s])
  const next = {
    floor: toMicro(f.floor),
    ceiling: toMicro(f.ceiling),
    dailyRefill: toMicro(f.dailyRefill),
    waitMinutes: Number(f.waitMinutes)
  }
  const valid = [next.floor, next.ceiling, next.dailyRefill].every((v) => v >= 0 && v <= 2_000_000_000) &&
    Number.isInteger(next.waitMinutes) && next.waitMinutes >= 5 && next.waitMinutes <= 1440
  const fields: Array<{ key: keyof typeof f; label: string; hint: string; dollars: boolean }> = [
    { key: "floor", label: "Keep at least", hint: "Whatever sales did.", dollars: true },
    { key: "ceiling", label: "Never hold more than", hint: "The most that can sit unused at Bitrefill. A refill for orders already waiting may go past it: that credit is spent within minutes.", dollars: true },
    { key: "dailyRefill", label: "Refill at most, per day", hint: "Across all refills in 24 hours. Big orders wait for room here.", dollars: true },
    { key: "waitMinutes", label: "Minutes an order may wait", hint: "Up to 1440 (a day). Then it's cancelled, and the customer pays nothing.", dollars: false }
  ]
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title="Credit settings" description="The target is two days of recent sales, between the first two numbers.">
      <div className="flex flex-col gap-4">
        {fields.map((x) => (
          <label key={x.key} className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold">{x.label}</span>
            <span className="relative">
              {x.dollars && <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 font-semibold text-muted">$</span>}
              <input className={`field ${x.dollars ? "pl-8!" : ""}`} inputMode="decimal" value={f[x.key]} onChange={(e) => setF({ ...f, [x.key]: e.target.value.replace(/[^\d.]/g, "") })} />
            </span>
            <span className="text-xs text-muted">{x.hint}</span>
          </label>
        ))}
        <Button size="lg" loading={busy} disabled={!valid} onClick={async () => {
          setBusy(true)
          if (await save(new CreditSettings({ autoRefill: s.autoRefill, ...next }), "Credit settings saved")) onClose()
          setBusy(false)
        }}>
          Save settings
        </Button>
      </div>
    </Sheet>
  )
}

function RefillNowSheet({ open, onClose, c }: { open: boolean; onClose: () => void; c: Credit }) {
  const { token } = useSession()
  const qc = useQueryClient()
  const suggested = Math.max(10_000_000, Math.min(c.settings.ceiling, c.target + c.waitingTotal) - c.free)
  const [amount, setAmount] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setAmount(String(Math.ceil(suggested / 10_000) / 100))
  }, [open, suggested])
  const micro = toMicro(amount)
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title="Refill now" description="Paid from the treasury, which pulls from the proceeds if it's automatic. It never takes the credit above the ceiling.">
      <div className="flex flex-col gap-5">
        <AmountField
          label="Credit to add in USD"
          value={amount}
          onChange={setAmount}
          picks={[{ label: `Suggested ${usd(suggested)}`, micro: Math.ceil(suggested / 10_000) * 10_000 }, { label: "$25", micro: 25_000_000 }, { label: "$100", micro: 100_000_000 }]}
        />
        <Button size="lg" loading={busy} disabled={!(micro >= 10_000_000)} onClick={async () => {
          setBusy(true)
          try {
            const r = await api((x) => x.admin.refill({ payload: { amount: micro } }), token)
            toast.success(`Refill of ${usd(r.amount)} started`, { description: "It shows below as it moves; usually a minute or two." })
            await qc.invalidateQueries({ queryKey: ["admin"] })
            onClose()
          } catch (e) {
            toast.error(errorMessage(e))
          }
          setBusy(false)
        }}>
          {micro >= 10_000_000 ? `Refill ${usd(micro)}` : "At least $10"}
        </Button>
      </div>
    </Sheet>
  )
}

function TreasuryCard({ o, asOwner, tx }: { o: AdminOverview; asOwner: AsOwner; tx: Tx }) {
  const t = o.treasury
  const mode = treasuryMode(t)
  const [sheet, setSheet] = useState<"mode" | "move">()
  const pill = {
    none: { text: "Not set up", tone: TONE.muted },
    mismatch: { text: "Points elsewhere", tone: TONE.bad },
    auto: { text: "Automatic", tone: TONE.good },
    manual: { text: "Manual", tone: TONE.warn }
  }[mode]
  return (
    <div className="card flex flex-col gap-5 p-7">
      <div className="flex items-start justify-between gap-3">
        <p className="flex items-center gap-2 text-ink-soft"><Landmark size={18} aria-hidden="true" />Treasury</p>
        <span className={`pill ${pill.tone}`}>{pill.text}</span>
      </div>
      <div>
        <p className="font-display text-4xl font-extrabold tracking-[-0.02em]"><Money micro={t.usdc} /> <span className="text-lg font-bold text-muted">USDC</span></p>
        {t.accountId && (
          <a href={explorerAccount(t.accountId)} target="_blank" rel="noreferrer" className="text-sm text-muted underline-offset-2 hover:underline">{t.accountId}</a>
        )}
      </div>
      {t.wallet && <BaseWallet w={t.wallet} />}
      <p className="text-[15px] text-ink-soft">
        {mode === "none"
          ? "The server has no treasury key yet, so refills can't be paid."
          : mode === "mismatch"
          ? `The contract lets ${t.contractTreasury ?? "no one"} pull proceeds, but the server signs as ${t.accountId}. Point the contract at the server's treasury.`
          : mode === "auto"
          ? `Pulls only what each refill needs from the proceeds, up to ${usd(t.dailyCap)} a day. ${usd(t.sweptToday)} pulled today.`
          : "Refills wait for you to move proceeds in. You'll be told how much, here and in alerts."}
      </p>
      {t.needs !== undefined && t.needs > 0 && (
        <p className="flex items-start gap-2 rounded-[1.25rem] bg-warn-soft p-4 text-sm text-warn">
          <CircleAlert size={18} className="mt-0.5 shrink-0" aria-hidden="true" />A refill is waiting for {usd(t.needs)} in the treasury.
        </p>
      )}
      <div className="mt-auto flex flex-wrap gap-2">
        <Button size="sm" variant={mode === "mismatch" ? "primary" : "soft"} disabled={!t.accountId} onClick={asOwner(() => setSheet("mode"))}>
          {mode === "mismatch" ? "Fix it" : "Change mode"}
        </Button>
        <Button size="sm" variant={t.needs ? "primary" : "soft"} disabled={mode === "none" || mode === "mismatch" || !o.reserve.proceeds} onClick={asOwner(() => setSheet("move"))}>
          Move proceeds here
        </Button>
      </div>
      <TreasuryModeSheet open={sheet === "mode"} onClose={() => setSheet(undefined)} o={o} tx={tx} />
      <MoveProceedsSheet open={sheet === "move"} onClose={() => setSheet(undefined)} o={o} tx={tx} />
    </div>
  )
}

/**
 * Our wallet on Base: refills swap into it, then pay Bitrefill from it. It has no key of its own; the
 * treasury signs for it through NEAR Chain Signatures, so whoever controls the treasury controls it.
 */
function BaseWallet({ w }: { w: NonNullable<AdminOverview["treasury"]["wallet"]> }) {
  const low = BigInt(w.eth) < BigInt(w.alertBelow)
  const eth = (Number(BigInt(w.eth) / 10n ** 12n) / 1e6).toFixed(5)
  return (
    <div className="rounded-[1.25rem] bg-soft p-4 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold">Base wallet</span>
        <a href={`https://${network === "testnet" ? "sepolia." : ""}basescan.org/address/${w.address}`} target="_blank" rel="noreferrer" className="font-mono text-xs text-muted underline-offset-2 hover:underline">
          {w.address.slice(0, 6)}…{w.address.slice(-4)}
        </a>
      </div>
      <p className="mt-1 text-ink-soft"><Money micro={w.usdc} /> USDC waiting · {eth} ETH for gas</p>
      {low && (
        <p className="mt-2 flex items-start gap-2 text-warn">
          <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />Low on gas: send about $1 of ETH on Base to {w.address}, or refills stop.
        </p>
      )}
    </div>
  )
}

function TreasuryModeSheet({ open, onClose, o, tx }: { open: boolean; onClose: () => void; o: AdminOverview; tx: Tx }) {
  const t = o.treasury
  const [auto, setAuto] = useState(true)
  const [cap, setCap] = useState("")
  useEffect(() => {
    if (!open) return
    setAuto(treasuryMode(t) !== "manual")
    setCap(String((t.dailyCap || o.credit.settings.dailyRefill) / 1e6))
  }, [open, t, o.credit.settings.dailyRefill])
  const capMicro = toMicro(cap)
  const call = (daily: number): Call => ({
    receiverId: o.contract.id,
    method: "set_treasury",
    args: { treasury: t.accountId, daily_cap: String(daily) },
    deposit: "1"
  })
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title="Treasury mode" description={`The contract will let ${t.accountId ?? "the treasury"} pull proceeds, and nothing else.`}>
      <div className="flex flex-col gap-4">
        {[
          { value: true, title: "Automatic", body: "Refills pull exactly what they need from the proceeds, up to a daily cap. No taps." },
          { value: false, title: "Manual", body: "Nothing is pulled. When a refill needs money you move proceeds in yourself, with one approval." }
        ].map((m) => (
          <button
            key={m.title}
            type="button"
            role="radio"
            aria-checked={auto === m.value}
            onClick={() => setAuto(m.value)}
            className="rounded-[1.5rem] p-5 text-left shadow-[inset_0_0_0_1.5px_var(--color-line)] transition-shadow aria-checked:shadow-[inset_0_0_0_2.5px_var(--color-ink)]"
          >
            <p className="font-semibold">{m.title}</p>
            <p className="mt-1 text-sm text-ink-soft">{m.body}</p>
          </button>
        ))}
        {auto && (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold">Most it may pull in a day</span>
            <span className="relative">
              <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 font-semibold text-muted">$</span>
              <input className="field pl-8!" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value.replace(/[^\d.]/g, ""))} />
            </span>
            <span className="text-xs text-muted">If the server were ever compromised, this is the most proceeds it could take in a day.</span>
          </label>
        )}
        <Button size="lg" disabled={auto && !(capMicro > 0)} onClick={async () => {
          const daily = auto ? capMicro : 0
          if (await tx("Saving the treasury mode", auto ? `Automatic, up to ${usd(daily)} a day` : "Manual: proceeds move only when you sign", (id) => send(id, call(daily)))) onClose()
        }}>
          {auto ? `Allow up to ${capMicro > 0 ? usd(capMicro) : "…"} a day` : "Switch to manual"}
        </Button>
      </div>
    </Sheet>
  )
}

function MoveProceedsSheet({ open, onClose, o, tx }: { open: boolean; onClose: () => void; o: AdminOverview; tx: Tx }) {
  const t = o.treasury
  const available = o.reserve.proceeds
  const suggested = Math.min(available, t.needs && t.needs > 0 ? t.needs : o.credit.target)
  const [amount, setAmount] = useState("")
  useEffect(() => {
    if (open) setAmount(String(Math.ceil(suggested / 10_000) / 100))
  }, [open, suggested])
  const micro = toMicro(amount)
  const ok = micro > 0 && micro <= available
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title="Move proceeds to the treasury" description={`${usd(available)} of proceeds. The contract sends it only to ${t.accountId}.`}>
      <div className="flex flex-col gap-5">
        <AmountField
          label="Amount to move in USDC"
          value={amount}
          onChange={setAmount}
          picks={[
            ...(t.needs && t.needs > 0 ? [{ label: `What's needed ${usd(t.needs)}`, micro: t.needs }] : []),
            { label: `A target's worth ${usd(o.credit.target)}`, micro: Math.min(available, o.credit.target) }
          ]}
        />
        <Button size="lg" disabled={!ok} onClick={async () => {
          if (await tx(`Moving ${usd(micro)} to the treasury`, `${usd(micro)} moved to the treasury`, (id) =>
            send(id, { receiverId: o.contract.id, method: "withdraw_proceeds", args: { amount: String(micro), to_treasury: true }, deposit: "1", tgas: 60 }))) onClose()
        }}>
          {micro > available ? `Only ${usd(available)} available` : `Move ${micro > 0 ? usd(micro) : ""}`}
        </Button>
      </div>
    </Sheet>
  )
}

function RefillsCard({ refills }: { refills: ReadonlyArray<RefillView> }) {
  const [resolving, setResolving] = useState<RefillView>()
  return (
    <div className="card flex flex-col gap-4 p-7">
      <h3 className="font-display text-2xl font-extrabold">Refills</h3>
      <ul className="flex flex-col divide-y divide-line">
        {refills.map((r) => {
          const step = STEP[r.step] ?? { label: r.step, tone: "muted" as const }
          return (
            <li key={r.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-semibold">
                  {usd(r.amount)}
                  <span className={`pill ${TONE[step.tone]}`}>
                    {step.tone === "busy" && <motion.span className="size-1.5 rounded-full bg-current" animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.2, repeat: Infinity }} />}
                    {step.label}
                  </span>
                  <span className="text-sm font-normal text-muted">{r.reason === "waiting" ? "for a waiting order" : r.reason === "manual" ? "by hand" : "to the target"} · {ago(r.createdAt)}</span>
                </p>
                {r.error && <p className="mt-1 line-clamp-2 text-sm text-ink-soft">{r.error}</p>}
              </div>
              <div className="flex shrink-0 gap-2">
                {r.sendTx && (
                  <a href={explorer(r.sendTx)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-semibold text-ink-soft hover:text-ink">
                    Payment<ArrowUpRight size={14} />
                  </a>
                )}
                {r.step === "stuck" && <Button size="sm" variant="light" onClick={() => setResolving(r)}>Mark resolved</Button>}
              </div>
            </li>
          )
        })}
      </ul>
      <ResolveSheet refill={resolving} onClose={() => setResolving(undefined)} />
    </div>
  )
}

function ResolveSheet({ refill, onClose }: { refill: RefillView | undefined; onClose: () => void }) {
  const { token } = useSession()
  const qc = useQueryClient()
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => setNote(""), [refill])
  return (
    <Sheet
      open={refill !== undefined}
      onOpenChange={(v) => !v && onClose()}
      title="Resolve this refill"
      description={refill ? `${usd(refill.amount)}, ${shortAccount(refill.id)}. Check 1Click's status and Bitrefill's credit first: automatic refills start again once it's resolved.` : undefined}
    >
      <div className="flex flex-col gap-4">
        {refill?.error && <p className="rounded-[1.25rem] bg-soft p-4 text-sm text-ink-soft">{refill.error}</p>}
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold">What you found</span>
          <textarea className="field min-h-24 py-3" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Bitrefill credited it by hand after support ticket 1234" />
        </label>
        <Button size="lg" loading={busy} disabled={note.trim().length < 3} onClick={async () => {
          if (!refill) return
          setBusy(true)
          try {
            await api((c) => c.admin.resolveRefill({ params: { id: refill.id }, payload: { note: note.trim() } }), token)
            toast.success("Resolved; automatic refills can run again")
            await qc.invalidateQueries({ queryKey: ["admin"] })
            onClose()
          } catch (e) {
            toast.error(errorMessage(e))
          }
          setBusy(false)
        }}>
          Mark resolved
        </Button>
      </div>
    </Sheet>
  )
}
