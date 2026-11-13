import { AgentAttestation, LinkInvalid, NewPurchase, NotFound, type Purchase } from "@luckout/api"
import { Config, Context, Effect, Layer, Option, Redacted, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { Bot, GrammyError, InlineKeyboard } from "grammy"
import { randomBytes, randomUUID } from "node:crypto"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import { makeAgent, modeName, type Pending, trimHistory, usd, usdUp, worksIn } from "./Agent.ts"
import { Alerts } from "./Alerts.ts"
import { makeAttestation } from "./Attestation.ts"
import { Bitrefill } from "./Bitrefill.ts"
import { closedMessage, Sales } from "./Sales.ts"
import { Near, Network } from "./Near.ts"
import { Purchases } from "./Purchases.ts"

const LINK_TTL_MINUTES = 10
const PENDING_TTL_MS = 10 * 60 * 1000
/** Messages per Telegram user per minute and per UTC day; each one can cost several LLM calls. */
const MESSAGES_PER_MINUTE = 10
const MESSAGES_PER_DAY = 200
/** A chat quiet this long starts over, so its history doesn't sit in memory. */
const IDLE_MS = 60 * 60_000

/** An error for the logs. Never the object itself: a GrammyError carries the message it failed to send, voucher codes included. */
export const describe = (e: unknown) =>
  e instanceof GrammyError
    ? `${e.method}: ${e.error_code} ${e.description}`
    : e instanceof Error
    ? `${e.name}: ${e.message}`
    : typeof e

// ponytail: counters in memory, one process; a restart resets them, and the day is UTC.
/** Per-Telegram-user message limits: "minute" or "day" when a message is over one, undefined when it may go ahead. */
export const messageLimits = (perMinute = MESSAGES_PER_MINUTE, perDay = MESSAGES_PER_DAY) => {
  const minutes = new Map<number, { count: number; resetAt: number }>()
  const days = new Map<number, { count: number; day: number }>()
  return {
    check: (userId: number, now = Date.now()): "minute" | "day" | undefined => {
      const w = minutes.get(userId)
      if (!w || w.resetAt < now) minutes.set(userId, { count: 1, resetAt: now + 60_000 })
      else if (++w.count > perMinute) return "minute"
      const day = Math.floor(now / 86_400_000)
      const d = days.get(userId)
      if (!d || d.day !== day) days.set(userId, { count: 1, day })
      else if (++d.count > perDay) return "day"
      return undefined
    },
    /** Forgets counters that no longer count. */
    sweep: (now = Date.now()) => {
      for (const [k, w] of minutes) if (w.resetAt < now) minutes.delete(k)
      for (const [k, d] of days) if (d.day !== Math.floor(now / 86_400_000)) days.delete(k)
    }
  }
}

/** A new link for the account. Earlier ones stop working, so only the latest link can connect Telegram. */
export const addLinkCode = (accountId: string, code: string, expiresAt: Date) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DELETE FROM telegram_link_codes WHERE expires_at < now() OR account_id = ${accountId}`
    yield* sql`INSERT INTO telegram_link_codes (code, account_id, expires_at) VALUES (${code}, ${accountId}, ${expiresAt})`
  }).pipe(Effect.orDie)

/** Disconnects Telegram, and cancels any link not opened yet so it can't connect it again. */
export const unlinkAccount = (accountId: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DELETE FROM telegram_link_codes WHERE account_id = ${accountId}`
    yield* sql`DELETE FROM telegram_links WHERE account_id = ${accountId}`
  }).pipe(Effect.orDie)

/**
 * Links whoever opened the code. Returns the account, and the chat this replaced if it was another
 * one; undefined if the code expired, was used, or was cancelled.
 */
export const redeemLinkCode = (code: string, user: { id: number; chatId: number; name: string }) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function*() {
      const [row] = yield* sql<{ account_id: string }>`
        DELETE FROM telegram_link_codes WHERE code = ${code} AND expires_at > now() RETURNING account_id`
      if (!row) return undefined
      // One Telegram account per wallet: linking a new one replaces the old link.
      const old = yield* sql<{ account_id: string; chat_id: string | number }>`
        DELETE FROM telegram_links WHERE account_id = ${row.account_id} OR telegram_user_id = ${user.id} RETURNING account_id, chat_id`
      yield* sql`INSERT INTO telegram_links (telegram_user_id, account_id, chat_id, telegram_name) VALUES (${user.id}, ${row.account_id}, ${user.chatId}, ${user.name})`
      const replaced = old.find((o) => o.account_id === row.account_id && String(o.chat_id) !== String(user.chatId))
      return { accountId: row.account_id, ...(replaced ? { replacedChat: String(replaced.chat_id) } : {}) }
    }))
  }).pipe(Effect.orDie)

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
  /** The latest check of the Agent's TEE (Attestation.ts); NotFound while the Agent is off. */
  readonly attestation: Effect.Effect<AgentAttestation, NotFound>
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

      const withSql = Effect.provideService(SqlClient.SqlClient, sql)
      const linkCode = Effect.fn("Telegram.linkCode")(function*(accountId: string) {
        if (!botUrl) return yield* new LinkInvalid({ message: "The Telegram bot is offline right now." })
        const code = randomBytes(18).toString("base64url")
        const expiresAt = Date.now() + LINK_TTL_MINUTES * 60_000
        yield* withSql(addLinkCode(accountId, code, new Date(expiresAt)))
        return { url: `${botUrl}?start=${code}`, expiresAt }
      })

      const unlink = (accountId: string) => withSql(unlinkAccount(accountId))

      if (!bot) {
        yield* Effect.logInfo("TELEGRAM_BOT_TOKEN not set: the Telegram Agent is off")
        return Telegram.of({ status, linkCode, unlink, attestation: Effect.fail(new NotFound()) })
      }
      if (Option.isNone(aiKey)) {
        yield* Effect.logWarning("NEAR_AI_API_KEY not set: the bot can link accounts but can't chat")
      }

      const purchases = yield* Purchases
      const alerts = yield* Alerts
      const offline = `The assistant is offline right now. You can still buy in the web app: ${webOrigin}/shop`
      const ai = Option.isSome(aiKey) ? { apiKey: Redacted.value(aiKey.value), baseURL: aiBase, model: aiModel } : undefined
      const tee = ai && makeAttestation(ai, (message) => void Effect.runPromise(alerts.admin(message)))
      if (tee) yield* Effect.promise(tee.refresh).pipe(Effect.repeat(Schedule.spaced("1 hour")), Effect.forkScoped)
      const agent = ai && tee
        ? makeAgent({
          bitrefill: yield* Bitrefill,
          purchases,
          near: yield* Near,
          shopClosed: Effect.map((yield* Sales).status, (st) => (st.open ? undefined : closedMessage(st))),
          testnet,
          web: webOrigin,
          ...ai,
          verify: tee.verify
        })
        : undefined
      const attestation = Effect.suspend(() => {
        const a = tee?.latest()
        return a ? Effect.succeed(new AgentAttestation(a)) : Effect.fail(new NotFound())
      })

      // ponytail: chat history and pending confirmations live in memory (lost on restart, one process).
      const history = new Map<number, { messages: Array<ChatCompletionMessageParam>; at: number }>()
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
        const next = (chains.get(chatId) ?? Promise.resolve()).then(job).catch((e) => console.error("telegram job failed:", describe(e)))
        chains.set(chatId, next)
        void next.then(() => chains.get(chatId) === next && chains.delete(chatId))
      }
      const limits = messageLimits()
      // Every few minutes, forget what can't matter any more: expired buttons, quiet chats, old counters.
      yield* Effect.sync(() => {
        const now = Date.now()
        for (const [id, p] of pending) if (p.expires < now) pending.delete(id)
        for (const [chat, h] of history) if (h.at < now - IDLE_MS) history.delete(chat)
        limits.sweep(now)
      }).pipe(Effect.repeat(Schedule.spaced("5 minutes")), Effect.forkScoped)

      bot.command("start", async (ctx) => {
        const code = ctx.match.trim()
        if (code) {
          const name = ctx.from!.username ? `@${ctx.from!.username}` : ctx.from!.first_name
          const linked = await db(withSql(redeemLinkCode(code, { id: ctx.from!.id, chatId: ctx.chat.id, name })))
          if (!linked) return void ctx.reply(`That link expired. Open ${webOrigin}/wallet and tap "Connect Telegram" again.`)
          const { accountId } = linked
          // Best effort: the chat that just lost the link hears it from us, in case it wasn't them.
          if (linked.replacedChat) {
            bot.api.sendMessage(linked.replacedChat, `${accountId} connected another Telegram account, so this chat is no longer linked. If that wasn't you, open ${webOrigin}/wallet.`)
              .catch((e) => console.error("telegram notice failed:", describe(e)))
          }
          history.delete(ctx.chat.id)
          return void ctx.reply(
            `You're in, ${accountId}. Tell me what you want, like ${testnet ? `"a $10 test gift card" (this is the testnet demo)` : `"a ₹500 Swiggy voucher"`}. Nothing is bought until you tap Confirm.`
          )
        }
        const accountId = await linkedAccount(ctx.from!.id)
        await ctx.reply(
          accountId
            ? `You're linked to ${accountId}. What would you like to buy?`
            : `Welcome to Luckout. To buy from here, open ${webOrigin}/wallet, sign in with your NEAR wallet and tap "Connect Telegram".`
        )
      })

      // So the operator can find their chat id for ALERT_TELEGRAM_CHAT_ID.
      bot.command("chatid", (ctx) => ctx.reply(`This chat's id is ${ctx.chat.id}.`))

      bot.on("message:text", (ctx) => inChat(ctx.chat.id, async () => {
        const over = limits.check(ctx.from.id)
        if (over === "minute") return void ctx.reply("That's a lot of messages; give me a minute.")
        if (over === "day") return void ctx.reply(`That's all I can chat today. You can still buy in the web app: ${webOrigin}/shop`)
        const accountId = await linkedAccount(ctx.from.id)
        if (!accountId) return void ctx.reply("Send /start to link your NEAR account first.")
        if (!agent) return void ctx.reply(offline)
        await ctx.replyWithChatAction("typing")
        // No passing TEE check on file, no chat: the model's replies couldn't be trusted.
        if (!(await tee!.ready())) return void ctx.reply(offline)
        let failure: unknown
        const turn = await agent(accountId, history.get(ctx.chat.id)?.messages ?? [], ctx.message.text).catch((e) => {
          failure = e
          console.error("agent error", e)
          return undefined
        })
        if (!turn) {
          // 402: the NEAR AI account has no credits or spending limit. Tell the customer plainly, and us.
          if ((failure as { status?: number })?.status === 402) {
            void Effect.runPromise(alerts.admin("NEAR AI returned 402 (no credits or spending limit): the bot can't chat until credits are added at cloud.near.ai"))
            return void ctx.reply(offline)
          }
          return void ctx.reply("Sorry, something went wrong on my side. Try again in a moment.")
        }
        history.set(ctx.chat.id, { messages: trimHistory(turn.history), at: Date.now() })
        if (!turn.pending) return void ctx.reply(turn.reply || "…")
        const id = randomUUID()
        pending.set(id, { ...turn.pending, telegramUserId: ctx.from.id, accountId, expires: Date.now() + PENDING_TTL_MS })
        const p = turn.pending
        const summary = (p.maxPrice === p.referencePrice
          ? `${p.voucherName}, ${p.value} ${p.currency}: ${usdUp(p.maxPrice)}.`
          : `${p.voucherName}, ${p.value} ${p.currency} on ${modeName(p.mode)}: ${usdUp(p.maxPrice)} now (price ${usd(p.referencePrice)}).`) +
          // A card only works in its own country: said on the button's line, every time.
          ` Works in ${worksIn(p.country)}.`
        await ctx.reply(`${turn.reply}\n\n${summary}`.trim(), {
          reply_markup: new InlineKeyboard().text(`Buy for ${usdUp(p.maxPrice)}`, `buy:${id}`).text("Cancel", `cancel:${id}`)
        })
      }))

      const result = (p: Purchase) => {
        if (p.status === "waiting") {
          return `Your ${p.voucherName} ${p.value} needs a little time: we're topping up our gift card supply, usually a few minutes, longer for big cards. You're only charged once it's ready, and you can cancel until then in the app under Purchases. I'll message you here when it's ready.`
        }
        if (p.status !== "delivered") return p.error ?? `Purchase ${p.status}.`
        const paid = p.draw ? p.draw.finalPrice : p.referencePrice
        const diff = paid - p.referencePrice
        const r = p.redemption ?? {}
        const lines = [
          `${p.voucherName} ${p.value} is yours.`,
          !p.draw
            ? `You paid ${usdUp(paid)}.`
            : p.draw.cashback === 0
            ? `No cashback this time: you paid ${usdUp(paid)}.`
            : `${paid === 0 ? "100% off!" : `${usd(p.draw.cashback)} cashback!`} You paid ${usdUp(paid)}${diff < 0 ? `, ${usd(-diff)} less than the price` : diff > 0 ? `, ${usd(diff)} above the price` : ", exactly the price"}.`,
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
            purchases.create(p.accountId, new NewPurchase({ voucherId: p.voucherId, value: p.value, mode: p.mode, maxPrice: p.maxPrice, ...(p.mode === "normal" ? {} : { luckyAmount: p.luckyAmount }), idempotencyKey: id! }))
              .pipe(Effect.match({ onFailure: (e) => e.message, onSuccess: result }))
          )
          await ctx.reply(outcome)
        })
      })

      bot.catch((err) => console.error("telegram error:", describe(err.error)))
      // Long polling: no webhook or public URL needed (ADR-0006).
      yield* Effect.acquireRelease(
        // A rejection (e.g. 409: another process polls with this token) must not crash the server,
        // but the bot is deaf from then on, so a human has to hear about it.
        Effect.sync(() =>
          void bot.start({ drop_pending_updates: true }).catch((e) => {
            console.error("telegram polling stopped:", describe(e))
            void Effect.runPromise(alerts.admin(`Telegram polling stopped (${describe(e)}): the bot answers no one until the server restarts`))
          })
        ),
        () => Effect.promise(() => bot.stop())
      )
      yield* Effect.logInfo("Telegram Agent is running")
      return Telegram.of({ status, linkCode, unlink, attestation })
    })
  )
}
