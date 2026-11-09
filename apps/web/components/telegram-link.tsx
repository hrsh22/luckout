"use client"

import { Button } from "@/components/ui/button"
import { api, errorMessage } from "@/lib/api"
import { useTelegram } from "@/lib/queries"
import { useSession } from "@/lib/session"
import { Send } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

/** Linking starts here, in the signed-in session, so only the wallet owner picks the Telegram account. */
export function TelegramLink() {
  const { token } = useSession()
  const status = useTelegram(token)
  const [busy, setBusy] = useState(false)

  const connect = async () => {
    setBusy(true)
    try {
      const { url } = await api((c) => c.telegram.linkCode(), token)
      window.open(url, "_blank", "noopener")
      toast("Finish in Telegram", { description: "Tap Start in the Luckout bot. Then come back here." })
    } catch (e) {
      toast.error(errorMessage(e))
    }
    setBusy(false)
  }
  const disconnect = async () => {
    setBusy(true)
    await api((c) => c.telegram.unlink(), token).then(() => toast.success("Telegram disconnected"), (e) => toast.error(errorMessage(e)))
    await status.refetch()
    setBusy(false)
  }

  const s = status.data
  return (
    <div className="card relative flex flex-col gap-4 overflow-hidden p-6 sm:flex-row sm:items-center">
      <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-sky-soft text-[#2B7CC4]"><Send /></span>
      <div className="min-w-0 flex-1">
        <p className="font-display text-xl font-extrabold">{s?.linked ? `Connected to ${s.telegramName}` : "Buy from Telegram"}</p>
        <p className="text-[15px] text-ink-soft">
          {s?.linked
            ? "The bot buys only when you tap Confirm, always within your limits."
            : "Ask the Luckout bot for a card. Nothing is bought until you tap Confirm, and codes arrive in your private chat."}
        </p>
      </div>
      {!s
        ? <span className="skeleton h-11 w-40 rounded-full" />
        : s.linked
        ? <Button variant="light" loading={busy} onClick={disconnect}>Disconnect</Button>
        : <Button loading={busy} onClick={connect} disabled={!s.botUrl}>{s.botUrl ? "Connect Telegram" : "Bot offline"}</Button>}
    </div>
  )
}
