"use client"

import { RefillsCard } from "@/components/admin/refills"
import { type AsOwner, ago, Bar, Toggle, type Tx } from "@/components/admin/shared"
import { TreasuryCard } from "@/components/admin/treasury"
import { AmountField } from "@/components/funds"
import { Money } from "@/components/money"
import { Button } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { api, errorMessage } from "@/lib/api"
import { dollars, toMicro, usd } from "@/lib/format"
import { useSession } from "@/lib/session"
import { type AdminOverview, CreditSettings } from "@luckout/api"
import { useQueryClient } from "@tanstack/react-query"
import { CircleAlert, Mail, RefreshCw, Settings2, Store, Wallet } from "lucide-react"
import { motion } from "motion/react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

// Bitrefill credit, the treasury and refills (ADR-0009); with guest checkout (ADR-0012), the Base Float
// instead, since credit is retired. Credit settings and "refill now" are server actions any admin can
// take; the treasury's mode and moving proceeds into it are contract calls the owner signs in their own wallet.

/** With guest checkout, `credit` describes the Base Float: the Base Wallet's USDC. */
type Credit = AdminOverview["credit"]

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

export function CreditSection({ o, asOwner, tx }: { o: AdminOverview; asOwner: AsOwner; tx: Tx }) {
  const guest = o.checkout.guest
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="font-display text-3xl font-extrabold">{guest ? "Base Float" : "Bitrefill credit"}</h2>
        <p className="mt-1 max-w-[66ch] text-ink-soft">
          {guest
            ? "USDC in our Base Wallet that pays each card's Bitrefill invoice. We keep about a day of sales there and refill it from the treasury through NEAR Intents."
            : "Every real card is paid from our USD credit at Bitrefill, which can't be refunded, so we keep only what recent sales need and refill it from the treasury through NEAR Intents."}
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
          : <CreditCard c={o.credit} guest={guest} ordersToday={o.purchases.bitrefillOrders} cap={o.purchases.bitrefillCap} />}
        <TreasuryCard o={o} asOwner={asOwner} tx={tx} />
      </div>
      {guest && <CheckoutCard c={o.checkout} />}
      {o.refills.length > 0 && <RefillsCard refills={o.refills} guest={guest} />}
    </section>
  )
}

/** Guest checkout (ADR-0012): Bitrefill's limits count per Checkout Email, so the busiest one shows how close anyone is. */
function CheckoutCard({ c }: { c: AdminOverview["checkout"] }) {
  const rows = [
    { label: "Cards today", used: c.busiest.orders, cap: c.limits.orders, show: String },
    { label: "Spent today", used: c.busiest.daily, cap: c.limits.daily, show: usd },
    { label: "Spent in 30 days", used: c.busiest.monthly, cap: c.limits.monthly, show: usd }
  ]
  return (
    <div className="card flex flex-col gap-5 p-7">
      <div>
        <p className="flex items-center gap-2 text-ink-soft"><Mail size={18} aria-hidden="true" />Checkout</p>
        <p className="font-display mt-1 text-2xl font-extrabold">Guest checkout through Bitrefill's MCP</p>
        <p className="mt-1 text-sm text-muted">
          Each card carries its customer's Checkout Email, and Bitrefill limits each email to {c.limits.orders} cards and {usd(c.limits.daily)} a day,{" "}
          {usd(c.limits.monthly)} a month. {c.emails} {c.emails === 1 ? "customer has" : "customers have"} given one, and {c.connected}{" "}
          {c.connected === 1 ? "buys" : "buy"} on their own Bitrefill account instead, under its limits.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <p className="text-sm font-semibold">The busiest email</p>
        <div className="grid gap-4 sm:grid-cols-3">
          {rows.map((r) => (
            <div key={r.label} className="flex flex-col gap-1.5">
              <p className="flex justify-between gap-2 text-sm">
                <span className="text-muted">{r.label}</span>
                <span className="font-semibold">{r.show(r.used)} <span className="font-normal text-muted">of {r.show(r.cap)}</span></span>
              </p>
              <Bar value={r.cap > 0 ? r.used / r.cap : 0} tone={r.used >= r.cap * 0.8 ? "warn" : "good"} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function CreditCard({ c, guest, ordersToday, cap }: { c: Credit; guest: boolean; ordersToday: number; cap: number }) {
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
          <p className="flex items-center gap-2 text-ink-soft">
            {guest ? <><Wallet size={18} aria-hidden="true" />USDC in our Base Wallet</> : <><Store size={18} aria-hidden="true" />USD credit at Bitrefill</>}
          </p>
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

      <dl className={`grid grid-cols-2 gap-4 text-sm ${guest ? "sm:grid-cols-3" : "sm:grid-cols-4"}`}>
        <div><dt className="text-muted">Sales a day</dt><dd className="text-base font-semibold">{usd(c.avgDaily)}</dd></div>
        <div><dt className="text-muted">Refilled today</dt><dd className="text-base font-semibold">{usd(c.refilledToday)} <span className="text-muted">of {usd(s.dailyRefill)}</span></dd></div>
        <div><dt className="text-muted">Waiting for {guest ? "the float" : "credit"}</dt><dd className="text-base font-semibold">{c.waitingCount}{c.waitingCount > 0 ? ` (${usd(c.waitingTotal)})` : ""}</dd></div>
        {!guest && <div><dt className="text-muted">Bitrefill orders</dt><dd className="text-base font-semibold">{ordersToday} <span className="text-muted">of {cap} today</span></dd></div>}
      </dl>
      {!guest && balance !== undefined && (
        <p className="-mt-2 text-sm text-muted">Bitrefill lets our account hold {usd(c.room)} more; the biggest card we can buy right now is {usd(Math.max(0, c.free) + c.room)}.</p>
      )}

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

      <CreditSettingsSheet open={sheet === "settings"} onClose={() => setSheet(undefined)} s={s} guest={guest} />
      <RefillNowSheet open={sheet === "refill"} onClose={() => setSheet(undefined)} c={c} guest={guest} />
    </div>
  )
}

function CreditSettingsSheet({ open, onClose, s, guest }: { open: boolean; onClose: () => void; s: CreditSettings; guest: boolean }) {
  const save = useSaveCredit()
  const [f, setF] = useState({ floor: "", ceiling: "", refillBelow: "", dailyRefill: "", waitMinutes: "", baseFloat: "" })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) {
      setF({
        floor: dollars(s.floor),
        ceiling: dollars(s.ceiling),
        refillBelow: dollars(s.refillBelow ?? 0),
        dailyRefill: dollars(s.dailyRefill),
        waitMinutes: String(s.waitMinutes),
        baseFloat: dollars(s.baseFloat ?? 0)
      })
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const next = {
    floor: toMicro(f.floor),
    ceiling: toMicro(f.ceiling),
    refillBelow: toMicro(f.refillBelow),
    dailyRefill: toMicro(f.dailyRefill),
    waitMinutes: Number(f.waitMinutes),
    baseFloat: toMicro(f.baseFloat)
  }
  const valid = [next.floor, next.ceiling, next.refillBelow, next.dailyRefill, next.baseFloat].every((v) => v >= 0 && v <= 2_000_000_000) &&
    Number.isInteger(next.waitMinutes) && next.waitMinutes >= 5 && next.waitMinutes <= 1440
  // With guest checkout these govern the Base Float itself, so its separate "Keep ready on Base" is hidden (and saved unchanged).
  const it = guest ? "the float" : "credit"
  const fields: Array<{ key: keyof typeof f; label: string; hint: string; dollars: boolean }> = [
    { key: "floor", label: "Top up to at least", hint: `Each refill brings ${it} back to at least this, whatever sales did.`, dollars: true },
    {
      key: "ceiling",
      label: "Never hold more than",
      hint: guest
        ? "The most that can sit unused in the Base Wallet. A refill for orders already waiting may go past it: that USDC is spent within minutes."
        : "The most that can sit unused at Bitrefill. A refill for orders already waiting may go past it: that credit is spent within minutes.",
      dollars: true
    },
    { key: "refillBelow", label: "Refill when below", hint: `A refill starts once ${it} falls under this, so a big card's worth stays ready and small sales don't each start one. At least $10 under the first number; 0 refills at half the target.`, dollars: true },
    { key: "dailyRefill", label: "Refill at most, per day", hint: "Across all refills in 24 hours. Big orders wait for room here.", dollars: true },
    { key: "waitMinutes", label: "Minutes an order may wait", hint: "Up to 1440 (a day). Then it's cancelled, and the customer pays nothing.", dollars: false },
    {
      key: "baseFloat",
      label: "Keep ready on Base",
      hint: "USDC in our Base wallet, so a refill pays Bitrefill in a minute instead of waiting on a swap. Topped back up by itself; 0 turns it off. It's ours, unlike Bitrefill credit.",
      dollars: true
    }
  ]
  return (
    <Sheet
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title={guest ? "Float settings" : "Credit settings"}
      description={guest ? "The target is a day of recent sales, between the first two numbers." : "The target is a day of recent sales with a Base float (two without), between the first two numbers."}
    >
      <div className="flex flex-col gap-4">
        {fields.filter((x) => !(guest && x.key === "baseFloat")).map((x) => (
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
          if (await save(new CreditSettings({ autoRefill: s.autoRefill, ...next }), guest ? "Float settings saved" : "Credit settings saved")) onClose()
          setBusy(false)
        }}>
          Save settings
        </Button>
      </div>
    </Sheet>
  )
}

function RefillNowSheet({ open, onClose, c, guest }: { open: boolean; onClose: () => void; c: Credit; guest: boolean }) {
  const { token } = useSession()
  const qc = useQueryClient()
  const suggested = Math.max(10_000_000, Math.min(c.settings.ceiling, c.target + c.waitingTotal) - c.free)
  const [amount, setAmount] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setAmount(dollars(Math.ceil(suggested / 10_000) * 10_000))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const micro = toMicro(amount)
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title="Refill now" description={`Paid from the treasury, which pulls from the proceeds if it's automatic. It never takes ${guest ? "the float" : "the credit"} above the ceiling.`}>
      <div className="flex flex-col gap-5">
        <AmountField
          label={guest ? "USDC to add to the float" : "Credit to add in USD"}
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
