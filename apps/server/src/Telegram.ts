import { LinkInvalid, NewPurchase, type Purchase } from "@luckout/api"
import { Config, Context, Effect, Layer, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { Bot, InlineKeyboard } from "grammy"
import { randomBytes, randomUUID } from "node:crypto"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import { makeAgent, type Pending } from "./Agent.ts"
import { Bitrefill } from "./Bitrefill.ts"
import { Near, Network } from "./Near.ts"
import { Purchases } from "./Purchases.ts"

const usd = (micro: number) => `$${(micro / 1e6).toFixed(2)}`
const LINK_TTL_MINUTES = 10
const PENDING_TTL_MS = 10 * 60 * 1000
/** Messages per Telegram user per minute; each one can cost several LLM calls. */
const MESSAGES_PER_MINUTE = 10

interface Status {
  readonly linked: boolean
  readonly telegramName?: string
  readonly botUrl?: string
}

// Linking direction (security review): the signed-in web session — proof of the wallet —
// issues the code and opens the bot with it. Whoever sends that code to the bot gets linked,
// so the wallet owner alone decides which Telegram account may buy for them.
export class Telegram extends Context.Service<Telegram, {
  status(accountId: string): Effect.Effect<Status>
  /** A one-time deep link to the bot that links whichever Telegram user opens it. */
  linkCode(accountId: string): Effect.Effect<{ url: string; expiresAt: number }, LinkInvalid>
  unlink(accountId: string): Effect.Effect<void>
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
      const testnet = (yield* Network) === "testnet"

      const bot = Option.isSome(token) ? new Bot(Redacted.value(token.value)) : undefined
      const db = <A>(e: Effect.Effect<A, unknown>) => Effect.runPromise(Effect.orDie(e))

      const botName = bot ? yield* Effect.promise(() => bot.api.getMe().then((me) => me.username, () => undefined)) : undefined
      const botUrl = botName ? `https://t.me/${botName}` : undefined

      const status = (accountId: string) =>
        sql<{ telegram_name: string }>`SELECT telegram_name FROM telegram_links WHERE account_id = ${accountId}`
          .pipe(
            Effect.map((r): Status => ({
              linked: r.length > 0,
              ...(r[0] ? { telegramName: r[0].telegram_name } : {}),
              ...(botUrl ? { botUrl } : {})
            })),
            Effect.orDie
          )

      const linkCode = Effect.fn("Telegram.linkCode")(function*(accountId: string) {
        if (!botUrl) return yield* new LinkInvalid({ message: "The Telegram bot is offline right now." })
        const code = randomBytes(18).toString("base64url")
        const expiresAt = Date.now() + LINK_TTL_MINUTES * 60_000
        yield* sql`DELETE FROM telegram_link_codes WHERE expires_at < now()`.pipe(Effect.orDie)
        yield* sql`INSERT INTO telegram_link_codes (code, account_id, expires_at) VALUES (${code}, ${accountId}, ${new Date(expiresAt)})`
          .pipe(Effect.orDie)
        return { url: `${botUrl}?start=${code}`, expiresAt }
      })

      const unlink = (accountId: string) =>
        sql`DELETE FROM telegram_links WHERE account_id = ${accountId}`.pipe(Effect.asVoid, Effect.orDie)

      if (!bot) {
        yield* Effect.logInfo("TELEGRAM_BOT_TOKEN not set: the Telegram Agent is off")
        return Telegram.of({ status, linkCode, unlink })
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

      // grammY handles updates one at a time, so slow work (the LLM, a purchase) runs detached:
      // one chat waiting never holds up another. Each chat's jobs still run in order.
      const chains = new Map<number, Promise<void>>()
      const inChat = (chatId: number, job: () => Promise<void>) => {
        const next = (chains.get(chatId) ?? Promise.resolve()).then(job).catch((e) => console.error("telegram job failed", e))
        chains.set(chatId, next)
        void next.then(() => chains.get(chatId) === next && chains.delete(chatId))
      }
      // ponytail: fixed one-minute window in memory, one process.
      const windows = new Map<number, { count: number; resetAt: number }>()
      const allowed = (userId: number) => {
        const now = Date.now()
        const w = windows.get(userId)
        if (!w || w.resetAt < now) return windows.set(userId, { count: 1, resetAt: now + 60_000 }), true
        return ++w.count <= MESSAGES_PER_MINUTE
      }

      bot.command("start", async (ctx) => {
        const code = ctx.match.trim()
        if (code) {
          const rows = await db(sql<{ account_id: string }>`
            DELETE FROM telegram_link_codes WHERE code = ${code} AND expires_at > now() RETURNING account_id`)
          const accountId = rows[0]?.account_id
          if (!accountId) return void ctx.reply(`That link expired. Open ${webOrigin}/wallet and tap "Connect Telegram" again.`)
          const name = ctx.from!.username ? `@${ctx.from!.username}` : ctx.from!.first_name
          // One Telegram account per wallet: linking a new one replaces the old link.
          await db(sql.withTransaction(Effect.gen(function*() {
            yield* sql`DELETE FROM telegram_links WHERE account_id = ${accountId} OR telegram_user_id = ${ctx.from!.id}`
            yield* sql`INSERT INTO telegram_links (telegram_user_id, account_id, chat_id, telegram_name) VALUES (${ctx.from!.id}, ${accountId}, ${ctx.chat.id}, ${name})`
          })))
          history.delete(ctx.chat.id)
          return void ctx.reply(`Linked to ${accountId}. Ask me for a gift card, e.g. "a 500 rupee Swiggy voucher". You confirm every purchase with a button.`)
        }
        const accountId = await linkedAccount(ctx.from!.id)
        await ctx.reply(
          accountId
            ? `You're linked to ${accountId}. What would you like to buy?`
            : `Welcome to Luckout. To buy from here, open ${webOrigin}/wallet, sign in with your NEAR wallet and tap "Connect Telegram".`
        )
      })

      bot.on("message:text", (ctx) => inChat(ctx.chat.id, async () => {
        if (!allowed(ctx.from.id)) return void ctx.reply("That's a lot of messages; give me a minute.")
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
      }))

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
        // The wallet may have unlinked this Telegram account since the button was made.
        if ((await linkedAccount(ctx.from.id)) !== p.accountId) {
          return void ctx.answerCallbackQuery({ text: "This Telegram account is no longer linked to that wallet." })
        }
        await ctx.answerCallbackQuery({ text: "Buying…" })
        inChat(ctx.chat!.id, async () => {
          const outcome = await Effect.runPromise(
            // The contract refuses to debit more than the maximum shown on the button.
            purchases.create(p.accountId, new NewPurchase({ voucherId: p.voucherId, value: p.value, mode: p.mode, maxPrice: p.maxPrice, idempotencyKey: id! }))
              .pipe(Effect.match({ onFailure: (e) => e.message, onSuccess: result }))
          )
          await ctx.reply(outcome)
        })
      })

      bot.catch((err) => console.error("telegram error", err.error))
      // Long polling: no webhook or public URL needed (ADR-0006).
      yield* Effect.acquireRelease(
        // A rejection (e.g. 409: another process polls with this token) must not crash the server.
        Effect.sync(() => void bot.start({ drop_pending_updates: true }).catch((e) => console.error("telegram polling stopped", e))),
        () => Effect.promise(() => bot.stop())
      )
      yield* Effect.logInfo("Telegram Agent is running")
      return Telegram.of({ status, linkCode, unlink })
    })
  )
}
