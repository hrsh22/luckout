"use client"

import { Button } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { toMicro, typedAmount } from "@/lib/format"
import { isAddress, isSignature } from "@solana/kit"
import { Pause, Play } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"

/**
 * Two ways to stop new purchases: Stop sales (any admin, on the server, instant) and the program's
 * pause (the owner's wallet, the hard stop). The pill says which, if any, is on. Without `onPause` and
 * `onResume` (the overview didn't load, so who owns the program isn't known) only Stop sales is offered.
 */
export function ShopControls({ salesStopped, paused, onSales, onPause, onResume }: {
  salesStopped: boolean
  paused: boolean
  onSales: (open: boolean) => Promise<void>
  onPause?: (() => void) | undefined
  onResume?: (() => void) | undefined
}) {
  const [busy, setBusy] = useState(false)
  const state = paused
    ? { text: "Program paused", box: "bg-bad-soft text-bad", dot: "bg-bad" }
    : salesStopped
    ? { text: "Sales stopped", box: "bg-warn-soft text-warn", dot: "bg-warn" }
    : { text: "Shop open", box: "bg-good-soft text-good", dot: "bg-good" }
  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <div className={`flex items-center gap-3 rounded-full p-1.5 pl-5 ${state.box}`}>
        <span className="relative flex size-2.5" aria-hidden="true">
          {!paused && !salesStopped && <span className="absolute inline-flex size-full animate-ping rounded-full bg-good opacity-50" />}
          <span className={`relative inline-flex size-2.5 rounded-full ${state.dot}`} />
        </span>
        <span className="font-semibold">{state.text}</span>
        <Button size="sm" variant="light" loading={busy} onClick={async () => {
          setBusy(true)
          await onSales(salesStopped)
          setBusy(false)
        }}>
          {salesStopped ? <><Play />Restart sales</> : <><Pause />Stop sales</>}
        </Button>
      </div>
      {onPause && onResume && (
        <button type="button" className="px-2 text-sm text-muted underline-offset-4 hover:text-ink hover:underline" onClick={paused ? onResume : onPause}>
          {paused ? "Resume the program" : "Pause the program"} <span className="text-xs">(owner)</span>
        </button>
      )}
    </div>
  )
}

/**
 * One owner setting: a USDC amount or a Solana address. It says what saving does before the wallet opens, and
 * `problem` refuses what the program would refuse.
 */
export function ValueSheet({ open, onClose, title, description, label, kind, initial = "", problem, save, onSave }: {
  open: boolean
  onClose: () => void
  title: string
  description: ReactNode
  label: string
  kind: "amount" | "address" | "signature"
  initial?: string
  problem?: (value: string) => string | undefined
  /** The button's text for a valid value. */
  save: (value: string) => string
  /** Gets the value as typed (an amount still in dollars); true closes the sheet. */
  onSave: (value: string) => Promise<boolean>
}) {
  const [value, setValue] = useState(initial)
  useEffect(() => {
    if (open) setValue(initial)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const v = value.trim()
  const wrong = v === ""
    ? "Fill it in first"
    : kind === "amount" && !(toMicro(v) >= 0)
    ? "That isn't an amount"
    : kind === "address" && !isAddress(v)
    ? "That isn't a Solana address"
    : kind === "signature" && !isSignature(v)
    ? "That isn't a transaction signature"
    : problem?.(v)
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()} title={title} description={description}>
      <div className="flex flex-col gap-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold">{label}</span>
          {kind === "amount"
            ? (
              <span className="relative">
                <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 font-semibold text-muted">$</span>
                <input className="field pl-8!" inputMode="decimal" value={value} onChange={(e) => setValue(typedAmount(e.target.value))} />
              </span>
            )
            : <input className="field font-mono text-sm!" value={value} onChange={(e) => setValue(e.target.value)} autoCapitalize="none" spellCheck={false} />}
        </label>
        <Button size="lg" disabled={!!wrong} onClick={async () => (await onSave(v)) && onClose()}>{wrong ?? save(v)}</Button>
      </div>
    </Sheet>
  )
}
