"use client"

import { shortAccount } from "@/components/avatar"
import { ValueSheet } from "@/components/admin/controls"
import { ago } from "@/components/admin/shared"
import { Button } from "@/components/ui/button"
import { api, errorMessage } from "@/lib/api"
import { explorer } from "@/lib/chain"
import { usd } from "@/lib/format"
import { useSession } from "@/lib/session"
import type { UndeliveredCard } from "@luckout/api"
import { useQueryClient } from "@tanstack/react-query"
import { Check, ExternalLink } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

const RUNBOOK = "https://github.com/hrsh22/luckout/blob/main/deploy/RUNBOOK.md#a-card-bitrefill-didnt-deliver"

const Tx = ({ sig, children }: { sig: string; children: string }) => (
  <a href={explorer(sig)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">
    {children}<ExternalLink size={12} aria-hidden="true" />
  </a>
)

const customerRefund = (c: UndeliveredCard) =>
  c.refund === "paid"
    ? "refunded at once"
    : c.refund === "pending"
    ? `${usd(c.refundPending ?? 0)} still owed from the Pay Wallet`
    : `${usd(c.refundPending ?? 0)} paid later from the Pay Wallet`

/**
 * Cards we paid Bitrefill for that it didn't deliver (ADR-0016), one invoice each: what claiming Bitrefill's refund to the
 * Pay Wallet needs (deploy/RUNBOOK.md), where each customer's refund is, and the mark for when Bitrefill's arrives.
 */
export function UndeliveredList({ cards }: { cards: ReadonlyArray<UndeliveredCard> }) {
  const { token } = useSession()
  const qc = useQueryClient()
  const [marking, setMarking] = useState<UndeliveredCard>()
  const invoices = [...Map.groupBy(cards, (c) => c.checkoutId).values()]
  return (
    <div className="card flex flex-col gap-5 p-7">
      <div>
        <p className="font-semibold">Paid, not delivered</p>
        <p className="mt-1 text-sm text-muted">
          Invoices we paid where Bitrefill didn't deliver a card. Claim each refund to the Pay Wallet (<a href={RUNBOOK} target="_blank" rel="noreferrer" className="underline underline-offset-2">how</a>), then mark it received here.
        </p>
      </div>
      {invoices.length === 0
        ? (
          <p className="flex items-center gap-3 rounded-[1.5rem] bg-good-soft p-5 font-medium text-good">
            <Check size={20} aria-hidden="true" />Bitrefill delivered every card we paid for.
          </p>
        )
        : (
          <ul className="flex flex-col gap-3">
            {invoices.map((group) => {
              const c = group[0]!
              const owed = group.reduce((s, x) => s + x.amount, 0)
              return (
                <li key={c.checkoutId} className="flex flex-col gap-3 rounded-[1.5rem] bg-soft p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 font-semibold">
                        Invoice {c.invoiceId}
                        <span className={`pill ${c.claimed ? "bg-good-soft! text-good" : "bg-warn-soft! text-warn"}`}>
                          {c.claimed ? "Refund received" : `Bitrefill owes ${usd(owed)}`}
                        </span>
                      </p>
                      <p className="mt-1 text-sm text-muted">
                        {shortAccount(c.accountId)} · paid {c.paidAt ? ago(c.paidAt) : ""} · <Tx sig={c.payTx}>payment</Tx> · {c.advance > 0 ? `${usd(c.advance)} advanced` : "no advance"}
                      </p>
                    </div>
                    {c.claimed
                      ? <p className="text-sm text-muted">Marked by {shortAccount(c.claimed.by)} {ago(c.claimed.at)} · <Tx sig={c.claimed.tx}>refund</Tx></p>
                      : <Button size="sm" variant="light" onClick={() => setMarking(c)}>Mark Bitrefill's refund received</Button>}
                  </div>
                  <ul className="flex flex-col gap-1 text-sm text-ink-soft">
                    {group.map((x) => (
                      <li key={x.purchaseId}>
                        {x.voucherName} {x.value}, {usd(x.amount)}: customer {customerRefund(x)}
                        {x.refundTx && <> · <Tx sig={x.refundTx}>transaction</Tx></>}
                      </li>
                    ))}
                  </ul>
                </li>
              )
            })}
          </ul>
        )}
      <ValueSheet
        kind="signature"
        open={!!marking}
        onClose={() => setMarking(undefined)}
        title="Bitrefill's refund received"
        description={`Paste the transaction that brought Bitrefill's refund for invoice ${marking?.invoiceId ?? ""} to the Pay Wallet. This only records it: no money moves.`}
        label="Transaction signature"
        save={() => "Mark it received"}
        onSave={async (tx) => {
          try {
            await api((c) => c.admin.claimed({ params: { id: marking!.checkoutId }, payload: { tx } }), token)
            toast.success(`Invoice ${marking!.invoiceId}: Bitrefill's refund marked received`)
            await qc.invalidateQueries({ queryKey: ["admin"] })
            return true
          } catch (e) {
            toast.error(errorMessage(e))
            return false
          }
        }}
      />
    </div>
  )
}
