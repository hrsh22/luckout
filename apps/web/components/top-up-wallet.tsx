"use client"

import { AmountField } from "@/components/amount-field"
import { chainLabel, sortAssets, TokenPicker } from "@/components/token-picker"
import { DepositAddress, OnItsWay, stepOf, TopUpSteps, topUpAmount, topUpPicks, TopUpPreview, useTopUpPreview } from "@/components/top-up"
import { Button } from "@/components/ui/button"
import { useWalletActions } from "@/lib/actions"
import { GAS_COIN, maxTopUp, useWalletHoldings } from "@/lib/balances"
import { api, cancelled, errorMessage } from "@/lib/api"
import { sendFromWallet, TransferReverted, walletChain } from "@/lib/evm"
import { tokenAmount, toMicro, usd } from "@/lib/format"
import { contractId, usdcId } from "@/lib/near"
import { pendingMode } from "@/lib/onboarding"
import { useSession } from "@/lib/session"
import { sendFromSolana } from "@/lib/solana"
import { pricedAsShown, transferFor } from "@/lib/top-up-quote"
import { moveInIntent, type TopUpAsset, type TopUpQuote, TopUpStatus } from "@luckout/api"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

const DONE = new Set(["SUCCESS", "REFUNDED", "FAILED"])

/**
 * An EVM or Solana wallet's Top-Up (ADR-0011): 1Click swaps the token into exact USDC in the customer's own NEAR
 * Intents account, and the intent they sign before sending moves it into Luckout once it lands. The
 * transfer on their own chain is the only fee they pay.
 */
export function TopUpWallet({ onDone, onContinue, need }: { onDone?: (ok: boolean) => void; onContinue?: (() => void) | undefined; need?: number | undefined } = {}) {
  const { accountId, token, refresh, signIntent, wallet } = useSession()
  const kind = wallet === "solana" ? "solana" : "evm"
  const actions = useWalletActions()
  const qc = useQueryClient()
  const [assets, setAssets] = useState<ReadonlyArray<TopUpAsset>>()
  const [assetId, setAssetId] = useState("")
  const [amount, setAmount] = useState(() => topUpAmount(need))
  /** A quote and the token it was asked for, kept together: Send transfers this pair, never what the picker shows now. */
  const [quoted, setQuoted] = useState<{ quote: TopUpQuote; asset: TopUpAsset }>()
  const quote = quoted?.quote
  const [signed, setSigned] = useState(false)
  /** The wallet has sent this Top-Up's transfer: it may land, so Send is never offered again for it. */
  const [sent, setSent] = useState(false)
  const [status, setStatus] = useState<TopUpStatus>()
  const [busy, setBusy] = useState<"quote" | "send" | "sign">()
  const [error, setError] = useState<string>()
  /** Sending from an exchange or another wallet: the address (and its QR) is the point, so it's shown open. */
  const [manual, setManual] = useState(false)
  const asset = assets?.find((a) => a.assetId === assetId)

  useEffect(() => {
    if (!token) return
    api((c) => c.topup.assets(), token).then((all) => {
      const mine = sortAssets(all.filter((a) => walletChain(kind, a.chain)))
      setAssets(mine)
      setAssetId(mine[0]?.assetId ?? "")
    }, (e) => setError(errorMessage(e)))
  }, [token, kind])

  // What the wallet holds on each chain: it orders the tokens and says what's short.
  const { holdings, gas } = useWalletHoldings(accountId ?? undefined, kind, assets)
  const micro = toMicro(amount)
  const covers = (id: string) => (holdings?.get(id)?.usd ?? 0) >= (micro / 1e6) * 1.02
  const ordered = useMemo(() => {
    if (!assets || !holdings) return assets
    const rank = (a: TopUpAsset) => (covers(a.assetId) ? 2 : holdings.has(a.assetId) ? 1 : 0)
    return [...assets].sort((a, b) => rank(b) - rank(a))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, holdings, micro])
  // The best token for this amount, until the customer picks one themselves, or a price has been asked for:
  // the picker never moves under a quote.
  const picked = useRef(false)
  useEffect(() => {
    if (!picked.current && !busy && !quoted && holdings && ordered?.[0]) setAssetId(ordered[0].assetId)
  }, [ordered, holdings, busy, quoted])
  const preview = useTopUpPreview(token ?? undefined, assetId, micro)
  const held = holdings?.get(assetId)
  // The price of the token chosen now. While the next one loads, the last token's price is still drawn (dimmed),
  // but nothing is decided or sent on it.
  const p = preview.isPlaceholderData ? undefined : preview.data
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

  // Poll until the swap settles and its USDC has moved into Luckout (or couldn't). An exchange transfer is followed
  // too, approved or not: unapproved, it lands in their NEAR Intents account and they're offered the one tap.
  const waiting = !!quote && (signed || manual) && !(status && DONE.has(status.status) && status.move !== "waiting")
  useEffect(() => {
    if (!quote || !token || !waiting) return
    const t = setInterval(() => {
      api((c) => c.topup.status({ query: { depositAddress: quote.depositAddress } }), token).then((s) => {
        setStatus(s)
        if (s.move === "moved" && !reported.current) {
          reported.current = true
          refresh().catch(() => {})
          // Keyed by the Top-Up: the header says the same when it sees it land, and only one toast shows.
          toast.success(`${usd(quote.usdcOut)} added to your balance`, { id: quote.depositAddress })
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
    // A first Top-Up starts the account in Welcome's pick, so the mode needs no signature of its own.
    const mode = pendingMode(accountId)
    const move = await signIntent(moveInIntent({ usdcId, contractId, account: accountId, amount: String(q.usdcOut), mode }), 24 * 60)
    await api((c) => c.topup.move({ payload: { depositAddress: q.depositAddress, signed: move } }), token)
    setSigned(true)
    setStatus(new TopUpStatus({ status: "PENDING_DEPOSIT", move: "waiting" }))
  }

  if (!token || !accountId) return null

  /** A real quote: recorded on the server, so it shows under "Money on its way" even if this sheet closes. */
  const realQuote = async () => {
    if (!asset) throw new Error("Choose a token to pay with.")
    const next = { quote: await api((c) => c.topup.quote({ payload: { originAsset: asset.assetId, usdc: micro } }), token), asset }
    setQuoted(next)
    void qc.invalidateQueries({ queryKey: ["transfers"] })
    return next
  }
  const sendNow = ({ quote: q, asset: a }: NonNullable<typeof quoted>) =>
    step("send", async () => {
      // Checked before anything is signed: a quote and a token that don't belong together are never sent.
      const transfer = transferFor(a, q)
      // Checked here too, not only by hiding the button: with the approval declined nothing polls, so the page may not
      // have re-rendered since the deadline passed, and a transfer to an expired deposit address isn't swapped as quoted.
      if (Date.now() > Date.parse(q.deadline)) throw new Error("This price has expired. Nothing was sent: top up again for a new one.")
      await signMoveIn(q)
      try {
        const txHash = await (kind === "solana" ? sendFromSolana : sendFromWallet)(accountId, transfer, () => setSent(true))
        // Kept with the Top-Up and passed to 1Click: it stays in sight even if 1Click is slow to see it.
        void api((c) => c.topup.sent({ payload: { depositAddress: q.depositAddress, txHash } }), token).catch(() => {})
      } catch (e) {
        // Mined and reverted: nothing left the wallet, so they may send again.
        if (e instanceof TransferReverted) setSent(false)
        throw e
      }
    })
  /**
   * Asks once for the approval that moves this Top-Up into Luckout when it lands. Declining isn't an error: the
   * money then waits in their NEAR Intents account for one tap.
   */
  const approve = (q = quote) =>
    step("sign", async () => {
      try {
        if (q) await signMoveIn(q)
      } catch (e) {
        if (!cancelled(e)) throw e
      }
    })
  /** Paid from an exchange or another wallet: approve first, then the address (and its QR). */
  const sendElsewhere = () =>
    step("quote", async () => {
      setManual(true)
      await approve((await realQuote()).quote)
    })

  if (!quoted || !quote) {
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
            q={preview.data}
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
                    const next = await realQuote()
                    // Priced as shown: send at once. If it moved, the next screen shows the new price to confirm.
                    if (pricedAsShown(p, next.quote)) await sendNow(next)
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
  // A quote past its deadline is never sent to: the way on is a new one.
  const expired = Date.now() > Date.parse(quote.deadline)
  return (
    <div className="flex flex-col gap-3 rounded-[1.5rem] bg-soft p-5 text-sm">
      {moved
        ? <p className="font-semibold">Done: {usd(quote.usdcOut)} is in your balance.</p>
        : (
          <>
            {manual
              ? (
                // Sent from an exchange or another wallet: the address is the point, not something to unfold.
                <div className="flex flex-col gap-3">
                  <p>
                    Send <b>{tokenAmount(quote.amountInFormatted, quote.symbol, "up")} {quote.symbol}</b> on <b>{chainLabel(quote.chain)}</b> before{" "}
                    {new Date(quote.deadline).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} to this address, and get <b>{usd(quote.usdcOut)}</b>{" "}
                    in Luckout. A little more is fine: 1Click sends the extra back.
                  </p>
                  <DepositAddress address={quote.depositAddress} memo={quote.depositMemo} />
                  {signed
                    ? <p className="font-medium text-good">Approved: it goes straight into your balance when it arrives.</p>
                    : !(status && DONE.has(status.status)) && (
                      <div className="flex flex-col gap-2 rounded-2xl bg-white p-3">
                        <p>
                          {busy === "sign"
                            ? "Approve in your wallet, and it goes straight into your balance when it arrives."
                            : "Not approved yet: when it arrives it waits in your NEAR Intents account (yours, safe) until you move it in with one tap. Approve now and it goes straight into your balance."}
                        </p>
                        <Button variant="light" size="sm" className="self-start" loading={busy === "sign"} disabled={!!busy} onClick={() => approve()}>
                          Approve now
                        </Button>
                      </div>
                    )}
                </div>
              )
              : (
                <>
                  <p>
                    Send <b>{tokenAmount(quote.amountInFormatted, quote.symbol, "up")} {quote.symbol}</b> on <b>{chainLabel(quote.chain)}</b> and get <b>{usd(quote.usdcOut)}</b> in
                    Luckout, about {Math.ceil(quote.timeEstimateSeconds / 60)} min after it confirms. Your wallet pays that chain's fee; Luckout pays the rest.
                  </p>
                  {!sent && !expired && (
                    <>
                      <Button className="self-start" loading={busy === "send"} disabled={!!busy} onClick={() => sendNow(quoted)}>
                        Send from your wallet
                      </Button>
                      <button type="button" disabled={!!busy} className="self-start text-sm font-semibold text-muted underline-offset-4 hover:text-ink hover:underline" onClick={() => (setManual(true), approve())}>
                        Send it from an exchange or another wallet instead
                      </button>
                    </>
                  )}
                </>
              )}
            {(signed || manual) && (
              ["REFUNDED", "FAILED"].includes(status?.status ?? "")
                ? <p className="font-medium text-warn">It didn't go through, and 1Click sent it back. Wallet shows where it is.</p>
                // Not shown while it waits on the customer's one tap (below): nothing there is moving by itself.
                : !(status?.move === "failed" || (status?.status === "SUCCESS" && !status.move)) && (
                  <>
                    <TopUpSteps at={stepOf(status?.status, true)} landing="In your Luckout balance" minutes={Math.ceil(quote.timeEstimateSeconds / 60)} />
                    {(sent || manual) && <OnItsWay sent={sent} lands={signed ? "moves into your balance by itself" : "waits in your NEAR Intents account for one tap in Wallet"} onContinue={onContinue} />}
                  </>
                )
            )}
            {(status?.move === "failed" || (status?.status === "SUCCESS" && !status.move)) && (
              <div className="flex flex-col gap-2">
                <p>It landed in your NEAR Intents account. Move it into Luckout with one tap.</p>
                <Button variant="light" size="sm" className="self-start" onClick={() => void actions.deposit(quote.usdcOut)}>Move it in now</Button>
              </div>
            )}
          </>
        )}
      {(moved || status?.move === "failed" || ["REFUNDED", "FAILED"].includes(status?.status ?? "") || (!manual && !sent && expired)) && (
        <Button variant="light" size="sm" className="self-start" onClick={() => (setQuoted(undefined), setSigned(false), setSent(false), setManual(false), setStatus(undefined), (reported.current = false))}>
          Top up again
        </Button>
      )}
      {error && <p role="alert" className="font-medium text-bad">{error}</p>}
    </div>
  )
}
