"use client"

import { shortAccount } from "@/components/avatar"
import { ago, Bar, CreditSection, Toggle, type Tx } from "@/components/admin-credit"
import { AmountField } from "@/components/funds"
import { Money } from "@/components/money"
import { SignInCard } from "@/components/sign-in-card"
import { Button, buttonVariants } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { faucetCall } from "@/lib/actions"
import { api, cancelled, errorMessage } from "@/lib/api"
import { toMicro, usd } from "@/lib/format"
import { type Call, explorer, explorerAccount, liveAverage, network, send, sendNear } from "@/lib/near"
import { useSession } from "@/lib/session"
import { type AdminOverview, type AttentionPurchase, RelaySettings } from "@luckout/api"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowUpRight, Check, CircleAlert, Fuel, Pause, Play, Plus, RotateCw, ShieldCheck, Zap } from "lucide-react"
import { motion } from "motion/react"
import Link from "next/link"
import { useEffect, useState } from "react"
import { toast } from "sonner"

// The admin panel (/admin). The server only answers whitelisted accounts, and everyone else sees
// the ordinary "No page here". Money never moves through the server: reserve, proceeds, the shop
// switch and gas are transactions signed in the admin's own wallet, and the contract checks the
// owner itself. The relayer's switch and caps are server settings.

const YOCTO = 10n ** 24n
/** yoctoNEAR → "1.25" */
const nearAmount = (yocto: string | bigint) => {
  const n = Number(BigInt(yocto) / 10n ** 18n) / 1e6
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 3 : 2 })
}
/** "1.5" NEAR → yoctoNEAR, without floating point. */
const toYocto = (s: string) => {
  const m = /^(\d+)(?:\.(\d{0,24}))?$/.exec(s.trim())
  return m ? BigInt(m[1]!) * YOCTO + BigInt((m[2] ?? "").padEnd(24, "0")) : undefined
}
const RUNBOOK = "https://github.com/hrsh22/luckout/blob/main/deploy/RUNBOOK.md#a-purchase-is-stuck"
/** Full cashback needs the Discount Cap (20% of free reserve) to reach the Cashback Cap. */
const capFor = (free: number) => Math.floor(free / 5)

export function AdminPanel() {
  const { accountId, token, ready } = useSession()
  const q = useQuery({
    queryKey: ["admin", token],
    queryFn: () => api((c) => c.admin.overview(), token),
    enabled: !!token,
    refetchInterval: 15_000,
    retry: false
  })

  if (ready && !accountId) {
    return <SignInCard title="Sign in to continue" body="Sign in with your NEAR wallet." />
  }
  if ((q.error as { _tag?: string } | null)?._tag === "NotFound") return <NoPage />
  if (q.error) return <p role="alert" className="font-medium text-bad">{errorMessage(q.error)}</p>
  if (!q.data) return <Loading />
  return <Dashboard o={q.data} />
}

function NoPage() {
  return (
    <div className="flex max-w-xl flex-col gap-6 py-10">
      <h1 className="font-display text-6xl leading-none font-extrabold tracking-[-0.03em]">No page here</h1>
      <p className="text-lg text-ink-soft">The link may be mistyped, or the page has moved.</p>
      <Link href="/shop" className={buttonVariants({ size: "lg", className: "self-start" })}>Go to the shop</Link>
    </div>
  )
}

function Loading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading">
      <div className="skeleton h-14 w-56 rounded-full" />
      <div className="grid gap-4 lg:grid-cols-4">
        <div className="skeleton h-64 rounded-[2.25rem] lg:col-span-2" />
        <div className="skeleton h-64 rounded-[2.25rem]" />
        <div className="skeleton h-64 rounded-[2.25rem]" />
      </div>
      <div className="grid gap-4 md:grid-cols-3">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-52 rounded-[1.75rem]" />)}</div>
    </div>
  )
}

/** Signs with the admin's own wallet (never the relayer), toasts the result with a link, and refreshes. */
function useAdminTx(): Tx {
  const { accountId, refresh } = useSession()
  const qc = useQueryClient()
  return async (pending: string, done: string, f: (accountId: string) => Promise<unknown>) => {
    if (!accountId) return false
    const id = toast.loading(pending, { description: "Approve it in your wallet." })
    try {
      const result = await f(accountId)
      const last = (Array.isArray(result) ? result.at(-1) : result) as { transaction?: { hash?: string } } | undefined
      const hash = last?.transaction?.hash
      toast.success(done, { id, description: undefined, ...(hash ? { action: { label: "View", onClick: () => window.open(explorer(hash), "_blank") } } : {}) })
      await Promise.all([qc.invalidateQueries({ queryKey: ["admin"] }), refresh().catch(() => {})])
      return true
    } catch (e) {
      if (cancelled(e)) toast("Cancelled in your wallet. Nothing was sent.", { id, description: undefined })
      else toast.error(errorMessage(e), { id, description: undefined })
      return false
    }
  }
}

type Open = "fund" | "withdraw-reserve" | "withdraw-proceeds" | "pause" | "owner" | { gas: AdminOverview["gas"][number] }

/** NEAR account ids: lowercase parts joined by dots, 2 to 64 characters. */
const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/

function Dashboard({ o }: { o: AdminOverview }) {
  const { accountId, token } = useSession()
  const qc = useQueryClient()
  const tx = useAdminTx()
  const [open, setOpen] = useState<Open>()
  const isOwner = accountId === o.contract.owner
  const proposedToMe = accountId !== undefined && o.contract.pendingOwner === accountId
  // Owner-only actions stay clickable: someone else learns why, instead of staring at a grey button.
  const asOwner = (f: () => void) => () =>
    isOwner
      ? f()
      : toast(`That needs the owner's wallet: ${o.contract.owner}`, {
        description: `You're signed in as ${shortAccount(accountId ?? "")}. Sign in with the owner's account to do this.`
      })
  const setSales = async (openSales: boolean) => {
    try {
      await api((c) => c.admin.sales({ payload: { open: openSales } }), token)
      toast.success(openSales ? "Sales restarted" : "Sales stopped: no new purchases until you restart them")
      await Promise.all([qc.invalidateQueries({ queryKey: ["admin"] }), qc.invalidateQueries({ queryKey: ["shop-status"] })])
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const contractCall = (method: string, args: object, tgas = 30): Call => ({ receiverId: o.contract.id, method, args, deposit: "1", tgas })
  const average = liveAverage({ lucky_settled: o.stats.luckySettled, lucky_amount_total: String(o.stats.luckyAmountTotal), lucky_paid_total: String(o.stats.luckyPaidTotal) })
  const close = () => setOpen(undefined)

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <span className="pill bg-white! text-ink"><ShieldCheck size={14} aria-hidden="true" />Admin</span>
            <span className={`pill ${o.network === "mainnet" ? "bg-bad-soft! text-bad" : "bg-gold-soft! text-gold-ink"}`}>{o.network}</span>
            <span className="pill bg-white!">{shortAccount(accountId ?? "")}{isOwner ? " · owner" : ""}</span>
            {isOwner && (
              <button type="button" className="pill bg-white/60! text-muted transition-colors hover:bg-white! hover:text-ink" onClick={() => setOpen("owner")}>
                Transfer ownership
              </button>
            )}
          </p>
          <h1 className="font-display mt-3 text-5xl leading-[0.95] font-extrabold tracking-[-0.03em] sm:text-[64px]">Control room</h1>
          {average !== undefined && (
            <p className="mt-2 text-ink-soft">
              Lucky buyers paid <b className="text-ink">{average.toFixed(1)}%</b> of price on average across {o.stats.luckySettled} draws (promised over time: 105.6%).
            </p>
          )}
        </div>
        <ShopControls
          salesStopped={o.salesStopped}
          paused={o.contract.paused}
          onSales={setSales}
          onPause={asOwner(() => setOpen("pause"))}
          onResume={asOwner(() => void tx("Resuming the contract", "The contract is running again", (id) => send(id, contractCall("set_paused", { paused: false }))))}
        />
      </header>

      {proposedToMe
        ? (
          <div className="flex flex-col gap-4 rounded-[1.5rem] bg-lilac-soft p-5 sm:flex-row sm:items-center">
            <p className="flex flex-1 items-start gap-3 text-[15px]">
              <ShieldCheck size={20} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                <b>{o.contract.owner}</b> proposed you as the contract's owner. Accept with your wallet to take over pausing, the reserve, proceeds and the
                treasury.
              </span>
            </p>
            <Button onClick={() => tx("Accepting ownership", "You own the contract now", (id) => send(id, contractCall("accept_owner", {})))}>
              Accept ownership
            </Button>
          </div>
        )
        : isOwner && o.contract.pendingOwner
        ? (
          <div className="flex flex-col gap-4 rounded-[1.5rem] bg-soft p-5 sm:flex-row sm:items-center">
            <p className="flex-1 text-[15px] text-ink-soft">
              You proposed <b className="text-ink">{o.contract.pendingOwner}</b> as owner. Nothing changes until they accept from their own wallet.
            </p>
            <Button variant="light" size="sm" onClick={() => tx("Withdrawing the proposal", "Proposal withdrawn", (id) => send(id, contractCall("propose_owner", { new_owner: null })))}>
              Withdraw the proposal
            </Button>
          </div>
        )
        : !isOwner && (
          <p className="flex items-start gap-3 rounded-[1.5rem] bg-lilac-soft p-5 text-[15px]">
            <CircleAlert size={20} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              The reserve, proceeds, the contract's pause and the treasury's mode need the owner's wallet, <b>{o.contract.owner}</b>. Any admin can stop
              sales, send gas, and change the relayer and credit settings.
            </span>
          </p>
        )}

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="relative overflow-hidden rounded-[2.25rem] bg-ink p-8 text-white lg:col-span-2">
          <div className="blob -top-24 -right-16 size-72 bg-lilac opacity-50" aria-hidden="true" />
          <div className="blob -bottom-32 left-24 size-64 bg-gold opacity-30" aria-hidden="true" />
          <div className="relative flex h-full flex-col">
            <p className="text-white/70">Cashback Reserve, free</p>
            <p className="font-display mt-1 text-6xl leading-none font-extrabold tracking-[-0.03em]"><Money micro={o.reserve.free} /></p>
            <p className="mt-3 text-sm text-white/65">
              {usd(o.reserve.locked)} locked in open lucky buys. One purchase can get up to {usd(Math.min(o.reserve.maxCashback, o.reserve.discountCap))} back
              {o.reserve.discountCap < o.reserve.maxCashback ? `: the reserve needs ${usd(o.reserve.maxCashback * 5)} free for the full ${usd(o.reserve.maxCashback)}.` : "."}
            </p>
            <div className="mt-auto flex flex-wrap gap-2 pt-8">
              <Button variant="gold" onClick={asOwner(() => setOpen("fund"))}><Plus />Fund</Button>
              <Button variant="onColor" className="text-white!" disabled={!o.reserve.free} onClick={asOwner(() => setOpen("withdraw-reserve"))}>Withdraw</Button>
            </div>
          </div>
        </div>

        <div className="card flex flex-col p-7">
          <p className="text-ink-soft">Proceeds</p>
          <p className="font-display mt-1 text-5xl font-extrabold tracking-[-0.03em]"><Money micro={o.reserve.proceeds} /></p>
          <p className="mt-2 text-sm text-muted">What customers paid for delivered cards. The treasury refills Bitrefill from it.</p>
          <div className="mt-auto pt-6">
            <Button variant="soft" disabled={!o.reserve.proceeds} onClick={asOwner(() => setOpen("withdraw-proceeds"))}>Withdraw</Button>
          </div>
        </div>

      </section>

      <CreditSection o={o} asOwner={asOwner} tx={tx} />

      <section className="flex flex-col gap-4">
        <SectionTitle title="Gas" body="NEAR our accounts spend on the network. Each alerts below its line; any admin can top it up." />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {o.gas.map((g) => <GasTile key={g.role} g={g} onSend={() => setOpen({ gas: g })} />)}
        </div>
      </section>

      <section className="grid items-start gap-4 lg:grid-cols-[1fr_1.25fr]">
        <RelayerCard r={o.relay} />
        <PurchasesCard p={o.purchases} />
      </section>

      <FundReserveSheet open={open === "fund"} onClose={close} o={o} tx={tx} />
      <WithdrawSheet
        open={open === "withdraw-reserve"}
        onClose={close}
        title="Withdraw from the reserve"
        available={o.reserve.free}
        to={o.contract.owner}
        preview={(m) => {
          const after = o.reserve.free - m
          return `Free reserve after: ${usd(after)}. Most cashback per purchase: ${usd(Math.min(o.reserve.maxCashback, capFor(after)))}.`
        }}
        onWithdraw={(m) => tx(`Withdrawing ${usd(m)} from the reserve`, `${usd(m)} sent to ${o.contract.owner}`, (id) =>
          send(id, contractCall("withdraw_reserve", { amount: String(m) }, 60)))}
      />
      <WithdrawSheet
        open={open === "withdraw-proceeds"}
        onClose={close}
        title="Withdraw proceeds"
        available={o.reserve.proceeds}
        to={o.contract.owner}
        preview={() => "Leave enough for Bitrefill refills: the treasury pulls them from here."}
        onWithdraw={(m) => tx(`Withdrawing ${usd(m)} of proceeds`, `${usd(m)} sent to ${o.contract.owner}`, (id) =>
          send(id, contractCall("withdraw_proceeds", { amount: String(m) }, 60)))}
      />
      <Sheet open={open === "pause"} onOpenChange={(v) => !v && close()} title="Pause the contract?">
        <div className="flex flex-col gap-5">
          <ul className="flex flex-col gap-2 text-ink-soft">
            <li>The contract refuses every new purchase, whoever sends it.</li>
            <li>Purchases already in progress still finish and draw.</li>
            <li>Withdrawals and reclaims keep working.</li>
            <li>For a quick stop, <b className="text-ink">Stop sales</b> needs no wallet. This is the hard stop.</li>
          </ul>
          <Button size="lg" variant="danger" onClick={async () => {
            close()
            await tx("Pausing the contract", "The contract is paused", (id) => send(id, contractCall("set_paused", { paused: true })))
          }}>
            <Pause />Pause the contract
          </Button>
        </div>
      </Sheet>
      <TransferOwnerSheet open={open === "owner"} onClose={close} o={o} tx={tx} contractCall={contractCall} />
      <SendNearSheet target={typeof open === "object" ? open.gas : undefined} onClose={close} tx={tx} />
    </div>
  )
}

function SectionTitle({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h2 className="font-display text-3xl font-extrabold">{title}</h2>
      <p className="mt-1 max-w-[62ch] text-ink-soft">{body}</p>
    </div>
  )
}

/**
 * Two ways to stop new purchases: Stop sales (any admin, on the server, instant) and the contract's
 * pause (the owner's wallet, the hard stop). The pill says which, if any, is on.
 */
function ShopControls({ salesStopped, paused, onSales, onPause, onResume }: {
  salesStopped: boolean
  paused: boolean
  onSales: (open: boolean) => Promise<void>
  onPause: () => void
  onResume: () => void
}) {
  const [busy, setBusy] = useState(false)
  const state = paused
    ? { text: "Contract paused", box: "bg-bad-soft text-bad", dot: "bg-bad" }
    : salesStopped
    ? { text: "Sales stopped", box: "bg-warn-soft text-warn", dot: "bg-warn" }
    : { text: "Shop open", box: "bg-good-soft text-good", dot: "bg-good" }
  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <div className={`flex items-center gap-3 rounded-full p-1.5 pl-5 ${state.box}`}>
        <span className="relative flex size-2.5" aria-hidden="true">
          {!paused && !salesStopped && <span className="absolute inline-flex size-full animate-ping rounded-full bg-good opacity-50" />}
          <span className={`relative inline-flex size-2.5 rounded-full ${state.dot}`} />
        </span>
        <span className="font-semibold">{state.text}</span>
        <Button size="sm" variant="light" loading={busy} onClick={async () => {
          setBusy(true)
          await onSales(salesStopped)
          setBusy(false)
        }}>
          {salesStopped ? <><Play />Restart sales</> : <><Pause />Stop sales</>}
        </Button>
      </div>
      <button type="button" className="px-2 text-sm text-muted underline-offset-4 hover:text-ink hover:underline" onClick={paused ? onResume : onPause}>
        {paused ? "Resume the contract" : "Pause the contract"} <span className="text-xs">(owner)</span>
      </button>
    </div>
  )
}

function TransferOwnerSheet({ open, onClose, o, tx, contractCall }: {
  open: boolean
  onClose: () => void
  o: AdminOverview
  tx: Tx
  contractCall: (method: string, args: object) => Call
}) {
  const [to, setTo] = useState("")
  useEffect(() => {
    if (open) setTo("")
  }, [open])
  const account = to.trim().toLowerCase()
  const valid = NEAR_ACCOUNT.test(account) && account !== o.contract.owner
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title="Transfer ownership" description="The new owner accepts from their own wallet, here in the admin panel. Nothing changes until they do.">
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold">New owner's NEAR account</span>
          <input className="field" value={to} onChange={(e) => setTo(e.target.value)} placeholder={o.network === "mainnet" ? "name.near" : "name.testnet"} autoCapitalize="none" spellCheck={false} />
          <span className="text-xs text-muted">The operator and the treasury can never own the contract; the contract refuses them.</span>
        </label>
        <Button size="lg" disabled={!valid} onClick={async () => {
          if (await tx(`Proposing ${account}`, `${account} can now accept ownership`, (id) => send(id, contractCall("propose_owner", { new_owner: account })))) onClose()
        }}>
          Propose {valid ? account : "the new owner"}
        </Button>
      </div>
    </Sheet>
  )
}

const GAS_COPY = {
  operator: { label: "Operator", purpose: "Sends every purchase and delivery." },
  treasury: { label: "Treasury", purpose: "Signs Bitrefill refills; holds only the USDC they need." },
  relayer: { label: "Relayer", purpose: "Pays customers' fees for deposits, withdrawals and settings." },
  contract: { label: "Contract storage", purpose: "Each purchase stores a record; storage is paid in NEAR." }
} as const

function GasTile({ g, onSend }: { g: AdminOverview["gas"][number]; onSend: () => void }) {
  const low = BigInt(g.spendable) < BigInt(g.alertBelow)
  // The bar is full at four times the alert line, so the line sits at a quarter.
  const fill = Number((BigInt(g.spendable) * 1000n) / (BigInt(g.alertBelow) * 4n)) / 1000
  return (
    <div className="card flex flex-col p-6">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 font-semibold"><Fuel size={18} className="text-muted" aria-hidden="true" />{GAS_COPY[g.role].label}</p>
        <span className={`pill ${low ? "bg-warn-soft! text-warn" : "bg-good-soft! text-good"}`}>{low ? "Low" : "OK"}</span>
      </div>
      <p className="mt-1 text-sm text-muted">{GAS_COPY[g.role].purpose}</p>
      <p className="font-display mt-5 text-4xl font-extrabold tracking-[-0.02em]">
        {nearAmount(g.spendable)} <span className="text-lg font-bold text-muted">NEAR</span>
      </p>
      <div className="relative mt-3">
        <Bar value={fill} tone={low ? "warn" : "good"} />
        <span className="absolute top-[-3px] left-1/4 h-3.5 w-0.5 rounded-full bg-ink/30" aria-hidden="true" />
      </div>
      <p className="mt-2 text-xs text-muted">
        Alert under {nearAmount(g.alertBelow)} NEAR ·{" "}
        <a href={explorerAccount(g.accountId)} target="_blank" rel="noreferrer" className="underline underline-offset-2">{shortAccount(g.accountId)}</a>
      </p>
      <Button size="sm" variant={low ? "primary" : "soft"} className="mt-5 self-start" onClick={onSend}><Plus />Send NEAR</Button>
    </div>
  )
}

function RelayerCard({ r }: { r: AdminOverview["relay"] }) {
  const { token } = useSession()
  const qc = useQueryClient()
  const [per, setPer] = useState(String(r.settings.perAccountDaily))
  const [all, setAll] = useState(String(r.settings.allDaily))
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setPer(String(r.settings.perAccountDaily))
    setAll(String(r.settings.allDaily))
  }, [r.settings.perAccountDaily, r.settings.allDaily])

  const nPer = Number(per)
  const nAll = Number(all)
  const valid = Number.isInteger(nPer) && nPer >= 0 && nPer <= 1000 && Number.isInteger(nAll) && nAll >= 0 && nAll <= 100_000 && per !== "" && all !== ""
  const changed = nPer !== r.settings.perAccountDaily || nAll !== r.settings.allDaily

  const save = async (next: { enabled: boolean; perAccountDaily: number; allDaily: number }, done: string) => {
    setBusy(true)
    try {
      await api((c) => c.admin.relay({ payload: new RelaySettings(next) }), token)
      toast.success(done)
      await qc.invalidateQueries({ queryKey: ["admin"] })
    } catch (e) {
      toast.error(errorMessage(e))
    }
    setBusy(false)
  }

  return (
    <div className="card flex flex-col gap-6 p-7">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-display flex items-center gap-2 text-3xl font-extrabold"><Zap size={24} aria-hidden="true" />Relayer</h2>
          <p className="mt-1 text-ink-soft">
            {!r.configured ? "No relayer key on the server, so customers' wallets pay their own fees." : r.settings.enabled ? "Paying customers' network fees." : "Off: customers' wallets pay their own fees."}
          </p>
        </div>
        <Toggle
          on={r.settings.enabled}
          busy={busy || !r.configured}
          label="Relayer on"
          onChange={(enabled) => save({ ...r.settings, enabled }, enabled ? "Relayer on: Luckout pays customers' fees" : "Relayer off: customers' wallets pay their fees")}
        />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <p className="font-semibold">Free transactions, last 24 hours</p>
          <p className="text-sm text-muted">{r.usedToday} of {r.settings.allDaily}</p>
        </div>
        <Bar value={r.settings.allDaily ? r.usedToday / r.settings.allDaily : 1} tone={r.usedToday >= r.settings.allDaily * 0.8 ? "warn" : "ink"} />
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        {[
          { label: "Per account a day", value: per, set: setPer },
          { label: "Everyone a day", value: all, set: setAll }
        ].map((f) => (
          <label key={f.label} className="flex flex-col gap-2">
            <span className="text-sm font-semibold">{f.label}</span>
            <input className="field" inputMode="numeric" value={f.value} onChange={(e) => f.set(e.target.value.replace(/\D/g, ""))} />
          </label>
        ))}
        <Button loading={busy} disabled={!changed || !valid} onClick={() => save({ enabled: r.settings.enabled, perAccountDaily: nPer, allDaily: nAll }, "Relayer caps saved")}>
          Save caps
        </Button>
      </div>

      {r.topAccounts.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold text-ink-soft">Most relays today</p>
          <ul className="flex flex-col divide-y divide-line">
            {r.topAccounts.map((t) => (
              <li key={t.accountId} className="flex items-center justify-between py-2 text-sm">
                <a href={explorerAccount(t.accountId)} target="_blank" rel="noreferrer" className="truncate underline-offset-2 hover:underline">{shortAccount(t.accountId)}</a>
                <span className="text-muted">{t.count} of {r.settings.perAccountDaily}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function PurchasesCard({ p }: { p: AdminOverview["purchases"] }) {
  return (
    <div className="card flex flex-col gap-6 p-7">
      <div>
        <h2 className="font-display text-3xl font-extrabold">Purchases</h2>
        <p className="mt-1 text-ink-soft">Last 24 hours: {p.today} started, {p.deliveredToday} delivered.</p>
      </div>
      {p.attention.length === 0
        ? (
          <p className="flex items-center gap-3 rounded-[1.5rem] bg-good-soft p-5 font-medium text-good">
            <Check size={20} aria-hidden="true" />Nothing needs attention.
          </p>
        )
        : (
          <ul className="flex flex-col gap-3">
            {p.attention.map((a) => <AttentionRow key={a.id} a={a} />)}
          </ul>
        )}
    </div>
  )
}

function AttentionRow({ a }: { a: AttentionPurchase }) {
  const { token } = useSession()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const retry = async () => {
    setBusy(true)
    try {
      await api((c) => c.admin.retry({ params: { id: a.id } }), token)
      toast.success("Queued: the next pass runs within a minute")
      await qc.invalidateQueries({ queryKey: ["admin"] })
    } catch (e) {
      toast.error(errorMessage(e))
    }
    setBusy(false)
  }
  return (
    <li className="flex flex-col gap-3 rounded-[1.5rem] bg-soft p-5 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 font-semibold">
          {a.voucherName} {a.value}
          <span className={`pill ${a.step === "stuck" ? "bg-bad-soft! text-bad" : "bg-warn-soft! text-warn"}`}>{a.step}</span>
        </p>
        <p className="mt-1 text-sm text-muted">{shortAccount(a.accountId)} · {ago(a.createdAt)} · {a.attempts} attempts</p>
        {a.error && <p className="mt-2 line-clamp-3 text-sm text-ink-soft">{a.error}</p>}
      </div>
      {a.retryable
        ? <Button size="sm" variant="light" loading={busy} onClick={retry}><RotateCw />Retry now</Button>
        : (
          <a href={RUNBOOK} target="_blank" rel="noreferrer" className={buttonVariants({ size: "sm", variant: "light" })}>
            Manual check<ArrowUpRight />
          </a>
        )}
    </li>
  )
}


function FundReserveSheet({ open, onClose, o, tx }: { open: boolean; onClose: () => void; o: AdminOverview; tx: Tx }) {
  const { walletUsdc } = useSession()
  const [amount, setAmount] = useState("100")
  const micro = toMicro(amount)
  const inWallet = Number(walletUsdc ?? 0)
  const fund = (m: number): Call => ({ receiverId: o.contract.usdc, method: "ft_transfer_call", args: { receiver_id: o.contract.id, amount: String(m), msg: "reserve" }, deposit: "1", tgas: 100 })
  const go = async (f: (id: string) => Promise<unknown>, pending: string, done: string) => {
    if (await tx(pending, done, f)) onClose()
  }
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title="Fund the reserve" description="USDC from your wallet backs every cashback. It can be withdrawn whenever it isn't locked.">
      <div className="flex flex-col gap-5">
        {o.network === "testnet" && (
          <div className="flex flex-col gap-3 rounded-[1.5rem] bg-gold-soft p-5 text-gold-ink">
            <p className="text-[15px]">Testnet: mint 100 test USDC and add it in one approval.</p>
            <Button variant="gold" onClick={() => go((id) => send(id, faucetCall, fund(100_000_000)), "Adding 100 test USDC to the reserve", "$100.00 added to the reserve")}>
              Add 100 test USDC
            </Button>
          </div>
        )}
        <AmountField
          label="Amount to add in USDC"
          value={amount}
          onChange={setAmount}
          picks={[
            { label: "$100", micro: 100_000_000 },
            { label: "$500", micro: 500_000_000 },
            { label: "$1,000", micro: 1_000_000_000 },
            ...(inWallet > 0 ? [{ label: "All of it", micro: inWallet }] : [])
          ]}
        />
        <p className="text-sm text-muted">Your wallet has {usd(inWallet)} USDC.</p>
        <Button size="lg" disabled={!(micro > 0) || micro > inWallet} onClick={() => go((id) => send(id, fund(micro)), `Adding ${usd(micro)} to the reserve`, `${usd(micro)} added to the reserve`)}>
          {micro > inWallet ? "More than your wallet holds" : `Add ${micro > 0 ? usd(micro) : ""}`}
        </Button>
      </div>
    </Sheet>
  )
}

function WithdrawSheet({ open, onClose, title, available, to, preview, onWithdraw }: {
  open: boolean
  onClose: () => void
  title: string
  available: number
  to: string
  preview: (micro: number) => string
  onWithdraw: (micro: number) => Promise<boolean>
}) {
  const [amount, setAmount] = useState("")
  const micro = toMicro(amount)
  useEffect(() => {
    if (open) setAmount("")
  }, [open])
  const ok = micro > 0 && micro <= available
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title={title} description={`${usd(available)} available. It goes to ${to}.`}>
      <div className="flex flex-col gap-5">
        <AmountField
          label="Amount to withdraw in USDC"
          value={amount}
          onChange={setAmount}
          picks={[{ label: "Half", micro: Math.floor(available / 2) }, { label: `All ${usd(available)}`, micro: available }]}
        />
        {ok && <p className="rounded-[1.25rem] bg-soft p-4 text-sm text-ink-soft">{preview(micro)}</p>}
        <Button size="lg" disabled={!ok} onClick={async () => (await onWithdraw(micro)) && onClose()}>
          {micro > available ? `Only ${usd(available)} available` : `Withdraw ${micro > 0 ? usd(micro) : ""}`}
        </Button>
      </div>
    </Sheet>
  )
}

function SendNearSheet({ target, onClose, tx }: { target: AdminOverview["gas"][number] | undefined; onClose: () => void; tx: Tx }) {
  const { walletNear } = useSession()
  const [amount, setAmount] = useState("1")
  useEffect(() => {
    if (target) setAmount("1")
  }, [target])
  const yocto = toYocto(amount)
  const inWallet = BigInt(walletNear ?? 0)
  const ok = yocto !== undefined && yocto > 0n && yocto < inWallet
  return (
    <Sheet
      open={target !== undefined}
      onOpenChange={(v) => !v && onClose()}
      title={target ? `Send NEAR to the ${GAS_COPY[target.role].label.toLowerCase()}` : "Send NEAR"}
      description={target ? `To ${target.accountId}, which has ${nearAmount(target.spendable)} NEAR.` : undefined}
    >
      <div className="flex flex-col gap-5">
        <label className="relative block">
          <span className="sr-only">NEAR to send</span>
          <input className="field font-display h-16! rounded-[1.25rem]! pr-20! text-3xl! font-extrabold!" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} />
          <span className="font-display pointer-events-none absolute top-1/2 right-5 -translate-y-1/2 text-xl font-extrabold text-muted">NEAR</span>
        </label>
        <div className="flex flex-wrap gap-2">
          {["0.5", "1", "2", "5"].map((v) => (
            <button key={v} type="button" onClick={() => setAmount(v)} aria-pressed={amount === v}
              className="h-9 rounded-full bg-soft px-4 text-sm font-semibold transition-colors hover:bg-[#ebe9f3] aria-pressed:bg-ink aria-pressed:text-white">
              {v} NEAR
            </button>
          ))}
        </div>
        <p className="text-sm text-muted">
          Your wallet has {nearAmount(inWallet)} NEAR{network === "testnet" ? " (testnet NEAR is free from the faucet)" : ""}.
        </p>
        <Button size="lg" disabled={!ok || !target} onClick={async () => {
          if (!target || yocto === undefined) return
          if (await tx(`Sending ${amount} NEAR`, `${amount} NEAR sent to ${shortAccount(target.accountId)}`, (id) => sendNear(id, target.accountId, String(yocto)))) onClose()
        }}>
          {yocto !== undefined && yocto >= inWallet ? "More than your wallet holds" : `Send ${ok ? amount : ""} NEAR`}
        </Button>
      </div>
    </Sheet>
  )
}
