"use client"

import { Button } from "@/components/ui/button"
import { useWalletActions } from "@/lib/actions"
import { api, cancelled, errorMessage } from "@/lib/api"
import { CHAIN_NAMES, EVM_CHAIN_IDS, sendFromWallet } from "@/lib/evm"
import { toMicro, usd } from "@/lib/format"
import { contractId, usdcId } from "@/lib/near"
import { useSession } from "@/lib/session"
import { moveInIntent, type TopUpAsset, type TopUpQuote, TopUpStatus } from "@luckout/api"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

const DONE = new Set(["SUCCESS", "REFUNDED", "FAILED"])

/**
 * An EVM wallet's Top-Up (ADR-0011): 1Click swaps the token into exact USDC in the customer's own NEAR
 * Intents account, and the intent they sign before sending moves it into Luckout once it lands. The
 * transfer on their own chain is the only fee they pay.
 */
export function TopUpEvm({ onDone }: { onDone?: (ok: boolean) => void } = {}) {
  const { accountId, token, refresh, signIntent } = useSession()
  const actions = useWalletActions()
  const qc = useQueryClient()
  const [assets, setAssets] = useState<ReadonlyArray<TopUpAsset>>()
  const [assetId, setAssetId] = useState("")
  const [amount, setAmount] = useState("20")
  const [quote, setQuote] = useState<TopUpQuote>()
  const [signed, setSigned] = useState(false)
  const [status, setStatus] = useState<TopUpStatus>()
  const [busy, setBusy] = useState<"quote" | "send" | "sign">()
  const [error, setError] = useState<string>()
  const asset = assets?.find((a) => a.assetId === assetId)

  useEffect(() => {
    if (!token) return
    api((c) => c.topup.assets(), token).then((all) => {
      const mine = all.filter((a) => EVM_CHAIN_IDS[a.chain])
      setAssets(mine)
      setAssetId(mine.find((a) => a.symbol === "USDC" && a.chain === "base")?.assetId ?? mine[0]?.assetId ?? "")
    }, (e) => setError(errorMessage(e)))
  }, [token])

  // The caller's onDone changes every render: read it through a ref, so the poll isn't restarted, and run it once.
  const finished = useRef(onDone)
  finished.current = onDone
  const reported = useRef(false)

  // Poll until the swap settles and its USDC has moved into Luckout (or couldn't).
  const waiting = !!quote && signed && !(status && DONE.has(status.status) && status.move !== "waiting")
  useEffect(() => {
    if (!quote || !token || !waiting) return
    const t = setInterval(() => {
      api((c) => c.topup.status({ query: { depositAddress: quote.depositAddress } }), token).then((s) => {
        setStatus(s)
        if (s.move === "moved" && !reported.current) {
          reported.current = true
          refresh().catch(() => {})
          toast.success(`${usd(quote.usdcOut)} added to your balance`)
          // Like a wallet deposit: a mode chosen before the first one is saved now, and Welcome moves on.
          finished.current?.(true)
        }
      }, () => {})
    }, 5000)
    return () => clearInterval(t)
  }, [quote, token, waiting, refresh])

  const step = async (kind: "quote" | "send" | "sign", f: () => Promise<unknown>) => {
    setBusy(kind)
    setError(undefined)
    try {
      await f()
    } catch (e) {
      setError(cancelled(e) ? "Cancelled in your wallet. Nothing was sent." : errorMessage(e))
    }
    setBusy(undefined)
  }

  /** Signed before anything is sent, so the USDC moves in even if this tab is closed. */
  const signMoveIn = async (q: TopUpQuote) => {
    if (!accountId || signed) return
    const move = await signIntent(moveInIntent({ usdcId, contractId, account: accountId, amount: String(q.usdcOut) }), 24 * 60)
    await api((c) => c.topup.move({ payload: { depositAddress: q.depositAddress, signed: move } }), token)
    setSigned(true)
    setStatus(new TopUpStatus({ status: "PENDING_DEPOSIT", move: "waiting" }))
  }

  if (!token || !accountId) return null

  if (!quote) {
    return (
      <div className="flex flex-col gap-3">
        <input className="field !w-28" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="USDC to receive" />
        <span className="text-sm text-muted">USDC, paid with</span>
        <select className="field !w-auto" value={assetId} onChange={(e) => setAssetId(e.target.value)} aria-label="Pay with">
          {assets?.map((a) => <option key={a.assetId} value={a.assetId}>{a.symbol} on {CHAIN_NAMES[a.chain] ?? a.chain}</option>)}
        </select>
        <Button
          loading={busy === "quote"}
          disabled={!!busy || !assetId || !(toMicro(amount) >= 1_000_000)}
          onClick={() =>
            step("quote", async () => {
              setQuote(await api((c) => c.topup.quote({ payload: { originAsset: assetId, usdc: toMicro(amount) } }), token))
              // Recorded on the server now: it shows under "Money on its way" even if this sheet closes.
              void qc.invalidateQueries({ queryKey: ["transfers"] })
            })}
        >
          Get a quote
        </Button>
        {error && <p role="alert" className="text-sm font-medium text-bad">{error}</p>}
      </div>
    )
  }

  const moved = status?.move === "moved"
  return (
    <div className="flex flex-col gap-3 rounded-[1.5rem] bg-soft p-5 text-sm">
      {moved
        ? <p className="font-semibold">Done: {usd(quote.usdcOut)} is in your balance.</p>
        : (
          <>
            <p>
              Send <b>{quote.amountInFormatted} {quote.symbol}</b> on <b>{CHAIN_NAMES[quote.chain] ?? quote.chain}</b> and get <b>{usd(quote.usdcOut)}</b> in
              Luckout, about {Math.ceil(quote.timeEstimateSeconds / 60)} min after it confirms. Your wallet pays that chain's fee; Luckout pays the rest.
            </p>
            {!signed && (
              <Button
                className="self-start"
                loading={busy === "send"}
                disabled={!!busy}
                onClick={() =>
                  step("send", async () => {
                    await signMoveIn(quote)
                    const txHash = await sendFromWallet(accountId, { chain: quote.chain, contract: asset?.contract, to: quote.depositAddress, amount: quote.amountIn })
                    // Kept with the Top-Up and passed to 1Click: it stays in sight even if 1Click is slow to see it.
                    void api((c) => c.topup.sent({ payload: { depositAddress: quote.depositAddress, txHash } }), token).catch(() => {})
                  })}
              >
                Send from your wallet
              </Button>
            )}
            <details className="text-muted" open={signed}>
              <summary className="cursor-pointer">Or send it yourself, from an exchange or another wallet</summary>
              <div className="mt-2 flex flex-col gap-2">
                <p>Send exactly {quote.amountInFormatted} {quote.symbol} on {CHAIN_NAMES[quote.chain] ?? quote.chain} before {new Date(quote.deadline).toLocaleTimeString()} to:</p>
                <p className="font-mono break-all text-ink select-all">{quote.depositAddress}</p>
                {!signed && (
                  <Button variant="light" size="sm" className="self-start" loading={busy === "sign"} disabled={!!busy} onClick={() => step("sign", () => signMoveIn(quote))}>
                    Sign to move it in when it lands
                  </Button>
                )}
              </div>
            </details>
            {signed && (
              <p>
                Status: <b>{status?.status.replaceAll("_", " ").toLowerCase() ?? "waiting for your transfer"}</b>
                {status?.status === "SUCCESS" && status.move === "waiting" && ", moving it into Luckout"}
              </p>
            )}
            {status?.move === "failed" && (
              <div className="flex flex-col gap-2">
                <p>It didn't move into Luckout. Whatever arrived is in your NEAR Intents account.</p>
                <Button variant="light" size="sm" className="self-start" onClick={() => void actions.deposit(quote.usdcOut)}>Move it in now</Button>
              </div>
            )}
          </>
        )}
      {(moved || status?.move === "failed" || ["REFUNDED", "FAILED"].includes(status?.status ?? "")) && (
        <Button variant="light" size="sm" className="self-start" onClick={() => (setQuote(undefined), setSigned(false), setStatus(undefined), (reported.current = false))}>
          Top up again
        </Button>
      )}
      {error && <p role="alert" className="font-medium text-bad">{error}</p>}
    </div>
  )
}
