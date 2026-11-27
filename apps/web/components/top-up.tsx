"use client"

import { AmountField } from "@/components/amount-field"
import { Qr } from "@/components/qr"
import { chainLabel, sortAssets, TokenMark, TokenPicker } from "@/components/token-picker"
import { Button } from "@/components/ui/button"
import { api, errorMessage } from "@/lib/api"
import { cluster } from "@/lib/chain"
import { dollars, tokenAmount, toMicro, usd } from "@/lib/format"
import { refundAddress, setRefundAddress } from "@/lib/onboarding"
import { useTopUpAssets } from "@/lib/queries"
import { useSession } from "@/lib/session"
import { minimumOf, topUpMicro, topUpPicks } from "@/lib/top-up-quote"
import type { TopUpAsset, TopUpQuote } from "@luckout/api"
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query"
import { Circle, CircleCheck, Copy, LoaderCircle } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

// Top-Ups from other chains (ADR-0015): a 1Click quote that swaps whatever arrives above its minimum (FLEX_INPUT)
// into USDC at the customer's Deposit Address, where it moves into their Balance by itself. 1Click refunds to the
// address the customer gives on the source chain, not to the sender, so an exchange can send it.

const FINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"])

/** A transfer's network fee on each chain, roughly: the sender pays it, not Luckout. */
const FEES: Record<string, string> = {
  base: "under $0.01",
  arb: "under $0.01",
  pol: "under $0.01",
  sol: "under $0.01",
  near: "under $0.01",
  bsc: "about $0.02",
  eth: "varies, often $0.50 or more"
}

/** What a refund address looks like on each chain, as the field's hint. */
const PLACEHOLDERS: Record<string, string> = { eth: "0x…", arb: "0x…", base: "0x…", pol: "0x…", bsc: "0x…", tron: "T…", btc: "bc1…", near: "you.near", sol: "Your Solana address" }

export const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

export const copy = (text: string, what: string) =>
  navigator.clipboard.writeText(text).then(() => toast.success(`${what} copied`), () => toast.error("Couldn't copy. Select it and copy it instead."))

/** An address to copy, or to scan from a phone wallet or an exchange app. `qr` is what the code holds, if not the address. */
export function AddressBox({ address, qr = address, memo, label, size = 136 }: {
  address: string
  qr?: string
  memo?: string | undefined
  label: string
  size?: number
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <Qr value={qr} size={size} label={label} />
      <div className="flex min-w-0 flex-col gap-2">
        <p className="font-mono text-sm break-all text-ink select-all">{address}</p>
        {memo && <p className="text-sm">Memo (required): <span className="font-mono select-all">{memo}</span></p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="light" size="sm" onClick={() => copy(address, "Address")}><Copy />Copy address</Button>
          {memo && <Button variant="light" size="sm" onClick={() => copy(memo, "Memo")}><Copy />Copy memo</Button>}
        </div>
      </div>
    </div>
  )
}

/** A live price while the amount, token and refund address are chosen: a dry quote, so nothing is created. */
const usePreview = (token: string | undefined, assetId: string | undefined, micro: number, refundTo: string) => {
  const asked = { assetId: assetId ?? "", micro, refundTo: refundTo.trim() }
  const [settled, setSettled] = useState(asked)
  const key = JSON.stringify(asked)
  useEffect(() => {
    const t = setTimeout(() => setSettled(JSON.parse(key)), 400)
    return () => clearTimeout(t)
  }, [key])
  return useQuery({
    queryKey: ["topup-preview", settled.assetId, settled.micro, settled.refundTo],
    queryFn: () => api((c) => c.topup.quote({ payload: { originAsset: settled.assetId, usdc: settled.micro, refundTo: settled.refundTo, dry: true } }), token),
    enabled: !!token && !!settled.assetId && settled.micro >= 1_000_000 && !!settled.refundTo,
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousData
  })
}

function Preview({ q, stale, error }: { q: TopUpQuote | undefined; stale: boolean; error: unknown }) {
  if (error) return <p role="alert" className="text-sm font-medium text-bad">{errorMessage(error)}</p>
  if (!q) return <span className="skeleton h-[66px] rounded-2xl" />
  const chain = chainLabel(q.chain)
  return (
    <div className={`flex flex-col gap-1 rounded-2xl bg-soft px-4 py-3 transition-opacity ${stale ? "opacity-60" : ""}`} aria-live="polite">
      <p className="flex items-center gap-2">
        <TokenMark symbol={q.symbol} chain={q.chain} size={22} />
        <span>You send <b>≈ {tokenAmount(q.amountInFormatted, q.symbol, "up")} {q.symbol}</b> on {chain}</span>
      </p>
      <p className="text-sm text-muted">
        In your balance about {Math.max(1, Math.ceil(q.timeEstimateSeconds / 60))} min after it arrives · {chain} network fee:{" "}
        {FEES[q.chain] ?? "set by your wallet or exchange"}, paid by the sender
      </p>
    </div>
  )
}

/** The step a Top-Up is on, from 1Click's status: 0 the transfer, 1 converting, 3 all done. */
const stepOf = (status: string) => (status === "PROCESSING" ? 1 : status === "SUCCESS" ? 3 : 0)

function Steps({ at, minutes }: { at: number; minutes: number }) {
  const steps = ["Your transfer arrives", `Converted to USDC, usually in about ${minutes} min`, "In your balance a minute later"]
  return (
    <ol className="flex flex-col gap-1.5" aria-label="Top-up progress">
      {steps.map((s, i) => (
        <li key={i} aria-current={i === at ? "step" : undefined} className={`flex items-center gap-2 ${i === at ? "font-semibold" : i > at ? "text-muted" : ""}`}>
          {i < at
            ? <CircleCheck size={18} className="shrink-0 text-good" aria-hidden="true" />
            : i === at
            ? <LoaderCircle size={18} className="shrink-0 animate-spin" aria-hidden="true" />
            : <Circle size={18} className="shrink-0" aria-hidden="true" />}
          {s}
        </li>
      ))}
    </ol>
  )
}

/**
 * Top up from another chain through 1Click: the customer picks the USDC to receive, the token and chain they pay with,
 * and an address there for refunds; then they get 1Click's deposit address. `onContinue` lets them go on without
 * waiting: it lands by itself.
 */
export function TopUp({ need, onContinue }: { need?: number | undefined; onContinue?: (() => void) | undefined }) {
  const { accountId, token } = useSession()
  const qc = useQueryClient()
  const all = useTopUpAssets(token)
  // USDT and ORE on Solana go to the Deposit Address instead, and are swapped there with a tap.
  const assets = useMemo(() => sortAssets((all.data ?? []).filter((a) => !a.swap)), [all.data])
  const [assetId, setAssetId] = useState("")
  const asset = assets.find((a) => a.assetId === assetId) ?? assets[0]
  const [amount, setAmount] = useState(() => dollars(topUpMicro(need)))
  const [refundTo, setRefundTo] = useState("")
  const micro = toMicro(amount)
  const preview = usePreview(token, asset?.assetId, micro, refundTo)
  const [quoted, setQuoted] = useState<{ quote: TopUpQuote; asset: TopUpAsset }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const chain = asset ? chainLabel(asset.chain) : ""

  // The refund address they last gave on this chain, until they type another.
  useEffect(() => {
    if (accountId && asset) setRefundTo(refundAddress(accountId, asset.chain))
  }, [accountId, asset?.chain]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!token || !accountId) return null
  if (quoted) return <Quoted {...quoted} onAgain={() => setQuoted(undefined)} onContinue={onContinue} />

  const getAddress = async () => {
    if (!asset) return
    setBusy(true)
    setError(undefined)
    try {
      const quote = await api((c) => c.topup.quote({ payload: { originAsset: asset.assetId, usdc: micro, refundTo: refundTo.trim() } }), token)
      setRefundAddress(accountId, asset.chain, refundTo.trim())
      setQuoted({ quote, asset })
      // Recorded on the server now: it shows under "Money on its way" even if this closes.
      void qc.invalidateQueries({ queryKey: ["transfers"] })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {cluster !== "mainnet" && (
        <p role="note" className="rounded-2xl bg-warn-soft p-3 text-sm text-warn">This is {cluster}: prices work, but deposit addresses are given out on mainnet only.</p>
      )}
      <AmountField label="USDC to receive" value={amount} onChange={setAmount} picks={topUpPicks(need)} />
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-muted">Pay with</span>
        {all.isError
          ? <p role="alert" className="text-sm font-medium text-bad">{errorMessage(all.error)}</p>
          : all.data
          ? <TokenPicker assets={assets} value={asset?.assetId ?? ""} onChange={setAssetId} />
          : <span className="skeleton h-14 rounded-[1.25rem]" />}
      </div>
      {asset && (
        <div className="flex flex-col gap-2">
          <label htmlFor="refund-to" className="text-sm font-semibold text-muted">Your address on {chain}, for refunds</label>
          <input
            id="refund-to"
            className="field font-mono text-sm"
            value={refundTo}
            onChange={(e) => setRefundTo(e.target.value)}
            placeholder={PLACEHOLDERS[asset.chain] ?? "Your address"}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
          />
          <p className="text-sm text-muted">
            If the swap can't finish (too little arrives, or too late), 1Click sends the money back to this address, not to whoever sent it. So
            you can pay from an exchange, but give an address you control on {chain}.
          </p>
        </div>
      )}
      {micro >= 1_000_000 && asset && refundTo.trim() && <Preview q={preview.data} stale={preview.isPlaceholderData || preview.isFetching} error={preview.error} />}
      <Button size="lg" loading={busy} disabled={busy || !asset || !(micro >= 1_000_000) || !refundTo.trim()} onClick={getAddress}>
        Get the deposit address
      </Button>
      {error && <p role="alert" className="text-sm font-medium text-bad">{error}</p>}
    </div>
  )
}

/** The quote to pay: where, exactly how much, the least that's swapped, until when, and where refunds go; then where it is. */
function Quoted({ quote, asset, onAgain, onContinue }: { quote: TopUpQuote; asset: TopUpAsset; onAgain: () => void; onContinue?: (() => void) | undefined }) {
  const { token } = useSession()
  const [status, setStatus] = useState("PENDING_DEPOSIT")
  const done = FINAL.has(status)

  // 1Click's status until it settles. The Wallet page keeps following it after this closes.
  useEffect(() => {
    if (done) return
    const t = setInterval(() => {
      api((c) => c.topup.status({ query: { depositAddress: quote.depositAddress } }), token).then((s) => setStatus(s.status), () => {})
    }, 5000)
    return () => clearInterval(t)
  }, [quote.depositAddress, token, done])

  const chain = chainLabel(quote.chain)
  const send = tokenAmount(quote.amountInFormatted, quote.symbol, "up")
  const min = minimumOf(quote, asset.decimals)
  const by = time(quote.deadline)
  return (
    <div className="flex flex-col gap-4 rounded-[1.5rem] bg-soft p-5 text-sm">
      <p className="text-base">
        Send <b>{send} {quote.symbol}</b> on <b>{chain}</b> to this address before <b>{by}</b>, and get about <b>{usd(quote.usdcOut)}</b> in your balance.
      </p>
      <AddressBox address={quote.depositAddress} memo={quote.depositMemo} label={`QR code of 1Click's deposit address on ${chain}`} />
      <Button variant="light" size="sm" className="self-start" onClick={() => copy(send, "Amount")}><Copy />Copy amount</Button>
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-ink-soft">
        <li>Only {quote.symbol} on {chain}. Another token or network can't be swapped.</li>
        <li>More is fine: everything that arrives is swapped and lands in your balance, so add a little for an exchange's withdrawal fee.</li>
        {min && <li>At least {tokenAmount(min, quote.symbol, "up")} {quote.symbol} must arrive. Less waits for the rest until {by}, then goes back to your refund address.</li>}
        <li>Refunds go to <span className="font-mono break-all">{quote.refundTo}</span> on {chain}.</li>
      </ul>
      {status === "REFUNDED" || status === "FAILED"
        ? <p className="font-medium text-warn">It didn't go through: 1Click sent it back to your refund address on {chain}.</p>
        : status === "INCOMPLETE_DEPOSIT"
        ? <p className="font-medium text-warn">1Click got part of it. Send the rest to the same address before {by}, or what arrived goes back to your refund address.</p>
        : <Steps at={stepOf(status)} minutes={Math.max(1, Math.ceil(quote.timeEstimateSeconds / 60))} />}
      {!done && (
        <div className="flex flex-col gap-2 rounded-2xl bg-white p-3">
          <p>No need to wait here: once 1Click has it, it lands in your balance by itself. Wallet shows where it is.</p>
          {onContinue && <Button size="sm" className="self-start" onClick={onContinue}>Continue</Button>}
        </div>
      )}
      <Button variant={done ? "primary" : "ghost"} size="sm" className="self-start" onClick={onAgain}>
        {done ? "Top up again" : "Start a different Top-Up"}
      </Button>
    </div>
  )
}
