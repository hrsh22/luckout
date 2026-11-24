// The session's decisions that need no wallet and no React, so node --test can check them: which contract calls an
// EVM or Solana wallet may sign, and what a saved session's late check against the wallet may do. lib/session.tsx uses them.

import { type AuthAction, authCallIntent, type Mode, moveInIntent, type Wallet } from "@luckout/api"
import { contractId, usdcId } from "./chain.ts"
import type { Call } from "./near.ts"

/** The contract calls an EVM or Solana wallet makes through NEAR Intents (ADR-0011), from the calls a NEAR wallet would sign. */
const AUTH_METHODS = new Set(["withdraw", "set_default_mode", "set_limits", "reclaim", "retry_draw"])
export const asIntent = (account: string, c: Call) => {
  if (c.receiverId === contractId && AUTH_METHODS.has(c.method)) return authCallIntent(contractId, { [c.method]: c.args } as AuthAction)
  const args = c.args as { receiver_id?: string; amount?: string; msg?: string }
  // A deposit (depositCall), with the Default Mode a first one may carry.
  const mode = args.msg?.startsWith("{") ? (JSON.parse(args.msg) as { mode?: Mode }).mode : undefined
  if (c.receiverId === usdcId && c.method === "ft_transfer_call" && args.receiver_id === contractId && (args.msg === "" || mode !== undefined)) {
    return moveInIntent({ usdcId, contractId, account, amount: String(args.amount), mode })
  }
  throw new Error("This wallet can't do that here.")
}

/** What is saved of a session: who, with which kind of wallet, and until when. The token never reaches the page (an HttpOnly cookie). */
export interface Saved {
  accountId: string
  wallet: Wallet
  expiresAt: number
}
/** A sign-in's name: it keys what was read for it. */
export const nameOf = (s: Saved) => `${s.accountId}:${s.expiresAt}`

/**
 * What the check of the session saved at page load does once the wallet answers (`walletAccount`): restore it, end
 * it (the wallet left it behind), or keep out of the way. The answer can come late (the NEAR connector may take
 * longer than the page waits), after the customer has signed in again, perhaps with another wallet: that sign-in,
 * now saved (`now`) and signed in, must be neither replaced nor forgotten.
 */
export const restoreOutcome = (saved: Saved | undefined, now: Saved | undefined, signedIn: boolean, walletAccount: string | undefined): "restore" | "end" | "keep" =>
  signedIn || (now !== undefined && (saved === undefined || nameOf(now) !== nameOf(saved)))
    ? "keep"
    : saved !== undefined && now !== undefined && saved.accountId === walletAccount
    ? "restore"
    : "end"
