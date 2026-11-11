"use client"

import { shortAccount } from "@/components/avatar"
import { ago } from "@/components/admin/shared"
import { Button, buttonVariants } from "@/components/ui/button"
import { api, errorMessage } from "@/lib/api"
import { useSession } from "@/lib/session"
import type { AdminOverview, AttentionPurchase } from "@luckout/api"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowUpRight, Check, RotateCw } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

const RUNBOOK = "https://github.com/hrsh22/luckout/blob/main/deploy/RUNBOOK.md#a-purchase-is-stuck"

export function PurchasesCard({ p }: { p: AdminOverview["purchases"] }) {
  return (
    <div className="card flex flex-col gap-6 p-7">
      <div>
        <h2 className="font-display text-3xl font-extrabold">Purchases</h2>
        <p className="mt-1 text-ink-soft">Last 24 hours: {p.today} started, {p.deliveredToday} delivered.</p>
      </div>
      {p.attention.length === 0
        ? (
          <p className="flex items-center gap-3 rounded-[1.5rem] bg-good-soft p-5 font-medium text-good">
            <Check size={20} aria-hidden="true" />Nothing needs attention.
          </p>
        )
        : (
          <ul className="flex flex-col gap-3">
            {p.attention.map((a) => <AttentionRow key={a.id} a={a} />)}
          </ul>
        )}
    </div>
  )
}

function AttentionRow({ a }: { a: AttentionPurchase }) {
  const { token } = useSession()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const retry = async () => {
    setBusy(true)
    try {
      await api((c) => c.admin.retry({ params: { id: a.id } }), token)
      toast.success("Queued: the next pass runs within a minute")
      await qc.invalidateQueries({ queryKey: ["admin"] })
    } catch (e) {
      toast.error(errorMessage(e))
    }
    setBusy(false)
  }
  return (
    <li className="flex flex-col gap-3 rounded-[1.5rem] bg-soft p-5 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 font-semibold">
          {a.voucherName} {a.value}
          <span className={`pill ${a.step === "stuck" ? "bg-bad-soft! text-bad" : "bg-warn-soft! text-warn"}`}>{a.step}</span>
        </p>
        <p className="mt-1 text-sm text-muted">{shortAccount(a.accountId)} · {ago(a.createdAt)} · {a.attempts} attempts</p>
        {a.error && <p className="mt-2 line-clamp-3 text-sm text-ink-soft">{a.error}</p>}
      </div>
      {a.retryable
        ? <Button size="sm" variant="light" loading={busy} onClick={retry}><RotateCw />Retry now</Button>
        : (
          <a href={RUNBOOK} target="_blank" rel="noreferrer" className={buttonVariants({ size: "sm", variant: "light" })}>
            Manual check<ArrowUpRight />
          </a>
        )}
    </li>
  )
}
