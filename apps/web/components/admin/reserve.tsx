"use client"

import type { Tx } from "@/components/admin/shared"
import { AmountField } from "@/components/funds"
import { Button } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { faucetCall } from "@/lib/actions"
import { toMicro, usd } from "@/lib/format"
import { type Call, contractId, send, usdcId } from "@/lib/near"
import { useSession } from "@/lib/session"
import type { AdminOverview } from "@luckout/api"
import { useEffect, useState } from "react"

export function FundReserveSheet({ open, onClose, o, tx }: { open: boolean; onClose: () => void; o: AdminOverview; tx: Tx }) {
  const { walletUsdc } = useSession()
  const [amount, setAmount] = useState("100")
  const micro = toMicro(amount)
  const inWallet = Number(walletUsdc ?? 0)
  const fund = (m: number): Call => ({ receiverId: usdcId, method: "ft_transfer_call", args: { receiver_id: contractId, amount: String(m), msg: "reserve" }, deposit: "1", tgas: 100 })
  const go = async (f: (id: string) => Promise<unknown>, pending: string, done: string) => {
    if (await tx(pending, done, f)) onClose()
  }
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title="Fund the reserve" description="USDC from your wallet backs every cashback. It can be withdrawn whenever it isn't locked.">
      <div className="flex flex-col gap-5">
        {o.network === "testnet" && (
          <div className="flex flex-col gap-3 rounded-[1.5rem] bg-gold-soft p-5 text-gold-ink">
            <p className="text-[15px]">Testnet: mint 100 test USDC and add it in one approval.</p>
            <Button variant="gold" onClick={() => go((id) => send(id, faucetCall, fund(100_000_000)), "Adding 100 test USDC to the reserve", "$100.00 added to the reserve")}>
              Add 100 test USDC
            </Button>
          </div>
        )}
        <AmountField
          label="Amount to add in USDC"
          value={amount}
          onChange={setAmount}
          picks={[
            { label: "$100", micro: 100_000_000 },
            { label: "$500", micro: 500_000_000 },
            { label: "$1,000", micro: 1_000_000_000 },
            ...(inWallet > 0 ? [{ label: "All of it", micro: inWallet }] : [])
          ]}
        />
        <p className="text-sm text-muted">Your wallet has {usd(inWallet)} USDC.</p>
        <Button size="lg" disabled={!(micro > 0) || micro > inWallet} onClick={() => go((id) => send(id, fund(micro)), `Adding ${usd(micro)} to the reserve`, `${usd(micro)} added to the reserve`)}>
          {micro > inWallet ? "More than your wallet holds" : `Add ${micro > 0 ? usd(micro) : ""}`}
        </Button>
      </div>
    </Sheet>
  )
}

export function WithdrawSheet({ open, onClose, title, available, to, preview, onWithdraw }: {
  open: boolean
  onClose: () => void
  title: string
  available: number
  to: string
  preview: (micro: number) => string
  onWithdraw: (micro: number) => Promise<boolean>
}) {
  const [amount, setAmount] = useState("")
  const micro = toMicro(amount)
  useEffect(() => {
    if (open) setAmount("")
  }, [open])
  const ok = micro > 0 && micro <= available
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title={title} description={`${usd(available)} available. It goes to ${to}.`}>
      <div className="flex flex-col gap-5">
        <AmountField
          label="Amount to withdraw in USDC"
          value={amount}
          onChange={setAmount}
          picks={[{ label: "Half", micro: Math.floor(available / 2) }, { label: `All ${usd(available)}`, micro: available }]}
        />
        {ok && <p className="rounded-[1.25rem] bg-soft p-4 text-sm text-ink-soft">{preview(micro)}</p>}
        <Button size="lg" disabled={!ok} onClick={async () => (await onWithdraw(micro)) && onClose()}>
          {micro > available ? `Only ${usd(available)} available` : `Withdraw ${micro > 0 ? usd(micro) : ""}`}
        </Button>
      </div>
    </Sheet>
  )
}
