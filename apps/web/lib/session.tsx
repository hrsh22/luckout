"use client"

import type { Mode } from "@luckout/api"
import { createContext, useCallback, useContext, useEffect, useState } from "react"
import { api, UNAUTHORIZED } from "./api"
import { contractId, near, usdcId, view } from "./near"

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
  signIn(): Promise<void>
  signOut(): Promise<void>
  refresh(): Promise<void>
}

const STORAGE = "luckout.session"
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
  const accountId = session?.accountId

  const clear = useCallback(() => {
    forget()
    setSession(undefined)
    setAccount(undefined)
    setWalletUsdc(undefined)
  }, [])

  const refresh = useCallback(async () => {
    if (!accountId) return
    const [a, w] = await Promise.all([
      view<ContractAccount | null>(contractId, "get_account", { account_id: accountId }),
      view<string>(usdcId, "ft_balance_of", { account_id: accountId })
    ])
    setAccount(a)
    setWalletUsdc(w)
  }, [accountId])

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

  useEffect(() => {
    refresh().catch(() => {})
  }, [refresh])

  const signIn = async () => {
    const wallet = await near().connect()
    const id = (await wallet.getAccounts())[0]?.accountId
    if (!id) throw new Error("No account selected in the wallet")
    const challenge = await api((c) => c.auth.challenge())
    const nonce = Uint8Array.from(atob(challenge.nonce), (ch) => ch.charCodeAt(0))
    const signed = await wallet.signMessage({ message: challenge.message, recipient: challenge.recipient, nonce })
    const s = await api((c) =>
      c.auth.verify({ payload: { accountId: id, publicKey: signed.publicKey, signature: signed.signature, nonce: challenge.nonce } })
    )
    try {
      localStorage.setItem(STORAGE, JSON.stringify(s))
    } catch {}
    setSession({ accountId: s.accountId, token: s.token })
  }

  const signOut = async () => {
    clear()
    await near().disconnect().catch(() => {})
  }

  return (
    <SessionContext value={{ accountId, token: session?.token, ready, account, walletUsdc, signIn, signOut, refresh }}>
      {children}
    </SessionContext>
  )
}

export const useSession = () => {
  const s = useContext(SessionContext)
  if (!s) throw new Error("useSession outside SessionProvider")
  return s
}
