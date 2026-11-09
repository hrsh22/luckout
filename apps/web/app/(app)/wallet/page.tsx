"use client"

import { Button } from "@/components/ui/button"
import { WalletPanel } from "@/components/wallet-panel"
import { useSession } from "@/lib/session"

export default function Wallet() {
  const { accountId, ready, signIn } = useSession()
  return (
    <main className="flex flex-col gap-6">
      <h1 className="font-display text-4xl">Balance</h1>
      {accountId
        ? <WalletPanel key={accountId} accountId={accountId} />
        : ready && (
          <div className="flex max-w-lg flex-col items-start gap-3">
            <p className="text-muted-foreground">
              Sign in with your NEAR wallet to add funds, set your spending limits and link Telegram. Your balance is held by the
              Luckout contract for your account, and you can withdraw it any time.
            </p>
            <Button onClick={() => signIn().catch(() => {})}>Sign in with NEAR</Button>
          </div>
        )}
    </main>
  )
}
