"use client"

import { Button } from "@/components/ui/button"
import { api, errorMessage } from "@/lib/api"
import { useCheckoutEmail, useSaveCheckoutEmail } from "@/lib/queries"
import { useSession } from "@/lib/session"
import { useQueryClient } from "@tanstack/react-query"
import { KeyRound } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { toast } from "sonner"

/**
 * The Checkout Email (ADR-0012), prefilled with the saved one. Shown only where buying needs one.
 * `onSaved` also runs when it's submitted unchanged, so "Continue" works with an email already given.
 */
export function CheckoutEmailForm({ label = "Save", onSaved }: { label?: string; onSaved?: () => void }) {
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
      <label htmlFor={id} className="font-semibold">Email for your cards</label>
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
        : <p className="text-sm text-muted">Bitrefill sends each card's receipt here, and uses it to help if a code doesn't work. A throwaway address is fine.</p>}
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
            ? "Your cards are bought on your own Bitrefill account, under its limits, and it gets their receipts. We still pay for every card."
            : "As a guest, Bitrefill limits what one email can buy. Log in with your own Bitrefill account to buy under its limits instead. We still pay for every card."}
        </p>
      </div>
      {connected
        ? <Button variant="light" loading={busy} onClick={disconnect}>Disconnect</Button>
        : <Button loading={busy} onClick={connect}>Connect Bitrefill</Button>}
    </div>
  )
}
