"use client"

import { type Check, verify } from "@/lib/draw"
import { loadDraw } from "@/lib/proof"
import { useEffect, useState } from "react"

/** Fetches the Draw from NEAR RPC in this browser and recomputes every step, without our server. */
export function BrowserCheck({ tx }: { tx: string }) {
  const [checks, setChecks] = useState<Array<Check>>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    loadDraw(tx)
      .then((d) => verify(d.draw, d.version))
      .then(setChecks, (e) => setError(String(e?.message ?? e)))
  }, [tx])

  if (error) return <p role="alert" className="text-destructive">Couldn't recompute this Draw: {error}</p>
  if (!checks) return <p className="text-muted-foreground" aria-live="polite">Fetching the transaction from NEAR and recomputing it in your browser…</p>

  const ok = checks.every((c) => c.ok)
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <p className={`text-lg font-semibold ${ok ? "" : "text-destructive"}`}>
        {ok ? "✓ Recomputed in your browser: everything matches." : "✗ Mismatch: this Draw does not recompute."}
      </p>
      <div className="overflow-x-auto rounded-xl border">
        <table className="bg-receipt w-full text-sm">
          <thead className="text-muted-foreground border-b text-left">
            <tr>
              <th scope="col" className="p-3 font-medium">Step</th>
              <th scope="col" className="p-3 font-medium">The contract logged</th>
              <th scope="col" className="p-3 font-medium">Your browser got</th>
              <th scope="col" className="p-3"><span className="sr-only">Match</span></th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => (
              <tr key={c.label} className="border-b last:border-0">
                <td className="p-3">{c.label}</td>
                <td className="max-w-40 truncate p-3 tabular-nums" title={c.expected}>{c.expected}</td>
                <td className="max-w-40 truncate p-3 tabular-nums" title={c.recomputed}>{c.recomputed}</td>
                <td className="p-3">{c.ok ? "✓" : "✗"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
