"use client"

import { Button } from "@/components/ui/button"
import { api, errorMessage } from "@/lib/api"
import { useSession } from "@/lib/session"
import { useCallback, useEffect, useState } from "react"

/** Linking starts here, in the signed-in session, so only the wallet owner picks the Telegram account. */
export function TelegramLink() {
  const { token } = useSession()
  const [status, setStatus] = useState<{ readonly linked: boolean; readonly telegramName?: string | undefined; readonly botUrl?: string | undefined }>()
  const [error, setError] = useState<string>()

  const load = useCallback(() => {
    if (token) api((c) => c.telegram.status(), token).then(setStatus, (e) => setError(errorMessage(e)))
  }, [token])
  useEffect(load, [load])

  const connect = async () => {
    setError(undefined)
    try {
      const { url } = await api((c) => c.telegram.linkCode(), token)
      window.open(url, "_blank", "noopener")
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  const disconnect = async () => {
    await api((c) => c.telegram.unlink(), token).catch((e) => setError(errorMessage(e)))
    load()
  }

  if (!status) return null
  return (
    <div className="flex flex-col items-start gap-2 text-sm">
      {status.linked
        ? (
          <>
            <p className="text-muted-foreground">
              Connected to {status.telegramName}. The bot buys only when you tap Confirm, always within your Spending Limits.
            </p>
            <Button variant="outline" onClick={disconnect}>Disconnect Telegram</Button>
          </>
        )
        : (
          <>
            <p className="text-muted-foreground">Buy by chatting with the Luckout bot. Codes arrive in your private chat.</p>
            <Button variant="outline" onClick={connect} disabled={!status.botUrl}>
              {status.botUrl ? "Connect Telegram" : "Telegram bot offline"}
            </Button>
          </>
        )}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  )
}
