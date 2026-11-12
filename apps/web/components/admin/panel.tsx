"use client"

import { shortAccount } from "@/components/avatar"
import { ShopControls, TransferOwnerSheet } from "@/components/admin/controls"
import { capText, CashbackCapSheet, maxCashbackAt } from "@/components/admin/cashback-cap"
import { CreditSection } from "@/components/admin/credit"
import { BaseGasTile, GasTile, SendNearSheet } from "@/components/admin/gas"
import { PurchasesCard } from "@/components/admin/purchases"
import { RelayerCard } from "@/components/admin/relayer"
import { FundReserveSheet, WithdrawSheet } from "@/components/admin/reserve"
import type { Tx } from "@/components/admin/shared"
import { Money } from "@/components/money"
import { SignInCard } from "@/components/sign-in-card"
import { Button, buttonVariants } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { api, cancelled, errorMessage } from "@/lib/api"
import { usd } from "@/lib/format"
import { type Call, contractId, explorer, liveAverage, send, usdcId } from "@/lib/near"
import { useSession } from "@/lib/session"
import type { AdminOverview } from "@luckout/api"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleAlert, Pause, Plus, ShieldCheck } from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { toast } from "sonner"

// The admin panel (/admin). The server only answers whitelisted accounts, and everyone else sees
// the ordinary "No page here". Money never moves through the server: reserve, proceeds, the shop
// switch and gas are transactions signed in the admin's own wallet, and the contract checks the
// owner itself. The relayer's switch and caps are server settings.

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
  if (!q.data) return q.error ? <p role="alert" className="font-medium text-bad">{errorMessage(q.error)}</p> : <Loading />
  // A failed poll keeps the last figures (and any open sheet) on screen; the next poll tries again.
  return (
    <>
      {q.error && <p role="status" className="mb-4 text-sm text-warn">Couldn't refresh just now, so these are the last figures. {errorMessage(q.error)}</p>}
      <Dashboard o={q.data} />
    </>
  )
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

type Open = "fund" | "withdraw-reserve" | "withdraw-proceeds" | "pause" | "owner" | "cap" | { gas: AdminOverview["gas"][number] }

function Dashboard({ o }: { o: AdminOverview }) {
  const { accountId, token } = useSession()
  const qc = useQueryClient()
  const tx = useAdminTx()
  const [open, setOpen] = useState<Open>()
  const isOwner = accountId === o.contract.owner
  const proposedToMe = accountId !== undefined && o.contract.pendingOwner === accountId
  // Owner calls go to the contract this site was built for, never to ids the server reports.
  const elsewhere = o.contract.id !== contractId || o.contract.usdc !== usdcId
  // Owner-only actions stay clickable: someone else learns why, instead of staring at a grey button.
  const asOwner = (f: () => void) => () =>
    elsewhere
      ? toast.error("Owner actions are off", { description: "The server reports a different contract or USDC than this site is built for." })
      : isOwner
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
  const contractCall = (method: string, args: object, tgas = 30): Call => ({ receiverId: contractId, method, args, deposit: "1", tgas })
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
              <button type="button" className="pill bg-white/60! text-muted transition-colors hover:bg-white! hover:text-ink" onClick={asOwner(() => setOpen("owner"))}>
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

      {elsewhere && (
        <p role="alert" className="flex items-start gap-3 rounded-[1.5rem] bg-bad-soft p-5 text-[15px] font-medium text-bad">
          <CircleAlert size={20} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            The server reports contract {o.contract.id} with USDC {o.contract.usdc}, but this site is built for {contractId} with {usdcId}. Owner
            actions are off until they match: check the server's and the site's environment.
          </span>
        </p>
      )}

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
            <Button disabled={elsewhere} onClick={() => tx("Accepting ownership", "You own the contract now", (id) => send(id, contractCall("accept_owner", {})))}>
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
            <Button variant="light" size="sm" disabled={elsewhere} onClick={() => tx("Withdrawing the proposal", "Proposal withdrawn", (id) => send(id, contractCall("propose_owner", { new_owner: null })))}>
              Withdraw the proposal
            </Button>
          </div>
        )
        : !isOwner && (
          <p className="flex items-start gap-3 rounded-[1.5rem] bg-lilac-soft p-5 text-[15px]">
            <CircleAlert size={20} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              The reserve, its cashback cap, proceeds, the contract's pause and the treasury's mode need the owner's wallet, <b>{o.contract.owner}</b>. Any admin can stop
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
              {usd(o.reserve.locked)} locked in open lucky buys. One purchase can get up to {usd(o.reserve.maxCashback)} back: {capText(o.reserve.cashbackCap)}.
            </p>
            <div className="mt-auto flex flex-wrap gap-2 pt-8">
              <Button variant="gold" onClick={asOwner(() => setOpen("fund"))}><Plus />Fund</Button>
              <Button variant="onColor" className="text-white!" disabled={!o.reserve.free} onClick={asOwner(() => setOpen("withdraw-reserve"))}>Withdraw</Button>
              <Button variant="onColor" className="text-white!" onClick={asOwner(() => setOpen("cap"))}>Cashback cap</Button>
            </div>
          </div>
        </div>

        <div className="card flex flex-col p-7">
          <p className="text-ink-soft">Proceeds</p>
          <p className="font-display mt-1 text-5xl font-extrabold tracking-[-0.03em]"><Money micro={o.reserve.proceeds} /></p>
          <p className="mt-2 text-sm text-muted">What customers paid for delivered cards. The treasury refills Bitrefill from it.</p>
          <p className={`mt-4 text-sm ${o.reserve.customers < 0 ? "font-semibold text-bad" : "text-muted"}`}>
            {o.reserve.customers < 0
              ? `The contract holds ${usd(o.reserve.held)}, less than the reserve and proceeds alone. Pause it and investigate now.`
              : `Customers hold ${usd(o.reserve.customers)} in Luckout, theirs to withdraw any time. The contract holds ${usd(o.reserve.held)} in all.`}
          </p>
          <div className="mt-auto pt-6">
            <Button variant="soft" disabled={!o.reserve.proceeds} onClick={asOwner(() => setOpen("withdraw-proceeds"))}>Withdraw</Button>
          </div>
        </div>

      </section>

      <CreditSection o={o} asOwner={asOwner} tx={tx} />

      <section className="flex flex-col gap-4">
        <SectionTitle title="Gas" body="What our accounts spend on network fees: NEAR on NEAR, ETH on Base. Each alerts below its line; any admin can top it up." />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {o.gas.map((g) => <GasTile key={g.role} g={g} onSend={() => setOpen({ gas: g })} />)}
          {o.treasury.wallet && <BaseGasTile w={o.treasury.wallet} />}
        </div>
      </section>

      <section className="grid items-start gap-4 lg:grid-cols-[1fr_1.25fr]">
        <RelayerCard r={o.relay} />
        <PurchasesCard p={o.purchases} />
      </section>

      <FundReserveSheet open={open === "fund"} onClose={close} o={o} tx={tx} />
      <CashbackCapSheet open={open === "cap"} onClose={close} o={o} tx={tx} />
      <WithdrawSheet
        open={open === "withdraw-reserve"}
        onClose={close}
        title="Withdraw from the reserve"
        available={o.reserve.free}
        to={o.contract.owner}
        preview={(m) => {
          const after = o.reserve.free - m
          return `Free reserve after: ${usd(after)}. Most cashback per purchase: ${usd(maxCashbackAt(o.reserve.cashbackCap, after))}.`
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
