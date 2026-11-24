"use client"

import { type Check, plainly, verify } from "@/lib/draw"
import { loadDraw } from "@/lib/proof"
import { useEffect, useState } from "react"

/** Fetches the Draw from NEAR RPC in this browser and recomputes every step, without our server. `purchase` picks the Draw when the transaction settled a cart. */
export function BrowserCheck({ tx, purchase }: { tx: string; purchase: number }) {
  const [checks, setChecks] = useState<Array<Check>>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    loadDraw(tx, purchase)
      .then((d) => verify(d.draw, d.version))
      .then(setChecks, (e) => setError(String(e?.message ?? e)))
  }, [tx, purchase])

  if (error) return <p role="alert" className="font-medium text-bad">Couldn't recompute this Draw: {error}</p>
  if (!checks) return <p className="skeleton rounded-2xl p-4 text-ink-soft" aria-live="polite">Fetching the transaction from NEAR and recomputing it in your browser…</p>

  const ok = checks.every((c) => c.ok)
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <p className={`flex items-center gap-2 rounded-2xl p-4 text-lg font-semibold ${ok ? "bg-good-soft text-good" : "bg-bad-soft text-bad"}`}>
        {ok ? "✓ Recomputed in your browser: everything matches." : "✗ Mismatch: this Draw does not recompute."}
      </p>
      {/* Fixed columns that fit a 390px phone: long values (the 64-hex random value) shorten in place, with the whole
          value on hover, so both sides and the match mark stay in sight without scrolling sideways. */}
      <div className="card overflow-hidden">
        <table className="w-full table-fixed text-sm">
          <thead className="border-b border-line text-left text-muted">
            <tr>
              <th scope="col" className="w-[28%] p-3 font-medium sm:p-4">Step</th>
              <th scope="col" className="p-3 font-medium sm:p-4">The contract logged</th>
              <th scope="col" className="p-3 font-medium sm:p-4">Your browser got</th>
              <th scope="col" className="w-10 p-3 sm:w-14 sm:p-4"><span className="sr-only">Match</span></th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => (
              <tr key={c.label} className="border-b border-line align-top last:border-0">
                <td className="p-3 sm:p-4">{c.label}</td>
                {[c.expected, c.recomputed].map((v, i) => (
                  <td key={i} className="p-3 tabular-nums sm:p-4" title={v}>
                    <span className="block truncate">{v}</span>
                    {c.unit && <span className="block text-muted">{plainly(v, c.unit)}</span>}
                  </td>
                ))}
                <td className="p-3 sm:p-4">{c.ok ? "✓" : "✗"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
