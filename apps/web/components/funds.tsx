"use client"

import { AmountField } from "@/components/amount-field"
import { HelpLink } from "@/components/help-link"
import { AddressBox, TopUp } from "@/components/top-up"
import { Button } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { useWalletActions } from "@/lib/actions"
import { errorMessage } from "@/lib/api"
import { dollars, toMicro, usd, usdUp } from "@/lib/format"
import { modeName } from "@/lib/modes"
import { pendingMode, setPendingMode } from "@/lib/onboarding"
import { useDepositAddress, useProgram, useTopUpAssets } from "@/lib/queries"
import { useSession } from "@/lib/session"
import { solanaPayUri, tapsFor, withdrawProblem } from "@/lib/top-up-quote"
import { useQueryClient } from "@tanstack/react-query"
import { LoaderCircle } from "lucide-react"
import { useEffect, useRef, useState } from "react"

export { AmountField }

type Tab = "solana" | "chain"

/** Add funds without leaving the page, as a sheet. `need` is what's missing for a card. */
export function AddFundsSheet({ open, onOpenChange, need, tab = "solana" }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  need?: number
  tab?: Tab
}) {
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Add funds"
      description={need ? `You need ${usdUp(need)} more for this card.` : "Your balance pays for cards. Withdraw what you don't spend any time."}
    >
      <AddFundsPanel key={`${need ?? 0}-${tab}`} need={need} tab={tab} onDone={(ok) => ok && onOpenChange(false)} onContinue={() => onOpenChange(false)} />
    </Sheet>
  )
}

/**
 * Adding funds (ADR-0015): the one-time approval first, then the Deposit Address for USDC and USDT on Solana, or a
 * 1Click Top-Up from another chain. Money arrives by itself, so `onContinue` lets the customer go on without waiting;
 * `onDone(true)` runs once their balance has grown.
 */
export function AddFundsPanel({ need, onDone, onContinue, tab: first = "solana" }: {
  need?: number | undefined
  onDone: (ok: boolean) => void
  onContinue?: () => void
  tab?: Tab
}) {
  const { account, token } = useSession()
  const approved = useDepositAddress(token).data?.approved === true
  const [tab, setTab] = useState<Tab>(first)

  // The balance when this opened; once it grows, the money has landed.
  const balance = account === undefined ? undefined : Number(account?.balance ?? 0)
  const start = useRef<number | undefined>(undefined)
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    if (balance === undefined) return
    if (start.current === undefined) start.current = balance
    else if (balance > start.current) {
      start.current = balance
      done.current(true)
    }
  }, [balance])

  return (
    <div className="flex flex-col gap-6">
      {/* A Top-Up from another chain lands at the Deposit Address too: it needs the approval first. */}
      {approved && (
        <div role="tablist" className="flex rounded-full bg-soft p-1">
          {(["solana", "chain"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              type="button"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className="h-10 flex-1 rounded-full text-sm font-semibold text-muted transition-colors aria-selected:bg-white aria-selected:text-ink aria-selected:shadow-card"
            >
              {t === "solana" ? "On Solana" : "From another chain"}
            </button>
          ))}
        </div>
      )}
      {approved && tab === "chain" ? <TopUp need={need} onContinue={onContinue} /> : <DepositPanel need={need} onContinue={onContinue} />}
      <p className="text-sm text-muted">
        <HelpLink href="/docs/add-funds">Every way to add funds</HelpLink>, with what each costs.
      </p>
    </div>
  )
}

/**
 * The customer's Deposit Address: their own Solana address, where USDC moves into their Balance by itself (ADR-0015).
 * Before the one-time approval, the approval. After it, the address with its QR, what's waiting there, and a tap for
 * any USDT or ORE there.
 */
export function DepositPanel({ need, onContinue }: { need?: number | undefined; onContinue?: (() => void) | undefined }) {
  const { accountId, account, token, refresh } = useSession()
  const actions = useWalletActions()
  const qc = useQueryClient()
  const deposit = useDepositAddress(token)
  const usdcMint = useProgram().data?.usdcMint
  const assets = useTopUpAssets(token).data ?? []
  const [busy, setBusy] = useState<string>()

  // Deposits land by themselves: each time the address is read again, so is the balance.
  useEffect(() => {
    if (deposit.dataUpdatedAt) refresh().catch(() => {})
  }, [deposit.dataUpdatedAt, refresh])

  if (!accountId) return null
  const d = deposit.data
  if (!d) {
    return deposit.isError
      ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm font-medium text-bad">Couldn't read your Deposit Address. {errorMessage(deposit.error)}</p>
          <Button variant="light" size="sm" loading={deposit.isFetching} onClick={() => void deposit.refetch()}>Try again</Button>
        </div>
      )
      : <span className="skeleton h-40 rounded-[1.5rem]" />
  }

  const after = async (key: string, f: () => Promise<boolean>) => {
    setBusy(key)
    const ok = await f()
    await qc.invalidateQueries({ queryKey: ["deposit-address"] })
    setBusy(undefined)
    return ok
  }

  if (!d.approved) {
    // A new customer's account opens on the mode they chose in Welcome (or here, on Wallet).
    const mode = account?.default_mode ?? pendingMode(accountId) ?? "normal"
    const approve = () => after("approve", () => actions.approve(mode)).then((ok) => ok && setPendingMode(accountId, undefined))
    return (
      <div className="flex flex-col gap-4">
        {account
          ? (
            <p>
              Your Deposit Address lost its approval for Luckout: another app replaced it. Until you approve again, what you send there waits
              at the address, still yours.
            </p>
          )
          : (
            <>
              <p>
                One tap sets up your <b>Deposit Address</b>: your own Solana address, where USDC from any exchange or wallet moves into your
                balance by itself. The program lets it go into your balance and nowhere else.
              </p>
              <p className="text-sm text-muted">It also opens your Luckout account, on {modeName(mode)} as your default mode. No fee: Luckout pays it.</p>
            </>
          )}
        {d.waiting > 0 && <p className="text-sm font-medium">{usd(d.waiting)} USDC is at the address already: it moves into your balance once you approve.</p>}
        <Button size="lg" className="self-start" loading={busy === "approve"} disabled={!!busy} onClick={() => void approve()}>
          {account ? "Approve it again" : "Set up deposits"}
        </Button>
      </div>
    )
  }

  const taps = tapsFor(d.held, assets)
  return (
    <div className="flex flex-col gap-4">
      <p>
        Send USDC or USDT <b>on Solana</b> to your Deposit Address, from any exchange or wallet.
        {need ? <> This card needs at least <b>{usdUp(Math.max(need, 1_000_000))}</b>.</> : null}
      </p>
      <AddressBox address={d.address} qr={usdcMint ? solanaPayUri(d.address, usdcMint) : d.address} label="QR code of your Deposit Address" />
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-ink-soft">
        <li>USDC lands in your balance by itself, in a minute or two. Less than 1 USDC waits here until more arrives.</li>
        <li>USDT takes one tap here once it arrives{assets.some((a) => a.swap && a.symbol === "ORE") ? ", and so does ORE" : ""}.</li>
        <li>On an exchange, pick the Solana network. USDC on another network doesn't arrive here: use From another chain.</li>
        <li>A wallet app that scans the code opens a USDC transfer; on an exchange, paste the address.</li>
      </ul>

      {d.waiting >= 1_000_000
        ? (
          <p className="flex items-center gap-2 rounded-2xl bg-soft p-3 text-sm font-medium" aria-live="polite">
            <LoaderCircle size={16} className="shrink-0 animate-spin" aria-hidden="true" />
            {usd(d.waiting)} USDC has arrived and is moving into your balance.
          </p>
        )
        : d.waiting > 0 && (
          <p className="rounded-2xl bg-soft p-3 text-sm" aria-live="polite">
            {usd(d.waiting)} USDC is here, under the 1 USDC minimum: it moves into your balance once more arrives.
          </p>
        )}

      {taps.map((t) => (
        <div key={t.held.assetId} className="flex flex-col gap-2 rounded-2xl bg-gold-soft p-4 text-gold-ink">
          <p>
            <b>{t.amount} {t.held.symbol}</b> is at your Deposit Address{t.usd !== undefined ? `, worth about ${usd(Math.floor(t.usd * 1e6))}` : ""}.
          </p>
          {t.enough
            ? (
              <>
                <p className="text-sm">One tap swaps all of it into USDC through Jupiter and puts it in your balance, in one transaction. Luckout pays the fee.</p>
                <Button
                  size="sm"
                  variant="light"
                  className="self-start"
                  loading={busy === t.held.assetId}
                  disabled={!!busy}
                  onClick={() => void after(t.held.assetId, () => actions.swap(t.held))}
                >
                  Swap it into my balance
                </Button>
              </>
            )
            : <p className="text-sm">That's under $1 of {t.held.symbol}, the smallest swap. Send a little more to swap it.</p>}
        </div>
      ))}

      {onContinue && (
        <div className="flex flex-col gap-2 rounded-2xl bg-soft p-3 text-sm">
          <p>Sent it, or sending it later? No need to wait here: it lands in your balance by itself.</p>
          <Button size="sm" className="self-start" onClick={onContinue}>Continue</Button>
        </div>
      )}
    </div>
  )
}

export function WithdrawSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { account, accountId } = useSession()
  const actions = useWalletActions()
  const [amount, setAmount] = useState("")
  const [to, setTo] = useState("")
  const [busy, setBusy] = useState(false)
  const balance = Number(account?.balance ?? 0)
  const micro = toMicro(amount)
  const problem = to.trim() ? withdrawProblem(to.trim(), accountId) : undefined

  useEffect(() => {
    if (open) setAmount(dollars(balance))
  }, [open, balance])

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Withdraw"
      description="USDC goes to any Solana address: a wallet of yours, or an exchange's USDC deposit address on Solana. Money locked in a purchase in progress stays until it finishes."
    >
      <div className="flex flex-col gap-4">
        <AmountField
          label="Amount to withdraw in USDC"
          value={amount}
          onChange={setAmount}
          picks={[{ label: "Half", micro: Math.floor(balance / 2) }, { label: `All ${usd(balance)}`, micro: balance }].filter((p) => p.micro > 0)}
        />
        <div className="flex flex-col gap-2">
          <label htmlFor="withdraw-to" className="text-sm font-semibold text-muted">To this Solana address</label>
          <input
            id="withdraw-to"
            className="field font-mono text-sm"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            aria-invalid={!!problem}
            placeholder="Your wallet or exchange address on Solana"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
          />
          {problem
            ? <p role="alert" className="text-sm font-medium text-bad">{problem}</p>
            : <p className="text-sm text-muted">Sent as USDC on Solana. Check the address: a transfer can't be undone. No fee: Luckout pays it.</p>}
        </div>
        <Button
          size="lg"
          loading={busy}
          disabled={busy || !(micro > 0) || micro > balance || !to.trim() || !!problem}
          onClick={async () => {
            setBusy(true)
            if (await actions.withdraw(micro, to.trim())) {
              setTo("")
              onOpenChange(false)
            }
            setBusy(false)
          }}
        >
          {micro > balance ? `Your balance is ${usd(balance)}` : `Withdraw ${micro > 0 ? usd(micro) : ""}`}
        </Button>
      </div>
    </Sheet>
  )
}
