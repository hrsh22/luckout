"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { errorMessage } from "@/lib/api"
import { toMicro, usd } from "@/lib/format"
import { MODES, modeName, sameMode } from "@/lib/modes"
import { type Call, contractId, network, send, usdcId } from "@/lib/near"
import { useSession } from "@/lib/session"
import { useState } from "react"
import { TelegramLink } from "./telegram-link"
import { TopUp } from "./top-up"

const ONE_YOCTO = "1"

export function WalletPanel({ accountId }: { accountId: string }) {
  const { account, walletUsdc, refresh } = useSession()
  const [amount, setAmount] = useState("10")
  const [perPurchase, setPerPurchase] = useState("")
  const [daily, setDaily] = useState("")
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()

  const run = (label: string, ...calls: Array<Call>) => async () => {
    setBusy(label)
    setError(undefined)
    await send(accountId, ...calls).catch((e) => setError(errorMessage(e)))
    await refresh().catch(() => {})
    setBusy(undefined)
  }

  const deposit = (micro: number): Call => ({
    receiverId: usdcId,
    method: "ft_transfer_call",
    args: { receiver_id: contractId, amount: String(micro), msg: "" },
    deposit: ONE_YOCTO,
    tgas: 100
  })
  const micro = toMicro(amount)
  const running = account ? Number(account.refunds_received) - Number(account.premiums_paid) : 0

  return (
    <div className="flex flex-col gap-6">
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}

      <dl className="bg-receipt grid gap-6 rounded-2xl border p-6 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground text-sm">Balance in Luckout</dt>
          <dd className="font-display text-3xl tabular-nums">{account ? usd(account.balance) : account === null ? usd(0) : "…"}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground text-sm">USDC in your wallet</dt>
          <dd className="font-display text-3xl tabular-nums">{walletUsdc !== undefined ? usd(walletUsdc) : "…"}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground text-sm">Running Total</dt>
          <dd className="font-display text-3xl tabular-nums">{running >= 0 ? "+" : "−"}{usd(Math.abs(running))}</dd>
          <dd className="text-muted-foreground text-sm">Discounts won minus premiums paid, over all your lucky buys.</dd>
        </div>
      </dl>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-xl">Add or withdraw USDC</h2>
        {network === "testnet" && (
          <Button
            variant="outline"
            className="self-start"
            disabled={!!busy}
            onClick={run("faucet", { receiverId: usdcId, method: "faucet", args: {} }, deposit(100_000_000))}
          >
            {busy === "faucet" ? "Approve in your wallet…" : "Get 100 test USDC and deposit it"}
          </Button>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Input className="w-32" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount in USDC" />
          <Button disabled={!!busy || !(micro >= 1_000_000)} onClick={run("deposit", deposit(micro))}>Deposit</Button>
          <Button
            variant="outline"
            disabled={!!busy || !account || !(micro > 0)}
            onClick={run("withdraw", { receiverId: contractId, method: "withdraw", args: { amount: String(micro) }, deposit: ONE_YOCTO, tgas: 60 })}
          >
            Withdraw
          </Button>
        </div>
        <p className="text-muted-foreground text-sm">Deposits are at least 1 USDC. Whatever isn't locked in a purchase can be withdrawn any time.</p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-xl">Top up from any chain</h2>
        {network === "mainnet"
          ? <TopUp />
          : <p className="text-muted-foreground text-sm">Top-ups from Ethereum, Base, Arbitrum, Solana, Bitcoin and more run on mainnet through NEAR Intents. On testnet, use the test USDC button above.</p>}
      </section>

      {account && (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="font-display text-xl">Default mode</h2>
            <div className="flex flex-wrap gap-2">
              {MODES.map((m) => (
                <button
                  key={m.name}
                  type="button"
                  aria-pressed={sameMode(account.default_mode, m.mode)}
                  disabled={!!busy}
                  onClick={run("mode", { receiverId: contractId, method: "set_default_mode", args: { mode: m.mode }, deposit: ONE_YOCTO })}
                  className="aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background bg-receipt min-h-11 rounded-lg border px-4 text-sm font-medium"
                >
                  {m.name}{m.premiumBps ? ` +${m.premiumBps / 100}%` : ""}
                </button>
              ))}
            </div>
            <p className="text-muted-foreground text-sm">Every purchase, in the shop and in Telegram, uses {modeName(account.default_mode)} unless you pick another one for that purchase.</p>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="font-display text-xl">Telegram</h2>
            <TelegramLink />
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="font-display text-xl">Spending limits</h2>
            <p className="text-muted-foreground text-sm">
              Now {usd(account.per_purchase_limit)} per purchase and {usd(account.daily_limit)} per day, with{" "}
              {usd(account.day === Math.floor(Date.now() / 86_400_000) ? account.spent_today : 0)} used today. The contract enforces these
              on every purchase, including ones the Telegram bot makes. The day resets at 00:00 UTC.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input className="w-36" inputMode="decimal" placeholder="Per purchase" value={perPurchase} onChange={(e) => setPerPurchase(e.target.value)} aria-label="Per-purchase limit in USDC" />
              <Input className="w-36" inputMode="decimal" placeholder="Per day" value={daily} onChange={(e) => setDaily(e.target.value)} aria-label="Daily limit in USDC" />
              <Button
                variant="outline"
                disabled={!!busy || !(toMicro(perPurchase) >= 0) || !(toMicro(daily) >= 0)}
                onClick={run("limits", {
                  receiverId: contractId,
                  method: "set_limits",
                  args: { per_purchase: String(toMicro(perPurchase)), daily: String(toMicro(daily)) },
                  deposit: ONE_YOCTO
                })}
              >
                Save limits
              </Button>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
