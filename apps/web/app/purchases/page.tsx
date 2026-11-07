"use client"

import { PurchaseCard } from "@/components/purchase-card"
import { api, errorMessage } from "@/lib/api"
import { useSession } from "@/lib/session"
import type { Purchase } from "@luckout/api"
import { useEffect, useState } from "react"

export default function Purchases() {
  const { token } = useSession()
  const [list, setList] = useState<ReadonlyArray<Purchase>>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (token) api((c) => c.purchases.list(), token).then(setList, (e) => setError(errorMessage(e)))
  }, [token])

  return (
    <main className="flex flex-col gap-4">
      <h1 className="font-heading text-3xl font-bold">Purchases</h1>
      {!token && <p className="text-muted-foreground">Sign in to see your purchases.</p>}
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      {list?.length === 0 && <p className="text-muted-foreground">No purchases yet.</p>}
      {list?.map((p) => <PurchaseCard key={p.id} p={p} />)}
    </main>
  )
}
