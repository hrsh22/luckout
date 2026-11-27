"use client"

import { PreparedTransaction } from "@luckout/api"
import { useSignTransaction, useWallets } from "@privy-io/react-auth/solana"
import { useCallback } from "react"
import { api, TimedOut } from "./api"
import { cluster } from "./chain"
import { useSession } from "./session"

const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const toBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))

/**
 * Signs a transaction our server prepared and sends it (ADR-0015). Every endpoint that answers a `PreparedTransaction`
 * (`/deposits/approval`, `/transactions/*`, `/topup/swap`) is finished with it:
 *
 *   const submit = useSubmitPrepared()
 *   const signature = await submit(await api((c) => c.deposits.withdrawal({ payload: { amount, to } }), token))
 *
 * The customer's Privy wallet signs with no prompt, then `/transactions/submit` has our fee payer co-sign exactly
 * those bytes (so the customer needs no SOL) and waits until it lands. Privy signs the wire bytes as they are, so
 * legacy and v0 transactions (a swap) both work. Resolves the transaction's signature; rejects with the reason if the
 * program refused it, and never sends anything twice.
 *
 * `signer` picks another connected wallet instead, such as the owner's Phantom for the Admin panel: an external wallet
 * shows its own prompt.
 */
export function useSubmitPrepared() {
  const { accountId, token } = useSession()
  const { wallets } = useWallets()
  const { signTransaction } = useSignTransaction()
  return useCallback(async (prepared: Pick<PreparedTransaction, "transaction" | "token">, signer = accountId) => {
    const wallet = wallets.find((w) => w.address === signer)
    if (!wallet) throw new Error(signer === accountId ? "Your Luckout wallet is still loading. Try again in a moment." : `Connect the wallet ${signer} first.`)
    const { signedTransaction } = await signTransaction({
      transaction: fromBase64(prepared.transaction),
      wallet,
      // Privy knows no local validator; the chain only names where it's headed.
      ...(cluster === "localnet" ? {} : { chain: `solana:${cluster}` as const }),
      options: { uiOptions: { showWalletUIs: false } }
    })
    const payload = new PreparedTransaction({ transaction: toBase64(signedTransaction), token: prepared.token })
    try {
      return (await api((c) => c.deposits.submit({ payload }), token, "90 seconds")).signature
    } catch (e) {
      if (e instanceof TimedOut) throw new Error(`${e.message} It may still go through, so check your balance before trying again.`)
      throw e
    }
  }, [wallets, accountId, signTransaction, token])
}
