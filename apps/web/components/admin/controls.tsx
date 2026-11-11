"use client"

import type { Tx } from "@/components/admin/shared"
import { Button } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { type Call, send } from "@/lib/near"
import type { AdminOverview } from "@luckout/api"
import { Pause, Play } from "lucide-react"
import { useEffect, useState } from "react"

/** NEAR account ids: lowercase parts joined by dots, 2 to 64 characters. */
const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/

/**
 * Two ways to stop new purchases: Stop sales (any admin, on the server, instant) and the contract's
 * pause (the owner's wallet, the hard stop). The pill says which, if any, is on.
 */
export function ShopControls({ salesStopped, paused, onSales, onPause, onResume }: {
  salesStopped: boolean
  paused: boolean
  onSales: (open: boolean) => Promise<void>
  onPause: () => void
  onResume: () => void
}) {
  const [busy, setBusy] = useState(false)
  const state = paused
    ? { text: "Contract paused", box: "bg-bad-soft text-bad", dot: "bg-bad" }
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
      <button type="button" className="px-2 text-sm text-muted underline-offset-4 hover:text-ink hover:underline" onClick={paused ? onResume : onPause}>
        {paused ? "Resume the contract" : "Pause the contract"} <span className="text-xs">(owner)</span>
      </button>
    </div>
  )
}

export function TransferOwnerSheet({ open, onClose, o, tx, contractCall }: {
  open: boolean
  onClose: () => void
  o: AdminOverview
  tx: Tx
  contractCall: (method: string, args: object) => Call
}) {
  const [to, setTo] = useState("")
  useEffect(() => {
    if (open) setTo("")
  }, [open])
  const account = to.trim().toLowerCase()
  const valid = NEAR_ACCOUNT.test(account) && account !== o.contract.owner
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title="Transfer ownership" description="The new owner accepts from their own wallet, here in the admin panel. Nothing changes until they do.">
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold">New owner's NEAR account</span>
          <input className="field" value={to} onChange={(e) => setTo(e.target.value)} placeholder={o.network === "mainnet" ? "name.near" : "name.testnet"} autoCapitalize="none" spellCheck={false} />
          <span className="text-xs text-muted">The operator and the treasury can never own the contract; the contract refuses them.</span>
        </label>
        <Button size="lg" disabled={!valid} onClick={async () => {
          if (await tx(`Proposing ${account}`, `${account} can now accept ownership`, (id) => send(id, contractCall("propose_owner", { new_owner: account })))) onClose()
        }}>
          Propose {valid ? account : "the new owner"}
        </Button>
      </div>
    </Sheet>
  )
}
