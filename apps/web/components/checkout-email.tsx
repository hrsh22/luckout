"use client"

import { Button } from "@/components/ui/button"
import { api, errorMessage } from "@/lib/api"
import { usd } from "@/lib/format"
import { useCheckoutEmail, useSaveCheckoutEmail } from "@/lib/queries"
import { useSession } from "@/lib/session"
import { BITREFILL_ACCOUNT_LIMITS, GUEST_LIMITS } from "@luckout/api/limits"
import { useQueryClient } from "@tanstack/react-query"
import { KeyRound } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { toast } from "sonner"

/**
 * The Checkout Email (ADR-0012), prefilled with the saved one. Shown only where buying needs one.
 * `onSaved` also runs when it's submitted unchanged, so "Continue" works with an email already given.
 */
/** `titled`: a heading above already names the field, so its label is for screen readers only. */
export function CheckoutEmailForm({ label = "Save", onSaved, titled = false }: { label?: string; onSaved?: () => void; titled?: boolean }) {
  const { token } = useSession()
  const current = useCheckoutEmail(token).data?.email
  const save = useSaveCheckoutEmail(token)
  const [email, setEmail] = useState(current ?? "")
  useEffect(() => setEmail(current ?? ""), [current])
  const id = useId()
  const next = email.trim()
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (next === current) onSaved?.()
        else save.mutate(next, { onSuccess: () => onSaved?.() })
      }}
    >
      <label htmlFor={id} className={titled ? "sr-only" : "font-semibold"}>Email for your cards</label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={id}
          type="email"
          required
          autoComplete="email"
          className="field flex-1"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Button type="submit" loading={save.isPending} disabled={!next}>{label}</Button>
      </div>
      {save.error
        ? <p role="alert" className="text-sm font-medium text-bad">{errorMessage(save.error)}</p>
        : <p className="text-sm text-muted">Each card and its receipt are emailed here too. A throwaway address is fine.</p>}
    </form>
  )
}

/**
 * Connect Bitrefill (ADR-0012): the customer logs in to their own Bitrefill account, and their cards are bought on
 * it, under its limits instead of a guest's. Bitrefill sends them back to /wallet?bitrefill=finish (or failed).
 */
export function BitrefillAccount() {
  const { token } = useSession()
  const qc = useQueryClient()
  const connected = useCheckoutEmail(token).data?.bitrefill === true
  const [busy, setBusy] = useState(false)

  // Back from Bitrefill with a code: it's exchanged here, in this session, so a login started from someone else's
  // account (their link) is refused by the server. Then the code leaves the address.
  const finishing = useRef(false)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const outcome = q.get("bitrefill")
    if (!outcome || (outcome === "finish" && !token) || finishing.current) return
    finishing.current = true
    window.history.replaceState(null, "", window.location.pathname)
    if (outcome !== "finish") {
      toast.error("Couldn't connect Bitrefill", { description: "Nothing changed. Try again in a moment." })
      return
    }
    setBusy(true)
    api((c) => c.purchases.finishBitrefill({ payload: { code: q.get("code") ?? "", state: q.get("state") ?? "" } }), token).then(
      (saved) => {
        qc.setQueryData(["checkout-email", token], saved)
        toast.success("Bitrefill connected", { description: "Your cards are now bought on your Bitrefill account." })
      },
      (e) => toast.error("Couldn't connect Bitrefill", { description: errorMessage(e) })
    ).finally(() => setBusy(false))
  }, [qc, token])

  const connect = async () => {
    setBusy(true)
    try {
      const { url } = await api((c) => c.purchases.connectBitrefill(), token)
      window.location.assign(url)
    } catch (e) {
      toast.error(errorMessage(e))
      setBusy(false)
    }
  }
  const disconnect = async () => {
    setBusy(true)
    await api((c) => c.purchases.disconnectBitrefill(), token).then(
      (saved) => {
        qc.setQueryData(["checkout-email", token], saved)
        toast.success("Bitrefill disconnected")
      },
      (e) => toast.error(errorMessage(e))
    )
    setBusy(false)
  }

  return (
    <div className="card flex flex-col gap-4 p-6 sm:flex-row sm:items-center">
      <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-gold-soft text-gold-ink"><KeyRound /></span>
      <div className="min-w-0 flex-1">
        <p className="font-display text-xl font-extrabold">{connected ? "Connected" : "Connect Bitrefill to raise your limits"}</p>
        <p className="text-[15px] text-ink-soft">
          {connected
            ? "Cards are bought on your Bitrefill account, under its limits. We still pay for every card."
            : "Buy under your own Bitrefill account's higher limits. We still pay for every card."}
        </p>
      </div>
      {connected
        ? <Button variant="light" loading={busy} onClick={disconnect}>Disconnect</Button>
        : <Button loading={busy} onClick={connect}>Connect Bitrefill</Button>}
    </div>
  )
}

const whole = (micro: number) => usd(micro).replace(/\.00$/, "")

function Meter({ label, used, of, text }: { label: string; used: number; of: number; text: string }) {
  const full = used >= of
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[15px] text-ink-soft">{label}</span>
        <span className={`text-[15px] font-semibold tabular-nums ${full ? "text-bad" : ""}`}>{text}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-soft" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={of} aria-valuenow={Math.min(used, of)} aria-valuetext={text}>
        <div className={`h-full rounded-full transition-[width] duration-500 ${full ? "bg-bad" : "bg-ink"}`} style={{ width: `${Math.min(100, (used / of) * 100)}%` }} />
      </div>
    </div>
  )
}

/**
 * Bitrefill's own purchase limits (ADR-0012). A guest's count per Checkout Email, and the server refuses a card that
 * would pass them, so the same counts are shown here. A connected account has Bitrefill's account limits instead;
 * Bitrefill has no API for an account's level, so both levels are shown.
 */
export function BitrefillLimits() {
  const { token } = useSession()
  const checkout = useCheckoutEmail(token).data
  const used = checkout?.used
  if (used) {
    return (
      <div className="card flex flex-col gap-5 p-6">
        <div>
          <p className="font-display text-xl font-extrabold">Bitrefill's limits for your email</p>
          <p className="text-[15px] text-ink-soft">A card that would go over is stopped before you pay.</p>
        </div>
        <div className="grid gap-5 sm:grid-cols-3">
          <Meter label="Cards, last 24 hours" used={used.orders} of={GUEST_LIMITS.orders} text={`${used.orders} of ${GUEST_LIMITS.orders}`} />
          <Meter label="Spent, last 24 hours" used={used.day} of={GUEST_LIMITS.daily} text={`${usd(used.day)} of ${whole(GUEST_LIMITS.daily)}`} />
          <Meter label="Spent, last 30 days" used={used.month} of={GUEST_LIMITS.monthly} text={`${usd(used.month)} of ${whole(GUEST_LIMITS.monthly)}`} />
        </div>
        <p className="text-sm text-muted">Cards you buy on Bitrefill itself with this email count too.</p>
      </div>
    )
  }
  if (!checkout?.bitrefill) return null
  const levels = [
    { name: "Basic account", note: "Until you verify your identity", ...BITREFILL_ACCOUNT_LIMITS.basic },
    { name: "Verified account", note: "After Bitrefill checks your ID", ...BITREFILL_ACCOUNT_LIMITS.verified }
  ]
  return (
    <div className="card flex flex-col gap-5 p-6">
      <div>
        <p className="font-display text-xl font-extrabold">Your Bitrefill account's limits</p>
        <p className="text-[15px] text-ink-soft">Bitrefill doesn't share your account's level, so both are shown.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {levels.map((l) => (
          <div key={l.name} className="rounded-2xl bg-soft p-4">
            <p className="font-semibold">{l.name}</p>
            <p className="text-sm text-muted">{l.note}</p>
            <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-[15px] tabular-nums">
              <dt className="text-ink-soft">Cards a day</dt><dd className="text-right font-semibold">{l.orders}</dd>
              <dt className="text-ink-soft">One card</dt><dd className="text-right font-semibold">{whole(l.perCard)}</dd>
              <dt className="text-ink-soft">A day</dt><dd className="text-right font-semibold">{whole(l.daily)}</dd>
              <dt className="text-ink-soft">A month</dt><dd className="text-right font-semibold">{whole(l.monthly)}</dd>
            </dl>
          </div>
        ))}
      </div>
      <p className="text-sm text-muted">
        <a className="underline underline-offset-2" href="https://www.bitrefill.com/account/verification" target="_blank" rel="noreferrer">Verify your account</a> on Bitrefill to move up.
      </p>
    </div>
  )
}
