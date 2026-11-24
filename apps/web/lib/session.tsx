"use client"

import {
  evmSignInMessage,
  intentPayload,
  intentSignature,
  type Mode,
  SignedChallenge,
  SignedEvmChallenge,
  type SignedIntent,
  SignedSolanaChallenge,
  solanaAddress,
  solanaSignedIntent,
  solanaSignInMessage,
  type Wallet,
  walletOf
} from "@luckout/api"
import { useQueryClient } from "@tanstack/react-query"
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { getAddress } from "viem"
import { api, cancelled, errorMessage, TimedOut, UNAUTHORIZED } from "./api"
import { claimCart, releaseCart } from "./cart"
import { connectEvm, disconnectWallets, evmAddress, evmChainId, signText, watchEvm } from "./evm"
import { type Call, canSignForRelay, contractId, intentsId, intentsUsdc, near, nearBalance, send as walletSend, signForRelay, usdcId, view } from "./near"
import { asIntent, nameOf, restoreOutcome, type Saved } from "./session-rules.ts"
import { connectSolana, signSolana, solanaAccount, watchSolana } from "./solana"

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
  /** The signed-in account; set only together with `token`. */
  accountId: string | undefined
  /**
   * This sign-in's name (account and expiry), not a secret: it keys what was read for it and marks a call as
   * made signed in (`api(f, token)`). The session token itself is an HttpOnly cookie no script can read.
   */
  token: string | undefined
  /** False until the saved session has been checked against the wallet. */
  ready: boolean
  /** undefined while loading (or if reading it failed: see accountError), null before the first deposit */
  account: ContractAccount | null | undefined
  /** Why the account couldn't be read from the chain; refresh() tries again. */
  accountError: string | undefined
  /** USDC held in the wallet, not yet deposited; for an EVM or Solana wallet, in its NEAR Intents account (ADR-0011) */
  walletUsdc: string | undefined
  /** NEAR in the wallet, in yoctoNEAR: it pays the network fee unless our relayer does */
  walletNear: string | undefined
  /** Our relayer pays this account's network fees: the wallet can sign for it and today's free relays aren't used up. */
  gasFree: boolean | undefined
  /** The kind of wallet signed in with; undefined when signed out. */
  wallet: Wallet | undefined
  /** Signed in with an EVM or Solana wallet: it acts through NEAR Intents, and our relayer pays its NEAR fees within the free actions (past them it is refused, with no wallet path to fall back on). */
  intents: boolean
  signing: SignInStep | undefined
  signInError: SignInProblem | undefined
  /** Resolves undefined once signed in, or why it didn't happen. */
  signIn(kind?: Wallet): Promise<SignInProblem | undefined>
  signOut(): Promise<void>
  refresh(): Promise<void>
  /** Signs the calls in one wallet approval and sends them, fee paid by our relayer when it can. */
  send(...calls: Array<Call>): Promise<void>
  /** EVM and Solana wallets: one NEAR Intents payload holding `intent`, signed by the wallet and valid for `minutes`. */
  signIntent(intent: object, minutes?: number): Promise<SignedIntent>
}

const STORAGE = "luckout.session"

/** What each kind of wallet is called on the page. */
export const WALLET_NAMES: Record<Wallet, string> = { near: "NEAR", evm: "EVM", solana: "Solana" }

/** Everything the app shows about an account, read straight from the chain. An EVM or Solana wallet's USDC waits in NEAR Intents. */
const readAccount = (id: string, intents: boolean) =>
  Promise.all([
    view<ContractAccount | null>(contractId, "get_account", { account_id: id }),
    intents ? intentsUsdc(id) : view<string>(usdcId, "ft_balance_of", { account_id: id }),
    intents ? Promise.resolve(undefined) : nearBalance(id).catch(() => undefined)
  ])
/** Whether our relayer will pay this account's next fee (ADR-0008). An EVM or Solana wallet signs only what the relayer sends. */
const relayable = (token: string, intents: boolean) =>
  Promise.all([intents || canSignForRelay(), api((c) => c.relay.status(), token).then((s) => s.available, () => false)]).then(([a, b]) => a && b)

const SessionContext = createContext<Session | null>(null)

const load = (): Saved | undefined => {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE) ?? "null")
    // Saved before sessions named their wallet: none of those was Solana.
    return s && s.expiresAt > Date.now() ? { ...s, wallet: s.wallet ?? walletOf(s.accountId) } : undefined
  } catch {
    return undefined
  }
}
const forget = () => {
  try {
    localStorage.removeItem(STORAGE)
  } catch {}
}
/**
 * Ends `who`'s session on the server, which also drops the cookie in this browser. Sign out does it, and so does
 * every way the wallet leaves the session behind (disconnected, or on another account): otherwise the cookie stays
 * good for days, on what may be a shared computer. Sent without the session's name, so one already over doesn't
 * fire UNAUTHORIZED again, and skipped once another tab has signed in as someone else, since the browser's one
 * cookie is theirs now. It never fails: a server that doesn't answer in 5 seconds, or says the session is already
 * over, is left behind.
 */
const endOnServer = (who: string | undefined) => {
  const saved = load()
  return who && (!saved || saved.accountId === who) ? api((c) => c.session.signOut(), undefined, "5 seconds").catch(() => {}) : Promise.resolve()
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<{ accountId: string; token: string; wallet: Wallet }>()
  const [ready, setReady] = useState(false)
  const [account, setAccount] = useState<ContractAccount | null>()
  const [accountError, setAccountError] = useState<string>()
  const [walletUsdc, setWalletUsdc] = useState<string>()
  const [walletNear, setWalletNear] = useState<string>()
  const [gasFree, setGasFree] = useState<boolean>()
  const [signing, setSigning] = useState<SignInStep>()
  const [signInError, setSignInError] = useState<SignInProblem>()
  const accountId = session?.accountId
  // Who is signed in right now, for work that finishes later: a balance read started for one account must
  // never be shown to the next.
  const current = useRef<string | undefined>(undefined)
  current.current = accountId
  // A sign-in under way, from the wallet's first prompt until it's saved and shown: see the restore below.
  const signingIn = useRef(false)
  const wallet = session?.wallet
  const intents = wallet === "evm" || wallet === "solana"
  const qc = useQueryClient()

  // Signed out, switched or expired: nothing read for the last account (purchases and their codes
  // included) may outlive it.
  const reset = useCallback(() => {
    current.current = undefined
    setSession(undefined)
    setAccount(undefined)
    setAccountError(undefined)
    setWalletUsdc(undefined)
    setWalletNear(undefined)
    setGasFree(undefined)
    qc.clear()
  }, [qc])
  const clear = useCallback(() => {
    forget()
    reset()
  }, [reset])
  // The wallet left this session behind: end it on the server too, not only on this page.
  const leave = useCallback(() => {
    void endOnServer(current.current)
    clear()
  }, [clear])

  const token = session?.token
  const refresh = useCallback(async () => {
    if (!accountId || !token) return
    try {
      const [[a, w, n], free] = await Promise.all([readAccount(accountId, intents), relayable(token, intents)])
      // Signed out or switched while this was on its way: it's someone else's balance now.
      if (current.current !== accountId) return
      setAccount(a)
      setWalletUsdc(w)
      setWalletNear(n)
      setGasFree(free)
      setAccountError(undefined)
    } catch (e) {
      if (current.current !== accountId) return
      setAccountError(errorMessage(e))
      throw e
    }
  }, [accountId, token, intents])

  // The Cart is this account's from now on; another account's Cart is emptied first.
  useEffect(() => {
    if (accountId) claimCart(accountId)
  }, [accountId])

  // Restore the saved session only if the wallet is still on the same account.
  useEffect(() => {
    const saved = load()
    const connected = saved?.wallet === "evm"
      ? evmAddress()
      : saved?.wallet === "solana"
      ? solanaAccount()
      : near().getConnectedWallet().then(({ accounts }) => accounts[0]?.accountId)
    // Decided when the wallet answers, which may come after the customer has signed in again (see below).
    const settle = (id: string | undefined) => {
      const outcome = restoreOutcome({ saved, now: load(), walletAccount: id, signedIn: current.current !== undefined, signingIn: signingIn.current })
      if (outcome === "restore" && saved) setSession({ accountId: saved.accountId, token: nameOf(saved), wallet: saved.wallet })
      if (outcome === "end") {
        void endOnServer(saved?.accountId)
        forget()
      }
    }
    connected.then(settle, () => settle(undefined)).finally(() => setReady(true))
    // The NEAR connector loads its wallet list from elsewhere first. If that hangs, the page must not: Sign in
    // appears anyway (an EVM or Solana wallet doesn't need it), and a late answer still restores the session above,
    // unless the customer has signed in, or started to, meanwhile.
    const waited = setTimeout(() => setReady(true), 8000)
    return () => clearTimeout(waited)
  }, [])

  // One cookie serves every tab. Another tab signed in as someone else, or signed out: this tab's calls no
  // longer carry its own session, so it ends here too (leaving the saved session, which is the other tab's).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE && accountId && load()?.accountId !== accountId) reset()
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [accountId, reset])

  // An EVM or Solana wallet that switched account or disconnected no longer matches this session.
  useEffect(() => {
    if (!intents) return
    let stop: (() => void) | undefined
    let live = true
    const watch = wallet === "solana" ? watchSolana : watchEvm
    watch((id) => id !== accountId && leave()).then((s) => (live ? (stop = s) : s()), () => {})
    return () => {
      live = false
      stop?.()
    }
  }, [intents, wallet, accountId, leave])

  // The wallet signed out or switched accounts elsewhere: this session no longer matches it.
  useEffect(() => {
    const c = near()
    const onSignOut = () => leave()
    const onSignIn = (e: { accounts: Array<{ accountId: string }> }) => {
      if (accountId && e.accounts[0]?.accountId !== accountId) leave()
    }
    c.on("wallet:signOut", onSignOut)
    c.on("wallet:signIn", onSignIn)
    window.addEventListener(UNAUTHORIZED, clear)
    return () => {
      c.off("wallet:signOut", onSignOut)
      c.off("wallet:signIn", onSignIn)
      window.removeEventListener(UNAUTHORIZED, clear)
    }
  }, [accountId, clear, leave])

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

  /** personal_sign of a Sign-In with Ethereum message naming this site, with an EVM wallet (ADR-0011). */
  const signInEvm = async () => {
    const address = await connectEvm()
    const challenge = await api((c) => c.auth.challenge())
    // The site as the browser sees it: the wallet compares it with the page, and the server with its own sites.
    const site = { uri: window.location.origin, chainId: await evmChainId(), issuedAt: new Date().toISOString() }
    setSigning("message")
    const signature = await signText(address, evmSignInMessage({ challenge, address: getAddress(address), ...site }))
    return api((c) => c.auth.verifyEvm({ payload: new SignedEvmChallenge({ address, signature, nonce: challenge.nonce, ...site }) }))
  }

  /** An ed25519 signature of a Sign In With Solana message naming this site, with a Solana wallet (ADR-0011). */
  const signInSolana = async () => {
    const id = await connectSolana()
    const address = solanaAddress(id)
    const challenge = await api((c) => c.auth.challenge())
    const site = { uri: window.location.origin, issuedAt: new Date().toISOString() }
    setSigning("message")
    const signature = await signSolana(id, solanaSignInMessage({ challenge, address, ...site }))
    return api((c) =>
      c.auth.verifySolana({ payload: new SignedSolanaChallenge({ address, signature: btoa(String.fromCharCode(...signature)), nonce: challenge.nonce, ...site }) })
    )
  }

  const signIn = async (kind: Wallet = "near") => {
    setSignInError(undefined)
    setSigning("wallet")
    signingIn.current = true
    try {
      const s = await (kind === "evm" ? signInEvm() : kind === "solana" ? signInSolana() : signInNear())
      try {
        localStorage.setItem(STORAGE, JSON.stringify(s))
      } catch {}
      // Read the account before switching to signed in, so the page settles once: a new customer
      // sees Welcome straight away instead of a signed-in flash, a lookup, then a jump.
      const [read, free] = await Promise.all([
        readAccount(s.accountId, s.wallet !== "near").catch((e: unknown) => new Error(errorMessage(e))),
        relayable(nameOf(s), s.wallet !== "near")
      ])
      if (read instanceof Error) {
        // Whatever was held before isn't this account's: show "couldn't read", never another balance.
        setAccount(undefined)
        setWalletUsdc(undefined)
        setWalletNear(undefined)
        setAccountError(read.message)
      } else {
        setAccount(read[0])
        setWalletUsdc(read[1])
        setWalletNear(read[2])
        setAccountError(undefined)
      }
      setGasFree(free)
      setSession({ accountId: s.accountId, token: nameOf(s), wallet: s.wallet })
      return undefined
    } catch (e) {
      const problem = {
        message: cancelled(e) ? "You closed your wallet before signing in. Nothing was shared." : errorMessage(e),
        cancelled: cancelled(e)
      }
      setSignInError(problem)
      return problem
    } finally {
      signingIn.current = false
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
    if (session.wallet === "solana") return solanaSignedIntent({ payload, accountId: session.accountId, signature: await signSolana(session.accountId, payload) })
    return { standard: "erc191", payload, signature: intentSignature(await signText(session.accountId, payload)) }
  }

  const send = async (...calls: Array<Call>) => {
    if (!session) throw new Error("Sign in first.")
    // An EVM or Solana wallet has no NEAR to pay with: each call is a signed intent our relayer sends, or nothing.
    if (intents) {
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
    await endOnServer(current.current)
    clear()
    releaseCart()
    await Promise.all([near().disconnect().catch(() => {}), disconnectWallets()])
  }

  return (
    <SessionContext
      value={{ accountId, token, ready, account, accountError, walletUsdc, walletNear, gasFree, wallet, intents, signing, signInError, signIn, signOut, refresh, send, signIntent }}
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
