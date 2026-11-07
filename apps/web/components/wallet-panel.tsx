"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { errorMessage } from "@/lib/api"
import { MODES, modeName, sameMode, toMicro, usd } from "@/lib/format"
import { type Call, contractId, network, send, usdcId } from "@/lib/near"
import { useSession } from "@/lib/session"
import { useState } from "react"

const ONE_YOCTO = "1"

export function WalletPanel() {
  const { account, walletUsdc, refresh } = useSession()
  const [amount, setAmount] = useState("10")
  const [perPurchase, setPerPurchase] = useState("")
  const [daily, setDaily] = useState("")
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()

  const run = (label: string, ...calls: Array<Call>) => async () => {
    setBusy(label)
    setError(undefined)
    await send(...calls).catch((e) => setError(errorMessage(e)))
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

      <section className="bg-card grid gap-4 rounded-xl border p-4 sm:grid-cols-3">
        <div>
          <p className="text-muted-foreground text-xs">Balance in Luckout</p>
          <p className="font-heading text-2xl font-bold tabular-nums">{account ? usd(account.balance) : "—"}</p>
        </div>
        <div>
          <p className="text-muted-foreground text-xs">In your wallet</p>
          <p className="font-heading text-2xl font-bold tabular-nums">{walletUsdc !== undefined ? usd(walletUsdc) : "—"}</p>
        </div>
        <div>
          <p className="text-muted-foreground text-xs">Running Total</p>
          <p className="font-heading text-2xl font-bold tabular-nums">{running >= 0 ? "+" : "−"}{usd(Math.abs(running))}</p>
          <p className="text-muted-foreground text-xs">Discounts won minus extra paid, over all lucky buys.</p>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-heading text-lg font-semibold">Add or withdraw USDC</h2>
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
        <p className="text-muted-foreground text-xs">Deposits are at least 1 USDC. Whatever isn't locked in a purchase can be withdrawn any time.</p>
      </section>

      {account && (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="font-heading text-lg font-semibold">Default mode</h2>
            <div className="flex flex-wrap gap-2">
              {MODES.map((m) => (
                <button
                  key={m.name}
                  type="button"
                  aria-pressed={sameMode(account.default_mode, m.mode)}
                  disabled={!!busy}
                  onClick={run("mode", { receiverId: contractId, method: "set_default_mode", args: { mode: m.mode } })}
                  className="aria-pressed:border-foreground aria-pressed:bg-secondary rounded-lg border px-3 py-2 text-sm"
                >
                  {m.name} {m.premium}
                </button>
              ))}
            </div>
            <p className="text-muted-foreground text-xs">Every purchase uses {modeName(account.default_mode)} unless you pick another one for that purchase.</p>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="font-heading text-lg font-semibold">Spending limits</h2>
            <p className="text-muted-foreground text-sm">
              Now {usd(account.per_purchase_limit)} per purchase and {usd(account.daily_limit)} per day ({usd(account.spent_today)} used today).
              The contract enforces these on every purchase, including ones the Telegram agent makes.
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
