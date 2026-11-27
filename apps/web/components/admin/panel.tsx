"use client"

import { CashbackCapSheet } from "@/components/admin/cashback-cap"
import { ShopControls, ValueSheet } from "@/components/admin/controls"
import { OwnerBanner, useOwner } from "@/components/admin/owner"
import { PurchasesCard } from "@/components/admin/purchases"
import { FundReserveSheet, WithdrawSheet } from "@/components/admin/reserve"
import { AddressLink, AdminTabs, Bar, LastFigures, sol } from "@/components/admin/shared"
import { shortAccount } from "@/components/avatar"
import { Money } from "@/components/money"
import { SignInCard } from "@/components/sign-in-card"
import { NoPage } from "@/components/site-chrome"
import { Button } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { api, errorMessage } from "@/lib/api"
import { liveAverage } from "@/lib/chain"
import { capText, maxCashbackAt } from "@/lib/cashback-cap"
import { dollars, toMicro, usd } from "@/lib/format"
import { useIsAdmin, useShopStatus } from "@/lib/queries"
import { useSession } from "@/lib/session"
import type { AdminOverview, ShopStatus } from "@luckout/api"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Fuel, Pause, Plus, ShieldCheck, Wallet } from "lucide-react"
import { type ReactNode, useState } from "react"
import { toast } from "sonner"

// The admin panel (/admin). The server only answers whitelisted accounts, and everyone else sees the ordinary
// "No page here". Money never moves through the server: the reserve, Proceeds, the pause and the program's settings
// are transactions the owner's own wallet signs (components/admin/owner.tsx). Stop sales and Retry are the server's.

export function AdminPanel() {
  const { accountId, token, ready } = useSession()
  const q = useQuery({
    queryKey: ["admin", token],
    queryFn: () => api((c) => c.admin.overview(), token),
    enabled: !!token,
    refetchInterval: 15_000,
    retry: false
  })
  // Read alongside the overview, not after it: the shop's status needs only our database (the program's pause is
  // read if Solana answers), so Stop sales can be offered when the overview fails.
  const shop = useShopStatus()
  const isAdmin = useIsAdmin(token)

  if (ready && !accountId) return <SignInCard title="Sign in to continue" body="Sign in with your admin account." />
  if ((q.error as { _tag?: string } | null)?._tag === "NotFound") return <NoPage />
  if (!q.data) return q.error ? <OverviewFailed error={q.error} shop={isAdmin ? shop.data : undefined} /> : <Loading />
  // A failed poll keeps the last figures (and any open sheet) on screen; the next poll tries again.
  return (
    <>
      {q.error && <LastFigures error={q.error} className="mb-4" />}
      <Dashboard o={q.data} />
    </>
  )
}

/**
 * The overview reads Solana, Bitrefill and the database together, and fails if any of them does. Stop sales needs only
 * the database, and it is the first step in an incident (deploy/RUNBOOK.md), so it is offered here too.
 */
function OverviewFailed({ error, shop }: { error: unknown; shop: ShopStatus | undefined }) {
  const setSales = useSetSales()
  return (
    <div className="flex flex-col gap-6">
      <AdminTabs />
      <p role="alert" className="font-medium text-bad">{errorMessage(error)}</p>
      {shop && (
        <div className="flex flex-col items-start gap-3">
          <p className="text-ink-soft">The control room shows again once it loads. Stopping or restarting sales works now.</p>
          <ShopControls salesStopped={shop.reason === "stopped"} paused={shop.reason === "paused"} onSales={setSales} />
        </div>
      )}
    </div>
  )
}

/** Stops or restarts new purchases on the server (any admin, no wallet), then re-reads what shows it. */
function useSetSales() {
  const { token } = useSession()
  const qc = useQueryClient()
  return async (open: boolean) => {
    try {
      await api((c) => c.admin.sales({ payload: { open } }), token)
      toast.success(open ? "Sales restarted" : "Sales stopped: no new purchases until you restart them")
      await Promise.all([qc.invalidateQueries({ queryKey: ["admin"] }), qc.invalidateQueries({ queryKey: ["shop-status"] })])
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
}

function Loading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading">
      <div className="skeleton h-14 w-56 rounded-full" />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="skeleton h-64 rounded-[2.25rem] lg:col-span-2" />
        <div className="skeleton h-64 rounded-[2.25rem]" />
      </div>
      <div className="grid gap-4 md:grid-cols-3">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-52 rounded-[1.75rem]" />)}</div>
    </div>
  )
}

type Open = "fund" | "withdraw-reserve" | "withdraw-proceeds" | "pause" | "cap" | "repay" | "min-lucky" | "operator" | "pay-wallet" | "owner"

function Dashboard({ o }: { o: AdminOverview }) {
  const owner = useOwner(o)
  const [open, setOpen] = useState<Open>()
  const setSales = useSetSales()
  const close = () => setOpen(undefined)
  const show = (what: Open) => owner.asOwner(() => setOpen(what))
  const average = liveAverage(o.stats)
  const amountSheet = { kind: "amount" as const, onClose: close }

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <AdminTabs />
          <p className="mt-4 flex flex-wrap items-center gap-2 text-sm text-muted">
            <span className="pill bg-white! text-ink"><ShieldCheck size={14} aria-hidden="true" />Admin</span>
            <span className={`pill ${o.cluster === "mainnet" ? "bg-bad-soft! text-bad" : "bg-gold-soft! text-gold-ink"}`}>{o.cluster}</span>
            {owner.wallet && <span className="pill bg-white!">Owner: {owner.wallet.standardWallet.name}</span>}
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
          paused={o.program.paused}
          onSales={setSales}
          onPause={show("pause")}
          onResume={owner.asOwner(() => void owner.sign({ _tag: "set_paused", paused: false }, "Resuming the program", "The program takes new purchases again"))}
        />
      </header>

      <OwnerBanner o={o} owner={owner} />

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="relative overflow-hidden rounded-[2.25rem] bg-ink p-8 text-white lg:col-span-2">
          <div className="blob -top-24 -right-16 size-72 bg-lilac opacity-50" aria-hidden="true" />
          <div className="blob -bottom-32 left-24 size-64 bg-gold opacity-30" aria-hidden="true" />
          <div className="relative flex h-full flex-col">
            <p className="text-white/70">Cashback Reserve, free</p>
            <p className="font-display mt-1 text-6xl leading-none font-extrabold tracking-[-0.03em]"><Money micro={o.reserve.free} /></p>
            <p className="mt-3 text-sm text-white/65">
              {usd(o.reserve.locked)} locked in open Lucky cards. One card can get up to {usd(o.reserve.maxCashback)} back: {capText(o.reserve.cashbackCap)}. A
              Checkout with Lucky cards plays at least {usd(o.reserve.minLuckyCheckout)} of Lucky Amount, so its margin covers the Draw.
            </p>
            <div className="mt-auto flex flex-wrap gap-2 pt-8">
              <Button variant="gold" onClick={show("fund")}><Plus />Fund</Button>
              <Button variant="onColor" className="text-white!" disabled={!o.reserve.free} onClick={show("withdraw-reserve")}>Withdraw</Button>
              <Button variant="onColor" className="text-white!" onClick={show("cap")}>Cashback cap</Button>
              <Button variant="onColor" className="text-white!" onClick={show("min-lucky")}>Smallest Lucky Checkout</Button>
            </div>
          </div>
        </div>

        <div className="card flex flex-col p-7">
          <p className="text-ink-soft">Proceeds</p>
          <p className="font-display mt-1 text-5xl font-extrabold tracking-[-0.03em]"><Money micro={o.reserve.proceeds} /></p>
          <p className="mt-2 text-sm text-muted">Prices of delivered cards that waited past the daily repay cap. They go to the owner, or to the Pay Wallet as float.</p>
          <p className={`mt-4 text-sm ${o.reserve.customers < 0 ? "font-semibold text-bad" : "text-muted"}`}>
            {o.reserve.customers < 0
              ? `The Vault holds ${usd(o.reserve.held)}, less than the reserve and Proceeds alone. Pause the program and investigate now.`
              : `Customers hold ${usd(o.reserve.customers)} in Luckout, theirs to withdraw any time. The Vault holds ${usd(o.reserve.held)} in all.`}
          </p>
          <div className="mt-auto pt-6">
            <Button variant="soft" disabled={!o.reserve.proceeds} onClick={show("withdraw-proceeds")}>Withdraw</Button>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle
          title="Paying Bitrefill"
          body="The Pay Wallet pays each checkout's invoice in USDC, and settle repays it from the Vault up to the daily cap. The fee payer pays every transaction's fee. Each alerts below its line."
        />
        <div className="grid gap-4 md:grid-cols-3">
          <RepayCard r={o.repay} onChange={show("repay")} />
          {o.keys.map((k) => <KeyTile key={k.role} k={k} />)}
        </div>
        <LimitsCard o={o} />
      </section>

      <section className="grid items-start gap-4 lg:grid-cols-[1fr_1.25fr]">
        <ProgramCard o={o} onOperator={show("operator")} onPayWallet={show("pay-wallet")} onOwner={show("owner")} />
        <PurchasesCard p={o.purchases} />
      </section>

      <FundReserveSheet open={open === "fund"} onClose={close} owner={owner} />
      <CashbackCapSheet open={open === "cap"} onClose={close} o={o} owner={owner} />
      <WithdrawSheet
        open={open === "withdraw-reserve"}
        onClose={close}
        title="Withdraw from the reserve"
        available={o.reserve.free}
        to={[{ id: "owner", label: `the owner's USDC account (${shortAccount(o.program.owner)})` }]}
        preview={(m) => {
          const after = o.reserve.free - m
          return `Free reserve after: ${usd(after)}. Most cashback per card: ${usd(maxCashbackAt(o.reserve.cashbackCap, after))}.`
        }}
        onWithdraw={(m) => owner.sign({ _tag: "withdraw_reserve", amount: m }, `Withdrawing ${usd(m)} from the reserve`, `${usd(m)} sent to the owner`)}
      />
      <WithdrawSheet
        open={open === "withdraw-proceeds"}
        onClose={close}
        title="Withdraw Proceeds"
        available={o.reserve.proceeds}
        to={[
          { id: "owner", label: `the owner's USDC account (${shortAccount(o.program.owner)})` },
          { id: "payWallet", label: "the Pay Wallet, as float" }
        ]}
        preview={() => "Only Proceeds move; customers' Balances and the reserve stay where they are."}
        onWithdraw={(m, to) =>
          owner.sign({ _tag: "withdraw_proceeds", amount: m, to }, `Withdrawing ${usd(m)} of Proceeds`, `${usd(m)} sent to ${to === "owner" ? "the owner" : "the Pay Wallet"}`)}
      />
      <Sheet open={open === "pause"} onOpenChange={(v) => !v && close()} title="Pause the program?">
        <div className="flex flex-col gap-5">
          <ul className="flex flex-col gap-2 text-ink-soft">
            <li>The program refuses every new Checkout, whoever sends it.</li>
            <li>Checkouts already admitted still settle and draw.</li>
            <li>Deposits, withdrawals and Reclaims keep working.</li>
            <li>For a quick stop, <b className="text-ink">Stop sales</b> needs no wallet. This is the hard stop.</li>
          </ul>
          <Button size="lg" variant="danger" onClick={async () => {
            close()
            await owner.sign({ _tag: "set_paused", paused: true }, "Pausing the program", "The program is paused")
          }}>
            <Pause />Pause the program
          </Button>
        </div>
      </Sheet>
      <ValueSheet
        {...amountSheet}
        open={open === "repay"}
        title="Daily repay cap"
        description="How much settle repays the Pay Wallet from the Vault in a day (UTC). Past it, prices wait as Proceeds and the float runs down. Keep it at about twice the busiest day."
        label="Repay up to, each day"
        initial={dollars(o.repay.dailyCap)}
        save={(v) => `Set it to ${usd(toMicro(v))} a day`}
        onSave={(v) => owner.sign({ _tag: "set_repay_cap", daily: toMicro(v) }, "Saving the repay cap", `Repay cap: ${usd(toMicro(v))} a day`)}
      />
      <ValueSheet
        {...amountSheet}
        open={open === "min-lucky"}
        title="Smallest Lucky Checkout"
        description="A Checkout's Lucky Amounts must add up to at least this, so its margin covers the Draw's randomness fee. Move it with SOL's price."
        label="Lucky Amount per Checkout, at least"
        initial={dollars(o.reserve.minLuckyCheckout)}
        save={(v) => `Set it to ${usd(toMicro(v))}`}
        onSave={(v) => owner.sign({ _tag: "set_min_lucky_checkout", amount: toMicro(v) }, "Saving the smallest Lucky Checkout", `Smallest Lucky Checkout: ${usd(toMicro(v))}`)}
      />
      <ValueSheet
        kind="address"
        open={open === "operator"}
        onClose={close}
        title="Change the operator"
        description="The key that admits and settles Checkouts. Put the new key on the server as SOLANA_OPERATOR_SECRET_KEY right after: until then, no Checkout can be admitted or settled."
        label="New operator's address"
        problem={(v) => (v === o.program.owner || v === o.program.pendingOwner ? "The owner can't be the operator" : v === o.program.operator ? "That's the operator now" : undefined)}
        save={(v) => `Make ${shortAccount(v)} the operator`}
        onSave={(v) => owner.sign({ _tag: "set_operator", operator: v }, "Changing the operator", `${shortAccount(v)} is the operator now`)}
      />
      <ValueSheet
        kind="address"
        open={open === "pay-wallet"}
        onClose={close}
        title="Change the Pay Wallet"
        description="The wallet that pays Bitrefill; settle repays its USDC account, opened now if it has none. Bitrefill must tag the address first. Then put its key on the server as SOLANA_PAY_WALLET_SECRET_KEY: until then, no card can be paid."
        label="New Pay Wallet's address"
        save={(v) => `Make ${shortAccount(v)} the Pay Wallet`}
        onSave={(v) => owner.sign({ _tag: "set_pay_wallet", payWallet: v }, "Changing the Pay Wallet", `${shortAccount(v)} is the Pay Wallet now`)}
      />
      <ValueSheet
        kind="address"
        open={open === "owner"}
        onClose={close}
        title="Transfer ownership"
        description="The new owner accepts from its own wallet, here in the admin panel. Nothing changes until it does, and you can withdraw the proposal until then."
        label="New owner's address"
        problem={(v) => (v === o.program.owner ? "That's the owner now" : v === o.program.operator ? "The operator can't own the program" : undefined)}
        save={(v) => `Propose ${shortAccount(v)}`}
        onSave={(v) => owner.sign({ _tag: "propose_owner", newOwner: v }, `Proposing ${shortAccount(v)}`, `${shortAccount(v)} can now accept ownership`)}
      />
    </div>
  )
}

function SectionTitle({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h2 className="font-display text-3xl font-extrabold">{title}</h2>
      <p className="mt-1 max-w-[70ch] text-ink-soft">{body}</p>
    </div>
  )
}

/** The monitor warns at 80% of the cap (ADR-0015). */
function RepayCard({ r, onChange }: { r: AdminOverview["repay"]; onChange: () => void }) {
  const used = r.dailyCap > 0 ? r.repaidToday / r.dailyCap : 1
  return (
    <div className="card flex flex-col p-6">
      <p className="flex items-center gap-2 font-semibold"><Wallet size={18} className="text-muted" aria-hidden="true" />Repaid today</p>
      <p className="mt-1 text-sm text-muted">What settle has repaid the Pay Wallet since midnight UTC, against the owner's daily cap.</p>
      <p className="font-display mt-5 text-4xl font-extrabold tracking-[-0.02em]">
        {usd(r.repaidToday)} <span className="text-lg font-bold text-muted">of {usd(r.dailyCap)}</span>
      </p>
      <div className="mt-3"><Bar value={used} tone={used >= 0.8 ? "warn" : "good"} /></div>
      <Button size="sm" variant={used >= 0.8 ? "primary" : "soft"} className="mt-5 self-start" onClick={onChange}>Change the cap</Button>
    </div>
  )
}

const KEY_COPY = {
  feePayer: { label: "Fee payer", purpose: "Pays every transaction's fee and rent, customers' too. Holds only SOL; send it SOL from any wallet." },
  payWallet: { label: "Pay Wallet float", purpose: "Pays each checkout's Bitrefill invoice. A float that can't cover a checkout holds it, uncharged." }
} as const

function KeyTile({ k }: { k: AdminOverview["keys"][number] }) {
  const [balance, line] = [BigInt(k.balance), BigInt(k.alertBelow)]
  const low = balance < line
  // The bar is full at four times the alert line, so the line sits at a quarter.
  const fill = line > 0n ? Number((balance * 1000n) / (line * 4n)) / 1000 : 1
  const show = (v: string) => (k.role === "feePayer" ? `${sol(v)} SOL` : usd(v))
  return (
    <div className="card flex flex-col p-6">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 font-semibold"><Fuel size={18} className="text-muted" aria-hidden="true" />{KEY_COPY[k.role].label}</p>
        <span className={`pill ${low ? "bg-warn-soft! text-warn" : "bg-good-soft! text-good"}`}>{low ? "Low" : "OK"}</span>
      </div>
      <p className="mt-1 text-sm text-muted">{KEY_COPY[k.role].purpose}</p>
      <p className="font-display mt-5 text-4xl font-extrabold tracking-[-0.02em]">{show(k.balance)}</p>
      <div className="relative mt-3">
        <Bar value={fill} tone={low ? "warn" : "good"} />
        <span className="absolute top-[-3px] left-1/4 h-3.5 w-0.5 rounded-full bg-ink/30" aria-hidden="true" />
      </div>
      <p className="mt-2 text-xs text-muted">Alert under {show(k.alertBelow)} · <AddressLink address={k.address} /></p>
    </div>
  )
}

/** Bitrefill's limits: our paying address's own (ADR-0015), and each Checkout Email's, shown by the busiest one. */
function LimitsCard({ o }: { o: AdminOverview }) {
  const c = o.checkout
  const groups: ReadonlyArray<[string, ReactNode, ReadonlyArray<{ label: string; used: number; cap: number; show: (n: number) => string }>]> = [
    ["Our paying address", "Every card counts against the limits Bitrefill set for the address that pays all our invoices, a guest's or one on a customer's own Bitrefill account.", [
      { label: "Last 24 hours", used: o.paying.daily, cap: o.paying.limits.daily, show: usd },
      { label: "Last 30 days", used: o.paying.monthly, cap: o.paying.limits.monthly, show: usd }
    ]],
    ["The busiest Checkout Email", (
      <>
        Bitrefill limits each email to {c.limits.orders} cards and {usd(c.limits.daily)} a day, {usd(c.limits.monthly)} a month. {c.emails}{" "}
        {c.emails === 1 ? "customer has" : "customers have"} given one, and {c.connected} {c.connected === 1 ? "buys" : "buy"} on their own Bitrefill account instead.
      </>
    ), [
      { label: "Cards today", used: c.busiest.orders, cap: c.limits.orders, show: String },
      { label: "Spent today", used: c.busiest.daily, cap: c.limits.daily, show: usd },
      { label: "Spent in 30 days", used: c.busiest.monthly, cap: c.limits.monthly, show: usd }
    ]]
  ]
  return (
    <div className="card grid gap-8 p-7 lg:grid-cols-2">
      {groups.map(([title, body, rows]) => (
        <div key={title} className="flex flex-col gap-4">
          <div>
            <p className="font-semibold">{title}</p>
            <p className="mt-1 text-sm text-muted">{body}</p>
          </div>
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
      ))}
    </div>
  )
}

/** The program's keys and accounts, each linked to Solana Explorer, and the owner's rarer changes. */
function ProgramCard({ o, onOperator, onPayWallet, onOwner }: { o: AdminOverview; onOperator: () => void; onPayWallet: () => void; onOwner: () => void }) {
  const p = o.program
  const rows: ReadonlyArray<[string, string | undefined]> = [
    ["Program", p.id],
    ["Owner", p.owner],
    ["Proposed owner", p.pendingOwner],
    ["Operator", p.operator],
    ["Pay Wallet's USDC", p.payWallet],
    ["Vault", p.vault],
    ["USDC", p.usdcMint]
  ]
  return (
    <div className="card flex flex-col gap-6 p-7">
      <div>
        <h2 className="font-display text-3xl font-extrabold">Program</h2>
        <p className="mt-1 text-ink-soft">{p.paused ? "Paused: no new Checkouts." : "Running."} Each links to Solana Explorer.</p>
      </div>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        {rows.filter(([, v]) => v).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="min-w-0"><AddressLink address={v!} /></dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="light" onClick={onOperator}>Change the operator</Button>
        <Button size="sm" variant="light" onClick={onPayWallet}>Change the Pay Wallet</Button>
        <Button size="sm" variant="light" onClick={onOwner}>Transfer ownership</Button>
      </div>
    </div>
  )
}

