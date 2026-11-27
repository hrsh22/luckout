// The session's decisions that need no Privy and no React, so node --test can check them. lib/session.tsx uses them.

import type { Wallet } from "@luckout/api"

/** What is saved of a session: who, and until when. The token never reaches the page (an HttpOnly cookie). */
export interface Saved {
  accountId: string
  wallet: Wallet
  expiresAt: number
}
/** A sign-in's name: it keys what was read for it. */
export const nameOf = (s: Saved) => `${s.accountId}:${s.expiresAt}`

/** Enough of a Privy user to find their wallet: the accounts they linked. */
export interface LinkedAccounts {
  linkedAccounts: ReadonlyArray<{ type: string; address?: string; chainType?: string; walletClientType?: string }>
}

/**
 * The customer's account id: their Privy embedded Solana wallet (ADR-0015). Someone who signs in with Phantom has
 * one too; Phantom only pays in. Undefined until Privy has made it.
 */
export const privyWallet = (user: LinkedAccounts | null | undefined) =>
  user?.linkedAccounts.find((a) => a.type === "wallet" && a.chainType === "solana" && a.walletClientType === "privy")?.address

/**
 * Privy says who is signed in (`wallet`, or none): the session saved in this browser comes back only if it is theirs
 * and still good. Otherwise Privy's sign-in makes a new one, and one left behind (another person, or none) ends.
 */
export const onPrivy = (o: { saved: Saved | undefined; wallet: string | undefined; now: number }): "restore" | "sign in" | "end" =>
  o.wallet === undefined
    ? "end"
    : o.saved?.accountId === o.wallet && o.saved.expiresAt > o.now
    ? "restore"
    : "sign in"

/** The server's answer while a new customer's Privy wallet is still being made: worth asking again shortly. */
export const stillMaking = (e: unknown) => /still being made/i.test(String((e as { message?: string })?.message ?? ""))
