"use client"

import { Button } from "@/components/ui/button"
import { errorMessage } from "@/lib/api"
import { useCheckoutEmail, useSaveCheckoutEmail } from "@/lib/queries"
import { useSession } from "@/lib/session"
import { useEffect, useId, useState } from "react"

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
