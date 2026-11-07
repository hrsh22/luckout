"use client"

import { Button } from "@/components/ui/button"
import { errorMessage } from "@/lib/api"
import { usd } from "@/lib/format"
import { useSession } from "@/lib/session"
import Link from "next/link"
import { useState } from "react"

export function Header() {
  const { accountId, token, account, signIn, signOut } = useSession()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const start = async () => {
    setError(undefined)
    setBusy(true)
    await signIn().catch((e) => setError(errorMessage(e)))
    setBusy(false)
  }

  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <nav className="flex items-center gap-5">
        <Link href="/" className="font-heading text-xl font-bold">Luckout</Link>
        <Link href="/fair" className="text-muted-foreground hover:text-foreground text-sm">Is it fair?</Link>
        {token && (
          <>
            <Link href="/purchases" className="text-muted-foreground hover:text-foreground text-sm">Purchases</Link>
            <Link href="/wallet" className="text-muted-foreground hover:text-foreground text-sm">Wallet</Link>
          </>
        )}
      </nav>
      <div className="flex items-center gap-2">
        {token && account && (
          <Link href="/wallet" className="bg-card rounded-full border px-3 py-1.5 text-sm tabular-nums">
            {usd(account.balance)}
          </Link>
        )}
        {token
          ? <Button variant="outline" onClick={() => signOut()} title="Sign out">{accountId}</Button>
          : <Button onClick={start} disabled={busy}>{busy ? "Check your wallet…" : "Sign in with NEAR"}</Button>}
      </div>
      {error && <p role="alert" className="text-destructive w-full text-right text-sm">{error}</p>}
    </header>
  )
}
