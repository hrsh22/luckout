"use client"

import { type Check, plainly, verify } from "@/lib/draw"
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

  if (error) return <p role="alert" className="font-medium text-bad">Couldn't recompute this Draw: {error}</p>
  if (!checks) return <p className="skeleton rounded-2xl p-4 text-ink-soft" aria-live="polite">Fetching the transaction from NEAR and recomputing it in your browser…</p>

  const ok = checks.every((c) => c.ok)
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <p className={`flex items-center gap-2 rounded-2xl p-4 text-lg font-semibold ${ok ? "bg-good-soft text-good" : "bg-bad-soft text-bad"}`}>
        {ok ? "✓ Recomputed in your browser: everything matches." : "✗ Mismatch: this Draw does not recompute."}
      </p>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line text-left text-muted">
            <tr>
              <th scope="col" className="p-4 font-medium">Step</th>
              <th scope="col" className="p-4 font-medium">The contract logged</th>
              <th scope="col" className="p-4 font-medium">Your browser got</th>
              <th scope="col" className="p-4"><span className="sr-only">Match</span></th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => (
              <tr key={c.label} className="border-b border-line last:border-0">
                <td className="p-4">{c.label}</td>
                <td className="max-w-40 truncate p-4 tabular-nums" title={c.expected}>
                  {c.expected}
                  {c.unit && <span className="block text-muted">{plainly(c.expected, c.unit)}</span>}
                </td>
                <td className="max-w-40 truncate p-4 tabular-nums" title={c.recomputed}>
                  {c.recomputed}
                  {c.unit && <span className="block text-muted">{plainly(c.recomputed, c.unit)}</span>}
                </td>
                <td className="p-4">{c.ok ? "✓" : "✗"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
