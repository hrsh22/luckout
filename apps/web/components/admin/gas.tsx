"use client"

import { shortAccount } from "@/components/avatar"
import { Bar, basescan, eth, type Tx } from "@/components/admin/shared"
import { Button } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { explorerAccount, network, sendNear } from "@/lib/near"
import { useSession } from "@/lib/session"
import type { AdminOverview } from "@luckout/api"
import { Fuel, Plus } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

const YOCTO = 10n ** 24n
/** yoctoNEAR → "1.25" */
const nearAmount = (yocto: string | bigint) => {
  const n = Number(BigInt(yocto) / 10n ** 18n) / 1e6
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 3 : 2 })
}
/** "1.5" NEAR → yoctoNEAR, without floating point. */
const toYocto = (s: string) => {
  const m = /^(\d+)(?:\.(\d{0,24}))?$/.exec(s.trim())
  return m ? BigInt(m[1]!) * YOCTO + BigInt((m[2] ?? "").padEnd(24, "0")) : undefined
}

const GAS_COPY = {
  operator: { label: "Operator", purpose: "Sends every purchase and delivery." },
  treasury: { label: "Treasury", purpose: "Signs Bitrefill refills; holds only the USDC they need." },
  relayer: { label: "Relayer", purpose: "Pays customers' fees for deposits, withdrawals and settings." },
  contract: { label: "Contract storage", purpose: "Each purchase stores a record; storage is paid in NEAR." }
} as const

export function GasTile({ g, onSend }: { g: AdminOverview["gas"][number]; onSend: () => void }) {
  const low = BigInt(g.spendable) < BigInt(g.alertBelow)
  // The bar is full at four times the alert line, so the line sits at a quarter.
  const fill = Number((BigInt(g.spendable) * 1000n) / (BigInt(g.alertBelow) * 4n)) / 1000
  return (
    <div className="card flex flex-col p-6">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 font-semibold"><Fuel size={18} className="text-muted" aria-hidden="true" />{GAS_COPY[g.role].label}</p>
        <span className={`pill ${low ? "bg-warn-soft! text-warn" : "bg-good-soft! text-good"}`}>{low ? "Low" : "OK"}</span>
      </div>
      <p className="mt-1 text-sm text-muted">{GAS_COPY[g.role].purpose}</p>
      <p className="font-display mt-5 text-4xl font-extrabold tracking-[-0.02em]">
        {nearAmount(g.spendable)} <span className="text-lg font-bold text-muted">NEAR</span>
      </p>
      <div className="relative mt-3">
        <Bar value={fill} tone={low ? "warn" : "good"} />
        <span className="absolute top-[-3px] left-1/4 h-3.5 w-0.5 rounded-full bg-ink/30" aria-hidden="true" />
      </div>
      <p className="mt-2 text-xs text-muted">
        Alert under {nearAmount(g.alertBelow)} NEAR ·{" "}
        <a href={explorerAccount(g.accountId)} target="_blank" rel="noreferrer" className="underline underline-offset-2">{shortAccount(g.accountId)}</a>
      </p>
      <Button size="sm" variant={low ? "primary" : "soft"} className="mt-5 self-start" onClick={onSend}><Plus />Send NEAR</Button>
    </div>
  )
}

/**
 * The Base wallet's ETH, which pays for every Bitrefill payment on Base. It has no NEAR key to send
 * to from here: top it up by sending ETH on Base to its address from any wallet or exchange.
 */
export function BaseGasTile({ w }: { w: NonNullable<AdminOverview["treasury"]["wallet"]> }) {
  const low = BigInt(w.eth) < BigInt(w.alertBelow)
  const fill = Number((BigInt(w.eth) * 1000n) / (BigInt(w.alertBelow) * 4n)) / 1000
  return (
    <div className="card flex flex-col p-6">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 font-semibold"><Fuel size={18} className="text-muted" aria-hidden="true" />Base wallet</p>
        <span className={`pill ${low ? "bg-warn-soft! text-warn" : "bg-good-soft! text-good"}`}>{low ? "Low" : "OK"}</span>
      </div>
      <p className="mt-1 text-sm text-muted">Pays Bitrefill on Base, a fraction of a cent each. Signed by the treasury.</p>
      <p className="font-display mt-5 text-4xl font-extrabold tracking-[-0.02em]">
        {eth(w.eth)} <span className="text-lg font-bold text-muted">ETH</span>
      </p>
      <div className="relative mt-3">
        <Bar value={fill} tone={low ? "warn" : "good"} />
        <span className="absolute top-[-3px] left-1/4 h-3.5 w-0.5 rounded-full bg-ink/30" aria-hidden="true" />
      </div>
      <p className="mt-2 text-xs text-muted">
        Alert under {eth(w.alertBelow)} ETH ·{" "}
        <a href={basescan(`address/${w.address}`)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          {w.address.slice(0, 6)}…{w.address.slice(-4)}
        </a>
      </p>
      <Button
        size="sm"
        variant={low ? "primary" : "soft"}
        className="mt-5 self-start"
        onClick={() => navigator.clipboard.writeText(w.address).then(() => toast.success("Address copied: send ETH on Base to it"), () => toast.error("Couldn't copy"))}
      >
        Copy address
      </Button>
    </div>
  )
}

export function SendNearSheet({ target, onClose, tx }: { target: AdminOverview["gas"][number] | undefined; onClose: () => void; tx: Tx }) {
  const { walletNear } = useSession()
  const [amount, setAmount] = useState("1")
  useEffect(() => {
    if (target) setAmount("1")
  }, [target])
  const yocto = toYocto(amount)
  const inWallet = BigInt(walletNear ?? 0)
  const ok = yocto !== undefined && yocto > 0n && yocto < inWallet
  return (
    <Sheet
      open={target !== undefined}
      onOpenChange={(v) => !v && onClose()}
      title={target ? `Send NEAR to the ${GAS_COPY[target.role].label.toLowerCase()}` : "Send NEAR"}
      description={target ? `To ${target.accountId}, which has ${nearAmount(target.spendable)} NEAR.` : undefined}
    >
      <div className="flex flex-col gap-5">
        <label className="relative block">
          <span className="sr-only">NEAR to send</span>
          <input className="field font-display h-16! rounded-[1.25rem]! pr-20! text-3xl! font-extrabold!" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} />
          <span className="font-display pointer-events-none absolute top-1/2 right-5 -translate-y-1/2 text-xl font-extrabold text-muted">NEAR</span>
        </label>
        <div className="flex flex-wrap gap-2">
          {["0.5", "1", "2", "5"].map((v) => (
            <button key={v} type="button" onClick={() => setAmount(v)} aria-pressed={amount === v}
              className="h-9 rounded-full bg-soft px-4 text-sm font-semibold transition-colors hover:bg-[#ebe9f3] aria-pressed:bg-ink aria-pressed:text-white">
              {v} NEAR
            </button>
          ))}
        </div>
        <p className="text-sm text-muted">
          Your wallet has {nearAmount(inWallet)} NEAR{network === "testnet" ? " (testnet NEAR is free from the faucet)" : ""}.
        </p>
        <Button size="lg" disabled={!ok || !target} onClick={async () => {
          if (!target || yocto === undefined) return
          if (await tx(`Sending ${amount} NEAR`, `${amount} NEAR sent to ${shortAccount(target.accountId)}`, (id) => sendNear(id, target.accountId, String(yocto)))) onClose()
        }}>
          {yocto !== undefined && yocto >= inWallet ? "More than your wallet holds" : `Send ${ok ? amount : ""} NEAR`}
        </Button>
      </div>
    </Sheet>
  )
}
