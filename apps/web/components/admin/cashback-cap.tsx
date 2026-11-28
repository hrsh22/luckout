"use client"

import type { Owner } from "@/components/admin/owner"
import { Button } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { capText, maxCashbackAt } from "@/lib/cashback-cap"
import { dollars, toMicro, typedAmount, usd } from "@/lib/format"
import type { AdminOverview } from "@luckout/api"
import { useEffect, useState } from "react"

/** The owner sets the Cashback Cap in their wallet. An empty fixed field turns that limit off; the share is required. */
export function CashbackCapSheet({ open, onClose, o, owner }: { open: boolean; onClose: () => void; o: AdminOverview; owner: Owner }) {
  const cap = o.reserve.cashbackCap
  const [fixed, setFixed] = useState("")
  const [share, setShare] = useState("")
  useEffect(() => {
    if (!open) return
    setFixed(cap.fixed === null ? "" : dollars(cap.fixed))
    setShare(String(cap.reserveBps / 100))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const next = { fixed: fixed.trim() === "" ? null : toMicro(fixed), reserveBps: Math.round(Number(share) * 100) }
  // The program's own checks in set_cashback_cap, said before the wallet opens.
  const problem = next.fixed !== null && !(next.fixed > 0)
    ? "The fixed limit must be an amount above $0."
    : !(share.trim() !== "" && next.reserveBps > 0 && next.reserveBps <= 5_000)
    ? "The share must be above 0% and at most 50%."
    : undefined
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title="Cashback cap" description="The most cashback one card can get. Cards already admitted keep theirs.">
      <div className="flex flex-col gap-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold">Fixed limit</span>
          <span className="relative">
            <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 font-semibold text-muted">$</span>
            <input className="field pl-8!" inputMode="decimal" placeholder="No fixed limit" value={fixed} onChange={(e) => setFixed(typedAmount(e.target.value))} />
          </span>
          <span className="text-xs text-muted">Limits what one Draw is worth to anyone able to withhold its randomness. Leave empty for none.</span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold">Share of free reserve</span>
          <span className="relative">
            <input className="field pr-9!" inputMode="decimal" placeholder="20" value={share} onChange={(e) => setShare(typedAmount(e.target.value))} />
            <span className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 font-semibold text-muted">%</span>
          </span>
          <span className="text-xs text-muted">Shrinks with the reserve after a run of luck, so it always lasts. Required, at most 50%: one card never takes most of the reserve.</span>
        </label>
        <p className="rounded-[1.25rem] bg-soft p-4 text-sm text-ink-soft">
          {problem ?? `With ${usd(o.reserve.free)} free, one card could get up to ${usd(maxCashbackAt(next, o.reserve.free))} back (now ${usd(o.reserve.maxCashback)}).`}
        </p>
        <Button size="lg" disabled={!!problem} onClick={async () => {
          if (await owner.sign({ _tag: "set_cashback_cap", ...next }, "Saving the cashback cap", `Cashback cap: ${capText(next)}`)) onClose()
        }}>
          Save
        </Button>
      </div>
    </Sheet>
  )
}
