"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api } from "@/lib/api"
import type { Voucher, VoucherSummary } from "@luckout/api"
import { useState } from "react"

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

export function Catalog() {
  const [q, setQ] = useState("swiggy")
  const [results, setResults] = useState<ReadonlyArray<VoucherSummary>>()
  const [voucher, setVoucher] = useState<Voucher>()
  const [error, setError] = useState<string>()

  const fail = (e: { message?: string }) => setError(String(e?.message ?? e))
  const search = () => {
    setError(undefined)
    setVoucher(undefined)
    api((c) => c.catalog.search({ query: { q } })).then(setResults, fail)
  }
  const open = (id: string) => {
    setError(undefined)
    api((c) => c.catalog.voucher({ params: { id } })).then(setVoucher, fail)
  }

  return (
    <section className="flex flex-col gap-4">
      <form className="flex gap-2" onSubmit={(e) => (e.preventDefault(), search())}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search vouchers" aria-label="Search vouchers" />
        <Button type="submit">Search</Button>
      </form>
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      {voucher && (
        <div className="bg-card rounded-xl border p-4">
          <p className="font-heading font-semibold">{voucher.name}</p>
          <ul className="text-muted-foreground mt-2 grid grid-cols-2 gap-1 text-sm sm:grid-cols-4">
            {voucher.packages.map((p) => (
              <li key={p.value}>{p.value} {voucher.currency} · {usd.format(p.priceMicroUsdc / 1e6)}</li>
            ))}
          </ul>
        </div>
      )}
      <ul className="grid gap-2 sm:grid-cols-2">
        {results?.map((v) => (
          <li key={v.id}>
            <button type="button" onClick={() => open(v.id)} className="bg-card hover:bg-secondary w-full rounded-xl border p-3 text-left">
              <span className="font-heading font-semibold">{v.name}</span>
              <span className="text-muted-foreground ml-2 text-sm">{v.countryCode} · {v.currency}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
