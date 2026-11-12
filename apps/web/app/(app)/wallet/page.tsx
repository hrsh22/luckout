"use client"

import { AddFundsSheet, WithdrawSheet } from "@/components/funds"
import { HeldInIntents, InTransit, RecentTransfers } from "@/components/in-transit"
import { DailyReset } from "@/components/local-time"
import { ModePicker } from "@/components/mode-picker"
import { Money } from "@/components/money"
import { SignInCard } from "@/components/sign-in-card"
import { TelegramLink } from "@/components/telegram-link"
import { Toggle } from "@/components/admin/shared"
import { Button } from "@/components/ui/button"
import { useWalletActions } from "@/lib/actions"
import { dollars, toMicro, usd } from "@/lib/format"
import { modeName, sameMode } from "@/lib/modes"
import { pendingMode, setPendingMode } from "@/lib/onboarding"
import { useSession } from "@/lib/session"
import { DEFAULT_LIMITS, type Mode, NO_LIMIT, noLimit } from "@luckout/api"
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
  const daily = account?.daily_limit ?? String(DEFAULT_LIMITS.daily)
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
              <div className="h-full rounded-full bg-ink transition-[width] duration-500" style={{ width: `${Math.min(100, (today / Number(daily)) * 100)}%` }} />
            </div>
            <p className="mt-2 text-sm text-muted">{noLimit(daily) ? "No daily limit." : <>of your {usd(daily)} daily limit. Resets at <DailyReset />.</>}</p>
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

      {account && <Limits per={account.per_purchase_limit} daily={daily} />}

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

/** Micro-USDC strings from the contract; "No limit" is u128::MAX, which no JS number holds exactly. */
function Limits({ per, daily }: { per: string; daily: string }) {
  const actions = useWalletActions()
  const [a, setA] = useState("")
  const [b, setB] = useState("")
  const [offA, setOffA] = useState(false)
  const [offB, setOffB] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setOffA(noLimit(per))
    setOffB(noLimit(daily))
    setA(noLimit(per) ? "" : dollars(Number(per)))
    setB(noLimit(daily) ? "" : dollars(Number(daily)))
  }, [per, daily])
  /** What a field would save: NO_LIMIT, micro-USDC, or undefined if it isn't an amount. */
  const next = (off: boolean, v: string) => (off ? NO_LIMIT : toMicro(v) >= 0 ? String(toMicro(v)) : undefined)
  const nextPer = next(offA, a)
  const nextDaily = next(offB, b)
  const same = (n: string | undefined, now: string) => (noLimit(now) ? n === NO_LIMIT : n === now)
  const changed = !same(nextPer, per) || !same(nextDaily, daily)

  return (
    <section id="limits" className="flex scroll-mt-28 flex-col gap-4">
      <div>
        <h2 className="font-display text-3xl font-extrabold">Spending limits</h2>
        <p className="mt-1 max-w-[60ch] text-ink-soft">
          The contract checks these on every purchase: yours here, the Telegram bot's, and any our server submits. Only your wallet can change
          them.
        </p>
      </div>
      <div className="card flex flex-col gap-5 p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end">
          {[
            { id: "limit-per", label: "Per purchase", value: a, set: setA, off: offA, setOff: setOffA },
            { id: "limit-day", label: "Per day", value: b, set: setB, off: offB, setOff: setOffB }
          ].map((f) => (
            <div key={f.id} className="flex flex-1 flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor={f.id} className="font-semibold">{f.label}</label>
                <span className="flex items-center gap-2 text-sm text-ink-soft">
                  No limit
                  <Toggle on={f.off} onChange={f.setOff} label={`No ${f.label.toLowerCase()} limit`} />
                </span>
              </div>
              <span className="relative">
                {!f.off && <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 font-semibold text-muted">$</span>}
                <input
                  id={f.id}
                  className="field !pl-8 disabled:opacity-60"
                  inputMode="decimal"
                  disabled={f.off}
                  placeholder={f.off ? "No limit" : undefined}
                  value={f.off ? "" : f.value}
                  onChange={(e) => f.set(e.target.value.replace(/[^\d.]/g, ""))}
                  aria-invalid={!f.off && !(toMicro(f.value) >= 0)}
                />
              </span>
            </div>
          ))}
          <Button
            size="md"
            className="sm:mb-0.5"
            loading={busy}
            disabled={!changed || !nextPer || !nextDaily}
            onClick={async () => {
              if (!nextPer || !nextDaily) return
              setBusy(true)
              await actions.setLimits(nextPer, nextDaily)
              setBusy(false)
            }}
          >
            Save limits
          </Button>
        </div>
        {(offA || offB) && (
          <p role="note" className="rounded-2xl bg-warn-soft p-4 text-[15px] text-warn">
            With no {offA && offB ? "limits" : offA ? "per-purchase limit" : "daily limit"}, the contract only checks your balance. Any purchase,
            whether you make it, the Telegram bot makes it or our server submits it, can spend up to everything in your balance.
          </p>
        )}
      </div>
    </section>
  )
}
