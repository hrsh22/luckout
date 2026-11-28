import { Config, Context, Effect, Layer, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { Cluster, ProgramId } from "./Solana.ts"

/**
 * Operator alerts and customer notices. Alerts are logged; with TELEGRAM_BOT_TOKEN set,
 * admin alerts also go to ALERT_TELEGRAM_CHAT_ID and customer notices to their linked chat.
 */
export class Alerts extends Context.Service<Alerts, {
  /** Something a human must look at. The same text is logged and sent at most once an hour. */
  admin(text: string): Effect.Effect<void>
  /**
   * A short notice to the customer's linked Telegram chat, if any. Never Redemption Data. False only when
   * it's worth sending again: Telegram didn't answer, rate-limited us or failed itself.
   */
  customer(accountId: string, text: string): Effect.Effect<boolean>
}>()("luckout/Alerts") {
  static readonly layer = Layer.effect(
    Alerts,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const token = yield* Config.option(Config.Redacted("TELEGRAM_BOT_TOKEN"))
      const adminChat = yield* Config.option(Config.String("ALERT_TELEGRAM_CHAT_ID"))
      // Every deployment may alert the same chat, so each alert names its own: its cluster and the start of its program's
      // address (staging and production are both on mainnet, each with its own program).
      const where = `${yield* Cluster} ${(yield* ProgramId).toBase58().slice(0, 4)}`

      /**
       * "sent" once Telegram took the message; "retry" when it didn't answer, rate-limited us or failed itself;
       * "refused" for the rest (a chat that blocked the bot), or with no bot. A failure logs its HTTP status
       * only: the URL holds the bot token.
       */
      const telegram = (chatId: string | number, text: string): Effect.Effect<"sent" | "retry" | "refused"> =>
        Option.isNone(token)
          ? Effect.succeed("refused")
          : Effect.tryPromise({
            try: () =>
              fetch(`https://api.telegram.org/bot${Redacted.value(token.value)}/sendMessage`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
                signal: AbortSignal.timeout(10_000)
              }),
            // Only the error's kind: its message can carry the URL, and the URL holds the token.
            catch: (e) => `no response (${e instanceof Error ? e.name : typeof e})`
          }).pipe(
            Effect.flatMap((res) =>
              res.status >= 200 && res.status < 300
                ? Effect.succeed("sent" as const)
                : Effect.as(
                  Effect.logError("alert delivery failed", `HTTP ${res.status}`),
                  res.status === 429 || res.status >= 500 ? ("retry" as const) : ("refused" as const)
                )
            ),
            Effect.catch((why: string) => Effect.as(Effect.logError("alert delivery failed", why), "retry" as const))
          )

      // ponytail: in-memory dedupe, resets on restart; fine for one process.
      const DEDUPE_MS = 60 * 60_000
      const lastSent = new Map<string, number>()
      const admin = (text: string) =>
        Effect.gen(function*() {
          const now = Date.now()
          for (const [t, at] of lastSent) if (at <= now - DEDUPE_MS) lastSent.delete(t)
          // A watcher raises the same alert every minute while its cause lasts: it's logged once an hour too,
          // so the log shows what else happened.
          if (lastSent.has(text)) return
          yield* Effect.logError(`ALERT [${where}] ${text}`)
          // Held while sending, so the same alert at the same moment isn't sent twice; only a delivered one counts.
          lastSent.set(text, now)
          if (Option.isNone(adminChat)) return
          if ((yield* telegram(adminChat.value, `⚠️ Luckout [${where}]: ${text}`)) !== "sent") lastSent.delete(text)
        })

      const customer = (accountId: string, text: string) =>
        // As text: Postgres hands a BIGINT back as a BigInt, which JSON (and so the Telegram call) can't carry.
        sql<{ chat_id: string }>`SELECT chat_id::text AS chat_id FROM telegram_links WHERE account_id = ${accountId}`.pipe(
          Effect.flatMap((rows) => (rows[0] ? telegram(rows[0].chat_id, text) : Effect.succeed("refused" as const))),
          Effect.map((d) => d !== "retry"),
          // Our own database failing isn't Telegram's: no retry loop over it.
          Effect.orElseSucceed(() => true)
        )

      return Alerts.of({ admin, customer })
    })
  )
}
