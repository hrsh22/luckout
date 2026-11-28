"use client"

import { useLeft } from "@/components/shop-banner"
import { chainLabel } from "@/components/token-picker"
import { AddressBox, time } from "@/components/top-up"
import { Button } from "@/components/ui/button"
import { api, errorMessage } from "@/lib/api"
import { explorer } from "@/lib/chain"
import { receivedAmount, tokenAmount, usd } from "@/lib/format"
import { ACTIVE_PHASES, useTransfers } from "@/lib/queries"
import { useSession } from "@/lib/session"
import type { Transfer } from "@luckout/api"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowDownLeft, CircleCheck, Clock, ExternalLink, RotateCcw } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

/** Where the customer's own transfer can be seen, by the chain it was sent on. */
const TX_EXPLORERS: Record<string, string> = {
  eth: "https://etherscan.io/tx/",
  arb: "https://arbiscan.io/tx/",
  base: "https://basescan.org/tx/",
  pol: "https://polygonscan.com/tx/",
  bsc: "https://bscscan.com/tx/",
  tron: "https://tronscan.org/#/transaction/",
  btc: "https://mempool.space/tx/",
  sol: "https://solscan.io/tx/",
  near: "https://nearblocks.io/txns/"
}

const minutes = (seconds: number | undefined) => (seconds ? `about ${Math.max(1, Math.round(seconds / 60))} min` : "a few minutes")
const when = (iso: string) => new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
/** "8 USDT on Tron" */
const paid = (t: Transfer) => `${t.amountIn ? `${tokenAmount(t.amountIn, t.symbol, "up")} ` : ""}${t.symbol} on ${chainLabel(t.chain)}`
const titleOf = (t: Transfer) => `${usd(t.usdc)} top-up from ${paid(t)}`
/** Where 1Click sends it back if it doesn't go through. */
const refundPlace = (t: Transfer) => (t.refundTo ? `${t.refundTo.length > 16 ? `${t.refundTo.slice(0, 6)}…${t.refundTo.slice(-4)}` : t.refundTo} on ${chainLabel(t.chain)}` : "your refund address")
/** Still before the deadline, so it can be paid, or the rest of a short payment sent. */
const open = (t: Transfer) => t.deadline !== undefined && Date.parse(t.deadline) > Date.now()

/**
 * The customer's Top-Ups from other chains still on their way, read from the server so they survive a closed tab:
 * where each is now, what usually happens next, and what to do if it's late or was sent back. Nothing here is ever
 * "just gone".
 */
export function InTransit() {
  const { token } = useSession()
  // Finished ones go to RecentTransfers, at the bottom: only what's moving or needs a look stays up here.
  const list = (useTransfers(token).data ?? []).filter((t) => t.phase !== "done")
  if (list.length === 0) return null
  const active = list.some((t) => ACTIVE_PHASES.has(t.phase))
  return (
    <section className="card flex flex-col gap-1 p-7" aria-live="polite">
      <h2 className="font-display text-2xl font-extrabold tracking-[-0.02em]">{active ? "Money on its way" : "Top-ups"}</h2>
      <p className="mb-3 text-sm text-muted">
        Top-ups from other chains, through 1Click. Each one either lands in your balance or goes back to your refund address; nothing gets lost in between.
      </p>
      <ul className="flex flex-col divide-y divide-line">
        {list.map((t) => <Row key={t.depositAddress} t={t} />)}
      </ul>
    </section>
  )
}

/** Top-Ups that landed in the last day, one line each, at the bottom of the wallet. */
export function RecentTransfers() {
  const { token } = useSession()
  const done = (useTransfers(token).data ?? []).filter((t) => t.phase === "done")
  const [all, setAll] = useState(false)
  if (done.length === 0) return null
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-3xl font-extrabold">Recent top-ups</h2>
      <ul className="card flex flex-col divide-y divide-line px-6 py-1">
        {(all ? done : done.slice(0, 3)).map((t) => (
          <li key={t.depositAddress} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-sm">
            <CircleCheck size={18} className="shrink-0 text-good" aria-hidden="true" />
            <span className="font-semibold">{titleOf(t)}</span>
            <span className="text-muted">{when(t.createdAt)}</span>
            <a href={t.explorer} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-muted underline-offset-2 hover:underline">
              Track<ExternalLink size={14} aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
      {done.length > 3 && (
        <button type="button" className="self-start text-sm font-semibold text-muted underline-offset-4 hover:text-ink hover:underline" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${done.length}`}
        </button>
      )}
    </section>
  )
}

function Row({ t }: { t: Transfer }) {
  const { token } = useSession()
  const qc = useQueryClient()
  // A quote nobody has paid into yet keeps its address behind a tap: it's often one the customer started and left.
  const unpaid = t.phase === "awaiting-transfer" && !t.depositTx
  // Ticks, so the time left stays current.
  const left = useLeft(Date.parse(t.deadline ?? ""))
  const waiting = unpaid && open(t)
  const [shown, setShown] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  // Only a Top-Up nobody paid into: the server refuses anything else. Money sent anyway still arrives and lists it again.
  const dismiss = async () => {
    setDismissing(true)
    try {
      await api((c) => c.topup.dismiss({ payload: { depositAddress: t.depositAddress } }), token)
      toast.success("Dismissed. Money already sent to it still arrives, and shows here again.")
      await qc.invalidateQueries({ queryKey: ["transfers"] })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setDismissing(false)
    }
  }
  const Icon = t.phase === "done" ? CircleCheck : t.phase === "refunded" ? RotateCcw : t.phase === "incomplete" ? Clock : ArrowDownLeft
  const tone = t.phase === "done" ? "text-good" : t.phase === "refunded" || t.phase === "incomplete" || t.late ? "text-warn" : "text-ink"
  return (
    <li className="flex gap-4 py-4">
      <Icon size={20} className={`mt-0.5 shrink-0 ${tone}`} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="font-semibold">{waiting ? `${usd(t.usdc)} top-up` : titleOf(t)}</p>
        {waiting
          ? (
            <p className="text-sm text-ink-soft">
              Send <span className="font-semibold text-ink">{paid(t)}</span> <span className="whitespace-nowrap text-muted">· {left} left</span>
              <span className="block">More is fine: everything that arrives is swapped into your balance.</span>
            </p>
          )
          : <p className="text-sm text-ink-soft">{say(t)}</p>}

        {((waiting && shown) || (t.phase === "incomplete" && open(t))) && (
          <div className="flex flex-col gap-3 rounded-2xl bg-soft p-3 text-sm">
            <AddressBox address={t.depositAddress} memo={t.depositMemo} label="QR code of 1Click's deposit address" size={112} />
            {t.phase === "awaiting-transfer" && <PasteTx t={t} />}
          </div>
        )}

        {t.late && (
          <p className="flex items-start gap-2 rounded-2xl bg-warn-soft p-3 text-sm text-warn">
            <Clock size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            Taking longer than usual. It's safe: 1Click either delivers it or sends it back to {refundPlace(t)}. You don't need to do anything.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          {waiting && !shown && <Button size="sm" onClick={() => setShown(true)}>Show address</Button>}
          {unpaid && (
            <button
              type="button"
              disabled={dismissing}
              onClick={() => void dismiss()}
              className="font-semibold text-muted underline-offset-4 hover:text-ink hover:underline disabled:opacity-45"
            >
              Dismiss
            </button>
          )}
          {t.depositTx && TX_EXPLORERS[t.chain] && (
            <a href={`${TX_EXPLORERS[t.chain]}${t.depositTx}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
              Your transfer on {chainLabel(t.chain)}<ExternalLink size={14} aria-hidden="true" />
            </a>
          )}
          {t.deliveredTx && (
            <a href={explorer(t.deliveredTx)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
              Delivery on Solana<ExternalLink size={14} aria-hidden="true" />
            </a>
          )}
          {/* Nothing to track until something is paid in. */}
          {!unpaid && (
            <a href={t.explorer} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted underline-offset-2 hover:underline">
              Track it<ExternalLink size={14} aria-hidden="true" />
            </a>
          )}
          {!waiting && <span className="text-muted">{when(t.createdAt)}</span>}
        </div>
      </div>
    </li>
  )
}

/**
 * Sent from an exchange or another wallet: its transaction keeps the Top-Up in sight past its deadline, helps 1Click
 * find the deposit, and gets us told if 1Click doesn't.
 */
function PasteTx({ t }: { t: Transfer }) {
  const { token } = useSession()
  const qc = useQueryClient()
  const [hash, setHash] = useState("")
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      await api((c) => c.topup.sent({ payload: { depositAddress: t.depositAddress, txHash: hash.trim() } }), token)
      toast.success("Got it. 1Click knows to look for your transfer.")
      void qc.invalidateQueries({ queryKey: ["transfers"] })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="flex flex-wrap gap-2" onSubmit={(e) => (e.preventDefault(), void save())}>
      <input
        className="field min-w-0 flex-1 !py-1.5 font-mono text-xs"
        placeholder="Already sent it? Paste the transaction hash"
        aria-label="Your transaction hash"
        value={hash}
        onChange={(e) => setHash(e.target.value)}
      />
      <Button size="sm" variant="light" type="submit" loading={busy} disabled={!hash.trim()}>Add</Button>
    </form>
  )
}

/** One sentence: where the money is right now, and what happens next. */
function say(t: Transfer) {
  switch (t.phase) {
    case "awaiting-transfer":
      if (t.depositTx) {
        // Paid: 1Click has until the deadline itself to see it.
        return open(t)
          ? "You sent it. Waiting for 1Click to confirm it arrived, usually within a minute."
          : `1Click hasn't confirmed your transfer yet. It's at 1Click's deposit address, so it either goes through or comes back to ${refundPlace(t)}. Luckout is looking into it.`
      }
      // One still open is said by the row itself: what to send and the time left.
      return "This price has expired and nothing was sent. Top up again for a new one."
    case "incomplete": {
      const got = t.deposited ? `${receivedAmount(t.deposited, t.symbol)} ${t.symbol}` : "part"
      return open(t)
        ? `1Click got ${got} of the ${paid(t)} this needs. Send the rest to the same address before ${time(t.deadline!)}, or what arrived goes back to ${refundPlace(t)}.`
        : `1Click got ${got} of the ${paid(t)} this needs, too late to finish: it's going back to ${refundPlace(t)}.`
    }
    case "swapping":
      return `1Click has your ${t.symbol} and is converting it to USDC. Usually ${minutes(t.timeEstimateSeconds)}.`
    case "done":
      return "In your Luckout balance."
    case "refunded":
      return `Didn't go through${t.detail ? ` (${t.detail})` : ""}. 1Click sent ${t.refunded ? `${receivedAmount(t.refunded, t.symbol)} ${t.symbol}` : "it"} back to ${refundPlace(t)}.`
  }
}
