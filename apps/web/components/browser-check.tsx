"use client"

import { type Check, plainly, proofChecks } from "@/lib/draw"
import type { CardDrawProof } from "@luckout/api"
import { useEffect, useState } from "react"

/** Recomputes every step of one card's Draw in this browser, from the Checkout's address to the Cashback. */
export function BrowserCheck({ draw }: { draw: CardDrawProof }) {
  const [checks, setChecks] = useState<Array<Check>>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    proofChecks(draw).then(setChecks, (e) => setError(String(e?.message ?? e)))
  }, [draw])

  if (error) return <p role="alert" className="font-medium text-bad">Couldn't recompute this Draw: {error}</p>
  if (!checks) return <p className="skeleton rounded-2xl p-4 text-ink-soft" aria-live="polite">Recomputing it in your browser…</p>

  const ok = checks.every((c) => c.ok)
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <p className={`flex items-center gap-2 rounded-2xl p-4 text-lg font-semibold ${ok ? "bg-good-soft text-good" : "bg-bad-soft text-bad"}`}>
        {ok ? "✓ Recomputed in your browser: everything matches." : "✗ Mismatch: this Draw does not recompute."}
      </p>
      {/* Fixed columns that fit a 390px phone: long values (seeds, addresses, randomness) shorten in place, with the
          whole value on hover, so both sides and the match mark stay in sight without scrolling sideways. */}
      <div className="card overflow-hidden">
        <table className="w-full table-fixed text-sm">
          <thead className="border-b border-line text-left text-muted">
            <tr>
              <th scope="col" className="w-[28%] p-3 font-medium sm:p-4">Step</th>
              <th scope="col" className="p-3 font-medium sm:p-4">The program recorded</th>
              <th scope="col" className="p-3 font-medium sm:p-4">Your browser got</th>
              <th scope="col" className="w-10 p-3 sm:w-14 sm:p-4"><span className="sr-only">Match</span></th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => (
              <tr key={c.label} className="border-b border-line align-top last:border-0">
                <td className="p-3 wrap-anywhere sm:p-4">{c.label}</td>
                {/* The cell clips, so nothing spills into the next column: the raw value shortens, its plain reading wraps. */}
                {[c.expected, c.recomputed].map((v, i) => (
                  <td key={i} className="overflow-hidden p-3 tabular-nums sm:p-4" title={v}>
                    <span className="block truncate">{v}</span>
                    {c.unit && <span className="block text-muted wrap-anywhere">{plainly(v, c.unit)}</span>}
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
