"use client"

import { usd } from "@/lib/format"
import { contractId, view } from "@/lib/near"
import { useEffect, useState } from "react"

interface Stats { lucky_settled: number; lucky_amount_total: string; lucky_paid_total: string }
interface Reserve { free: string; locked: string; discount_cap: string }

export default function Fair() {
  const [stats, setStats] = useState<Stats>()
  const [reserve, setReserve] = useState<Reserve>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    Promise.all([view<Stats>(contractId, "get_stats"), view<Reserve>(contractId, "get_reserve")])
      .then(([s, r]) => (setStats(s), setReserve(r)), (e) => setError(String(e?.message ?? e)))
  }, [])

  // Live Average: what lucky buyers paid per 100 of price, across every settled Lucky Buy.
  const avg = stats && Number(stats.lucky_amount_total) > 0
    ? (Number(stats.lucky_paid_total) / Number(stats.lucky_amount_total)) * 100
    : undefined

  return (
    <main className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-heading text-3xl font-bold">Is it fair?</h1>
        <p className="text-muted-foreground">
          Every lucky mode is built to average 106% of the price: that 6% is Luckout's only revenue. Here is what lucky buyers have
          actually paid so far, read live from the contract.
        </p>
      </div>
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}

      <section className="bg-card grid gap-6 rounded-xl border p-6 sm:grid-cols-2">
        <div>
          <p className="text-muted-foreground text-sm">Live Average</p>
          <p className="font-heading text-5xl font-bold tabular-nums">{avg === undefined ? "—" : `${avg.toFixed(1)}%`}</p>
          <p className="text-muted-foreground text-sm">of the price, over {stats?.lucky_settled ?? "…"} settled Lucky Buys</p>
        </div>
        <div>
          <p className="text-muted-foreground text-sm">Promised</p>
          <p className="font-heading text-5xl font-bold tabular-nums">106.0%</p>
          <p className="text-muted-foreground text-sm">in the long run, for every mode and every size</p>
        </div>
      </section>
      <p className="text-muted-foreground text-sm">
        Over a few dozen draws the average swings a lot; over thousands it settles near 106%. Every single Draw links to a Draw
        Proof you can recompute in your browser.
      </p>

      {reserve && (
        <section className="flex flex-col gap-2">
          <h2 className="font-heading text-lg font-semibold">Refund Reserve</h2>
          <p className="text-muted-foreground text-sm">
            {usd(reserve.free)} free and {usd(reserve.locked)} locked for purchases in progress. Each Lucky Buy locks its largest possible
            discount before it starts, so every refund is already covered. The biggest discount one purchase can win right now is{" "}
            {usd(reserve.discount_cap)}.
          </p>
        </section>
      )}
      <p className="text-muted-foreground text-xs">Contract {contractId}</p>
    </main>
  )
}
