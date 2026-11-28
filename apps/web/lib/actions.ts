"use client"

import type { HeldToken, Mode, PreparedTransaction } from "@luckout/api"
import { toast } from "sonner"
import { api, cancelled, errorMessage } from "./api"
import { limitsText, usd } from "./format"
import { modeName } from "./modes"
import { useSession } from "./session"
import { useSubmitPrepared } from "./transactions"
import { oneAtATime } from "./utils"

/**
 * Everything the customer signs. The server prepares each transaction, their Privy wallet signs it with no prompt, and
 * we pay the fee (lib/transactions.ts). Each one says what's happening in a toast, re-reads the account whatever
 * happened, and resolves false (never throws) if it failed.
 */
export function useWalletActions() {
  const { accountId, token, refresh } = useSession()
  const submit = useSubmitPrepared()

  /** `tapped` is false for a request the app makes by itself, which stays quiet if another is open. */
  const run = (pending: string, done: string, prepare: () => Promise<Pick<PreparedTransaction, "transaction" | "token">>, tapped = true) =>
    // One at a time: a second tap while this one is open answers false and signs nothing.
    oneAtATime(async () => {
      if (!accountId) return false
      const id = toast.loading(pending, { description: "Luckout pays the network fee." })
      try {
        await submit(await prepare())
        toast.success(done, { id, description: undefined })
        return true
      } catch (e) {
        if (cancelled(e)) toast("Cancelled. Nothing was sent.", { id, description: undefined })
        else toast.error(errorMessage(e), { id, description: undefined })
        return false
      } finally {
        // Even a failure or a timeout may have moved money: show what the program says now.
        await refresh().catch(() => {})
      }
    }, tapped)

  return {
    /**
     * The one-time approval (ADR-0015): opens the customer's account on `mode`, and lets USDC sent to their Deposit
     * Address move into their Balance by itself.
     */
    approve: (mode: Mode) =>
      run("Setting up deposits", "Deposits now arrive in your balance by themselves", () => api((c) => c.deposits.approval({ payload: { mode } }), token)),
    setDefaultMode: (mode: Mode, tapped = true) =>
      run(`Making ${modeName(mode)} your default`, `${modeName(mode)} is your default now`, () =>
        api((c) => c.deposits.defaultMode({ payload: { mode } }), token), tapped),
    /** Micro-USDC strings, so "No limit" (u64::MAX) reaches the program exactly. */
    setLimits: (perPurchase: string, daily: string) =>
      run("Saving your limits", `Limits saved: ${limitsText(perPurchase, daily)}`, () =>
        api((c) => c.deposits.limits({ payload: { perPurchase, daily } }), token)),
    /** From the Balance to any Solana address (its USDC account is opened if it has none). */
    withdraw: (micro: number, to: string) =>
      run(`Withdrawing ${usd(micro)}`, `${usd(micro)} sent`, () => api((c) => c.deposits.withdrawal({ payload: { amount: micro, to } }), token)),
    /**
     * USDT or ORE at the Deposit Address into the Balance: all of it, swapped by Jupiter and deposited in one
     * transaction, with a minimum out the chain enforces (ADR-0014, ADR-0015).
     */
    swap: (h: Pick<HeldToken, "assetId" | "symbol">) =>
      run(`Swapping your ${h.symbol}`, `${h.symbol} swapped into your balance`, () => api((c) => c.topup.swap({ payload: { assetId: h.assetId } }), token)),
    /**
     * A card neither delivered nor failed within 24 hours: the full amount comes back, all at once unless part of it had
     * already paid Bitrefill (ADR-0016), which follows from our Pay Wallet. The program checks the time.
     */
    reclaim: (purchaseId: string) =>
      run("Reclaiming your purchase", "Reclaimed: the amount you paid comes back to your balance", () =>
        api((c) => c.deposits.reclaim({ payload: { purchaseId } }), token))
  }
}
