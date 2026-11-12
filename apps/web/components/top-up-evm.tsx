"use client"

import { AmountField } from "@/components/amount-field"
import { chainLabel, sortAssets, TokenPicker } from "@/components/token-picker"
import { DepositAddress, topUpAmount, topUpPicks, TopUpPreview, useTopUpPreview } from "@/components/top-up"
import { Button } from "@/components/ui/button"
import { useWalletActions } from "@/lib/actions"
import { GAS_COIN, maxTopUp, useWalletHoldings } from "@/lib/balances"
import { api, cancelled, errorMessage } from "@/lib/api"
import { CHAIN_NAMES, EVM_CHAIN_IDS, sendFromWallet } from "@/lib/evm"
import { tokenAmount, toMicro, usd } from "@/lib/format"
import { contractId, usdcId } from "@/lib/near"
import { useSession } from "@/lib/session"
import { moveInIntent, type TopUpAsset, type TopUpQuote, TopUpStatus } from "@luckout/api"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

const DONE = new Set(["SUCCESS", "REFUNDED", "FAILED"])

/**
 * An EVM wallet's Top-Up (ADR-0011): 1Click swaps the token into exact USDC in the customer's own NEAR
 * Intents account, and the intent they sign before sending moves it into Luckout once it lands. The
 * transfer on their own chain is the only fee they pay.
 */
export function TopUpEvm({ onDone, need }: { onDone?: (ok: boolean) => void; need?: number | undefined } = {}) {
  const { accountId, token, refresh, signIntent } = useSession()
  const actions = useWalletActions()
  const qc = useQueryClient()
  const [assets, setAssets] = useState<ReadonlyArray<TopUpAsset>>()
  const [assetId, setAssetId] = useState("")
  const [amount, setAmount] = useState(() => topUpAmount(need))
  const [quote, setQuote] = useState<TopUpQuote>()
  const [signed, setSigned] = useState(false)
  const [status, setStatus] = useState<TopUpStatus>()
  const [busy, setBusy] = useState<"quote" | "send" | "sign">()
  const [error, setError] = useState<string>()
  /** Sending from an exchange or another wallet: the address (and its QR) is the point, so it's shown open. */
  const [manual, setManual] = useState(false)
  const asset = assets?.find((a) => a.assetId === assetId)

  useEffect(() => {
    if (!token) return
    api((c) => c.topup.assets(), token).then((all) => {
      const mine = sortAssets(all.filter((a) => EVM_CHAIN_IDS[a.chain]))
      setAssets(mine)
      setAssetId(mine[0]?.assetId ?? "")
    }, (e) => setError(errorMessage(e)))
  }, [token])

  // What the wallet holds on each chain (Reown's balance lookup): it orders the tokens and says what's short.
  const { holdings, gas } = useWalletHoldings(accountId ?? undefined, assets)
  const micro = toMicro(amount)
  const covers = (id: string) => (holdings?.get(id)?.usd ?? 0) >= (micro / 1e6) * 1.02
  const ordered = useMemo(() => {
    if (!assets || !holdings) return assets
    const rank = (a: TopUpAsset) => (covers(a.assetId) ? 2 : holdings.has(a.assetId) ? 1 : 0)
    return [...assets].sort((a, b) => rank(b) - rank(a))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, holdings, micro])
  // The best token for this amount, until the customer picks one themselves.
  const picked = useRef(false)
  useEffect(() => {
    if (!picked.current && holdings && ordered?.[0]) setAssetId(ordered[0].assetId)
  }, [ordered, holdings])
  const preview = useTopUpPreview(token ?? undefined, assetId, micro)
  const held = holdings?.get(assetId)
  const p = preview.data
  const short = !!holdings && !!p && Number(p.amountInFormatted) > (held?.amount ?? 0)
  const noGas = !!asset?.contract && !!gas && !gas.has(asset.chain)
  const nothingCovers = !!holdings && !!assets && micro >= 1_000_000 && !assets.some((a) => covers(a.assetId))
  const where = asset ? chainLabel(asset.chain) : ""
  /** Why this wallet can't pay this from here, in one line; undefined when it can. */
  const blocked = nothingCovers
    ? `This wallet doesn't hold ${usd(micro)} on any chain we take.`
    : short
    ? `This wallet has ${held ? `only ${held.amount.toLocaleString("en-US", { maximumSignificantDigits: 5 })}` : "no"} ${asset?.symbol} on ${where}.`
    : noGas
    ? `This wallet needs a little ${GAS_COIN[asset!.chain] ?? "gas"} on ${where} for the network fee.`
    : undefined
  const max = asset && held ? maxTopUp(asset, held) : 0

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

  /** A real quote: recorded on the server, so it shows under "Money on its way" even if this sheet closes. */
  const realQuote = async () => {
    const q = await api((c) => c.topup.quote({ payload: { originAsset: assetId, usdc: micro } }), token)
    void qc.invalidateQueries({ queryKey: ["transfers"] })
    return q
  }
  const sendNow = (q: TopUpQuote) =>
    step("send", async () => {
      await signMoveIn(q)
      const txHash = await sendFromWallet(accountId, { chain: q.chain, contract: asset?.contract, to: q.depositAddress, amount: q.amountIn })
      // Kept with the Top-Up and passed to 1Click: it stays in sight even if 1Click is slow to see it.
      void api((c) => c.topup.sent({ payload: { depositAddress: q.depositAddress, txHash } }), token).catch(() => {})
    })
  /** Paid from an exchange or another wallet: the address (and its QR) is the next screen. */
  const sendElsewhere = () => step("quote", async () => (setManual(true), setQuote(await realQuote())))

  if (!quote) {
    return (
      <div className="flex flex-col gap-4">
        <AmountField
          label="USDC to receive"
          value={amount}
          onChange={setAmount}
          picks={[...topUpPicks(need), ...(max >= 1 ? [{ label: `Max ${usd(max * 1e6)}`, micro: Math.round(max * 1e6) }] : [])]}
        />
        <div className="flex flex-col gap-2">
          <span className="text-sm font-semibold text-muted">Pay with</span>
          {ordered
            ? <TokenPicker assets={ordered} value={assetId} onChange={(id) => ((picked.current = true), setAssetId(id))} holdings={holdings} short={holdings && ((id) => !covers(id))} />
            : <span className="skeleton h-14 rounded-[1.25rem]" />}
        </div>
        {micro >= 1_000_000 && assetId && (
          <TopUpPreview
            q={p}
            stale={preview.isPlaceholderData || preview.isFetching}
            error={preview.error}
            warning={blocked}
          />
        )}
        {/* When this wallet can't pay, the way that can is the main button, not a disabled Send. */}
        {blocked
          ? (
            <Button size="lg" loading={busy === "quote"} disabled={!!busy || !assetId || !(micro >= 1_000_000)} onClick={sendElsewhere}>
              Send it from an exchange or another wallet
            </Button>
          )
          : (
            <>
              <Button
                size="lg"
                loading={busy === "send" || busy === "quote"}
                disabled={!!busy || !p}
                onClick={() =>
                  step("quote", async () => {
                    const q = await realQuote()
                    setQuote(q)
                    // Priced as shown: send at once. If it moved, the next screen shows the new price to confirm.
                    if (Number(q.amountInFormatted) <= Number(p!.amountInFormatted) * 1.005) await sendNow(q)
                  })}
              >
                {p ? `Send ${tokenAmount(p.amountInFormatted, p.symbol, "up")} ${p.symbol} on ${chainLabel(p.chain)}` : "Getting the price"}
              </Button>
              <button
                type="button"
                disabled={!!busy || !assetId || !(micro >= 1_000_000)}
                className="self-center text-sm font-semibold text-muted underline-offset-4 hover:text-ink hover:underline disabled:opacity-45"
                onClick={sendElsewhere}
              >
                Send it from an exchange or another wallet instead
              </button>
            </>
          )}
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
              Send <b>{tokenAmount(quote.amountInFormatted, quote.symbol, "up")} {quote.symbol}</b> on <b>{CHAIN_NAMES[quote.chain] ?? quote.chain}</b> and get <b>{usd(quote.usdcOut)}</b> in
              Luckout, about {Math.ceil(quote.timeEstimateSeconds / 60)} min after it confirms. Your wallet pays that chain's fee; Luckout pays the rest.
            </p>
            {!signed && !manual && (
              <Button className="self-start" loading={busy === "send"} disabled={!!busy} onClick={() => sendNow(quote)}>
                Send from your wallet
              </Button>
            )}
            <details className="text-muted" open={signed || manual}>
              <summary className="cursor-pointer">Or send it yourself, from an exchange or another wallet</summary>
              <div className="mt-2 flex flex-col gap-3">
                <p>Send exactly {quote.amountInFormatted} {quote.symbol} on {CHAIN_NAMES[quote.chain] ?? quote.chain} before {new Date(quote.deadline).toLocaleTimeString()} to:</p>
                <DepositAddress address={quote.depositAddress} memo={quote.depositMemo} />
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
