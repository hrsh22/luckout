"use client"

import { WalletPanel } from "@/components/wallet-panel"
import { useSession } from "@/lib/session"

export default function Wallet() {
  const { accountId } = useSession()
  return (
    <main className="flex flex-col gap-4">
      <h1 className="font-heading text-3xl font-bold">Wallet</h1>
      {accountId ? <WalletPanel /> : <p className="text-muted-foreground">Sign in to manage your balance.</p>}
    </main>
  )
}
