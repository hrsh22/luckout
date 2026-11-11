import { Config, Context, Effect, Layer, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { Network } from "./Near.ts"

/**
 * Operator alerts and customer notices. Everything is logged; with TELEGRAM_BOT_TOKEN set,
 * admin alerts also go to ALERT_TELEGRAM_CHAT_ID and customer notices to their linked chat.
 */
export class Alerts extends Context.Service<Alerts, {
  /** Something a human must look at. The same text is sent at most once an hour. */
  admin(text: string): Effect.Effect<void>
  /** A short notice to the customer's linked Telegram chat, if any. Never Redemption Data. */
  customer(accountId: string, text: string): Effect.Effect<void>
}>()("luckout/Alerts") {
  static readonly layer = Layer.effect(
    Alerts,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const token = yield* Config.option(Config.Redacted("TELEGRAM_BOT_TOKEN"))
      const adminChat = yield* Config.option(Config.String("ALERT_TELEGRAM_CHAT_ID"))
      // Both networks may alert the same chat: every alert says which one it's about.
      const network = yield* Network

      /** True once Telegram took the message. A failure logs its HTTP status only: the URL holds the bot token. */
      const telegram = (chatId: string | number, text: string) =>
        Option.isNone(token)
          ? Effect.succeed(false)
          : Effect.tryPromise(() =>
            fetch(`https://api.telegram.org/bot${Redacted.value(token.value)}/sendMessage`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
              signal: AbortSignal.timeout(10_000)
            })
          ).pipe(
            Effect.map((res) => res.status),
            Effect.orElseSucceed(() => 0),
            Effect.flatMap((status) =>
              status >= 200 && status < 300
                ? Effect.succeed(true)
                : Effect.as(Effect.logError("alert delivery failed", status ? `HTTP ${status}` : "no response"), false)
            )
          )

      // ponytail: in-memory dedupe, resets on restart; fine for one process.
      const DEDUPE_MS = 60 * 60_000
      const lastSent = new Map<string, number>()
      const admin = (text: string) =>
        Effect.gen(function*() {
          yield* Effect.logError(`ALERT [${network}] ${text}`)
          const now = Date.now()
          for (const [t, at] of lastSent) if (at <= now - DEDUPE_MS) lastSent.delete(t)
          if (lastSent.has(text) || Option.isNone(adminChat)) return
          // Held while sending, so the same alert at the same moment isn't sent twice; only a delivered one counts.
          lastSent.set(text, now)
          if (!(yield* telegram(adminChat.value, `⚠️ Luckout [${network}]: ${text}`))) lastSent.delete(text)
        })

      const customer = (accountId: string, text: string) =>
        sql<{ chat_id: string }>`SELECT chat_id FROM telegram_links WHERE account_id = ${accountId}`.pipe(
          Effect.flatMap((rows) => (rows[0] ? telegram(rows[0].chat_id, text) : Effect.void)),
          Effect.ignore
        )

      return Alerts.of({ admin, customer })
    })
  )
}
