"use client"

import {
  type AuthAction,
  authCallIntent,
  evmSignInMessage,
  intentPayload,
  intentSignature,
  isEvmAccount,
  type Mode,
  moveInIntent,
  SignedChallenge,
  SignedEvmChallenge,
  type SignedIntent
} from "@luckout/api"
import { useQueryClient } from "@tanstack/react-query"
import { createContext, useCallback, useContext, useEffect, useState } from "react"
import { api, cancelled, errorMessage, TimedOut, UNAUTHORIZED } from "./api"
import { connectEvm, disconnectEvm, evmAddress, signText, watchEvm } from "./evm"
import { type Call, canSignForRelay, contractId, intentsId, intentsUsdc, near, nearBalance, send as walletSend, signForRelay, usdcId, view } from "./near"

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
  /** undefined while loading (or if reading it failed: see accountError), null before the first deposit */
  account: ContractAccount | null | undefined
  /** Why the account couldn't be read from the chain; refresh() tries again. */
  accountError: string | undefined
  /** USDC held in the wallet, not yet deposited; for an EVM wallet, in its NEAR Intents account (ADR-0011) */
  walletUsdc: string | undefined
  /** A NEAR wallet's USDC in its NEAR Intents account (where 1Click sends refunds); EVM wallets read theirs as walletUsdc */
  intentsUsdc: string | undefined
  /** NEAR in the wallet, in yoctoNEAR: it pays the network fee unless our relayer does */
  walletNear: string | undefined
  /** Our relayer pays this account's network fees: the wallet can sign for it and today's free relays aren't used up. */
  gasFree: boolean | undefined
  /** Signed in with an EVM wallet: it acts through NEAR Intents, and our relayer pays every NEAR fee. */
  evm: boolean
  signing: SignInStep | undefined
  signInError: SignInProblem | undefined
  /** Resolves undefined once signed in, or why it didn't happen. */
  signIn(kind?: "near" | "evm"): Promise<SignInProblem | undefined>
  signOut(): Promise<void>
  refresh(): Promise<void>
  /** Signs the calls in one wallet approval and sends them, fee paid by our relayer when it can. */
  send(...calls: Array<Call>): Promise<void>
  /** EVM wallets: one NEAR Intents payload holding `intent`, signed with personal_sign and valid for `minutes`. */
  signIntent(intent: object, minutes?: number): Promise<SignedIntent>
}

const STORAGE = "luckout.session"

/** Everything the app shows about an account, read straight from the chain. An EVM wallet's USDC waits in NEAR Intents. */
const readAccount = (id: string) =>
  Promise.all([
    view<ContractAccount | null>(contractId, "get_account", { account_id: id }),
    isEvmAccount(id) ? intentsUsdc(id) : view<string>(usdcId, "ft_balance_of", { account_id: id }),
    isEvmAccount(id) ? Promise.resolve(undefined) : nearBalance(id).catch(() => undefined),
    isEvmAccount(id) ? Promise.resolve(undefined) : intentsUsdc(id).catch(() => undefined)
  ])
/** Whether our relayer will pay this account's next fee (ADR-0008). An EVM wallet signs only what the relayer sends. */
const relayable = (token: string, evm: boolean) =>
  Promise.all([evm || canSignForRelay(), api((c) => c.relay.status(), token).then((s) => s.available, () => false)]).then(([a, b]) => a && b)

/** The contract calls an EVM wallet makes through NEAR Intents (ADR-0011), from the calls a NEAR wallet would sign. */
const AUTH_METHODS = new Set(["withdraw", "set_default_mode", "set_limits", "reclaim", "retry_draw"])
const asIntent = (account: string, c: Call) => {
  if (c.receiverId === contractId && AUTH_METHODS.has(c.method)) return authCallIntent(contractId, { [c.method]: c.args } as AuthAction)
  const args = c.args as { receiver_id?: string; amount?: string; msg?: string }
  if (c.receiverId === usdcId && c.method === "ft_transfer_call" && args.receiver_id === contractId && args.msg === "") {
    return moveInIntent({ usdcId, contractId, account, amount: String(args.amount) })
  }
  throw new Error("EVM wallets can't do that here.")
}
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
  const [accountError, setAccountError] = useState<string>()
  const [walletUsdc, setWalletUsdc] = useState<string>()
  const [walletNear, setWalletNear] = useState<string>()
  const [nearIntentsUsdc, setNearIntentsUsdc] = useState<string>()
  const [gasFree, setGasFree] = useState<boolean>()
  const [signing, setSigning] = useState<SignInStep>()
  const [signInError, setSignInError] = useState<SignInProblem>()
  const accountId = session?.accountId
  const evm = !!accountId && isEvmAccount(accountId)
  const qc = useQueryClient()

  // Signed out, switched or expired: nothing read for the last account (purchases and their codes
  // included) may outlive it.
  const clear = useCallback(() => {
    forget()
    setSession(undefined)
    setAccount(undefined)
    setAccountError(undefined)
    setWalletUsdc(undefined)
    setWalletNear(undefined)
    setNearIntentsUsdc(undefined)
    setGasFree(undefined)
    qc.clear()
  }, [qc])

  const token = session?.token
  const refresh = useCallback(async () => {
    if (!accountId || !token) return
    try {
      const [[a, w, n, i], free] = await Promise.all([readAccount(accountId), relayable(token, evm)])
      setAccount(a)
      setWalletUsdc(w)
      setWalletNear(n)
      setNearIntentsUsdc(i)
      setGasFree(free)
      setAccountError(undefined)
    } catch (e) {
      setAccountError(errorMessage(e))
      throw e
    }
  }, [accountId, token, evm])

  // Restore the saved session only if the wallet is still on the same account.
  useEffect(() => {
    const saved = load()
    const connected = saved && isEvmAccount(saved.accountId)
      ? evmAddress()
      : near().getConnectedWallet().then(({ accounts }) => accounts[0]?.accountId)
    connected.then((id) => {
      if (saved && saved.accountId === id) setSession(saved)
      else forget()
    }, forget).finally(() => setReady(true))
  }, [])

  // An EVM wallet that switched address or disconnected no longer matches this session.
  useEffect(() => {
    if (!evm) return
    let stop: (() => void) | undefined
    let live = true
    watchEvm((id) => id !== accountId && clear()).then((s) => (live ? (stop = s) : s()), () => {})
    return () => {
      live = false
      stop?.()
    }
  }, [evm, accountId, clear])

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

  /** NEP-413 with a NEAR wallet. */
  const signInNear = async () => {
    const wallet = await near().connect()
    const id = (await wallet.getAccounts())[0]?.accountId
    if (!id) throw new Error("No account selected in the wallet")
    const challenge = await api((c) => c.auth.challenge())
    const nonce = Uint8Array.from(atob(challenge.nonce), (ch) => ch.charCodeAt(0))
    setSigning("message")
    const signed = await wallet.signMessage({ message: challenge.message, recipient: challenge.recipient, nonce })
    return api((c) =>
      // Class payloads must be instances: the client refuses a plain object before sending it.
      c.auth.verify({ payload: new SignedChallenge({ accountId: id, publicKey: signed.publicKey, signature: signed.signature, nonce: challenge.nonce }) })
    )
  }

  /** personal_sign with an EVM wallet (ADR-0011). */
  const signInEvm = async () => {
    const address = await connectEvm()
    const challenge = await api((c) => c.auth.challenge())
    setSigning("message")
    const signature = await signText(address, evmSignInMessage(challenge))
    return api((c) => c.auth.verifyEvm({ payload: new SignedEvmChallenge({ address, signature, nonce: challenge.nonce }) }))
  }

  const signIn = async (kind: "near" | "evm" = "near") => {
    setSignInError(undefined)
    setSigning("wallet")
    try {
      const s = await (kind === "evm" ? signInEvm() : signInNear())
      try {
        localStorage.setItem(STORAGE, JSON.stringify(s))
      } catch {}
      // Read the account before switching to signed in, so the page settles once: a new customer
      // sees Welcome straight away instead of a signed-in flash, a lookup, then a jump.
      const [read, free] = await Promise.all([
        readAccount(s.accountId).catch((e: unknown) => new Error(errorMessage(e))),
        relayable(s.token, isEvmAccount(s.accountId))
      ])
      if (read instanceof Error) setAccountError(read.message)
      else {
        setAccount(read[0])
        setWalletUsdc(read[1])
        setWalletNear(read[2])
        setNearIntentsUsdc(read[3])
        setAccountError(undefined)
      }
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

  const signIntent = async (intent: object, minutes = 10): Promise<SignedIntent> => {
    if (!session) throw new Error("Sign in first.")
    const payload = intentPayload({
      signer: session.accountId,
      intentsId,
      deadline: new Date(Date.now() + minutes * 60_000),
      nonce: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
      intents: [intent]
    })
    return { standard: "erc191", payload, signature: intentSignature(await signText(session.accountId, payload)) }
  }

  const send = async (...calls: Array<Call>) => {
    if (!session) throw new Error("Sign in first.")
    // An EVM wallet has no NEAR to pay with: each call is a signed intent our relayer sends, or nothing.
    if (evm) {
      for (const call of calls) {
        const signed = await signIntent(asIntent(session.accountId, call))
        try {
          await api((c) => c.relay.intent({ payload: { signed } }), session.token, "90 seconds")
        } catch (e) {
          if (e instanceof TimedOut) throw new Error(`${e.message} It may still go through, so check your balance before trying again.`)
          throw e
        }
      }
      return
    }
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
            if (e instanceof TimedOut) throw new Error(`${e.message} It may still go through, so check your balance before trying again.`)
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
    await Promise.all([near().disconnect().catch(() => {}), disconnectEvm()])
  }

  return (
    <SessionContext
      value={{ accountId, token, ready, account, accountError, walletUsdc, intentsUsdc: nearIntentsUsdc, walletNear, gasFree, evm, signing, signInError, signIn, signOut, refresh, send, signIntent }}
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
