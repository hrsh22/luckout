"use client"

import { Button } from "@/components/ui/button"
import { near } from "@/lib/near"
import { useEffect, useState } from "react"

export function ConnectButton() {
  const [account, setAccount] = useState<string>()

  useEffect(() => {
    const c = near()
    const onIn = (e: { accounts: Array<{ accountId: string }> }) => setAccount(e.accounts[0]?.accountId)
    const onOut = () => setAccount(undefined)
    c.on("wallet:signIn", onIn)
    c.on("wallet:signOut", onOut)
    c.getConnectedWallet().then((r) => setAccount(r.accounts[0]?.accountId), () => {})
    return () => {
      c.off("wallet:signIn", onIn)
      c.off("wallet:signOut", onOut)
    }
  }, [])

  return account
    ? <Button variant="outline" onClick={() => near().disconnect()}>{account}</Button>
    : <Button onClick={() => near().connect()}>Connect wallet</Button>
}
