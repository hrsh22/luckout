"use client"

import type { Owner } from "@/components/admin/owner"
import { AmountField } from "@/components/amount-field"
import { Button } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { toMicro, usd } from "@/lib/format"
import { useEffect, useState } from "react"

export function FundReserveSheet({ open, onClose, owner }: { open: boolean; onClose: () => void; owner: Owner }) {
  const [amount, setAmount] = useState("100")
  const micro = toMicro(amount)
  return (
    <Sheet
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title="Fund the reserve"
      description="USDC from the owner's wallet backs every cashback. It can be withdrawn whenever it isn't locked."
    >
      <div className="flex flex-col gap-5">
        <AmountField
          label="Amount to add in USDC"
          value={amount}
          onChange={setAmount}
          picks={[{ label: "$100", micro: 100_000_000 }, { label: "$500", micro: 500_000_000 }, { label: "$1,000", micro: 1_000_000_000 }]}
        />
        <p className="text-sm text-muted">It comes from the owner's own USDC account, which must hold it.</p>
        <Button size="lg" disabled={!(micro > 0)} onClick={async () => {
          if (await owner.sign({ _tag: "fund_reserve", amount: micro }, `Adding ${usd(micro)} to the reserve`, `${usd(micro)} added to the reserve`)) onClose()
        }}>
          Add {micro > 0 ? usd(micro) : ""}
        </Button>
      </div>
    </Sheet>
  )
}

/** Where a withdrawal can go: the first is the default, and more than one are offered as a choice. */
export interface Destination<T extends string> {
  readonly id: T
  readonly label: string
}

export function WithdrawSheet<T extends string>({ open, onClose, title, available, to, preview, onWithdraw }: {
  open: boolean
  onClose: () => void
  title: string
  available: number
  to: ReadonlyArray<Destination<T>>
  preview: (micro: number) => string
  onWithdraw: (micro: number, to: T) => Promise<boolean>
}) {
  const [amount, setAmount] = useState("")
  const [dest, setDest] = useState(to[0]!.id)
  const micro = toMicro(amount)
  useEffect(() => {
    if (!open) return
    setAmount("")
    setDest(to[0]!.id)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const ok = micro > 0 && micro <= available
  const label = to.find((d) => d.id === dest)?.label
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title={title} description={`${usd(available)} available.`}>
      <div className="flex flex-col gap-5">
        <AmountField
          label="Amount to withdraw in USDC"
          value={amount}
          onChange={setAmount}
          picks={[{ label: "Half", micro: Math.floor(available / 2) }, { label: `All ${usd(available)}`, micro: available }]}
        />
        {to.length > 1 && (
          <div role="radiogroup" aria-label="Send it to" className="flex flex-wrap gap-2">
            {to.map((d) => (
              <button key={d.id} type="button" role="radio" aria-checked={dest === d.id} onClick={() => setDest(d.id)}
                className={`pill transition-colors ${dest === d.id ? "bg-ink! text-white" : "bg-soft! text-muted hover:text-ink"}`}>
                {d.label}
              </button>
            ))}
          </div>
        )}
        {ok && <p className="rounded-[1.25rem] bg-soft p-4 text-sm text-ink-soft">It goes to {label}. {preview(micro)}</p>}
        <Button size="lg" disabled={!ok} onClick={async () => (await onWithdraw(micro, dest)) && onClose()}>
          {micro > available ? `Only ${usd(available)} available` : `Withdraw ${micro > 0 ? usd(micro) : ""}`}
        </Button>
      </div>
    </Sheet>
  )
}
