"use client"

import { type CustomerAccount, PrivySignIn, type Session as ServerSession } from "@luckout/api"
import { getIdentityToken, useLogin, usePrivy, useUser } from "@privy-io/react-auth"
import { useCreateWallet } from "@privy-io/react-auth/solana"
import { useQueryClient } from "@tanstack/react-query"
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { api, errorMessage, UNAUTHORIZED } from "./api"
import { claimCart, releaseCart } from "./cart"
import { nameOf, onPrivy, privyWallet, type Saved, stillMaking } from "./session-rules.ts"

/** The customer's Customer account in the program (amounts are micro-USDC strings). */
export type ContractAccount = CustomerAccount

/** Why sign-in didn't finish. Closing Privy's window is not an error, just a reason to show calmly. */
export interface SignInProblem {
  message: string
  cancelled: boolean
}

interface Session {
  /** The signed-in account: the customer's Privy Solana wallet. Set only together with `token`. */
  accountId: string | undefined
  /**
   * This sign-in's name (account and expiry), not a secret: it keys what was read for it and marks a call as
   * made signed in (`api(f, token)`). The session token itself is an HttpOnly cookie no script can read.
   */
  token: string | undefined
  /** False until Privy has said who, if anyone, is signed in, and the session matches it. */
  ready: boolean
  /** undefined while loading (or if reading it failed: see accountError), null before the one-time approval */
  account: ContractAccount | null | undefined
  /** Why the account couldn't be read; refresh() tries again. */
  accountError: string | undefined
  /** Privy's window is open, or its sign-in is reaching our server. */
  signing: boolean
  signInError: SignInProblem | undefined
  /** Opens Privy's window (or, already signed in to Privy, signs in here). Resolves undefined once signed in, or why not. */
  signIn(): Promise<SignInProblem | undefined>
  /** Signs out of Privy and of our server. */
  signOut(): Promise<void>
  refresh(): Promise<void>
  /** Signs in again with Privy's current tokens, so the server reads what changed there (a Telegram linked or unlinked). */
  resync(): Promise<void>
}

const STORAGE = "luckout.session"

const SessionContext = createContext<Session | null>(null)

const load = (): Saved | undefined => {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE) ?? "null")
    return s && s.expiresAt > Date.now() ? s : undefined
  } catch {
    return undefined
  }
}
const save = (s: Saved) => {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(s))
  } catch {}
}
const forget = () => {
  try {
    localStorage.removeItem(STORAGE)
  } catch {}
}
/**
 * Ends `who`'s session on the server, which also drops the cookie in this browser: on sign out, and whenever Privy
 * leaves the session behind (signed out, or someone else), so the cookie isn't left good for days on what may be a
 * shared computer. Sent without the session's name, so one already over doesn't fire UNAUTHORIZED again, and skipped
 * once another tab has signed in as someone else, since the browser's one cookie is theirs now. It never fails.
 */
const endOnServer = (who: string | undefined) => {
  const saved = load()
  return who && (!saved || saved.accountId === who) ? api((c) => c.session.signOut(), undefined, "5 seconds").catch(() => {}) : Promise.resolve()
}

const readAccount = (token: string) => api((c) => c.deposits.account(), token)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const privy = usePrivy()
  const { refreshUser } = useUser()
  const { createWallet } = useCreateWallet()
  const [session, setSession] = useState<Saved>()
  // Privy has told us who's signed in and we've acted on it (or waited long enough).
  const [settled, setSettled] = useState(false)
  const [account, setAccount] = useState<ContractAccount | null>()
  const [accountError, setAccountError] = useState<string>()
  const [signing, setSigning] = useState(false)
  const [signInError, setSignInError] = useState<SignInProblem>()
  const accountId = session?.accountId
  const token = session && nameOf(session)
  // Who is signed in right now, for work that finishes later: an account read started for one customer must never be
  // shown to the next.
  const current = useRef<string | undefined>(undefined)
  current.current = accountId
  const qc = useQueryClient()

  // Signed out, switched or expired: nothing read for the last account (purchases and their codes included) may outlive it.
  const reset = useCallback(() => {
    current.current = undefined
    setSession(undefined)
    setAccount(undefined)
    setAccountError(undefined)
    qc.clear()
  }, [qc])
  const clear = useCallback(() => {
    forget()
    reset()
  }, [reset])

  /** Shows `s` as signed in, after reading its account, so a new customer sees Welcome at once instead of a flash. */
  const show = useCallback(async (s: Saved) => {
    const read = await readAccount(nameOf(s)).catch((e: unknown) => new Error(errorMessage(e)))
    current.current = s.accountId
    if (read instanceof Error) {
      setAccount(undefined)
      setAccountError(read.message)
    } else {
      setAccount(read)
      setAccountError(undefined)
    }
    setSession(s)
  }, [])

  /**
   * Privy's tokens to our server, which answers with the session (its cookie HttpOnly). A brand-new customer's wallet
   * may not be in their identity token yet: the token is refreshed and asked again, for a few seconds.
   */
  const toServer = useCallback(async (): Promise<Saved> => {
    for (let attempt = 0; ; attempt++) {
      const [accessToken, identityToken] = await Promise.all([privy.getAccessToken(), getIdentityToken()])
      if (!accessToken || !identityToken) throw new Error("Privy didn't finish signing you in. Try again.")
      try {
        const s: ServerSession = await api((c) => c.auth.privy({ payload: new PrivySignIn({ accessToken, identityToken }) }))
        return { accountId: s.accountId, wallet: s.wallet, expiresAt: s.expiresAt }
      } catch (e) {
        if (!stillMaking(e) || attempt >= 5) throw e
        await refreshUser().catch(() => {})
        await sleep(1500)
      }
    }
  }, [privy, refreshUser])

  // One sign-in at a time: Privy's page-load callback and a tap on Sign in can arrive together.
  const inFlight = useRef<Promise<void> | undefined>(undefined)
  const pending = useRef<((p: SignInProblem | undefined) => void) | undefined>(undefined)
  const finish = (p: SignInProblem | undefined) => {
    setSignInError(p)
    setSigning(false)
    pending.current?.(p)
    pending.current = undefined
  }

  /** Privy has a signed-in user: keep the matching saved session, or sign in to our server for them. */
  const connect = useCallback((wallet: string | undefined) => {
    inFlight.current ??= (async () => {
      try {
        // Normally Privy's window made the wallet already; one that didn't (closed early) is made now.
        const id = wallet ?? (await createWallet()).wallet.address
        const saved = load()
        if (onPrivy({ saved, wallet: id, now: Date.now() }) === "restore") {
          if (current.current !== id) await show(saved!)
          return finish(undefined)
        }
        setSigning(true)
        // Someone else's session here ends first, and fully: its sign-out drops the cookie the new one is about to set.
        const before = current.current ?? saved?.accountId
        if (before) {
          await endOnServer(before)
          clear()
        }
        const s = await toServer()
        save(s)
        await show(s)
        finish(undefined)
      } catch (e) {
        finish({ message: errorMessage(e), cancelled: false })
      } finally {
        inFlight.current = undefined
        setSettled(true)
      }
    })()
    return inFlight.current
  }, [createWallet, clear, show, toServer])

  const { login } = useLogin({
    // After Privy's window (with the wallet made), and on page load for someone already signed in to Privy.
    onComplete: ({ user }) => void connect(privyWallet(user)),
    onError: (code) => {
      setSettled(true)
      // Only a sign-in someone tapped gets an answer; Privy's quiet page-load check stays quiet.
      if (!pending.current) return
      const closed = code === "exited_auth_flow"
      finish({ message: closed ? "You closed the sign-in window. Nothing was shared." : `Sign-in didn't finish (${code}). Try again.`, cancelled: closed })
    }
  })

  // Signed out of Privy (here, in another tab, or its session ran out): ours ends too.
  useEffect(() => {
    if (!privy.ready || privy.authenticated) return
    const saved = load()
    if (saved || current.current) {
      void endOnServer(saved?.accountId ?? current.current)
      clear()
    }
    setSettled(true)
  }, [privy.ready, privy.authenticated, clear])

  // If Privy's page-load callback never comes, the page must not wait for it: Sign in appears anyway.
  useEffect(() => {
    const t = setTimeout(() => setSettled(true), 8000)
    return () => clearTimeout(t)
  }, [])

  // The Cart is this account's from now on; another account's Cart is emptied first.
  useEffect(() => {
    if (accountId) claimCart(accountId)
  }, [accountId])

  // One cookie serves every tab. Another tab signed in as someone else, or signed out: this tab's calls no longer carry
  // its own session, so it ends here too (leaving the saved session, which is the other tab's).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE && accountId && load()?.accountId !== accountId) reset()
    }
    window.addEventListener("storage", onStorage)
    window.addEventListener(UNAUTHORIZED, clear)
    return () => {
      window.removeEventListener("storage", onStorage)
      window.removeEventListener(UNAUTHORIZED, clear)
    }
  }, [accountId, reset, clear])

  const refresh = useCallback(async () => {
    if (!accountId || !token) return
    try {
      const a = await readAccount(token)
      // Signed out or switched while this was on its way: it's someone else's account now.
      if (current.current !== accountId) return
      setAccount(a)
      setAccountError(undefined)
    } catch (e) {
      if (current.current !== accountId) return
      setAccountError(errorMessage(e))
      throw e
    }
  }, [accountId, token])

  // Balances can change elsewhere (Telegram, a deposit landing, another tab): read again when the tab comes back.
  useEffect(() => {
    refresh().catch(() => {})
    const onFocus = () => document.visibilityState === "visible" && refresh().catch(() => {})
    document.addEventListener("visibilitychange", onFocus)
    return () => document.removeEventListener("visibilitychange", onFocus)
  }, [refresh])

  const signIn = () =>
    new Promise<SignInProblem | undefined>((resolve) => {
      setSignInError(undefined)
      pending.current?.(undefined)
      pending.current = resolve
      if (privy.authenticated) {
        // Signed in to Privy already (our session ran out, or the server refused it): only ours is needed.
        void connect(privyWallet(privy.user))
        return
      }
      setSigning(true)
      login()
    })

  const resync = async () => {
    const s = await toServer()
    save(s)
    if (current.current === s.accountId) setSession(s)
  }

  const signOut = async () => {
    await endOnServer(current.current)
    clear()
    releaseCart()
    await privy.logout().catch(() => {})
  }

  return (
    <SessionContext
      value={{
        accountId,
        token,
        ready: privy.ready && (!privy.authenticated || settled),
        account,
        accountError,
        signing,
        signInError,
        signIn,
        signOut,
        refresh,
        resync
      }}
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
