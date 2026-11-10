"use client"

import { type Mode, SignedChallenge } from "@luckout/api"
import { createContext, useCallback, useContext, useEffect, useState } from "react"
import { api, cancelled, errorMessage, UNAUTHORIZED } from "./api"
import { type Call, canSignForRelay, contractId, near, nearBalance, send as walletSend, signForRelay, usdcId, view } from "./near"

/** The customer's state in the contract (all amounts micro-USDC strings). */
export interface ContractAccount {
  balance: string
  per_purchase_limit: string
  daily_limit: string
  default_mode: Mode
  day: number
  spent_today: string
  premiums_paid: string
  cashback_received: string
}

/** Where sign-in is: choosing a wallet, then signing the one-time message. */
export type SignInStep = "wallet" | "message"

/** Why sign-in didn't finish. Backing out of the wallet is not an error, just a reason to show calmly. */
export interface SignInProblem {
  message: string
  cancelled: boolean
}

interface Session {
  /** The signed-in account; set only together with a valid token. */
  accountId: string | undefined
  token: string | undefined
  /** False until the saved session has been checked against the wallet. */
  ready: boolean
  /** undefined while loading, null before the first deposit */
  account: ContractAccount | null | undefined
  /** USDC held in the wallet, not yet deposited */
  walletUsdc: string | undefined
  /** NEAR in the wallet, in yoctoNEAR: it pays the network fee unless our relayer does */
  walletNear: string | undefined
  /** Our relayer pays this account's network fees: the wallet can sign for it and today's free relays aren't used up. */
  gasFree: boolean | undefined
  signing: SignInStep | undefined
  signInError: SignInProblem | undefined
  /** Resolves undefined once signed in, or why it didn't happen. */
  signIn(): Promise<SignInProblem | undefined>
  signOut(): Promise<void>
  refresh(): Promise<void>
  /** Signs the calls in one wallet approval and sends them, fee paid by our relayer when it can. */
  send(...calls: Array<Call>): Promise<void>
}

const STORAGE = "luckout.session"

/** Everything the app shows about an account, read straight from the chain. */
const readAccount = (id: string) =>
  Promise.all([
    view<ContractAccount | null>(contractId, "get_account", { account_id: id }),
    view<string>(usdcId, "ft_balance_of", { account_id: id }),
    nearBalance(id).catch(() => undefined)
  ])
/** Whether our relayer will pay this account's next fee (ADR-0008). */
const relayable = (token: string) =>
  Promise.all([canSignForRelay(), api((c) => c.relay.status(), token).then((s) => s.available, () => false)]).then(([a, b]) => a && b)
const SessionContext = createContext<Session | null>(null)

// ponytail: the token sits in localStorage; move to an HttpOnly cookie on .gamified.trade if XSS risk grows.
const load = (): { accountId: string; token: string; expiresAt: number } | undefined => {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE) ?? "null")
    return s && s.expiresAt > Date.now() ? s : undefined
  } catch {
    return undefined
  }
}
const forget = () => {
  try {
    localStorage.removeItem(STORAGE)
  } catch {}
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<{ accountId: string; token: string }>()
  const [ready, setReady] = useState(false)
  const [account, setAccount] = useState<ContractAccount | null>()
  const [walletUsdc, setWalletUsdc] = useState<string>()
  const [walletNear, setWalletNear] = useState<string>()
  const [gasFree, setGasFree] = useState<boolean>()
  const [signing, setSigning] = useState<SignInStep>()
  const [signInError, setSignInError] = useState<SignInProblem>()
  const accountId = session?.accountId

  const clear = useCallback(() => {
    forget()
    setSession(undefined)
    setAccount(undefined)
    setWalletUsdc(undefined)
    setWalletNear(undefined)
    setGasFree(undefined)
  }, [])

  const token = session?.token
  const refresh = useCallback(async () => {
    if (!accountId || !token) return
    const [[a, w, n], free] = await Promise.all([readAccount(accountId), relayable(token)])
    setAccount(a)
    setWalletUsdc(w)
    setWalletNear(n)
    setGasFree(free)
  }, [accountId, token])

  // Restore the saved session only if the wallet is still on the same account.
  useEffect(() => {
    near().getConnectedWallet().then(({ accounts }) => {
      const saved = load()
      if (saved && saved.accountId === accounts[0]?.accountId) setSession(saved)
      else forget()
    }, forget).finally(() => setReady(true))
  }, [])

  // The wallet signed out or switched accounts elsewhere: this session no longer matches it.
  useEffect(() => {
    const c = near()
    const onSignOut = () => clear()
    const onSignIn = (e: { accounts: Array<{ accountId: string }> }) => {
      if (accountId && e.accounts[0]?.accountId !== accountId) clear()
    }
    c.on("wallet:signOut", onSignOut)
    c.on("wallet:signIn", onSignIn)
    window.addEventListener(UNAUTHORIZED, clear)
    return () => {
      c.off("wallet:signOut", onSignOut)
      c.off("wallet:signIn", onSignIn)
      window.removeEventListener(UNAUTHORIZED, clear)
    }
  }, [accountId, clear])

  // Balances can change elsewhere (Telegram, another tab): re-read when the tab comes back.
  useEffect(() => {
    refresh().catch(() => {})
    const onFocus = () => document.visibilityState === "visible" && refresh().catch(() => {})
    document.addEventListener("visibilitychange", onFocus)
    return () => document.removeEventListener("visibilitychange", onFocus)
  }, [refresh])

  const signIn = async () => {
    setSignInError(undefined)
    setSigning("wallet")
    try {
      const wallet = await near().connect()
      const id = (await wallet.getAccounts())[0]?.accountId
      if (!id) throw new Error("No account selected in the wallet")
      const challenge = await api((c) => c.auth.challenge())
      const nonce = Uint8Array.from(atob(challenge.nonce), (ch) => ch.charCodeAt(0))
      setSigning("message")
      const signed = await wallet.signMessage({ message: challenge.message, recipient: challenge.recipient, nonce })
      const s = await api((c) =>
        // Class payloads must be instances: the client refuses a plain object before sending it.
        c.auth.verify({ payload: new SignedChallenge({ accountId: id, publicKey: signed.publicKey, signature: signed.signature, nonce: challenge.nonce }) })
      )
      try {
        localStorage.setItem(STORAGE, JSON.stringify(s))
      } catch {}
      // Read the account before switching to signed in, so the page settles once: a new customer
      // sees Welcome straight away instead of a signed-in flash, a lookup, then a jump.
      const [[a, w, n], free] = await Promise.all([
        readAccount(s.accountId).catch(() => [undefined, undefined, undefined] as const),
        relayable(s.token)
      ])
      setAccount(a)
      setWalletUsdc(w)
      setWalletNear(n)
      setGasFree(free)
      setSession({ accountId: s.accountId, token: s.token })
      return undefined
    } catch (e) {
      const problem = {
        message: cancelled(e) ? "You closed your wallet before signing in. Nothing was shared." : errorMessage(e),
        cancelled: cancelled(e)
      }
      setSignInError(problem)
      return problem
    } finally {
      setSigning(undefined)
    }
  }

  const send = async (...calls: Array<Call>) => {
    if (!session) throw new Error("Sign in first.")
    if (gasFree) {
      let signed: Array<string> | undefined
      try {
        signed = await signForRelay(session.accountId, ...calls)
      } catch (e) {
        // Backing out stops here; a wallet that turns out unable to sign for the relayer pays itself below.
        if (cancelled(e)) throw e
      }
      if (signed) {
        for (const [i, signedDelegate] of signed.entries()) {
          try {
            await api((c) => c.relay.send({ payload: { signedDelegate } }), session.token, "90 seconds")
          } catch (e) {
            // Nothing was sent: the relayer is off or today's free relays are used, so the wallet sends the rest.
            if ((e as { _tag?: string })?._tag !== "RelayUnavailable") throw e
            setGasFree(false)
            await walletSend(session.accountId, ...calls.slice(i))
            return
          }
        }
        return
      }
    }
    await walletSend(session.accountId, ...calls)
  }

  const signOut = async () => {
    clear()
    await near().disconnect().catch(() => {})
  }

  return (
    <SessionContext
      value={{ accountId, token, ready, account, walletUsdc, walletNear, gasFree, signing, signInError, signIn, signOut, refresh, send }}
    >
      {children}
    </SessionContext>
  )
}

export const useSession = () => {
  const s = useContext(SessionContext)
  if (!s) throw new Error("useSession outside SessionProvider")
  return s
}
