"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api } from "@/lib/api"
import type { Voucher } from "@luckout/api"
import { useState } from "react"

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

export function Catalog() {
  const [q, setQ] = useState("swiggy")
  const [vouchers, setVouchers] = useState<ReadonlyArray<Voucher>>()
  const [error, setError] = useState<string>()

  const search = () => {
    setError(undefined)
    api((c) => c.catalog.search({ query: { q } })).then(setVouchers, (e) => setError(String(e?.message ?? e)))
  }

  return (
    <section className="flex flex-col gap-4">
      <form className="flex gap-2" onSubmit={(e) => (e.preventDefault(), search())}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search vouchers" aria-label="Search vouchers" />
        <Button type="submit">Search</Button>
      </form>
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      <ul className="grid gap-3 sm:grid-cols-2">
        {vouchers?.map((v) => (
          <li key={v.id} className="bg-card rounded-xl border p-4">
            <p className="font-heading font-semibold">{v.name}</p>
            <p className="text-muted-foreground text-sm">
              {v.packages.slice(0, 4).map((p) => `${p.value} ${v.currency} · ${usd.format(p.priceMicroUsdc / 1e6)}`).join("  —  ")}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}
