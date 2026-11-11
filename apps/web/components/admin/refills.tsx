"use client"

import { shortAccount } from "@/components/avatar"
import { ago, basescan, TONE } from "@/components/admin/shared"
import { Button } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { api, errorMessage } from "@/lib/api"
import { usd } from "@/lib/format"
import { explorer } from "@/lib/near"
import { useSession } from "@/lib/session"
import type { RefillView } from "@luckout/api"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowUpRight } from "lucide-react"
import { motion } from "motion/react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

const STEP: Record<string, { label: string; tone: "good" | "warn" | "bad" | "muted" | "busy" }> = {
  invoice: { label: "Asking Bitrefill", tone: "busy" },
  quote: { label: "Getting a quote", tone: "busy" },
  fund: { label: "Funding the treasury", tone: "warn" },
  send: { label: "Sending to NEAR Intents", tone: "busy" },
  swapping: { label: "Swapping into our Base wallet", tone: "busy" },
  pay: { label: "Paying Bitrefill", tone: "busy" },
  crediting: { label: "Waiting for Bitrefill", tone: "busy" },
  done: { label: "Credited", tone: "good" },
  refunded: { label: "Refunded to the treasury", tone: "warn" },
  failed: { label: "Didn't go ahead", tone: "muted" },
  stuck: { label: "Needs a look", tone: "bad" },
  resolved: { label: "Resolved", tone: "muted" }
}

export function RefillsCard({ refills }: { refills: ReadonlyArray<RefillView> }) {
  const [resolving, setResolving] = useState<RefillView>()
  return (
    <div className="card flex flex-col gap-4 p-7">
      <h3 className="font-display text-2xl font-extrabold">Refills</h3>
      <ul className="flex flex-col divide-y divide-line">
        {refills.map((r) => {
          // A float top-up ends with the USDC in our wallet, not as Bitrefill credit.
          const step = r.reason === "float" && r.step === "done"
            ? { label: "In our Base wallet", tone: "good" as const }
            : STEP[r.step] ?? { label: r.step, tone: "muted" as const }
          return (
            <li key={r.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-semibold">
                  {usd(r.amount)}
                  <span className={`pill ${TONE[step.tone]}`}>
                    {step.tone === "busy" && <motion.span className="size-1.5 rounded-full bg-current" animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.2, repeat: Infinity }} />}
                    {step.label}
                  </span>
                  <span className="text-sm font-normal text-muted">{r.reason === "waiting" ? "for a waiting order" : r.reason === "manual" ? "by hand" : r.reason === "float" ? "to top up the Base float" : "to the target"} · {ago(r.createdAt)}</span>
                </p>
                {r.error && <p className="mt-1 line-clamp-2 text-sm text-ink-soft">{r.error}</p>}
              </div>
              <div className="flex shrink-0 gap-2">
                {r.sendTx && (
                  <a href={explorer(r.sendTx)} target="_blank" rel="noreferrer" title="The treasury's USDC into the swap" className="inline-flex items-center gap-1 text-sm font-semibold text-ink-soft hover:text-ink">
                    Deposit<ArrowUpRight size={14} />
                  </a>
                )}
                {r.swap && (
                  <a href={`https://explorer.near-intents.org/transactions/${r.swap}`} target="_blank" rel="noreferrer" title="The swap at NEAR Intents" className="inline-flex items-center gap-1 text-sm font-semibold text-ink-soft hover:text-ink">
                    Swap<ArrowUpRight size={14} />
                  </a>
                )}
                {r.payTx && (
                  <a href={basescan(`tx/${r.payTx}`)} target="_blank" rel="noreferrer" title={`Our Base wallet paying Bitrefill's invoice ${r.invoiceId ?? ""}`} className="inline-flex items-center gap-1 text-sm font-semibold text-ink-soft hover:text-ink">
                    Bitrefill payment<ArrowUpRight size={14} />
                  </a>
                )}
                {r.step === "stuck" && <Button size="sm" variant="light" onClick={() => setResolving(r)}>Mark resolved</Button>}
              </div>
            </li>
          )
        })}
      </ul>
      <ResolveSheet refill={resolving} onClose={() => setResolving(undefined)} />
    </div>
  )
}

function ResolveSheet({ refill, onClose }: { refill: RefillView | undefined; onClose: () => void }) {
  const { token } = useSession()
  const qc = useQueryClient()
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => setNote(""), [refill])
  return (
    <Sheet
      open={refill !== undefined}
      onOpenChange={(v) => !v && onClose()}
      title="Resolve this refill"
      description={refill ? `${usd(refill.amount)}, ${shortAccount(refill.id)}. Check 1Click's status and Bitrefill's credit first: automatic refills start again once it's resolved.` : undefined}
    >
      <div className="flex flex-col gap-4">
        {refill?.error && <p className="rounded-[1.25rem] bg-soft p-4 text-sm text-ink-soft">{refill.error}</p>}
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold">What you found</span>
          <textarea className="field min-h-24 py-3" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Bitrefill credited it by hand after support ticket 1234" />
        </label>
        <Button size="lg" loading={busy} disabled={note.trim().length < 3} onClick={async () => {
          if (!refill) return
          setBusy(true)
          try {
            await api((c) => c.admin.resolveRefill({ params: { id: refill.id }, payload: { note: note.trim() } }), token)
            toast.success("Resolved; automatic refills can run again")
            await qc.invalidateQueries({ queryKey: ["admin"] })
            onClose()
          } catch (e) {
            toast.error(errorMessage(e))
          }
          setBusy(false)
        }}>
          Mark resolved
        </Button>
      </div>
    </Sheet>
  )
}
