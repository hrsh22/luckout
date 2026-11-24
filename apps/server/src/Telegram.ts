import { AgentAttestation, LinkInvalid, NewPurchase, NotFound, type Purchase, redemptionFields } from "@luckout/api"
import { Config, Context, Effect, Layer, Option, Redacted, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { Bot, GrammyError, InlineKeyboard } from "grammy"
import { randomBytes, randomUUID } from "node:crypto"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import { dateText, makeAgent, modeName, type Offer, type Pending, trimHistory, usd, usdUp, worksIn } from "./Agent.ts"
import { Alerts } from "./Alerts.ts"
import { makeAttestation } from "./Attestation.ts"
import { Bitrefill, MIN_PRICE } from "./Bitrefill.ts"
import { closedMessage, Sales } from "./Sales.ts"
import { Near, Network } from "./Near.ts"
import { Purchases } from "./Purchases.ts"

const LINK_TTL_MINUTES = 10
/** How long a button under the Agent's reply works (ADR-0007). */
const OFFER_TTL_MS = 10 * 60 * 1000
/** Messages per Telegram user per minute; each one can cost several LLM calls. */
const MESSAGES_PER_MINUTE = 10
/**
 * Messages that reach the model per UTC day: per account, per account with no Balance to buy with, and from all accounts
 * with no Balance together. A customer shopping all day sends a few dozen; these only stop runaway model costs.
 */
const MESSAGES_PER_DAY = 200
const UNFUNDED_MESSAGES_PER_DAY = 50
const UNFUNDED_BOT_MESSAGES_PER_DAY = 5_000
/** Telegram takes at most 4096 characters in one message. */
const MESSAGE_MAX = 4096
/** A chat quiet this long starts over, so its history doesn't sit in memory. */
const IDLE_MS = 60 * 60_000

/** An error for the logs. Never the object itself: a GrammyError carries the message it failed to send, voucher codes included. */
export const describe = (e: unknown) =>
  e instanceof GrammyError
    ? `${e.method}: ${e.error_code} ${e.description}`
    : e instanceof Error
    ? `${e.name}: ${e.message}`
    : typeof e

// ponytail: counters in memory, one process; a restart resets them, and the day is UTC. Raise
// UNFUNDED_BOT_MESSAGES_PER_DAY when real use nears it (the admin alert says so), or move the counters to the database
// if the bot ever runs twice.
/**
 * The bot's message limits: per Telegram user per minute, and per UTC day for messages that reach the model, counted by
 * account so that linking the wallet to another Telegram account doesn't start the count over.
 */
export const messageLimits = (
  o = { perMinute: MESSAGES_PER_MINUTE, perDay: MESSAGES_PER_DAY, unfundedPerDay: UNFUNDED_MESSAGES_PER_DAY, unfundedBotPerDay: UNFUNDED_BOT_MESSAGES_PER_DAY }
) => {
  const minutes = new Map<number, { count: number; resetAt: number }>()
  const days = new Map<string, { count: number; day: number }>()
  let unfunded = { count: 0, day: 0 }
  return {
    /** Every message, before anything else: "minute" when this user is over theirs. */
    check: (userId: number, now = Date.now()): "minute" | undefined => {
      const w = minutes.get(userId)
      if (!w || w.resetAt < now) minutes.set(userId, { count: 1, resetAt: now + 60_000 })
      else if (++w.count > o.perMinute) return "minute"
      return undefined
    },
    /**
     * A message about to reach the model, counted only if it goes ahead: "day" when this account has had today's (fewer
     * with no Balance to buy with), "bot" when accounts with no Balance have had today's, all together.
     */
    model: (accountId: string, funded: boolean, now = Date.now()): "day" | "bot" | undefined => {
      const day = Math.floor(now / 86_400_000)
      if (unfunded.day !== day) unfunded = { count: 0, day }
      const d = days.get(accountId)
      const used = d?.day === day ? d.count : 0
      if (used >= (funded ? o.perDay : o.unfundedPerDay)) return "day"
      // Only accounts with no Balance count toward the whole bot's cap, so it never turns away a customer who can buy.
      if (!funded) {
        if (unfunded.count >= o.unfundedBotPerDay) return "bot"
        unfunded.count++
      }
      days.set(accountId, { count: used + 1, day })
      return undefined
    },
    /** Forgets counters that no longer count. */
    sweep: (now = Date.now()) => {
      for (const [k, w] of minutes) if (w.resetAt < now) minutes.delete(k)
      for (const [k, d] of days) if (d.day !== Math.floor(now / 86_400_000)) days.delete(k)
    }
  }
}

/**
 * The lines under the Agent's reply, written by code: exactly what the button buys, and where the receipt goes. One
 * line for one card; several are numbered, with their total.
 */
export const buySummary = (cards: ReadonlyArray<Pending>) => {
  const receipt = cards[0]?.receiptTo ? ` Also emailed to ${cards[0].receiptTo}.` : ""
  if (cards.length === 1) return cardLine(cards[0]!) + receipt
  const total = cards.reduce((s, c) => s + c.maxPrice, 0)
  return [...cards.map((c, i) => `${i + 1}. ${cardLine(c)}`), `${cards.length} cards: ${usdUp(total)} in all.${receipt}`].join("\n")
}
const cardLine = (p: Pending) =>
  (p.maxPrice === p.referencePrice
    ? `${p.voucherName}, ${p.value} ${p.currency}: ${usdUp(p.maxPrice)}` +
      // A Lucky card the Cashback Reserve can't cover now is bought at Normal: said here by code, not left to the model.
      (p.mode === "normal" && p.requestedMode !== "normal"
        ? ` on Normal: the Cashback Reserve can't cover ${modeName(p.requestedMode)} right now, so there's no Draw.`
        : ".")
    : `${p.voucherName}, ${p.value} ${p.currency} on ${modeName(p.mode)}: ${usdUp(p.maxPrice)} now (price ${usd(p.referencePrice)}).`) +
  // A card only works in its own country: said on the button's line, every time.
  ` Works in ${worksIn(p.country)}.` +
  // Bitrefill gives no date before an order: the last delivered one's is the best guess, and said as one.
  (p.useBy ? ` Use it by about ${dateText(p.useBy)}.` : "")

/** Codes only ever go to a private chat with their owner: the bot ignores groups and channels. */
export const privateOnly = async (ctx: { readonly chat?: { readonly type: string } | undefined }, next: () => Promise<void>) => {
  if (ctx.chat?.type === "private") await next()
}

/** What the customer wrote themselves: nothing for a forwarded message, or one sent through an inline bot (ADR-0007). */
export const typedText = (m: { readonly text: string; readonly forward_origin?: unknown; readonly via_bot?: unknown }) =>
  m.forward_origin || m.via_bot ? "" : m.text

interface Held {
  readonly offer: Offer
  readonly telegramUserId: number
  readonly accountId: string
  readonly chatId: number
  /** The message its buttons are on, once sent: withdrawing the offer takes them off. */
  messageId?: number
  readonly expires: number
}

// ponytail: offers live in memory (lost on restart, one process): a button from before a restart says it expired.
/** The offers behind the buttons under the Agent's replies (ADR-0007). */
export const makeOffers = (ttl = OFFER_TTL_MS) => {
  const held = new Map<string, Held>()
  return {
    /**
     * Holds a new offer under a fresh id. Only the newest of a user's offers stands: their earlier ones (a cart they've
     * since changed, a Buy line with the email they're replacing) are withdrawn and returned, so their buttons can come off.
     */
    add: (o: Omit<Held, "expires" | "messageId">, now = Date.now()) => {
      const withdrawn = [...held].filter(([, h]) => h.telegramUserId === o.telegramUserId)
      for (const [id] of withdrawn) held.delete(id)
      const id = randomUUID()
      held.set(id, { ...o, expires: now + ttl })
      return { id, withdrawn: withdrawn.map(([, h]) => h) }
    },
    shownIn: (id: string, messageId: number) => {
      const h = held.get(id)
      if (h) h.messageId = messageId
    },
    /**
     * The offer behind a tap, at most once: only for the Telegram user it was made for, before it expires, by a button of
     * its own kind, and while they're still linked to the account it was made for (`linkedTo`). Cancel needs no link: it
     * only takes the buttons off. Otherwise, what to tell them, and whether the offer is gone (its buttons can come off).
     */
    take: (id: string, userId: number, action: "buy" | "email" | "cancel", linkedTo: string | undefined, now = Date.now()):
      | { readonly held: Held }
      | { readonly refused: string; readonly consumed: boolean } =>
    {
      const h = held.get(id)
      const kind = h && ("email" in h.offer ? "email" : "buy")
      if (!h || h.telegramUserId !== userId || h.expires < now || (action !== "cancel" && action !== kind)) {
        return { refused: "This offer expired. Ask again.", consumed: false }
      }
      held.delete(id)
      return action === "cancel" || h.accountId === linkedTo ? { held: h } : { refused: "This Telegram account is no longer linked to that wallet.", consumed: true }
    },
    sweep: (now = Date.now()) => {
      for (const [id, h] of held) if (h.expires < now) held.delete(id)
    }
  }
}

/**
 * The purchases a Buy tap makes: each card at the most it showed, which the contract won't debit past. The offer's id
 * keys each card, so a repeat returns the same purchases (ADR-0007).
 */
export const purchaseItems = (id: string, cards: ReadonlyArray<Pending>) =>
  cards.map((c, i) =>
    new NewPurchase({
      voucherId: c.voucherId,
      value: c.value,
      mode: c.mode,
      maxPrice: c.maxPrice,
      ...(c.mode === "normal" ? {} : { luckyAmount: c.luckyAmount }),
      idempotencyKey: cards.length === 1 ? id : `${id}:${i}`
    })
  )

/** Items joined by `sep` into as few messages as Telegram takes, never splitting an item. */
const fit = (items: ReadonlyArray<string>, sep: string) =>
  items.reduce<Array<string>>((out, item) => {
    const last = out.at(-1)
    if (last !== undefined && last.length + sep.length + item.length <= MESSAGE_MAX) out[out.length - 1] = last + sep + item
    else out.push(item)
    return out
  }, [])

/** Free text in pieces that each fit a message, cut at a space where there is one. Never for a code, PIN or link. */
const pieces = (text: string) => {
  const out: Array<string> = []
  let rest = text
  while (rest.length > MESSAGE_MAX) {
    const space = rest.lastIndexOf(" ", MESSAGE_MAX)
    const at = space > 0 ? space : MESSAGE_MAX
    out.push(rest.slice(0, at))
    rest = rest.slice(at).trimStart()
  }
  return [...out, rest]
}

/**
 * The Agent's reply and the code-written lines under it, as messages Telegram takes: one when both fit, otherwise the
 * reply first. The code-written lines end the last message, which carries the button.
 */
export const replyMessages = (reply: string, lines: ReadonlyArray<string> = []) =>
  fit([...(reply.trim() ? pieces(reply.trim()) : []), ...fit(lines, "\n")], "\n\n")

/**
 * One card's lines after a Buy tap: its code when delivered, or where it's at. Each line fits a message: Bitrefill's
 * free text comes in pieces, while a code, PIN or link is always one line.
 */
export const purchaseLines = (p: Purchase, web: string): Array<string> => {
  if (p.status === "waiting") {
    return [`Your ${p.voucherName} ${p.value} needs a little time: we're topping up our gift card supply, usually a few minutes, longer for big cards. You're only charged once it's ready, and you can cancel until then in the app under Purchases. I'll message you here when it's ready.`]
  }
  if (p.status === "pending") return [`Your ${p.voucherName} ${p.value} is on its way: Bitrefill usually sends the code within a minute. I'll message you here when it's ready.`]
  if (p.status !== "delivered") return [p.error ?? `Purchase ${p.status}.`]
  const paid = p.draw ? p.draw.finalPrice : p.referencePrice
  const diff = paid - p.referencePrice
  const r = redemptionFields(p.redemption)
  const lines = [
    `${p.voucherName} ${p.value} is yours.`,
    !p.draw
      ? `You paid ${usdUp(paid)}.`
      : p.draw.cashback === 0
      ? `No cashback this time: you paid ${usdUp(paid)}.`
      : `${paid === 0 ? "100% off!" : `${usd(p.draw.cashback)} cashback!`} You paid ${usdUp(paid)}${diff < 0 ? `, ${usd(-diff)} less than the price` : diff > 0 ? `, ${usd(diff)} above the price` : ", exactly the price"}.`,
    ...r.secrets.map((f) => `${f.label}: ${f.value}`),
    ...(r.other ? pieces(r.other) : []),
    r.link ? `Link: ${r.link}` : "",
    r.expires && !Number.isNaN(Date.parse(r.expires)) ? `Use it by ${dateText(r.expires)}.` : "",
    p.draw && p.settleTx ? `Draw Proof: ${web}/draw/${p.settleTx}` : ""
  ]
  return lines.filter(Boolean)
}

/**
 * Sends a Buy tap's cards (each as its lines) in as few messages as fit, a card whole where it fits in one, with no
 * link previews (Telegram would fetch the redemption link). A message Telegram won't take (down, rate-limited) is
 * skipped and the rest still go; then `fallback` sends one short notice, so a customer who was charged never sees only
 * "Buying…".
 */
export const deliver = async (
  send: (text: string, other: { link_preview_options: { is_disabled: true } }) => Promise<unknown>,
  cards: ReadonlyArray<ReadonlyArray<string>>,
  fallback: () => Promise<unknown>
) => {
  let failed = false
  for (const text of fit(cards.flatMap((lines) => fit(lines, "\n")), "\n\n")) {
    await send(text, { link_preview_options: { is_disabled: true } }).catch((e) => {
      failed = true
      console.error("telegram delivery failed:", describe(e))
    })
  }
  if (failed) await fallback()
}

/** A tap on "Change it": the new Checkout Email is saved only if the one it replaces is still the one on file. */
export const replaceCheckoutEmail = (
  purchases: Pick<Purchases["Service"], "checkoutEmail" | "setCheckoutEmail">,
  accountId: string,
  change: { readonly from: string; readonly to: string }
) =>
  Effect.gen(function*() {
    if ((yield* purchases.checkoutEmail(accountId)).email !== change.from) {
      return "Your card email changed since I asked, so I left it. Ask me again if you still want to change it."
    }
    const saved = yield* purchases.setCheckoutEmail(accountId, change.to)
    return `Done: your cards are now also emailed to ${saved.email}.`
  }).pipe(Effect.catch((e) => Effect.succeed(e.message)))

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
      const near = yield* Near
      const offline = `The assistant is offline right now. You can still buy in the web app: ${webOrigin}/shop`
      const ai = Option.isSome(aiKey) ? { apiKey: Redacted.value(aiKey.value), baseURL: aiBase, model: aiModel } : undefined
      const tee = ai && makeAttestation(ai, (message) => void Effect.runPromise(alerts.admin(message)))
      if (tee) yield* Effect.promise(tee.refresh).pipe(Effect.repeat(Schedule.spaced("1 hour")), Effect.forkScoped)
      const agent = ai && tee
        ? makeAgent({
          bitrefill: yield* Bitrefill,
          purchases,
          near,
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

      // ponytail: chat history lives in memory (lost on restart, one process).
      const history = new Map<number, { messages: Array<ChatCompletionMessageParam>; at: number }>()
      const offers = makeOffers()

      const linkedAccount = (telegramUserId: number) =>
        db(sql<{ account_id: string }>`SELECT account_id FROM telegram_links WHERE telegram_user_id = ${telegramUserId}`)
          .then((r) => r[0]?.account_id)

      bot.use(privateOnly)

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
        offers.sweep(now)
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
        if (limits.check(ctx.from.id)) return void ctx.reply("That's a lot of messages; give me a minute.")
        const accountId = await linkedAccount(ctx.from.id)
        if (!accountId) return void ctx.reply("Send /start to link your NEAR account first.")
        if (!agent) return void ctx.reply(offline)
        await ctx.replyWithChatAction("typing")
        // No passing TEE check on file, no chat: the model's replies couldn't be trusted.
        if (!(await tee!.ready())) return void ctx.reply(offline)
        // An account with nothing to buy with gets fewer messages a day. If NEAR can't say, it isn't held against them.
        const funded = await Effect.runPromise(
          near.view<{ balance: string } | null>("get_account", { account_id: accountId }).pipe(
            Effect.map((a) => Number(a?.balance ?? 0) >= MIN_PRICE),
            Effect.orElseSucceed(() => true)
          )
        )
        const over = limits.model(accountId, funded)
        if (over === "bot") {
          void Effect.runPromise(alerts.admin(
            `The Telegram Agent had ${UNFUNDED_BOT_MESSAGES_PER_DAY} messages today from accounts with no Balance; they get no answers until 00:00 UTC (funded customers still do). If that's real use, raise UNFUNDED_BOT_MESSAGES_PER_DAY.`
          ))
        }
        if (over) {
          return void ctx.reply(
            funded
              ? `That's all I can chat today. You can still buy in the web app: ${webOrigin}/shop`
              : `That's all I can chat today until you add funds at ${webOrigin}/wallet. You can browse cards at ${webOrigin}/shop`
          )
        }
        let failure: unknown
        // A forwarded message, or one sent through an inline bot, was written by someone else: the model
        // reads it, but it can't set the Checkout Email (ADR-0007).
        const turn = await agent(accountId, history.get(ctx.chat.id)?.messages ?? [], ctx.message.text, typedText(ctx.message)).catch((e) => {
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
        const offer = turn.offer
        if (!offer) {
          for (const text of replyMessages(turn.reply || "…")) await ctx.reply(text)
          return
        }
        const { id, withdrawn } = offers.add({ offer, telegramUserId: ctx.from.id, accountId, chatId: ctx.chat.id })
        for (const w of withdrawn) {
          if (w.messageId) void bot.api.editMessageReplyMarkup(w.chatId, w.messageId).catch(() => {})
        }
        const total = "cards" in offer ? offer.cards.reduce((s, c) => s + c.maxPrice, 0) : 0
        const [lines, keyboard] = "email" in offer
          ? [
            [`Your cards are also emailed to ${offer.email.from} now. Change that to ${offer.email.to}?`],
            new InlineKeyboard().text("Change it", `email:${id}`).text("Keep it", `cancel:${id}`)
          ]
          : [
            buySummary(offer.cards).split("\n"),
            new InlineKeyboard()
              .text(offer.cards.length === 1 ? `Buy for ${usdUp(total)}` : `Buy ${offer.cards.length} cards for ${usdUp(total)}`, `buy:${id}`)
              .text("Cancel", `cancel:${id}`)
          ]
        // The button always sits on the message with the code-written lines, whatever the model wrote above them.
        const messages = replyMessages(turn.reply, lines)
        for (const text of messages.slice(0, -1)) await ctx.reply(text)
        const sent = await ctx.reply(messages.at(-1)!, { reply_markup: keyboard })
        offers.shownIn(id, sent.message_id)
      }))

      bot.callbackQuery(/^(buy|email|cancel):(.+)$/, async (ctx) => {
        const [, a, id] = ctx.match as RegExpMatchArray
        const action = a as "buy" | "email" | "cancel"
        // Only the customer it was made for, by its own kind of button, still linked to that wallet, and only once.
        const tap = offers.take(id!, ctx.from.id, action, action === "cancel" ? undefined : await linkedAccount(ctx.from.id))
        if ("refused" in tap) {
          if (tap.consumed) await ctx.editMessageReplyMarkup().catch(() => {})
          return void ctx.answerCallbackQuery({ text: tap.refused })
        }
        await ctx.editMessageReplyMarkup().catch(() => {})
        if (action === "cancel") return void ctx.answerCallbackQuery({ text: "Cancelled." })
        const { offer, accountId } = tap.held
        if ("email" in offer) {
          await ctx.answerCallbackQuery()
          return inChat(ctx.chat!.id, async () => void (await ctx.reply(await Effect.runPromise(replaceCheckoutEmail(purchases, accountId, offer.email)))))
        }
        await ctx.answerCallbackQuery({ text: "Buying…" })
        inChat(ctx.chat!.id, async () => {
          const items = purchaseItems(id!, offer.cards)
          const lost = `I couldn't send all of your purchase details here. See them, and any codes, at ${webOrigin}/purchases`
          // Something unexpected: whether it went through is unknown, so send them to their purchases rather than say it failed.
          const unsure = `Something went wrong on my side, so I can't tell whether that went through. Check ${webOrigin}/purchases before buying again.`
          const outcome = await Effect.runPromise(
            (items.length === 1 ? Effect.map(purchases.create(accountId, items[0]!), (one) => [one]) : purchases.createCart(accountId, items)).pipe(
              Effect.match({
                onFailure: (e) => ({ cards: [[e.message]], notice: e.message }),
                onSuccess: (bought) => ({ cards: bought.map((p) => purchaseLines(p, webOrigin)), notice: lost })
              }),
              Effect.catchCause((cause) => Effect.as(Effect.logError("telegram buy failed", cause), { cards: [[unsure]], notice: unsure }))
            )
          )
          await deliver((text, other) => ctx.reply(text, other), outcome.cards, () =>
            Effect.runPromise(alerts.customer(accountId, outcome.notice).pipe(Effect.repeat({ schedule: Schedule.spaced("30 seconds"), until: (sent) => sent, times: 3 }))))
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
