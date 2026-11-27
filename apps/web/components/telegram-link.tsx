"use client"

import { Button, buttonVariants } from "@/components/ui/button"
import { api, errorMessage } from "@/lib/api"
import { useTelegram } from "@/lib/queries"
import { useSession } from "@/lib/session"
import { useLinkAccount, usePrivy, useUnlinkTelegram } from "@privy-io/react-auth"
import { Send } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

/**
 * Linking Telegram happens in Privy (ADR-0015): the server reads the link from Privy's identity token at sign-in, so
 * after linking or unlinking here we sign in to the server again with Privy's fresh tokens.
 */
export function TelegramLink() {
  const { token, resync } = useSession()
  const { user } = usePrivy()
  const status = useTelegram(token)
  const [busy, setBusy] = useState(false)
  const { unlink } = useUnlinkTelegram()

  const synced = async () => {
    await resync()
    return (await status.refetch()).data
  }
  const { linkTelegram } = useLinkAccount({
    onSuccess: () =>
      void synced().then(
        (s) => toast.success(`Telegram connected${s?.telegramName ? ` to ${s.telegramName}` : ""}`),
        (e) => toast.error(errorMessage(e))
      ).finally(() => setBusy(false)),
    onError: (code) => {
      setBusy(false)
      if (code === "linked_to_another_user") toast.error("That Telegram account is already linked to another Luckout account.")
      else if (code !== "exited_link_flow") toast.error(`Telegram didn't connect (${code}). Try again.`)
    }
  })

  const connect = () => {
    setBusy(true)
    linkTelegram()
  }
  const disconnect = async () => {
    setBusy(true)
    try {
      // The bot stops buying for them at once; unlinking in Privy keeps the next sign-in from linking it again.
      await api((c) => c.telegram.unlink(), token)
      const id = user?.telegram?.telegramUserId
      if (id) await unlink({ telegramUserId: id })
      await synced()
      toast.success("Telegram disconnected")
    } catch (e) {
      toast.error(errorMessage(e))
      await status.refetch()
    }
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
        ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" loading={busy} onClick={disconnect}>Disconnect</Button>
            {s.botUrl && <a href={s.botUrl} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "light" })}>Open the bot</a>}
          </div>
        )
        : <Button loading={busy} onClick={connect} disabled={!s.botUrl}>{s.botUrl ? "Connect Telegram" : "Bot offline"}</Button>}
    </div>
  )
}
