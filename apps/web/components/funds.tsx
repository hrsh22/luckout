"use client"

// TODO(phase3-wallet): rebuild on Solana (ADR-0015): the Deposit Address after the one-time approval
// (useWalletActions().approve), a tap for USDT that has arrived, 1Click Top-Ups from other chains, and withdrawal to any
// Solana address (useWalletActions().withdraw). The NEAR version is at `git show 9313693:apps/web/components/funds.tsx`.

import { AmountField } from "@/components/amount-field"
import { Sheet } from "@/components/ui/sheet"

export { AmountField }

const SOON = "Adding and withdrawing funds is being rebuilt for Solana."

/** Add funds without leaving the page, as a sheet. */
export function AddFundsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void; need?: number }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Add funds">
      <p className="text-ink-soft">{SOON}</p>
    </Sheet>
  )
}

/** Adding funds, inline (Welcome's step); `need` is what's missing for a purchase. */
export function AddFundsPanel(_: { need?: number | undefined; onDone: (ok: boolean) => void; onContinue?: () => void }) {
  return <p className="text-ink-soft">{SOON}</p>
}

export function WithdrawSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Withdraw">
      <p className="text-ink-soft">{SOON}</p>
    </Sheet>
  )
}
