"use client"

import { Wordmark } from "@/components/brand"
import { Button } from "@/components/ui/button"
import { errorMessage } from "@/lib/api"
import { usd } from "@/lib/format"
import { useSession } from "@/lib/session"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"

const NAV = [
  { href: "/shop", label: "Shop" },
  { href: "/purchases", label: "Purchases" },
  { href: "/wallet", label: "Balance" }
]

export function AppHeader() {
  const { accountId, account, ready, signIn, signOut } = useSession()
  const path = usePathname()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const start = async () => {
    setError(undefined)
    setBusy(true)
    await signIn().catch((e) => setError(errorMessage(e)))
    setBusy(false)
  }

  return (
    <header className="border-border bg-background/90 sticky top-0 z-10 border-b backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-6">
          <Wordmark />
          <nav className="flex items-center gap-1 text-sm" aria-label="App">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={path === n.href ? "page" : undefined}
                className="text-muted-foreground hover:text-foreground aria-[current=page]:text-foreground aria-[current=page]:bg-secondary rounded-md px-3 py-2 font-medium"
              >
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          {accountId && account && (
            <Link href="/wallet" className="bg-receipt rounded-full border px-3 py-2 text-sm font-semibold tabular-nums" title="Your Luckout balance">
              {usd(account.balance)}
            </Link>
          )}
          {accountId
            ? (
              <Button variant="outline" onClick={() => signOut()} title={`Signed in as ${accountId}. Click to sign out.`} className="max-w-48">
                <span className="truncate">{accountId}</span>
              </Button>
            )
            : <Button onClick={start} disabled={busy || !ready}>{busy ? "Check your wallet…" : "Sign in with NEAR"}</Button>}
        </div>
      </div>
      {error && <p role="alert" className="text-destructive mx-auto max-w-6xl px-4 pb-2 text-sm sm:px-6">{error}</p>}
    </header>
  )
}
