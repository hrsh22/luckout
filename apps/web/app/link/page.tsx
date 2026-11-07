"use client"

import { Button } from "@/components/ui/button"
import { api, errorMessage } from "@/lib/api"
import { useSession } from "@/lib/session"
import { useSearchParams } from "next/navigation"
import { Suspense, useState } from "react"

function Link() {
  const code = useSearchParams().get("code") ?? ""
  const { accountId, token, signIn } = useSession()
  const [linked, setLinked] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const link = async () => {
    setBusy(true)
    setError(undefined)
    try {
      if (!token) await signIn()
      const t = token ?? JSON.parse(localStorage.getItem("luckout.session") ?? "{}").token
      const r = await api((c) => c.telegram.link({ payload: { code } }), t)
      setLinked(r.telegramName)
    } catch (e) {
      setError(errorMessage(e))
    }
    setBusy(false)
  }

  if (!code) return <p className="text-muted-foreground">Open this page from the link the Luckout bot sent you.</p>
  if (linked) {
    return (
      <p className="text-lg">
        Telegram {linked} is now linked to {accountId}. Go back to the chat and ask for a gift card.
      </p>
    )
  }
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-muted-foreground">
        This lets the Luckout bot buy for {accountId ?? "your NEAR account"}, always within the Spending Limits you set, which the
        contract enforces. Voucher codes are sent to you privately in the chat.
      </p>
      <Button onClick={link} disabled={busy}>{busy ? "Check your wallet…" : token ? "Link Telegram" : "Sign in and link Telegram"}</Button>
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
    </div>
  )
}

export default function Page() {
  return (
    <main className="flex flex-col gap-4">
      <h1 className="font-heading text-3xl font-bold">Link Telegram</h1>
      <Suspense>
        <Link />
      </Suspense>
    </main>
  )
}
