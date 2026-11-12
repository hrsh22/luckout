"use client"

import { AmountField } from "@/components/amount-field"
import { Qr } from "@/components/qr"
import { chainLabel, sortAssets, TokenMark, TokenPicker } from "@/components/token-picker"
import { Button } from "@/components/ui/button"
import { depositCall, useWalletActions } from "@/lib/actions"
import { api, errorMessage } from "@/lib/api"
import { dollars, tokenAmount, toMicro, usd, usdUp } from "@/lib/format"
import { usdcId, view } from "@/lib/near"
import { useHeld } from "@/lib/queries"
import { useSession } from "@/lib/session"
import type { TopUpAsset, TopUpQuote } from "@luckout/api"
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query"
import { Copy } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

const STORAGE_DEPOSIT = "1250000000000000000000" // 0.00125 NEAR, USDC's registration fee
const DONE = new Set(["SUCCESS", "REFUNDED", "FAILED"])

/** A transfer's network fee on each chain, roughly: it's paid by the sender's own wallet, not Luckout. */
const FEES: Record<string, string> = {
  base: "under $0.01",
  arb: "under $0.01",
  pol: "under $0.01",
  sol: "under $0.01",
  near: "under $0.01",
  bsc: "about $0.02",
  eth: "varies, often $0.50 or more",
  btc: "set by your wallet"
}

/** A live price for a Top-Up while the amount and token are chosen: a dry quote, so nothing is created. */
export const useTopUpPreview = (token: string | undefined, assetId: string, micro: number) => {
  const [settled, setSettled] = useState(micro)
  useEffect(() => {
    const t = setTimeout(() => setSettled(micro), 400)
    return () => clearTimeout(t)
  }, [micro])
  return useQuery({
    queryKey: ["topup-preview", assetId, settled],
    queryFn: () => api((c) => c.topup.quote({ payload: { originAsset: assetId, usdc: settled, dry: true } }), token),
    enabled: !!token && !!assetId && settled >= 1_000_000,
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousData
  })
}

/** What the customer will send, when it arrives, and the fee their wallet pays. */
export function TopUpPreview({ q, stale, error, warning }: { q: TopUpQuote | undefined; stale: boolean; error: unknown; warning?: string | undefined }) {
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
        Arrives in about {Math.max(1, Math.ceil(q.timeEstimateSeconds / 60))} min · {chain} network fee: {FEES[q.chain] ?? "set by your wallet"}
      </p>
      {warning && <p className="text-sm font-medium text-warn">{warning}</p>}
    </div>
  )
}

/** A deposit address to copy, or to scan from a phone wallet or an exchange app. */
export function DepositAddress({ address, memo }: { address: string; memo?: string | undefined }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <Qr value={address} size={136} label="QR code of the deposit address" />
      <div className="flex min-w-0 flex-col gap-2">
        <p className="font-mono text-sm break-all text-ink select-all">{address}</p>
        {memo && <p className="text-sm">Memo (required): <span className="font-mono select-all">{memo}</span></p>}
        <Button variant="light" size="sm" className="self-start" onClick={() => navigator.clipboard.writeText(address).then(() => toast.success("Address copied"))}>
          <Copy />Copy address
        </Button>
      </div>
    </div>
  )
}

/**
 * A NEAR wallet can't show us its other chains, but its NEAR Intents account we can see: anything there (1Click's
 * change or a refund) is the cheapest place to start, so it's offered first.
 */
function HeldFirst() {
  const { token } = useSession()
  const actions = useWalletActions()
  const held = (useHeld(token).data ?? []).filter((h) => h.sendable)
  const [busy, setBusy] = useState(false)
  if (held.length === 0) return null
  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-gold-soft p-4 text-sm text-gold-ink">
      <p>
        You already have {held.map((h) => `${h.amount} ${h.symbol} on ${chainLabel(h.chain)}`).join(", ")} in your NEAR Intents account. Bring it to your
        NEAR wallet as USDC, then deposit it with the other tab.
      </p>
      <Button size="sm" variant="light" className="self-start" loading={busy} disabled={busy} onClick={() => {
        setBusy(true)
        // One at a time: each asks the wallet to approve.
        void held.reduce((p, h) => p.then(() => actions.sendBack(h)), Promise.resolve<unknown>(undefined)).finally(() => setBusy(false))
      }}>
        Send it to my NEAR wallet
      </Button>
    </div>
  )
}

/** What a card still needs (at least the $1 top-up minimum), or $20. */
const needed = (need: number | undefined) => (need ? Math.ceil(Math.max(need, 1_000_000) / 10_000) * 10_000 : undefined)
export const topUpAmount = (need?: number) => dollars(needed(need) ?? 20_000_000)
// One row of chips: "Exactly …" takes $50's place when a card needs a set amount.
export const topUpPicks = (need?: number) => [
  ...(needed(need) ? [{ label: `Exactly ${usdUp(needed(need)!)}`, micro: needed(need)! }] : []),
  { label: "$10", micro: 10_000_000 },
  { label: "$25", micro: 25_000_000 },
  ...(needed(need) ? [] : [{ label: "$50", micro: 50_000_000 }])
]

/**
 * Top up from any chain with NEAR Intents 1Click: USDC lands in the wallet, then one deposit.
 * `onDone` runs once it's in the balance, like a wallet deposit (a mode chosen before it is saved then).
 */
export function TopUp({ onDone, need }: { onDone?: (ok: boolean) => void; need?: number | undefined } = {}) {
  const { accountId, token, refresh, send, gasFree } = useSession()
  const qc = useQueryClient()
  const [registered, setRegistered] = useState<boolean>()
  const [assets, setAssets] = useState<ReadonlyArray<TopUpAsset>>()
  const [asset, setAsset] = useState("")
  const [amount, setAmount] = useState(() => topUpAmount(need))
  const preview = useTopUpPreview(token, asset, toMicro(amount))
  const [quote, setQuote] = useState<TopUpQuote>()
  const [status, setStatus] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const fail = (e: unknown) => setError(errorMessage(e))

  useEffect(() => {
    if (!accountId || !token) return
    view<unknown>(usdcId, "storage_balance_of", { account_id: accountId }).then((b) => setRegistered(b !== null), fail)
    api((c) => c.topup.assets(), token).then((a) => {
      const sorted = sortAssets(a)
      setAssets(sorted)
      setAsset(sorted[0]?.assetId ?? "")
    }, fail)
  }, [accountId, token])

  // Poll 1Click until the swap settles.
  useEffect(() => {
    if (!quote || !token || (status && DONE.has(status))) return
    const t = setInterval(() => {
      api((c) => c.topup.status({ query: { depositAddress: quote.depositAddress } }), token).then((s) => setStatus(s.status), () => {})
    }, 5000)
    return () => clearInterval(t)
  }, [quote, token, status])

  const step = async (f: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    await f().catch(fail)
    setBusy(false)
  }

  if (!token) return null
  if (registered === false) {
    return (
      <Button variant="light" className="self-start" disabled={busy} onClick={() => step(async () => {
        await send({ receiverId: usdcId, method: "storage_deposit", args: { account_id: accountId, registration_only: true }, deposit: STORAGE_DEPOSIT })
        setRegistered(true)
      })}>
        Enable USDC on your account (once{gasFree ? ", fee on us" : ", 0.00125 NEAR"})
      </Button>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {!quote && (
        <div className="flex flex-col gap-4">
          <HeldFirst />
          <AmountField label="USDC to receive" value={amount} onChange={setAmount} picks={topUpPicks(need)} />
          <div className="flex flex-col gap-2">
            <span className="text-sm font-semibold text-muted">Pay with</span>
            {assets ? <TokenPicker assets={assets} value={asset} onChange={setAsset} /> : <span className="skeleton h-14 rounded-[1.25rem]" />}
          </div>
          {toMicro(amount) >= 1_000_000 && asset && <TopUpPreview q={preview.data} stale={preview.isPlaceholderData || preview.isFetching} error={preview.error} />}
          <Button size="lg" disabled={busy || !asset || !(toMicro(amount) >= 1_000_000)} onClick={() => step(async () => {
            setQuote(await api((c) => c.topup.quote({ payload: { originAsset: asset, usdc: toMicro(amount) } }), token))
            setStatus("PENDING_DEPOSIT")
            // Recorded on the server now: it shows under "Money on its way" even if this page closes.
            void qc.invalidateQueries({ queryKey: ["transfers"] })
          })}>
            Get deposit address
          </Button>
        </div>
      )}

      {quote && (
        <div className="flex flex-col gap-2 rounded-[1.5rem] bg-soft p-5 text-sm">
          <p>
            Send exactly <b>{quote.amountInFormatted} {quote.symbol}</b> on <b>{chainLabel(quote.chain)}</b> to:
          </p>
          <DepositAddress address={quote.depositAddress} memo={quote.depositMemo} />
          <p className="text-muted">
            {usd(quote.usdcOut)} arrives in your NEAR wallet about {Math.ceil(quote.timeEstimateSeconds / 60)} min after your transfer
            confirms. Send before {new Date(quote.deadline).toLocaleTimeString()}. If anything goes wrong, 1Click refunds it to your
            NEAR Intents account, and the Wallet page sends it on to your wallet.
          </p>
          <p>Status: <b>{status?.replaceAll("_", " ").toLowerCase()}</b></p>
          {status === "SUCCESS" && (
            <Button className="self-start" disabled={busy} onClick={() => step(async () => {
              // The swap can deliver less than quoted: deposit what actually arrived, never more than the quote.
              const arrived = Number(await view<string>(usdcId, "ft_balance_of", { account_id: accountId }))
              const micro = Math.min(arrived, quote.usdcOut)
              if (!(micro > 0)) throw new Error("No USDC has arrived in your NEAR wallet yet. Try again in a minute.")
              await send(depositCall(micro)).finally(() => refresh().catch(() => {}))
              setQuote(undefined)
              setStatus(undefined)
              toast.success(`${usd(micro)} added to your balance`)
              onDone?.(true)
            })}>
              Deposit {usd(quote.usdcOut)} into Luckout
            </Button>
          )}
          {(status === "REFUNDED" || status === "FAILED") && (
            <Button variant="light" className="self-start" onClick={() => (setQuote(undefined), setStatus(undefined))}>Start over</Button>
          )}
        </div>
      )}
      {error && <p role="alert" className="text-sm font-medium text-bad">{error}</p>}
    </div>
  )
}
