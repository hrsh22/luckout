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

      const telegram = (chatId: string | number, text: string) =>
        Option.isNone(token)
          ? Effect.void
          : Effect.tryPromise(() =>
            fetch(`https://api.telegram.org/bot${Redacted.value(token.value)}/sendMessage`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
              signal: AbortSignal.timeout(10_000)
            })
          ).pipe(Effect.ignore)

      // ponytail: in-memory dedupe, resets on restart; fine for one process.
      const lastSent = new Map<string, number>()
      const admin = (text: string) =>
        Effect.gen(function*() {
          yield* Effect.logError(`ALERT [${network}] ${text}`)
          const now = Date.now()
          if ((lastSent.get(text) ?? 0) > now - 60 * 60_000) return
          lastSent.set(text, now)
          if (Option.isSome(adminChat)) yield* telegram(adminChat.value, `⚠️ Luckout [${network}]: ${text}`)
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
