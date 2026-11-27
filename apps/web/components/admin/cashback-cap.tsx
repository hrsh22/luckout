// @ts-nocheck TODO(phase3-admin): NEAR admin panel, reached from nothing now (components/admin/panel.tsx is a stub); rebuild on Solana or delete.
"use client"

import type { Tx } from "@/components/admin/shared"
import { Button } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { capText, maxCashbackAt } from "@/lib/cashback-cap"
import { dollars, toMicro, typedAmount, usd } from "@/lib/format"
import { contractId, send } from "@/lib/near"
import type { AdminOverview } from "@luckout/api"
import { useEffect, useState } from "react"

type Cap = AdminOverview["reserve"]["cashbackCap"]

/** The owner sets the Cashback Cap in their wallet. An empty fixed field turns that limit off; the share is required. */
export function CashbackCapSheet({ open, onClose, o, tx }: { open: boolean; onClose: () => void; o: AdminOverview; tx: Tx }) {
  const cap = o.reserve.cashbackCap
  const [fixed, setFixed] = useState("")
  const [share, setShare] = useState("")
  useEffect(() => {
    if (!open) return
    setFixed(cap.fixed === null ? "" : dollars(cap.fixed))
    setShare(cap.reserveBps === null ? "" : String(cap.reserveBps / 100))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const next: Cap = { fixed: fixed.trim() === "" ? null : toMicro(fixed), reserveBps: share.trim() === "" ? null : Math.round(Number(share) * 100) }
  // The contract's own checks in set_cashback_cap, said before the wallet opens.
  const problem = next.fixed !== null && !(next.fixed > 0)
    ? "The fixed limit must be an amount above $0."
    : !(next.reserveBps !== null && next.reserveBps > 0 && next.reserveBps <= 5_000)
    ? "The share must be above 0% and at most 50%."
    : undefined
  return (
    <Sheet
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title="Cashback cap"
      description="The most cashback one purchase can get. Purchases already made keep theirs."
    >
      <div className="flex flex-col gap-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold">Fixed limit</span>
          <span className="relative">
            <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 font-semibold text-muted">$</span>
            <input className="field pl-8!" inputMode="decimal" placeholder="No fixed limit" value={fixed} onChange={(e) => setFixed(typedAmount(e.target.value))} />
          </span>
          <span className="text-xs text-muted">Bounds what a block producer could gain by nudging one Draw. Leave empty for none.</span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold">Share of free reserve</span>
          <span className="relative">
            <input className="field pr-9!" inputMode="decimal" placeholder="20" value={share} onChange={(e) => setShare(typedAmount(e.target.value))} />
            <span className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 font-semibold text-muted">%</span>
          </span>
          <span className="text-xs text-muted">Shrinks with the reserve after a run of luck, so it always lasts. Required, at most 50%: one purchase never takes most of the reserve.</span>
        </label>
        <p className="rounded-[1.25rem] bg-soft p-4 text-sm text-ink-soft">
          {problem ?? `With ${usd(o.reserve.free)} free, one purchase could get up to ${usd(maxCashbackAt(next, o.reserve.free))} back (now ${usd(o.reserve.maxCashback)}).`}
        </p>
        <Button size="lg" disabled={!!problem} onClick={async () => {
          const args = { fixed: next.fixed === null ? null : String(next.fixed), reserve_bps: next.reserveBps }
          if (await tx("Saving the cashback cap", `Cashback cap: ${capText(next)}`, (id) =>
            send(id, { receiverId: contractId, method: "set_cashback_cap", args, deposit: "1" }))) onClose()
        }}>
          Save
        </Button>
      </div>
    </Sheet>
  )
}
