"use client"

import type { Mode } from "@luckout/api"
import { createContext, useCallback, useContext, useEffect, useState } from "react"
import { api } from "./api"
import { contractId, near, usdcId, view } from "./near"

/** The customer's state in the contract (all amounts micro-USDC strings). */
export interface ContractAccount {
  balance: string
  per_purchase_limit: string
  daily_limit: string
  default_mode: Mode
  spent_today: string
  premiums_paid: string
  refunds_received: string
}

interface Session {
  accountId: string | undefined
  token: string | undefined
  /** undefined while loading, null before the first deposit */
  account: ContractAccount | null | undefined
  /** tUSDC/USDC held in the wallet, not yet deposited */
  walletUsdc: string | undefined
  signIn(): Promise<void>
  signOut(): Promise<void>
  refresh(): Promise<void>
}

const STORAGE = "luckout.session"
const SessionContext = createContext<Session | null>(null)

const load = (): { accountId: string; token: string; expiresAt: number } | undefined => {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE) ?? "null")
    return s && s.expiresAt > Date.now() ? s : undefined
  } catch {
    return undefined
  }
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [accountId, setAccountId] = useState<string>()
  const [token, setToken] = useState<string>()
  const [account, setAccount] = useState<ContractAccount | null>()
  const [walletUsdc, setWalletUsdc] = useState<string>()

  const refresh = useCallback(async () => {
    if (!accountId) return
    const [a, w] = await Promise.all([
      view<ContractAccount | null>(contractId, "get_account", { account_id: accountId }),
      view<string>(usdcId, "ft_balance_of", { account_id: accountId })
    ])
    setAccount(a)
    setWalletUsdc(w)
  }, [accountId])

  useEffect(() => {
    near().getConnectedWallet().then(({ accounts }) => {
      const id = accounts[0]?.accountId
      setAccountId(id)
      const saved = load()
      if (id && saved?.accountId === id) setToken(saved.token)
    }, () => {})
  }, [])

  useEffect(() => {
    refresh().catch(() => {})
  }, [refresh])

  const signIn = async () => {
    const wallet = await near().connect()
    const id = (await wallet.getAccounts())[0]?.accountId
    if (!id) throw new Error("No account selected")
    setAccountId(id)
    const challenge = await api((c) => c.auth.challenge())
    const nonce = Uint8Array.from(atob(challenge.nonce), (ch) => ch.charCodeAt(0))
    const signed = await wallet.signMessage({ message: challenge.message, recipient: challenge.recipient, nonce })
    const session = await api((c) =>
      c.auth.verify({ payload: { accountId: id, publicKey: signed.publicKey, signature: signed.signature, nonce: challenge.nonce } })
    )
    try {
      localStorage.setItem(STORAGE, JSON.stringify(session))
    } catch {}
    setToken(session.token)
  }

  const signOut = async () => {
    try {
      localStorage.removeItem(STORAGE)
    } catch {}
    setToken(undefined)
    setAccountId(undefined)
    setAccount(undefined)
    await near().disconnect().catch(() => {})
  }

  return (
    <SessionContext value={{ accountId, token, account, walletUsdc, signIn, signOut, refresh }}>
      {children}
    </SessionContext>
  )
}

export const useSession = () => {
  const s = useContext(SessionContext)
  if (!s) throw new Error("useSession outside SessionProvider")
  return s
}
