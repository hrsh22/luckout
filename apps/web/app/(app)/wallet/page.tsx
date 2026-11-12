"use client"

import { AddFundsSheet, WithdrawSheet } from "@/components/funds"
import { HeldInIntents, InTransit, RecentTransfers } from "@/components/in-transit"
import { ModePicker } from "@/components/mode-picker"
import { Money } from "@/components/money"
import { SignInCard } from "@/components/sign-in-card"
import { TelegramLink } from "@/components/telegram-link"
import { Button } from "@/components/ui/button"
import { useWalletActions } from "@/lib/actions"
import { dollars, toMicro, usd } from "@/lib/format"
import { modeName, sameMode } from "@/lib/modes"
import { pendingMode, setPendingMode } from "@/lib/onboarding"
import { useSession } from "@/lib/session"
import type { Mode } from "@luckout/api"
import { Plus } from "lucide-react"
import { useEffect, useReducer, useState } from "react"
import { toast } from "sonner"

export default function WalletPage() {
  const { accountId, account, walletUsdc, ready, evm } = useSession()
  const actions = useWalletActions()
  const [adding, setAdding] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)
  const [saving, setSaving] = useState<Mode>()
  // The pre-deposit pick lives in localStorage, which doesn't re-render: nudge it.
  const [, rerender] = useReducer((n: number) => n + 1, 0)

  if (ready && !accountId) {
    return (
      <div className="flex flex-col gap-8">
        <h1 className="font-display text-5xl leading-[0.95] font-extrabold tracking-[-0.03em] sm:text-[64px]">Wallet</h1>
        <SignInCard title="Sign in to see your balance" body="Add funds, choose how you like to pay, set your limits and connect Telegram." />
      </div>
    )
  }

  const balance = Number(account?.balance ?? 0)
  const running = account ? Number(account.cashback_received) - Number(account.premiums_paid) : 0
  const today = account && account.day === Math.floor(Date.now() / 86_400_000) ? Number(account.spent_today) : 0
  const daily = Number(account?.daily_limit ?? 100_000_000)
  const chosen = account?.default_mode ?? (accountId ? pendingMode(accountId) : undefined) ?? "normal"

  const pickMode = async (m: Mode) => {
    if (!accountId || sameMode(m, chosen)) return
    // Before the first deposit the contract has no account to save it on; it's saved with the deposit.
    if (!account) {
      setPendingMode(accountId, m)
      rerender()
      toast.success(`${modeName(m)} it is`, { description: "It's saved as your default with your first deposit." })
      return
    }
    setSaving(m)
    await actions.setDefaultMode(m)
    setSaving(undefined)
  }

  return (
    <div className="flex flex-col gap-10">
      <h1 className="font-display text-5xl leading-[0.95] font-extrabold tracking-[-0.03em] sm:text-[64px]">Wallet</h1>

      <section className="grid gap-4 lg:grid-cols-[1.4fr_1fr_1fr]">
        <div className="relative overflow-hidden rounded-[2.25rem] bg-ink p-8 text-white">
          <div className="blob -top-24 -right-16 size-72 bg-lilac opacity-50" aria-hidden="true" />
          <div className="blob -bottom-32 left-24 size-64 bg-gold opacity-35" aria-hidden="true" />
          <div className="relative flex h-full flex-col">
            <p className="text-white/70">Balance in Luckout</p>
            <p className="font-display mt-1 text-6xl leading-none font-extrabold tracking-[-0.03em] sm:text-7xl">
              {account === undefined ? <span className="skeleton inline-block h-14 w-48 rounded-full opacity-30" /> : <Money micro={balance} down />}
            </p>
            {Number(walletUsdc) ? <p className="mt-3 text-sm text-white/60">{usd(walletUsdc!)} more USDC sits in your {evm ? "NEAR Intents account" : "NEAR wallet"}.</p> : null}
            <div className="mt-8 flex flex-wrap gap-2">
              <Button variant="gold" onClick={() => setAdding(true)}><Plus />Add funds</Button>
              <Button variant="light" disabled={!balance} onClick={() => setWithdrawing(true)}>Withdraw</Button>
            </div>
          </div>
        </div>

        <div className={`flex flex-col rounded-[2.25rem] p-7 ${running > 0 ? "bg-gold-soft text-gold-ink" : "card"}`}>
          <p className={running > 0 ? "opacity-80" : "text-ink-soft"}>Running total</p>
          <p className="font-display mt-1 text-5xl font-extrabold tracking-[-0.03em]">
            {running >= 0 ? "+" : "−"}<Money micro={Math.abs(running)} />
          </p>
          <p className={`mt-auto pt-6 text-sm ${running > 0 ? "opacity-80" : "text-muted"}`}>
            Cashback you've received, minus the extra you paid up front on lucky buys.
          </p>
        </div>

        <div className="card flex flex-col p-7">
          <p className="text-ink-soft">Spent today</p>
          <p className="font-display mt-1 text-5xl font-extrabold tracking-[-0.03em]"><Money micro={today} /></p>
          <div className="mt-auto pt-6">
            <div className="h-2 overflow-hidden rounded-full bg-soft">
              <div className="h-full rounded-full bg-ink transition-[width] duration-500" style={{ width: `${Math.min(100, (today / daily) * 100)}%` }} />
            </div>
            <p className="mt-2 text-sm text-muted">of your {usd(daily)} daily limit. Resets at 00:00 UTC.</p>
          </div>
        </div>
      </section>

      <InTransit />
      <HeldInIntents />

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="font-display text-3xl font-extrabold">Default mode</h2>
          <p className="mt-1 max-w-[60ch] text-ink-soft">
            Used for every purchase, here and in Telegram, unless you pick another one for that purchase. Changing it takes one approval.
          </p>
        </div>
        <ModePicker value={saving ?? chosen} onChange={pickMode} saving={saving} savedDefault={account?.default_mode} label="Default mode" />
      </section>

      {account && <Limits per={Number(account.per_purchase_limit)} daily={daily} />}

      <section className="flex flex-col gap-4">
        <h2 className="font-display text-3xl font-extrabold">Telegram</h2>
        <TelegramLink />
      </section>

      <RecentTransfers />

      <AddFundsSheet open={adding} onOpenChange={setAdding} />
      <WithdrawSheet open={withdrawing} onOpenChange={setWithdrawing} />
    </div>
  )
}

function Limits({ per, daily }: { per: number; daily: number }) {
  const actions = useWalletActions()
  const [a, setA] = useState("")
  const [b, setB] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setA(dollars(per))
    setB(dollars(daily))
  }, [per, daily])
  const nextPer = toMicro(a)
  const nextDaily = toMicro(b)
  const changed = nextPer !== per || nextDaily !== daily
  const valid = nextPer >= 0 && nextDaily >= 0

  return (
    <section id="limits" className="flex scroll-mt-28 flex-col gap-4">
      <div>
        <h2 className="font-display text-3xl font-extrabold">Spending limits</h2>
        <p className="mt-1 max-w-[60ch] text-ink-soft">
          The contract checks these on every purchase, including ones the Telegram bot makes. Only your wallet can raise them.
        </p>
      </div>
      <div className="card flex flex-col gap-5 p-6 sm:flex-row sm:items-end">
        {[
          { label: "Per purchase", value: a, set: setA },
          { label: "Per day", value: b, set: setB }
        ].map((f) => (
          <label key={f.label} className="flex flex-1 flex-col gap-2">
            <span className="font-semibold">{f.label}</span>
            <span className="relative">
              <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 font-semibold text-muted">$</span>
              <input className="field !pl-8" inputMode="decimal" value={f.value} onChange={(e) => f.set(e.target.value.replace(/[^\d.]/g, ""))} aria-invalid={!(toMicro(f.value) >= 0)} />
            </span>
          </label>
        ))}
        <Button
          size="md"
          className="sm:mb-0.5"
          loading={busy}
          disabled={!changed || !valid}
          onClick={async () => {
            setBusy(true)
            await actions.setLimits(nextPer, nextDaily)
            setBusy(false)
          }}
        >
          Save limits
        </Button>
      </div>
    </section>
  )
}
