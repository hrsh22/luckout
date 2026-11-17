"use client"

import { type AsOwner, basescan, eth, TONE, type Tx } from "@/components/admin/shared"
import { AmountField } from "@/components/funds"
import { Money } from "@/components/money"
import { Button } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { contractId, view } from "@/lib/chain"
import { dollars, toMicro, typedAmount, usd } from "@/lib/format"
import { type Call, explorerAccount, send } from "@/lib/near"
import { ourAccounts, treasuryMode } from "@/lib/treasury"
import type { AdminOverview } from "@luckout/api"
import { useQuery } from "@tanstack/react-query"
import { CircleAlert, Landmark } from "lucide-react"
import { useEffect, useState } from "react"

/** The treasury this site was built for: the only account the owner is ever asked to name with set_treasury. */
const OUR_TREASURY = ourAccounts(contractId)?.treasury

export function TreasuryCard({ o, asOwner, tx }: { o: AdminOverview; asOwner: AsOwner; tx: Tx }) {
  const t = o.treasury
  const mode = treasuryMode(t, OUR_TREASURY)
  const [sheet, setSheet] = useState<"mode" | "move">()
  const pill = {
    none: { text: "Not set up", tone: TONE.muted },
    unknown: { text: "Unknown", tone: TONE.bad },
    "server-differs": { text: "Check the server", tone: TONE.bad },
    mismatch: { text: "Points elsewhere", tone: TONE.bad },
    auto: { text: "Automatic", tone: TONE.good },
    manual: { text: "Manual", tone: TONE.warn }
  }[mode]
  return (
    <div className="card flex flex-col gap-5 p-7">
      <div className="flex items-start justify-between gap-3">
        <p className="flex items-center gap-2 text-ink-soft"><Landmark size={18} aria-hidden="true" />Treasury</p>
        <span className={`pill ${pill.tone}`}>{pill.text}</span>
      </div>
      <div>
        <p className="font-display text-4xl font-extrabold tracking-[-0.02em]"><Money micro={t.usdc} /> <span className="text-lg font-bold text-muted">USDC</span></p>
        {t.accountId && (
          <a href={explorerAccount(t.accountId)} target="_blank" rel="noreferrer" className="text-sm text-muted underline-offset-2 hover:underline">{t.accountId}</a>
        )}
      </div>
      {t.wallet && <BaseWallet w={t.wallet} float={o.credit.settings.baseFloat ?? 0} guest={o.checkout.guest} />}
      <p className="text-[15px] text-ink-soft">
        {mode === "none"
          ? "The server has no treasury key yet, so refills can't be paid."
          : mode === "unknown"
          ? `This site can't tell which treasury it is built for (its contract, ${contractId}, isn't named app.<name>), so the owner's treasury actions are off.`
          : mode === "server-differs"
          ? `The server signs refills as ${t.accountId}, but this site is built for ${OUR_TREASURY}: check TREASURY_ACCOUNT_ID in the server's environment. Change mode only ever names ${OUR_TREASURY}, so switching to manual still works.`
          : mode === "mismatch"
          ? `The contract lets ${t.contractTreasury ?? "no one"} pull proceeds, not ${OUR_TREASURY}, which the server signs as. Point the contract at it.`
          : mode === "auto"
          ? `Pulls only what each refill needs from the proceeds, up to ${usd(t.dailyCap)} a day. ${usd(t.sweptToday)} pulled today.`
          : "Refills wait for you to move proceeds in. You'll be told how much, here and in alerts."}
      </p>
      {t.needs !== undefined && t.needs > 0 && (
        <p className="flex items-start gap-2 rounded-[1.25rem] bg-warn-soft p-4 text-sm text-warn">
          <CircleAlert size={18} className="mt-0.5 shrink-0" aria-hidden="true" />A refill is waiting for {usd(t.needs)} in the treasury.
        </p>
      )}
      <div className="mt-auto flex flex-wrap gap-2">
        <Button size="sm" variant={mode === "mismatch" ? "primary" : "soft"} disabled={!OUR_TREASURY} onClick={asOwner(() => setSheet("mode"))}>
          {mode === "mismatch" ? "Fix it" : "Change mode"}
        </Button>
        <Button size="sm" variant={t.needs ? "primary" : "soft"} disabled={(mode !== "auto" && mode !== "manual") || !o.reserve.proceeds} onClick={asOwner(() => setSheet("move"))}>
          Move proceeds here
        </Button>
      </div>
      {OUR_TREASURY && (
        <>
          <TreasuryModeSheet open={sheet === "mode"} onClose={() => setSheet(undefined)} treasury={OUR_TREASURY} mode={mode} tx={tx} />
          <MoveProceedsSheet open={sheet === "move"} onClose={() => setSheet(undefined)} o={o} treasury={OUR_TREASURY} tx={tx} />
        </>
      )}
    </div>
  )
}

/**
 * Our wallet on Base: refills swap into it, then pay Bitrefill from it; with guest checkout (ADR-0012) its USDC is the
 * Base Float, which pays each card's invoice. It has no key of its own; the treasury signs for it through NEAR Chain
 * Signatures, so whoever controls the treasury controls it.
 */
function BaseWallet({ w, float, guest }: { w: NonNullable<AdminOverview["treasury"]["wallet"]>; float: number; guest: boolean }) {
  const low = BigInt(w.eth) < BigInt(w.alertBelow)
  return (
    <div className="rounded-[1.25rem] bg-soft p-4 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold">Base wallet</span>
        <a href={basescan(`address/${w.address}`)} target="_blank" rel="noreferrer" className="font-mono text-xs text-muted underline-offset-2 hover:underline">
          {w.address.slice(0, 6)}…{w.address.slice(-4)}
        </a>
      </div>
      <p className="mt-1 text-ink-soft">
        <Money micro={w.usdc} /> USDC {guest ? "in the Base Float" : float > 0 ? <>ready, of a <Money micro={float} /> float</> : "waiting"} · {eth(w.eth)} ETH for gas
      </p>
      {guest
        ? <p className="mt-1 text-xs text-muted">Pays each card's Bitrefill invoice; refills top it up from the treasury.</p>
        : float > 0 && (
        <p className="mt-1 text-xs text-muted">Refills pay Bitrefill from this in about a minute; it's topped back up by itself once under half.</p>
      )}
      {low && (
        <p className="mt-2 flex items-start gap-2 text-warn">
          <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />Low on gas: send about $1 of ETH on Base to {w.address}, or {guest ? "cards can't be paid" : "refills stop"}.
        </p>
      )}
    </div>
  )
}

/** `treasury` is the one this site was built for (OUR_TREASURY), never an account the server reports. */
function TreasuryModeSheet({ open, onClose, treasury, mode, tx }: { open: boolean; onClose: () => void; treasury: string; mode: ReturnType<typeof treasuryMode>; tx: Tx }) {
  const [auto, setAuto] = useState(true)
  const [cap, setCap] = useState("")
  // The cap starts from what the contract allows now, read from NEAR here, not from a number the server suggests.
  const live = useQuery({
    queryKey: ["contract-config", contractId],
    queryFn: () => view<{ sweep_daily_cap?: string }>(contractId, "get_config"),
    // Only the cap: get_config's other fields change on a refetch, and that mustn't overwrite what the owner typed.
    select: (c) => c.sweep_daily_cap ?? "0",
    enabled: open,
    staleTime: 0
  })
  useEffect(() => {
    if (!open) return
    setAuto(mode !== "manual")
    setCap("")
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open || !live.data) return
    const now = Number(live.data)
    // Manual (0) or unread: the field starts empty and the owner types the cap.
    setCap(now > 0 ? dollars(now) : "")
  }, [open, live.data])
  const capMicro = toMicro(cap)
  const call = (daily: number): Call => ({
    receiverId: contractId,
    method: "set_treasury",
    args: { treasury, daily_cap: String(daily) },
    deposit: "1"
  })
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title="Treasury mode" description={`The contract will let ${treasury} pull proceeds, and nothing else.`}>
      <div className="flex flex-col gap-4">
        {[
          { value: true, title: "Automatic", body: "Refills pull exactly what they need from the proceeds, up to a daily cap. No taps." },
          { value: false, title: "Manual", body: "Nothing is pulled. When a refill needs money you move proceeds in yourself, with one approval." }
        ].map((m) => (
          <button
            key={m.title}
            type="button"
            role="radio"
            aria-checked={auto === m.value}
            onClick={() => setAuto(m.value)}
            className="rounded-[1.5rem] p-5 text-left shadow-[inset_0_0_0_1.5px_var(--color-line)] transition-shadow aria-checked:shadow-[inset_0_0_0_2.5px_var(--color-ink)]"
          >
            <p className="font-semibold">{m.title}</p>
            <p className="mt-1 text-sm text-ink-soft">{m.body}</p>
          </button>
        ))}
        {auto && (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold">Most it may pull in a day</span>
            <span className="relative">
              <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 font-semibold text-muted">$</span>
              <input className="field pl-8!" inputMode="decimal" value={cap} onChange={(e) => setCap(typedAmount(e.target.value))} />
            </span>
            <span className="text-xs text-muted">If the server were ever compromised, this is the most proceeds it could take in a day.</span>
          </label>
        )}
        <Button size="lg" disabled={auto && !(capMicro > 0)} onClick={async () => {
          const daily = auto ? capMicro : 0
          if (await tx("Saving the treasury mode", auto ? `Automatic, up to ${usd(daily)} a day` : "Manual: proceeds move only when you sign", (id) => send(id, call(daily)))) onClose()
        }}>
          {auto ? `Allow up to ${capMicro > 0 ? usd(capMicro) : "…"} a day` : "Switch to manual"}
        </Button>
      </div>
    </Sheet>
  )
}

function MoveProceedsSheet({ open, onClose, o, treasury, tx }: { open: boolean; onClose: () => void; o: AdminOverview; treasury: string; tx: Tx }) {
  const t = o.treasury
  const available = o.reserve.proceeds
  const suggested = Math.min(available, t.needs && t.needs > 0 ? t.needs : o.credit.target)
  const [amount, setAmount] = useState("")
  useEffect(() => {
    if (open) setAmount(dollars(suggested))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const micro = toMicro(amount)
  const ok = micro > 0 && micro <= available
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title="Move proceeds to the treasury" description={`${usd(available)} of proceeds. The contract sends it only to its treasury, ${treasury}.`}>
      <div className="flex flex-col gap-5">
        <AmountField
          label="Amount to move in USDC"
          value={amount}
          onChange={setAmount}
          picks={[
            ...(t.needs && t.needs > 0 ? [{ label: `What's needed ${usd(t.needs)}`, micro: t.needs }] : []),
            { label: `A target's worth ${usd(o.credit.target)}`, micro: Math.min(available, o.credit.target) }
          ]}
        />
        <Button size="lg" disabled={!ok} onClick={async () => {
          if (await tx(`Moving ${usd(micro)} to the treasury`, `${usd(micro)} moved to the treasury`, (id) =>
            send(id, { receiverId: contractId, method: "withdraw_proceeds", args: { amount: String(micro), to_treasury: true }, deposit: "1", tgas: 60 }))) onClose()
        }}>
          {micro > available ? `Only ${usd(available)} available` : `Move ${micro > 0 ? usd(micro) : ""}`}
        </Button>
      </div>
    </Sheet>
  )
}
