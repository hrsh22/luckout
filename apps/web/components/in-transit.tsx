"use client"

import { Button } from "@/components/ui/button"
import { useWalletActions } from "@/lib/actions"
import { CHAIN_NAMES } from "@/lib/evm"
import { usd } from "@/lib/format"
import { ACTIVE_PHASES, useHeld, useTransfers } from "@/lib/queries"
import { useSession } from "@/lib/session"
import type { HeldToken, Transfer } from "@luckout/api"
import { useState } from "react"
import { ArrowDownLeft, ArrowUpRight, CircleCheck, Clock, Copy, ExternalLink, RotateCcw } from "lucide-react"
import { toast } from "sonner"

const TX_EXPLORERS: Record<string, string> = {
  eth: "https://etherscan.io/tx/",
  arb: "https://arbiscan.io/tx/",
  base: "https://basescan.org/tx/",
  pol: "https://polygonscan.com/tx/",
  bsc: "https://bscscan.com/tx/"
}
/** Where a customer moves money out of their NEAR Intents account themselves: same wallet, no Luckout needed. */
const INTENTS_APP = "https://near-intents.org"

const chain = (c: string) => CHAIN_NAMES[c] ?? c
/** " on Base", or nothing for a swap recorded before its chain was kept. */
const on = (c: string) => (c ? ` on ${chain(c)}` : "")
const walletOn = (c: string) => (c === "near" ? "your NEAR wallet" : `your wallet${on(c)}`)
/** Where 1Click sends a Top-Up's money if it doesn't go through. */
const refundPlace = (t: Transfer) => (t.refundsToWallet ? walletOn(t.chain) : "your NEAR Intents account")
const minutes = (seconds: number | undefined) => (seconds ? `about ${Math.max(1, Math.round(seconds / 60))} min` : "a few minutes")
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
/** Still before the deadline, so the rest of a short payment can be sent. */
const open = (t: Transfer) => t.deadline !== undefined && Date.parse(t.deadline) > Date.now()

/**
 * Money on its way (Top-Ups from other chains and withdrawals to them), read from the server so it
 * survives a closed tab: where it is now, what usually happens next, and what to do if it's late or
 * was sent back. Nothing here is ever "just gone".
 */
export function InTransit() {
  const { token } = useSession()
  const transfers = useTransfers(token)
  const list = transfers.data ?? []
  if (list.length === 0) return null
  const active = list.filter((t) => ACTIVE_PHASES.has(t.phase))
  return (
    <section className="card flex flex-col gap-1 p-7" aria-live="polite">
      <h2 className="font-display text-2xl font-extrabold tracking-[-0.02em]">{active.length > 0 ? "Money on its way" : "Recent transfers"}</h2>
      <p className="mb-3 text-sm text-muted">
        Top-ups and withdrawals through NEAR Intents. Each one either arrives or is sent back; nothing gets lost in between.
      </p>
      <ul className="flex flex-col divide-y divide-line">
        {list.map((t) => <Row key={t.depositAddress} t={t} />)}
      </ul>
    </section>
  )
}

/**
 * What else is in the customer's own NEAR Intents account: a refund, or the extra a Top-Up asked for, in the
 * token paid with. Luckout can't spend it, but it's the customer's: one tap sends it to their own wallet.
 */
export function HeldInIntents() {
  const { token, evm } = useSession()
  const actions = useWalletActions()
  const held = useHeld(token).data ?? []
  const [sending, setSending] = useState<string>()
  if (held.length === 0) return null
  const sendBack = (h: HeldToken) => {
    setSending(h.assetId)
    void actions.sendBack(h).finally(() => setSending(undefined))
  }
  return (
    <section className="card flex flex-col gap-3 p-7">
      <h2 className="font-display text-2xl font-extrabold tracking-[-0.02em]">Also yours, in NEAR Intents</h2>
      <ul className="flex flex-col gap-2">
        {held.map((h) => (
          <li key={h.assetId} className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold">{h.amount} {h.symbol} <span className="font-normal text-muted">on {chain(h.chain)}</span></span>
            {h.sendable && (
              <Button size="sm" variant="light" disabled={sending !== undefined} onClick={() => sendBack(h)}>
                {evm ? `Send to my wallet on ${chain(h.chain)}` : "Send to my NEAR wallet as USDC"}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <p className="text-sm text-ink-soft">
        A refund, or the extra a top-up asked for, that 1Click sent back to your own NEAR Intents account in the token you paid with.
        Your wallet controls it, not Luckout.{" "}
        {held.every((h) => h.sendable)
          ? "Sending it to your wallet takes one signature, and Luckout pays the network fee."
          : <>You can also sign in on <a href={INTENTS_APP} target="_blank" rel="noreferrer" className="font-semibold underline underline-offset-2">near-intents.org</a> with this same wallet to move it.</>}
      </p>
    </section>
  )
}

function Row({ t }: { t: Transfer }) {
  const { evm, walletUsdc } = useSession()
  const actions = useWalletActions()
  const incoming = t.direction === "in"
  const title = incoming
    ? `${usd(t.usdc)} top-up${t.amountIn ? ` from ${t.amountIn} ${t.symbol}` : ""}${on(t.chain)}`
    : t.direction === "back"
    ? `${t.amountOut ?? t.amountIn ?? ""} ${t.symbol} to ${walletOn(t.chain)}`
    : `${usd(t.usdc)} withdrawal to ${t.symbol}${on(t.chain)}`
  const Icon = t.phase === "done" || t.phase === "in-wallet"
    ? CircleCheck
    : t.phase === "refunded"
    ? RotateCcw
    : t.phase === "incomplete"
    ? Clock
    : incoming
    ? ArrowDownLeft
    : ArrowUpRight
  const tone = t.phase === "done" || t.phase === "in-wallet" ? "text-good" : t.phase === "refunded" || t.phase === "incomplete" || t.late ? "text-warn" : "text-ink"
  const sitting = Number(walletUsdc ?? 0)
  return (
    <li className="flex gap-4 py-4">
      <Icon size={20} className={`mt-0.5 shrink-0 ${tone}`} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="font-semibold">{title}</p>
        <p className="text-sm text-ink-soft">{say(t, evm, sitting >= 1_000_000)}</p>

        {(t.phase === "awaiting-transfer" || (t.phase === "incomplete" && open(t))) && (
          <div className="flex flex-col gap-1 rounded-2xl bg-soft p-3 text-sm">
            <span className="font-mono break-all select-all">{t.depositAddress}</span>
            {t.depositMemo && <span>Memo (required): <span className="font-mono select-all">{t.depositMemo}</span></span>}
            <Button variant="light" size="sm" className="self-start" onClick={() => navigator.clipboard.writeText(t.depositAddress).then(() => toast.success("Address copied"))}>
              <Copy />Copy address
            </Button>
          </div>
        )}

        {t.late && (
          <p className="flex items-start gap-2 rounded-2xl bg-warn-soft p-3 text-sm text-warn">
            <Clock size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            Taking longer than usual. It's safe: 1Click either delivers it or sends it back to {refundPlace(t)}. You don't need to do anything.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          {t.phase === "in-wallet" && sitting >= 1_000_000 && (
            <Button size="sm" onClick={() => void actions.deposit(Math.min(sitting, t.usdc))}>Deposit {usd(Math.min(sitting, t.usdc))} into Luckout</Button>
          )}
          {evm && (t.phase === "in-intents" || (t.phase === "refunded" && t.direction === "out")) && sitting >= 1_000_000 && (
            <Button size="sm" onClick={() => void actions.deposit(sitting)}>Move {usd(sitting)} into Luckout</Button>
          )}
          {t.deliveredTx && TX_EXPLORERS[t.chain] && (
            <a href={`${TX_EXPLORERS[t.chain]}${t.deliveredTx}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
              Delivery on {chain(t.chain)}<ExternalLink size={14} aria-hidden="true" />
            </a>
          )}
          <a href={t.explorer} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted underline-offset-2 hover:underline">
            Track on NEAR Intents<ExternalLink size={14} aria-hidden="true" />
          </a>
          <span className="text-muted">{new Date(t.createdAt).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
        </div>
      </div>
    </li>
  )
}

/** One sentence: where the money is right now, and what happens next. */
function say(t: Transfer, evm: boolean, canDeposit: boolean) {
  const usual = minutes(t.timeEstimateSeconds)
  switch (t.phase) {
    case "awaiting-transfer":
      return `Waiting for your transfer: send exactly ${t.amountIn ?? ""} ${t.symbol}${on(t.chain)}${t.deadline ? ` before ${time(t.deadline)}` : ""} to the address below.`
    case "incomplete":
      return open(t)
        ? `1Click got ${t.deposited ?? "part"} of the ${t.amountIn ?? ""} ${t.symbol} this needs. Send the rest to the same address before ${time(t.deadline!)}, or what arrived goes back to ${refundPlace(t)}.`
        : `1Click got ${t.deposited ?? "part"} of the ${t.amountIn ?? ""} ${t.symbol} this needs, too late to finish: it's going back to ${refundPlace(t)}.`
    case "swapping":
      return t.direction === "in"
        ? `1Click has your ${t.symbol} and is ${t.symbol === "USDC" ? "bringing it over to NEAR" : "converting it to USDC"}. Usually ${usual}.`
        : `On its way to ${walletOn(t.chain)}. Usually ${usual}.`
    case "moving":
      return "Landed. Moving it into your Luckout balance now."
    case "in-wallet":
      return canDeposit ? "Landed in your NEAR wallet. Deposit it to use it in Luckout." : "Landed in your NEAR wallet."
    case "in-intents":
      return `Landed in your NEAR Intents account${t.detail ? ` but didn't move into Luckout (${t.detail})` : ""}. ${evm ? "Move it in below." : ""}`.trim()
    case "done":
      return t.direction === "in" ? "In your Luckout balance." : `Arrived: ${t.amountOut ?? usd(t.usdc)} ${t.symbol}${on(t.chain)}.`
    case "refunded": {
      const why = `Didn't go through${t.detail ? ` (${t.detail})` : ""}.`
      if (t.direction === "back") return `${why} It's still in your NEAR Intents account, below.`
      if (t.direction === "out") return `${why} 1Click sent it back to your NEAR Intents account${evm ? "; move it back into Luckout below." : "."}`
      return `${why} 1Click sent ${t.refunded ? `${t.refunded} ${t.symbol}` : "it"} back to ${refundPlace(t)}${t.refundsToWallet ? "." : ", listed below."}`
    }
  }
}
