import { LinkInvalid, NewPurchase, type Purchase } from "@luckout/api"
import { Config, Context, Effect, Layer, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { Bot, InlineKeyboard } from "grammy"
import { randomBytes, randomUUID } from "node:crypto"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import { makeAgent, type Pending } from "./Agent.ts"
import { Bitrefill } from "./Bitrefill.ts"
import { Near } from "./Near.ts"
import { Purchases } from "./Purchases.ts"

const usd = (micro: number) => `$${(micro / 1e6).toFixed(2)}`
const LINK_TTL_MINUTES = 10
const PENDING_TTL_MS = 10 * 60 * 1000

export class Telegram extends Context.Service<Telegram, {
  /** Binds the Telegram user who received `code` to the signed-in NEAR account. */
  link(accountId: string, code: string): Effect.Effect<{ telegramName: string }, LinkInvalid>
}>()("luckout/Telegram") {
  static readonly layer = Layer.effect(
    Telegram,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const token = yield* Config.option(Config.Redacted("TELEGRAM_BOT_TOKEN"))
      const aiKey = yield* Config.option(Config.Redacted("NEAR_AI_API_KEY"))
      const aiBase = yield* Config.String("NEAR_AI_BASE_URL").pipe(Config.withDefault("https://cloud-api.near.ai/v1"))
      const aiModel = yield* Config.String("NEAR_AI_MODEL").pipe(Config.withDefault("deepseek-ai/DeepSeek-V4.1-Flash-1017"))
      const webOrigin = yield* Config.String("WEB_ORIGIN").pipe(Config.withDefault("http://localhost:3000"))
      const testnet = (yield* Config.String("NEAR_NETWORK").pipe(Config.withDefault("testnet"))) === "testnet"

      const bot = Option.isSome(token) ? new Bot(Redacted.value(token.value)) : undefined
      const db = <A>(e: Effect.Effect<A, unknown>) => Effect.runPromise(Effect.orDie(e))

      const link = Effect.fn("Telegram.link")(function*(accountId: string, code: string) {
        const rows = yield* sql<{ telegram_user_id: string; chat_id: string; telegram_name: string }>`
          DELETE FROM telegram_link_codes WHERE code = ${code} AND expires_at > now()
          RETURNING telegram_user_id, chat_id, telegram_name`.pipe(Effect.orDie)
        const row = rows[0]
        if (!row) return yield* new LinkInvalid({ message: "This link expired. Send /start to the bot for a new one." })
        yield* sql`
          INSERT INTO telegram_links (telegram_user_id, account_id, chat_id) VALUES (${row.telegram_user_id}, ${accountId}, ${row.chat_id})
          ON CONFLICT (telegram_user_id) DO UPDATE SET account_id = excluded.account_id, chat_id = excluded.chat_id, linked_at = now()`
          .pipe(Effect.orDie)
        if (bot) {
          yield* Effect.promise(() =>
            bot.api.sendMessage(Number(row.chat_id), `Linked to ${accountId}. Ask me for a gift card, e.g. "a 500 rupee Swiggy voucher".`)
              .catch(() => undefined)
          )
        }
        return { telegramName: row.telegram_name }
      })

      if (!bot) {
        yield* Effect.logInfo("TELEGRAM_BOT_TOKEN not set: the Telegram Agent is off")
        return Telegram.of({ link })
      }
      if (Option.isNone(aiKey)) {
        yield* Effect.logWarning("NEAR_AI_API_KEY not set: the bot can link accounts but can't chat")
      }

      const purchases = yield* Purchases
      const agent = Option.isSome(aiKey)
        ? makeAgent({
          bitrefill: yield* Bitrefill,
          purchases,
          near: yield* Near,
          testnet,
          apiKey: Redacted.value(aiKey.value),
          baseURL: aiBase,
          model: aiModel
        })
        : undefined

      // ponytail: chat history and pending confirmations live in memory (lost on restart, one process).
      const history = new Map<number, Array<ChatCompletionMessageParam>>()
      const pending = new Map<string, Pending & { telegramUserId: number; accountId: string; expires: number }>()

      const linkedAccount = (telegramUserId: number) =>
        db(sql<{ account_id: string }>`SELECT account_id FROM telegram_links WHERE telegram_user_id = ${telegramUserId}`)
          .then((r) => r[0]?.account_id)

      // Codes only ever go to a private chat with their owner.
      bot.use(async (ctx, next) => {
        if (ctx.chat?.type === "private") await next()
      })

      bot.command("start", async (ctx) => {
        const accountId = await linkedAccount(ctx.from!.id)
        if (accountId) return void ctx.reply(`You're linked to ${accountId}. What would you like to buy?`)
        const code = randomBytes(12).toString("base64url")
        const name = ctx.from!.username ? `@${ctx.from!.username}` : ctx.from!.first_name
        await db(sql`DELETE FROM telegram_link_codes WHERE expires_at < now()`)
        await db(sql`
          INSERT INTO telegram_link_codes (code, telegram_user_id, chat_id, telegram_name, expires_at)
          VALUES (${code}, ${ctx.from!.id}, ${ctx.chat.id}, ${name}, now() + make_interval(mins => ${LINK_TTL_MINUTES}))`)
        const url = `${webOrigin}/link?code=${code}`
        // Telegram only allows https URLs on buttons.
        await ctx.reply(
          `Welcome to Luckout. To buy from here, link your NEAR account by signing in on the web (valid ${LINK_TTL_MINUTES} minutes):\n${url}`,
          url.startsWith("https://") ? { reply_markup: new InlineKeyboard().url("Link my NEAR account", url) } : {}
        )
      })

      bot.on("message:text", async (ctx) => {
        const accountId = await linkedAccount(ctx.from.id)
        if (!accountId) return void ctx.reply("Send /start to link your NEAR account first.")
        if (!agent) return void ctx.reply("The assistant is offline right now. You can still buy in the web app.")
        await ctx.replyWithChatAction("typing")
        const turn = await agent(accountId, history.get(ctx.chat.id) ?? [], ctx.message.text).catch((e) => {
          console.error("agent error", e)
          return undefined
        })
        if (!turn) return void ctx.reply("Sorry, something went wrong on my side. Try again in a moment.")
        history.set(ctx.chat.id, turn.history.slice(-16))
        if (!turn.pending) return void ctx.reply(turn.reply || "…")
        const id = randomUUID()
        pending.set(id, { ...turn.pending, telegramUserId: ctx.from.id, accountId, expires: Date.now() + PENDING_TTL_MS })
        const p = turn.pending
        const summary = p.maxPrice === p.referencePrice
          ? `${p.voucherName} ${p.value} for ${usd(p.referencePrice)}.`
          : `${p.voucherName} ${p.value}: price ${usd(p.referencePrice)}, you pay at most ${usd(p.maxPrice)}, maybe much less.`
        await ctx.reply(`${turn.reply}\n\n${summary}`.trim(), {
          reply_markup: new InlineKeyboard().text(`Buy for up to ${usd(p.maxPrice)}`, `buy:${id}`).text("Cancel", `cancel:${id}`)
        })
      })

      const result = (p: Purchase) => {
        if (p.status !== "delivered") return p.error ?? `Purchase ${p.status}.`
        const paid = p.draw ? p.draw.finalPrice : p.referencePrice
        const diff = paid - p.referencePrice
        const r = p.redemption ?? {}
        const lines = [
          `${p.voucherName} ${p.value} is yours.`,
          p.draw
            ? `You paid ${usd(paid)}${diff < 0 ? `, ${usd(-diff)} less than the price` : diff > 0 ? `, ${usd(diff)} above the price` : ", exactly the price"}.`
            : `You paid ${usd(paid)}.`,
          typeof r.code === "string" ? `Code: ${r.code}` : "",
          typeof r.pin === "string" ? `PIN: ${r.pin}` : "",
          typeof r.link === "string" ? `Link: ${r.link}` : "",
          p.draw && p.settleTx ? `Draw Proof: ${webOrigin}/draw/${p.settleTx}` : ""
        ]
        return lines.filter(Boolean).join("\n")
      }

      bot.callbackQuery(/^(buy|cancel):(.+)$/, async (ctx) => {
        const [, action, id] = ctx.match as RegExpMatchArray
        const p = pending.get(id!)
        // Only the customer it was prepared for can confirm it, and only once.
        if (!p || p.telegramUserId !== ctx.from.id || p.expires < Date.now()) {
          return void ctx.answerCallbackQuery({ text: "This offer expired. Ask again." })
        }
        pending.delete(id!)
        await ctx.editMessageReplyMarkup().catch(() => {})
        if (action === "cancel") return void ctx.answerCallbackQuery({ text: "Cancelled." })
        await ctx.answerCallbackQuery({ text: "Buying…" })
        const outcome = await Effect.runPromise(
          purchases.create(p.accountId, new NewPurchase({ voucherId: p.voucherId, value: p.value, ...(p.mode ? { mode: p.mode } : {}), idempotencyKey: id! }))
            .pipe(Effect.match({ onFailure: (e) => e.message, onSuccess: result }))
        )
        await ctx.reply(outcome)
      })

      bot.catch((err) => console.error("telegram error", err.error))
      // Long polling: no webhook or public URL needed (ADR-0006).
      yield* Effect.acquireRelease(
        Effect.sync(() => void bot.start({ drop_pending_updates: true })),
        () => Effect.promise(() => bot.stop())
      )
      yield* Effect.logInfo("Telegram Agent is running")
      return Telegram.of({ link })
    })
  )
}
