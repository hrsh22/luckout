"use client"

import type { Mode } from "@luckout/api"
import { toast } from "sonner"
import { errorMessage } from "./api"
import { usd } from "./format"
import { modeName } from "./modes"
import { type Call, contractId, send, usdcId } from "./near"
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
 * re-reads the balance, and resolves false (never throws) if the wallet refused or it failed.
 */
export function useWalletActions() {
  const { accountId, refresh } = useSession()

  const run = async (pending: string, done: string, ...calls: Array<Call>) => {
    if (!accountId) return false
    const id = toast.loading(pending, { description: "Approve it in your wallet." })
    try {
      await send(accountId, ...calls)
      await refresh().catch(() => {})
      toast.success(done, { id, description: undefined })
      return true
    } catch (e) {
      toast.error(errorMessage(e), { id, description: undefined })
      return false
    }
  }

  return {
    /** Testnet only: 100 test USDC from the faucet, deposited in the same approval. */
    faucet: () => run("Getting 100 test USDC", "100 test USDC added to your balance", faucetCall, depositCall(100_000_000)),
    deposit: (micro: number) => run(`Depositing ${usd(micro)}`, `${usd(micro)} added to your balance`, depositCall(micro)),
    withdraw: (micro: number) =>
      run(`Withdrawing ${usd(micro)}`, `${usd(micro)} sent to your wallet`, {
        receiverId: contractId,
        method: "withdraw",
        args: { amount: String(micro) },
        deposit: ONE_YOCTO,
        tgas: 60
      }),
    setDefaultMode: (mode: Mode) =>
      run(`Making ${modeName(mode)} your default`, `${modeName(mode)} is your default now`, {
        receiverId: contractId,
        method: "set_default_mode",
        args: { mode },
        deposit: ONE_YOCTO
      }),
    setLimits: (perPurchase: number, daily: number) =>
      run("Saving your limits", `Limits saved: ${usd(perPurchase)} a purchase, ${usd(daily)} a day`, {
        receiverId: contractId,
        method: "set_limits",
        args: { per_purchase: String(perPurchase), daily: String(daily) },
        deposit: ONE_YOCTO
      })
  }
}
