"use client"

import { type Check, type DrawEvent, type GameVersion, verify } from "@/lib/draw"
import { usd } from "@/lib/format"
import { contractId, explorer } from "@/lib/near"
import { loadDraw } from "@/lib/proof"
import { useEffect, useState } from "react"

export function DrawProof({ tx }: { tx: string }) {
  const [data, setData] = useState<{ draw: DrawEvent; version: GameVersion; time: Date; checks: Array<Check> }>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    loadDraw(tx)
      .then(async (d) => setData({ ...d, checks: await verify(d.draw, d.version) }))
      .catch((e) => setError(String(e?.message ?? e)))
  }, [tx])

  if (error) return <main><h1 className="font-heading text-3xl font-bold">Draw Proof</h1><p role="alert" className="text-destructive mt-4">{error}</p></main>
  if (!data) return <main className="text-muted-foreground">Reading the Draw from the chain…</main>

  const { draw, version, time, checks } = data
  const ref = Number(draw.reference_price)
  const paid = Number(draw.final_price)
  const allOk = checks.every((c) => c.ok)

  return (
    <main className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-heading text-3xl font-bold">Draw Proof</h1>
        <p className="text-muted-foreground text-sm">
          Purchase #{draw.purchase_id} by {draw.customer} on {version.name} (+{version.premium_bps / 100}%), {time.toLocaleString()}.
        </p>
      </div>

      <section className="bg-card grid gap-4 rounded-xl border p-4 sm:grid-cols-4">
        <Stat label="Price" value={usd(ref)} />
        <Stat label="Most they could pay" value={usd(draw.max_price)} />
        <Stat label="Paid" value={usd(paid)} strong />
        <Stat label={paid < ref ? "Below the price" : paid > ref ? "Above the price" : "Difference"} value={usd(Math.abs(paid - ref))} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-heading text-lg font-semibold">
          {allOk ? "✓ Recomputed in your browser: everything matches" : "✗ Mismatch: this Draw does not recompute"}
        </h2>
        <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-sm">
          <li>The block's random seed: <code className="break-all">{draw.seed}</code></li>
          <li>Random value = sha256(seed ‖ purchase id #{draw.purchase_id}), so draws in the same block are independent.</li>
          <li>Roll = the first 8 bytes of the random value, modulo 10,000.</li>
          <li>The roll picks a row of the {version.name} table below; the Final Price is that share of the price, rounded up, never above the most they could pay.</li>
        </ol>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-secondary text-left">
              <tr><th className="p-2">Step</th><th className="p-2">Contract logged</th><th className="p-2">Your browser got</th><th className="p-2" /></tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.label} className="border-t">
                  <td className="p-2">{c.label}</td>
                  <td className="max-w-40 truncate p-2 font-mono" title={c.expected}>{c.expected}</td>
                  <td className="max-w-40 truncate p-2 font-mono" title={c.recomputed}>{c.recomputed}</td>
                  <td className="p-2">{c.ok ? "✓" : "✗"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-heading text-lg font-semibold">The {version.name} table</h2>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-secondary text-left"><tr><th className="p-2">Rolls</th><th className="p-2">Chance</th><th className="p-2">Pays</th></tr></thead>
            <tbody>
              {version.outcomes.map((o, i) => {
                const from = version.outcomes.slice(0, i).reduce((s, x) => s + x.chance_bps, 0)
                const hit = draw.roll >= from && draw.roll < from + o.chance_bps
                return (
                  <tr key={i} className={`border-t ${hit ? "bg-accent text-accent-foreground font-semibold" : ""}`}>
                    <td className="p-2 tabular-nums">{from}–{from + o.chance_bps - 1}</td>
                    <td className="p-2">{o.chance_bps / 100}%</td>
                    <td className="p-2">{o.final_bps / 100}% of the price{hit ? ` ← roll ${draw.roll}` : ""}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="text-muted-foreground text-xs">
          Game Versions are immutable and every table averages exactly 106%. A block producer can bias the seed slightly;
          the Discount Cap and Spending Limits bound what that could ever be worth.
        </p>
      </section>

      <p className="text-muted-foreground flex flex-wrap gap-x-4 text-xs">
        <a className="underline" href={explorer(tx)} target="_blank" rel="noreferrer">Transaction on NEAR</a>
        <span>Contract {contractId}</span>
      </p>
    </main>
  )
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className={`font-heading tabular-nums ${strong ? "text-2xl font-bold" : "text-xl"}`}>{value}</p>
    </div>
  )
}
