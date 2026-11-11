"use client"

import { shortAccount } from "@/components/avatar"
import { TopUp } from "@/components/top-up"
import { TopUpEvm } from "@/components/top-up-evm"
import { Button, buttonVariants } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { useWalletActions } from "@/lib/actions"
import { api } from "@/lib/api"
import { CHAIN_NAMES, EVM_CHAIN_IDS } from "@/lib/evm"
import { dollars, toMicro, usd, usdUp } from "@/lib/format"
import { MIN_GAS_NEAR, network } from "@/lib/near"
import { pendingMode, setPendingMode } from "@/lib/onboarding"
import { useSession } from "@/lib/session"
import type { TopUpAsset } from "@luckout/api"
import { Copy, Droplets, ExternalLink, Fuel } from "lucide-react"
import { toast } from "sonner"
import { useEffect, useState } from "react"

/** An amount field with quick picks. Everything stays in micro-USDC except what's typed. */
export function AmountField({ value, onChange, picks, label }: {
  value: string
  onChange: (v: string) => void
  picks: ReadonlyArray<{ label: string; micro: number }>
  label: string
}) {
  return (
    <div className="flex flex-col gap-3">
      <label className="relative block">
        <span className="sr-only">{label}</span>
        <span className="font-display pointer-events-none absolute top-1/2 left-5 -translate-y-1/2 text-3xl font-extrabold text-muted">$</span>
        <input
          className="field font-display !h-16 !rounded-[1.25rem] !pl-11 !text-3xl !font-extrabold"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))}
          aria-invalid={value !== "" && !(toMicro(value) > 0)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        {picks.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => onChange(dollars(p.micro))}
            aria-pressed={toMicro(value) === p.micro}
            className="h-9 rounded-full bg-soft px-4 text-sm font-semibold transition-colors hover:bg-[#ebe9f3] aria-pressed:bg-ink aria-pressed:text-white"
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Add funds without leaving the page, as a sheet. */
export function AddFundsSheet({ open, onOpenChange, need }: { open: boolean; onOpenChange: (o: boolean) => void; need?: number }) {
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Add funds"
      description={need ? `You need ${usdUp(need)} more for this card.` : "Your balance pays for cards. Withdraw what you don't spend any time."}
    >
      <AddFundsPanel key={need ?? 0} need={need} onDone={(ok) => ok && onOpenChange(false)} />
    </Sheet>
  )
}

/**
 * Test USDC on testnet, a deposit from the wallet, or (on mainnet) a top-up from any chain. A mode
 * chosen before the first deposit is saved right after it, with one more approval.
 */
export function AddFundsPanel({ need, onDone }: { need?: number | undefined; onDone: (ok: boolean) => void }) {
  const { accountId, walletUsdc, walletNear, gasFree, evm } = useSession()
  // Unless our relayer pays, every transaction costs a little NEAR. Say so before the wallet fails with "balance 0".
  const noGas = gasFree === false && walletNear !== undefined && BigInt(walletNear) < MIN_GAS_NEAR
  const actions = useWalletActions()
  const [amount, setAmount] = useState(() => (need ? dollars(Math.ceil(Math.max(need, 1_000_000) / 10_000) * 10_000) : "25"))
  const [busy, setBusy] = useState<"faucet" | "deposit" | "mode">()
  // An EVM wallet tops up from its own chain; "wallet" is then the USDC already in its NEAR Intents account.
  const [tab, setTab] = useState<"wallet" | "chain">(evm ? "chain" : "wallet")
  const inWallet = Number(walletUsdc ?? 0)
  const micro = toMicro(amount)

  const done = async (ok: boolean) => {
    if (ok && accountId) {
      const m = pendingMode(accountId)
      if (m) {
        setPendingMode(accountId, undefined)
        if (m !== "normal") {
          setBusy("mode")
          await actions.setDefaultMode(m)
        }
      }
    }
    setBusy(undefined)
    onDone(ok)
  }

  return (
    <div className="flex flex-col gap-6">
      {noGas && accountId && <GasNotice accountId={accountId} />}
      {network === "testnet" && (
        <div className="flex flex-col gap-3 rounded-[1.5rem] bg-gold-soft p-5 text-gold-ink">
          <p className="flex items-center gap-2 font-semibold"><Droplets size={18} aria-hidden="true" />This is the testnet</p>
          <p className="text-[15px]">Get 100 free test USDC, deposited straight into your balance in one {evm ? "signature" : "approval"}.</p>
          <Button variant="gold" size="lg" loading={busy === "faucet" || busy === "mode"} disabled={!!busy || noGas} onClick={() => (setBusy("faucet"), actions.faucet().then(done))}>
            {busy === "mode" ? "Saving your default mode" : "Get 100 test USDC"}
          </Button>
        </div>
      )}

      {network === "mainnet" && (
        <div role="tablist" className="flex rounded-full bg-soft p-1">
          {(evm ? (["chain", "wallet"] as const) : (["wallet", "chain"] as const)).map((t) => (
            <button
              key={t}
              role="tab"
              type="button"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className="h-10 flex-1 rounded-full text-sm font-semibold text-muted transition-colors aria-selected:bg-white aria-selected:text-ink aria-selected:shadow-card"
            >
              {t === "wallet" ? (evm ? "From NEAR Intents" : "From your NEAR wallet") : evm ? "From your EVM wallet" : "From another chain"}
            </button>
          ))}
        </div>
      )}

      {tab === "chain" && network === "mainnet"
        ? evm ? <TopUpEvm onDone={done} /> : <TopUp onDone={done} />
        : (
          <div className="flex flex-col gap-4">
            {network === "testnet" && <p className="font-semibold">{evm ? "Or move USDC from your NEAR Intents account" : "Or deposit USDC from your wallet"}</p>}
            <AmountField
              label="Amount to deposit in USDC"
              value={amount}
              onChange={setAmount}
              picks={[
                ...(need ? [{ label: `Exactly ${usdUp(Math.max(need, 1_000_000))}`, micro: Math.ceil(Math.max(need, 1_000_000) / 10_000) * 10_000 }] : []),
                { label: "$10", micro: 10_000_000 },
                { label: "$25", micro: 25_000_000 },
                { label: "$50", micro: 50_000_000 },
                ...(inWallet >= 1_000_000 ? [{ label: "All of it", micro: inWallet }] : [])
              ]}
            />
            <p className="text-sm text-muted">
              {accountId && (evm ? `Your NEAR Intents account has ${usd(inWallet)} USDC. ` : `${shortAccount(accountId)} has ${usd(inWallet)} USDC. `)}
              Deposits start at $1.{gasFree && " No network fee: Luckout pays it."}
            </p>
            <Button
              size="lg"
              loading={busy === "deposit"}
              disabled={!!busy || noGas || !(micro >= 1_000_000) || micro > inWallet}
              onClick={() => (setBusy("deposit"), actions.deposit(micro).then(done))}
            >
              {micro > inWallet
                ? `More than your ${evm ? "NEAR Intents account" : "wallet"} holds`
                : `${evm ? "Move" : "Deposit"} ${micro >= 1_000_000 ? usd(micro) : ""}${evm ? " into Luckout" : ""}`}
            </Button>
          </div>
        )}
    </div>
  )
}

/** The wallet has no NEAR for fees: how to get some, then check again without reloading. */
function GasNotice({ accountId }: { accountId: string }) {
  const { refresh } = useSession()
  const [checking, setChecking] = useState(false)
  return (
    <div className="flex flex-col gap-3 rounded-[1.5rem] bg-warn-soft p-5 text-warn">
      <p className="flex items-center gap-2 font-semibold"><Fuel size={18} aria-hidden="true" />Your wallet needs a little NEAR first</p>
      <p className="text-[15px]">
        Every NEAR transaction costs a tiny fee in NEAR (about 0.03), and {shortAccount(accountId)} has none yet.{" "}
        {network === "testnet" ? "Get free testnet NEAR from the official faucet, then check again." : "Send it about 0.1 NEAR, then check again."}
      </p>
      <div className="flex flex-wrap gap-2">
        {network === "testnet" && (
          <a href="https://docs.near.org/getting-started/faucet" target="_blank" rel="noreferrer" className={buttonVariants({ size: "sm" })}>
            Open the faucet<ExternalLink />
          </a>
        )}
        <Button variant="light" size="sm" onClick={() => navigator.clipboard.writeText(accountId).then(() => toast.success("Account copied"))}>
          <Copy />Copy account
        </Button>
        <Button
          variant="ghost"
          size="sm"
          loading={checking}
          onClick={async () => {
            setChecking(true)
            await refresh().catch(() => {})
            setChecking(false)
          }}
        >
          Check again
        </Button>
      </div>
    </div>
  )
}

export function WithdrawSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { account, accountId, evm, token } = useSession()
  const actions = useWalletActions()
  const [amount, setAmount] = useState("")
  const [busy, setBusy] = useState(false)
  // EVM wallets on mainnet pick where it lands (ADR-0011); "" keeps it in their NEAR Intents account.
  const [assets, setAssets] = useState<ReadonlyArray<TopUpAsset>>([])
  const [to, setTo] = useState("")
  const balance = Number(account?.balance ?? 0)
  const micro = toMicro(amount)
  const outward = evm && network === "mainnet"

  useEffect(() => {
    if (open) setAmount(dollars(balance))
  }, [open, balance])

  useEffect(() => {
    if (!open || !outward || !token) return
    api((c) => c.topup.assets(), token).then((all) => {
      const usdc = all.filter((a) => EVM_CHAIN_IDS[a.chain] && (a.symbol === "USDC" || a.symbol === "USDT"))
      setAssets(usdc)
      setTo((t) => t || (usdc.find((a) => a.symbol === "USDC" && a.chain === "base")?.assetId ?? ""))
    }, () => {})
  }, [open, outward, token])
  const destination = assets.find((a) => a.assetId === to)

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Withdraw"
      description={`${
        outward
          ? "USDC goes to your own address on the chain you pick, or stays in your NEAR Intents account."
          : evm
          ? "USDC goes to your NEAR Intents account, where your EVM wallet controls it."
          : `USDC goes back to ${accountId ? shortAccount(accountId) : "your wallet"}.`
      } Money locked in a purchase in progress stays until it finishes.`}
    >
      <div className="flex flex-col gap-4">
        <AmountField
          label="Amount to withdraw in USDC"
          value={amount}
          onChange={setAmount}
          picks={[{ label: "Half", micro: Math.floor(balance / 2) }, { label: `All ${usd(balance)}`, micro: balance }]}
        />
        {outward && (
          <label className="flex flex-col gap-2 text-sm">
            <span className="font-semibold">Send it to</span>
            <select className="field" value={to} onChange={(e) => setTo(e.target.value)}>
              {assets.map((a) => <option key={a.assetId} value={a.assetId}>{a.symbol} on {CHAIN_NAMES[a.chain] ?? a.chain} (your address)</option>)}
              <option value="">Keep it in NEAR Intents</option>
            </select>
            {destination && <span className="text-muted">Withdrawals start at $1. The swap's spread comes out of what arrives; there's no fee to Luckout and no gas for you.</span>}
          </label>
        )}
        <Button
          size="lg"
          loading={busy}
          disabled={busy || !(micro > 0) || micro > balance || (!!destination && micro < 1_000_000)}
          onClick={async () => {
            setBusy(true)
            if (await (destination ? actions.withdrawTo(micro, destination) : actions.withdraw(micro))) onOpenChange(false)
            setBusy(false)
          }}
        >
          {micro > balance ? `Your balance is ${usd(balance)}` : `Withdraw ${micro > 0 ? usd(micro) : ""}`}
        </Button>
      </div>
    </Sheet>
  )
}
