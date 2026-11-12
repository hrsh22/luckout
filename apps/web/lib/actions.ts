"use client"

import { type HeldToken, type Mode, mtTransferArgs, type TopUpAsset, transferIntent } from "@luckout/api"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { api, cancelled, errorMessage } from "./api"
import { limitsText, tokenAmount, usd } from "./format"
import { CHAIN_NAMES } from "./evm"
import { modeName } from "./modes"
import { type Call, contractId, intentsId, usdcId } from "./near"
import { useSession } from "./session"

const ONE_YOCTO = "1"

export const depositCall = (micro: number): Call => ({
  receiverId: usdcId,
  method: "ft_transfer_call",
  args: { receiver_id: contractId, amount: String(micro), msg: "" },
  deposit: ONE_YOCTO,
  tgas: 100
})
export const faucetCall: Call = { receiverId: usdcId, method: "faucet", args: {} }

/**
 * Everything the customer signs with their wallet. Each one says what's happening in a toast,
 * re-reads the balance whatever happened, and resolves false (never throws) if the wallet refused or it failed.
 */
export function useWalletActions() {
  const { accountId, token, evm, refresh, send, signIntent } = useSession()
  const qc = useQueryClient()

  /** Each step may ask the wallet to approve or sign; the toast says what's happening throughout. */
  const steps = async (pending: string, done: string | (() => string), f: (say: (text: string) => void) => Promise<unknown>) => {
    if (!accountId) return false
    const id = toast.loading(pending, { description: evm ? "Sign it in your wallet. Luckout pays the network fee." : "Approve it in your wallet." })
    try {
      await f((text) => toast.loading(text, { id }))
      toast.success(typeof done === "string" ? done : done(), { id, description: undefined })
      return true
    } catch (e) {
      // Backing out of the wallet isn't a failure: say what happened, without the alarm.
      if (cancelled(e)) toast("Cancelled in your wallet. Nothing was sent.", { id, description: undefined })
      else toast.error(errorMessage(e), { id, description: undefined })
      return false
    } finally {
      // Even a failure or a timeout may have moved money: show what the chain says now.
      await refresh().catch(() => {})
    }
  }

  const run = (pending: string, done: string, ...calls: Array<Call>) => steps(pending, done, () => send(...calls))
  const withdrawCall = (micro: number): Call => ({
    receiverId: contractId,
    method: "withdraw",
    args: { amount: String(micro) },
    deposit: ONE_YOCTO,
    tgas: 60
  })

  return {
    /**
     * Testnet only: 100 test USDC from the faucet, deposited in the same approval. An EVM wallet has no
     * NEAR account to call the faucet from: the server puts it in its NEAR Intents account, and one
     * signature moves it in.
     */
    faucet: () =>
      evm
        ? steps("Getting 100 test USDC", "100 test USDC added to your balance", async (say) => {
          await api((c) => c.topup.faucet(), token)
          say("Moving it into Luckout")
          await send(depositCall(100_000_000))
        })
        : run("Getting 100 test USDC", "100 test USDC added to your balance", faucetCall, depositCall(100_000_000)),
    /** From the NEAR wallet, or for an EVM wallet from its NEAR Intents account. */
    deposit: (micro: number) => run(evm ? `Moving ${usd(micro)} into Luckout` : `Depositing ${usd(micro)}`, `${usd(micro)} added to your balance`, depositCall(micro)),
    withdraw: (micro: number) =>
      run(`Withdrawing ${usd(micro)}`, evm ? `${usd(micro)} is in your NEAR Intents account` : `${usd(micro)} sent to your wallet`, withdrawCall(micro)),
    /**
     * EVM wallets (ADR-0011): out of Luckout into their own NEAR Intents account, then, with `asset`, on to
     * their own address on that chain through 1Click. If the second step fails, the money waits in NEAR Intents.
     */
    withdrawTo: (micro: number, asset: TopUpAsset) => {
      let arriving = ""
      return steps(`Withdrawing ${usd(micro)}`, () => arriving, async (say) => {
        await send(withdrawCall(micro))
        say(`Sending it to ${asset.symbol} on ${CHAIN_NAMES[asset.chain] ?? asset.chain}`)
        try {
          const q = await api((c) => c.topup.exit({ payload: { destinationAsset: asset.assetId, usdc: micro } }), token)
          void qc.invalidateQueries({ queryKey: ["transfers"] })
          const signed = await signIntent(transferIntent({ receiverId: q.depositAddress, token: `nep141:${usdcId}`, amount: String(micro) }))
          await api((c) => c.relay.intent({ payload: { signed } }), token, "90 seconds")
          arriving = `${tokenAmount(q.amountOutFormatted, q.symbol, "down")} ${q.symbol} arrives on ${CHAIN_NAMES[q.chain] ?? q.chain} in about ${Math.max(1, Math.ceil(q.timeEstimateSeconds / 60))} min`
        } catch (e) {
          throw new Error(`${usd(micro)} is in your NEAR Intents account, but sending it on didn't work: ${errorMessage(e)} Move it back into Luckout, or send it from near.com.`)
        }
      })
    },
    /**
     * All of a token held in their NEAR Intents account (1Click's change or a refund), to their own wallet through
     * 1Click: an EVM wallet gets it as it is on its own chain, a NEAR wallet as USDC. One signature; Luckout pays the fee.
     */
    sendBack: (h: HeldToken) => {
      let arriving = ""
      return steps(`Sending ${h.amount} ${h.symbol} to your wallet`, () => arriving, async () => {
        const q = await api((c) => c.topup.sendBack({ payload: { assetId: h.assetId } }), token)
        const to = { receiverId: q.depositAddress, token: q.assetId, amount: q.amount }
        try {
          if (evm) {
            const signed = await signIntent(transferIntent(to))
            await api((c) => c.relay.intent({ payload: { signed } }), token, "90 seconds")
          } else {
            await send({ receiverId: intentsId, method: "mt_transfer", args: mtTransferArgs(to), deposit: ONE_YOCTO, tgas: 30 })
          }
        } finally {
          void qc.invalidateQueries({ queryKey: ["transfers"] })
          void qc.invalidateQueries({ queryKey: ["held"] })
        }
        const where = q.chain === "near" ? "your NEAR wallet" : `your wallet on ${CHAIN_NAMES[q.chain] ?? q.chain}`
        arriving = `${tokenAmount(q.amountOutFormatted, q.symbol, "down")} ${q.symbol} arrives in ${where} in about ${Math.max(1, Math.ceil(q.timeEstimateSeconds / 60))} min`
      })
    },
    setDefaultMode: (mode: Mode) =>
      run(`Making ${modeName(mode)} your default`, `${modeName(mode)} is your default now`, {
        receiverId: contractId,
        method: "set_default_mode",
        args: { mode },
        deposit: ONE_YOCTO
      }),
    /** Micro-USDC strings, so "No limit" (u128::MAX) reaches the contract exactly. */
    setLimits: (perPurchase: string, daily: string) =>
      run("Saving your limits", `Limits saved: ${limitsText(perPurchase, daily)}`, {
        receiverId: contractId,
        method: "set_limits",
        args: { per_purchase: perPurchase, daily },
        deposit: ONE_YOCTO
      }),
    /** A purchase neither delivered nor cancelled within 24 hours: the full amount comes back. */
    reclaim: (purchaseId: number) =>
      run("Reclaiming your purchase", "The full amount is back in your balance", {
        receiverId: contractId,
        method: "reclaim",
        args: { purchase_id: purchaseId },
        tgas: 30
      }),
    /** A delivered Lucky Buy whose Draw didn't run (e.g. out of gas): run it again. */
    retryDraw: (purchaseId: number) =>
      run("Running the Draw again", "The Draw ran: see the result below", {
        receiverId: contractId,
        method: "retry_draw",
        args: { purchase_id: purchaseId },
        tgas: 60
      })
  }
}
