"use client"

import { PurchaseCard } from "@/components/purchase-card"
import { Button } from "@/components/ui/button"
import { api, errorMessage } from "@/lib/api"
import { useSession } from "@/lib/session"
import type { Purchase } from "@luckout/api"
import Link from "next/link"
import { useEffect, useState } from "react"

export default function Purchases() {
  const { accountId, token, ready, signIn } = useSession()
  return (
    <main className="flex flex-col gap-6">
      <h1 className="font-display text-4xl">Purchases</h1>
      {ready && !token
        ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-muted-foreground">Sign in to see your purchases and their codes.</p>
            <Button onClick={() => signIn().catch(() => {})}>Sign in with NEAR</Button>
          </div>
        )
        : token && <List key={accountId} token={token} />}
    </main>
  )
}

function List({ token }: { token: string }) {
  const [list, setList] = useState<ReadonlyArray<Purchase>>()
  const [error, setError] = useState<string>()
  const pending = list?.some((p) => p.status === "pending")

  useEffect(() => {
    api((c) => c.purchases.list(), token).then(setList, (e) => setError(errorMessage(e)))
  }, [token])

  // Purchases still in progress update on their own.
  useEffect(() => {
    if (!pending) return
    const t = setTimeout(() => api((c) => c.purchases.list(), token).then(setList, () => {}), 5000)
    return () => clearTimeout(t)
  }, [list, pending, token])

  if (error) return <p role="alert" className="text-destructive">{error}</p>
  if (!list) return <div className="flex flex-col gap-3">{[0, 1].map((i) => <div key={i} className="bg-secondary h-36 animate-pulse rounded-xl" />)}</div>
  if (list.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-muted-foreground">No purchases yet. Your cards and their codes will be listed here.</p>
        <Link href="/shop" className="underline underline-offset-4">Find a card</Link>
      </div>
    )
  }
  return <div className="grid gap-3 md:grid-cols-2">{list.map((p) => <PurchaseCard key={p.id} p={p} />)}</div>
}
