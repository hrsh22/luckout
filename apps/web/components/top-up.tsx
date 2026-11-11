"use client"

import { Button } from "@/components/ui/button"
import { depositCall } from "@/lib/actions"
import { api, errorMessage } from "@/lib/api"
import { toMicro, usd } from "@/lib/format"
import { usdcId, view } from "@/lib/near"
import { useSession } from "@/lib/session"
import type { TopUpAsset, TopUpQuote } from "@luckout/api"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { toast } from "sonner"

const STORAGE_DEPOSIT = "1250000000000000000000" // 0.00125 NEAR, USDC's registration fee
const DONE = new Set(["SUCCESS", "REFUNDED", "FAILED"])

/**
 * Top up from any chain with NEAR Intents 1Click: USDC lands in the wallet, then one deposit.
 * `onDone` runs once it's in the balance, like a wallet deposit (a mode chosen before it is saved then).
 */
export function TopUp({ onDone }: { onDone?: (ok: boolean) => void } = {}) {
  const { accountId, token, refresh, send, gasFree } = useSession()
  const qc = useQueryClient()
  const [registered, setRegistered] = useState<boolean>()
  const [assets, setAssets] = useState<ReadonlyArray<TopUpAsset>>()
  const [asset, setAsset] = useState("")
  const [amount, setAmount] = useState("20")
  const [quote, setQuote] = useState<TopUpQuote>()
  const [status, setStatus] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const fail = (e: unknown) => setError(errorMessage(e))

  useEffect(() => {
    if (!accountId || !token) return
    view<unknown>(usdcId, "storage_balance_of", { account_id: accountId }).then((b) => setRegistered(b !== null), fail)
    api((c) => c.topup.assets(), token).then((a) => (setAssets(a), setAsset(a.find((x) => x.symbol === "USDC" && x.chain === "base")?.assetId ?? a[0]?.assetId ?? "")), fail)
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
        <div className="flex flex-col gap-3">
          <input className="field !w-28" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="USDC to receive" />
          <span className="text-sm text-muted">USDC, paid with</span>
          <select className="field !w-auto" value={asset} onChange={(e) => setAsset(e.target.value)} aria-label="Pay with">
            {assets?.map((a) => <option key={a.assetId} value={a.assetId}>{a.symbol} on {a.chain}</option>)}
          </select>
          <Button disabled={busy || !asset || !(toMicro(amount) >= 1_000_000)} onClick={() => step(async () => {
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
            Send exactly <b>{quote.amountInFormatted} {quote.symbol}</b> on <b>{quote.chain}</b> to:
          </p>
          <p className="font-mono break-all select-all">{quote.depositAddress}</p>
          {quote.depositMemo && <p>Memo (required): <span className="font-mono select-all">{quote.depositMemo}</span></p>}
          <p className="text-muted">
            {usd(quote.usdcOut)} arrives in your NEAR wallet about {Math.ceil(quote.timeEstimateSeconds / 60)} min after your transfer
            confirms. Send before {new Date(quote.deadline).toLocaleTimeString()}. If anything goes wrong, the funds are refunded to your
            NEAR account on NEAR Intents.
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
