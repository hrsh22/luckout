import { AgentAttestation, MAX_CART, NewPurchase, NotFound, type Purchase, redemptionFields } from "@luckout/api"
import { PublicKey } from "@solana/web3.js"
import { Config, Context, Effect, Layer, Option, Redacted, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { Bot, GrammyError, InlineKeyboard } from "grammy"
import type { PhotoSize } from "grammy/types"
import { randomUUID } from "node:crypto"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import { dateText, type DepositTo, makeAgent, modeName, type Offer, type Pending, trimHistory, usd, usdUp, worksIn } from "./Agent.ts"
import { Alerts } from "./Alerts.ts"
import { makeAttestation } from "./Attestation.ts"
import { Bitrefill, MIN_PRICE } from "./Bitrefill.ts"
import { accountOf, Deposits } from "./Deposits.ts"
import { Purchases } from "./Purchases.ts"
import { closedMessage, Sales } from "./Sales.ts"
import { Cluster, Solana, SolanaUnavailable } from "./Solana.ts"
import { TopUp } from "./TopUp.ts"

/** How long a button under the Agent's reply works (ADR-0007). */
const OFFER_TTL_MS = 10 * 60 * 1000
/**
 * How long a confirmed Buy waits for the money its Balance lacks: until its quote expires, counted from the quote
 * (ADR-0015, amending ADR-0007). Money that lands later stays in the Balance.
 */
export const QUOTE_TTL_MS = 30 * 60_000
/** How often the Buy taps waiting for their money look at the Balance. */
const WAITING_POLL = "15 seconds"
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
 * account and by Telegram user alike, so re-linking either to another doesn't start the count over.
 */
export const messageLimits = (
  o = { perMinute: MESSAGES_PER_MINUTE, perDay: MESSAGES_PER_DAY, unfundedPerDay: UNFUNDED_MESSAGES_PER_DAY, unfundedBotPerDay: UNFUNDED_BOT_MESSAGES_PER_DAY }
) => {
  const minutes = new Map<number, { count: number; resetAt: number }>()
  /** Today's messages by `account:<id>` and by `telegram:<id>`. */
  const days = new Map<string, { count: number; day: number }>()
  const usedToday = (accountId: string, userId: number, day: number) =>
    Math.max(...[`account:${accountId}`, `telegram:${userId}`].map((k) => (days.get(k)?.day === day ? days.get(k)!.count : 0)))
  let unfunded = { count: 0, day: 0 }
  return {
    /** Every message, before anything else: "minute" when this user is over theirs. */
    check: (userId: number, now = Date.now()): "minute" | undefined => {
      const w = minutes.get(userId)
      if (!w || w.resetAt < now) minutes.set(userId, { count: 1, resetAt: now + 60_000 })
      else if (++w.count > o.perMinute) return "minute"
      return undefined
    },
    /** Whether this account or Telegram user has had today's highest allowance: known without reading their Balance. */
    capped: (accountId: string, userId: number, now = Date.now()) => usedToday(accountId, userId, Math.floor(now / 86_400_000)) >= o.perDay,
    /**
     * A message about to reach the model, counted only if it goes ahead: "day" when this account or Telegram user has had
     * today's (fewer with no Balance to buy with), "bot" when accounts with no Balance have had today's, all together.
     */
    model: (accountId: string, userId: number, funded: boolean, now = Date.now()): "day" | "bot" | undefined => {
      const day = Math.floor(now / 86_400_000)
      if (unfunded.day !== day) unfunded = { count: 0, day }
      const used = usedToday(accountId, userId, day)
      if (used >= (funded ? o.perDay : o.unfundedPerDay)) return "day"
      // Only accounts with no Balance count toward the whole bot's cap, so it never turns away a customer who can buy.
      if (!funded) {
        if (unfunded.count >= o.unfundedBotPerDay) return "bot"
        unfunded.count++
      }
      days.set(`account:${accountId}`, { count: used + 1, day })
      days.set(`telegram:${userId}`, { count: used + 1, day })
      return undefined
    },
    /** Forgets counters that no longer count. */
    sweep: (now = Date.now()) => {
      for (const [k, w] of minutes) if (w.resetAt < now) minutes.delete(k)
      for (const [k, d] of days) if (d.day !== Math.floor(now / 86_400_000)) days.delete(k)
    }
  }
}

// ponytail: in memory, one process; swept with the rest.
/**
 * Whether an account has a Balance to buy with, read from Solana at most once a minute per account, so a chatty or capped
 * account costs one read a minute. A failed read counts as funded (a paying customer is never shut out because the RPC
 * didn't answer), but only until that minute is up.
 */
export const fundedCheck = (read: (accountId: string) => Promise<boolean>, ttl = 60_000) => {
  const known = new Map<string, { funded: boolean; until: number }>()
  return {
    funded: async (accountId: string, now = Date.now()) => {
      const k = known.get(accountId)
      if (k && k.until > now) return k.funded
      const funded = await read(accountId).catch(() => true)
      known.set(accountId, { funded, until: now + ttl })
      return funded
    },
    sweep: (now = Date.now()) => {
      for (const [id, k] of known) if (k.until <= now) known.delete(id)
    }
  }
}

/**
 * The lines under the Agent's reply, written by code: exactly what the button buys, and where the receipt goes. One
 * line for one card; several are numbered, with their total.
 */
export const buySummary = (cards: ReadonlyArray<Pending>, short = 0) => {
  const receipt = cards[0]?.receiptTo ? ` Also emailed to ${cards[0].receiptTo}.` : ""
  // Their tap waits for the money (waitingRound): said by code, so the button's promise is exact.
  const wait = short > 0
    ? ` Your balance is ${usdUp(short)} short: tap Buy and I'll buy ${cards.length === 1 ? "it" : "them"} once the money lands, within 30 minutes.`
    : ""
  if (cards.length === 1) return cardLine(cards[0]!) + receipt + wait
  const total = cards.reduce((s, c) => s + c.maxPrice, 0)
  return [...cards.map((c, i) => `${i + 1}. ${cardLine(c)}`), `${cards.length} cards: ${usdUp(total)} in all.${receipt}${wait}`].join("\n")
}

/**
 * The code-written lines for a Deposit Address, or for 1Click's address for another chain's token: the address alone on
 * the last, so it copies whole.
 */
export const depositLines = (d: DepositTo, now = Date.now()) => {
  const c = d.oneClick
  if (!c) {
    return [
      `Send at least ${usdUp(d.amount)} of ${d.token} on ${d.chain} to your Deposit Address below. It reaches your balance by itself${
        d.tapInApp ? " after one tap in the app" : " within a few minutes"
      }.`,
      d.address
    ]
  }
  const until = Date.parse(c.until)
  return [
    `Send ${c.send} ${d.token} on ${d.chain} to 1Click's address below within ${Math.max(1, Math.round((until - now) / 60_000))} minutes (by ${utc(until)}), and about ${usd(d.amount)} lands in your balance. Only ${d.token} on ${d.chain}: another token or network can't be swapped.`,
    `More is fine, it's all swapped${c.least ? `, but at least ${c.least} ${d.token} must arrive` : ""}. If the swap fails, 1Click refunds it to ${c.refundTo} on ${d.chain}.`,
    ...(c.memo ? [`Include this memo, or 1Click can't match your transfer: ${c.memo}`] : []),
    d.address
  ]
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

/**
 * What the customer wrote themselves (a photo's caption counts, the photo doesn't): nothing for a forwarded message, or
 * one sent through an inline bot (ADR-0007).
 */
export const typedText = (m: { readonly text?: string; readonly caption?: string; readonly forward_origin?: unknown; readonly via_bot?: unknown }) =>
  m.forward_origin || m.via_bot ? "" : m.text ?? m.caption ?? ""

/** The size of a photo to send the model: the largest up to 1280 px, plenty for a screenshot and fewer tokens than full size. */
export const photoSize = <P extends { readonly width: number; readonly height: number }>(sizes: ReadonlyArray<P>): P | undefined => {
  const fit = sizes.filter((s) => Math.max(s.width, s.height) <= 1280)
  return fit.length ? fit.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a)) : sizes[0]
}

interface Held {
  readonly offer: Offer
  readonly telegramUserId: number
  readonly accountId: string
  readonly chatId: number
  /** The message its buttons are on, once sent: withdrawing the offer takes them off. */
  messageId?: number
  /** When its cards were quoted: a tap may wait for its money until QUOTE_TTL_MS after this. */
  readonly quotedAt: number
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
    add: (o: Omit<Held, "expires" | "messageId" | "quotedAt">, now = Date.now()) => {
      const withdrawn = [...held].filter(([, h]) => h.telegramUserId === o.telegramUserId)
      for (const [id] of withdrawn) held.delete(id)
      const id = randomUUID()
      held.set(id, { ...o, quotedAt: now, expires: now + ttl })
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
 * The purchases a Buy tap makes: each card at the most it showed, which the program won't debit past (max_debit). The offer's id
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
 * The Agent's reply and the Buy lines (replyMessages). When the card lines need more than one message, the total on the
 * button's message says which cards are in the messages above it.
 */
export const buyMessages = (reply: string, cards: ReadonlyArray<Pending>, short = 0) => {
  const lines = buySummary(cards, short).split("\n")
  const total = lines.pop()!
  // Fitted with room for the longest note, so the one it gets always fits.
  const roomy = `${total} Cards 1 to ${MAX_CART} are in the messages above.`
  const messages = replyMessages(reply, [...lines, roomy])
  const onLast = fit([...lines, roomy], "\n").at(-1)!.split("\n").length - 1
  const above = lines.length - onLast
  const note = above === 0 ? "" : above === 1 ? " Card 1 is in the message above." : ` Cards 1 to ${above} are in the messages above.`
  return [...messages.slice(0, -1), messages.at(-1)!.slice(0, -roomy.length) + total + note]
}

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
  const messages: Array<string> = []
  // Whether the last message ends with a whole card, so the next may join it; a split card's last lines stand alone.
  let open = false
  for (const lines of cards) {
    const blocks = fit(lines, "\n")
    const last = messages.at(-1)
    if (open && blocks.length === 1 && last!.length + 2 + blocks[0]!.length <= MESSAGE_MAX) messages[messages.length - 1] = `${last}\n\n${blocks[0]}`
    else messages.push(...blocks)
    open = blocks.length === 1
  }
  let failed = false
  for (const text of messages) {
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
    // The Agent can't act on a tap, so nothing is prepared after this one: say what to do next in code, not by the model.
    return `Done: your cards are now also emailed to ${saved.email}. Tell me what you'd like to buy and I'll set it up.`
  }).pipe(Effect.catch((e) => Effect.succeed(e.message)))

/** Disconnects Telegram here. Privy keeps its own link: the next sign-in with it connects the chat again (Auth.ts). */
export const unlinkAccount = (accountId: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DELETE FROM telegram_links WHERE account_id = ${accountId}`).pipe(Effect.asVoid, Effect.orDie)

/** A Buy tap waiting for the money its Balance lacks (waitingRound). */
export interface Waiting {
  /** The offer's id: it keys the purchases, so buying twice buys once. */
  readonly id: string
  readonly accountId: string
  readonly chatId: number | string
  readonly cards: ReadonlyArray<Pending>
  /** When its quote expires. */
  readonly expiresAt: Date
  /** The Balance when they tapped, in micro-USDC: money that lands is measured from it. */
  readonly balance: number
}

/** Keeps a Buy tap until its money lands or its quote expires. The same tap again changes nothing. */
export const holdBuy = (w: Waiting) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`INSERT INTO pending_buys (id, account_id, chat_id, cards, balance, expires_at)
        VALUES (${w.id}, ${w.accountId}, ${String(w.chatId)}, ${JSON.stringify(w.cards)}::jsonb, ${w.balance}, ${w.expiresAt})
        ON CONFLICT (id) DO NOTHING`).pipe(Effect.asVoid, Effect.orDie)

const utc = (at: number) => `${new Date(at).toISOString().slice(11, 16)} UTC`

/**
 * One look at every Buy tap waiting for its money (ADR-0015). Once the Balance covers its cards it buys them, each at
 * the most it showed (the program refuses a card whose price moved past it, and `buy` says so). One whose quote expired
 * is dropped and nothing is bought; its money stays in the Balance. Money that lands short is said once, with what's
 * still missing, and nothing is bought. A Balance that can't be read waits for the next look.
 */
export const waitingRound = (deps: {
  readonly balance: (accountId: string) => Effect.Effect<number, unknown>
  /** Buys the cards and tells the chat what came of it. */
  readonly buy: (w: { readonly id: string; readonly accountId: string; readonly chatId: string; readonly cards: ReadonlyArray<Pending> }) => Effect.Effect<void>
  readonly say: (chatId: string, text: string) => Effect.Effect<void>
}, at?: number) =>
  Effect.gen(function*() {
    // Read on every round: the same Effect runs again and again.
    const now = at ?? Date.now()
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ id: string; account_id: string; chat_id: string; cards: ReadonlyArray<Pending>; balance: string; expires_at: Date | string }>`
      SELECT id, account_id, chat_id::text AS chat_id, cards, balance::text AS balance, expires_at FROM pending_buys ORDER BY created_at`
    for (const r of rows) {
      const w = { id: r.id, accountId: r.account_id, chatId: r.chat_id, cards: r.cards }
      const total = r.cards.reduce((s, c) => s + c.maxPrice, 0)
      const what = r.cards.length === 1 ? `your ${r.cards[0]!.voucherName} ${r.cards[0]!.value}` : `your ${r.cards.length} cards`
      if (new Date(r.expires_at).getTime() <= now) {
        // Dropped before it's said, so it's said once.
        const [gone] = yield* sql`DELETE FROM pending_buys WHERE id = ${r.id} RETURNING id`
        if (gone) yield* deps.say(r.chat_id, `The money for ${what} didn't arrive within 30 minutes, so I didn't buy it. Anything that lands stays in your balance; ask me again when you're ready.`)
        continue
      }
      const balance = yield* deps.balance(r.account_id).pipe(Effect.option)
      if (Option.isNone(balance)) continue
      if (balance.value >= total) {
        // Bought before it's dropped: after a crash it's bought again under the same keys, which buys nothing new.
        yield* deps.buy(w)
        yield* sql`DELETE FROM pending_buys WHERE id = ${r.id}`
        continue
      }
      const was = Number(r.balance)
      if (balance.value === was) continue
      yield* sql`UPDATE pending_buys SET balance = ${balance.value} WHERE id = ${r.id}`
      if (balance.value > was) {
        yield* deps.say(
          r.chat_id,
          `${usd(balance.value - was)} arrived, but your balance is still ${usdUp(total - balance.value)} short of ${usdUp(total)}, so I haven't bought ${what}. Send ${usdUp(total - balance.value)} more by ${utc(new Date(r.expires_at).getTime())} and I'll buy it then.`
        )
      }
    }
  }).pipe(Effect.orDie)

interface Status {
  readonly linked: boolean
  readonly telegramName?: string
  readonly botUrl?: string
}

// Linking (ADR-0015): the customer signs in with Telegram in Privy's window, and Auth.ts records the link Privy reports.
// So only someone who proved both the wallet and the Telegram account links them; the bot issues nothing.
export class Telegram extends Context.Service<Telegram, {
  status(accountId: string): Effect.Effect<Status>
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
      const testnet = (yield* Cluster) !== "mainnet"

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
      const unlink = (accountId: string) => withSql(unlinkAccount(accountId))

      if (!bot) {
        yield* Effect.logInfo("TELEGRAM_BOT_TOKEN not set: the Telegram Agent is off")
        return Telegram.of({ status, unlink, attestation: Effect.fail(new NotFound()) })
      }
      if (Option.isNone(aiKey)) {
        yield* Effect.logWarning("NEAR_AI_API_KEY not set: the bot answers /start but can't chat")
      }

      const purchases = yield* Purchases
      const alerts = yield* Alerts
      const solana = yield* Solana
      const deposits = yield* Deposits
      const customer = (accountId: string) =>
        Effect.try({ try: () => new PublicKey(accountId), catch: () => new SolanaUnavailable({ message: `${accountId} isn't a Solana wallet` }) }).pipe(
          Effect.flatMap(solana.customer)
        )
      const balanceOf = (accountId: string) => Effect.map(customer(accountId), (c) => Number(c?.balance ?? 0n))
      /** What a stranger to the bot is told: linking is signing in with Telegram once, in the app. */
      const signInFirst = `Welcome to Luckout. To buy from here, sign in at ${webOrigin} with Telegram; that links this chat. Then tell me what you'd like.`
      const offline = `The assistant is offline right now. You can still buy in the web app: ${webOrigin}/shop`
      const ai = Option.isSome(aiKey) ? { apiKey: Redacted.value(aiKey.value), baseURL: aiBase, model: aiModel } : undefined
      const tee = ai && makeAttestation(ai, (message) => void Effect.runPromise(alerts.admin(message)))
      if (tee) yield* Effect.promise(tee.refresh).pipe(Effect.repeat(Schedule.spaced("1 hour")), Effect.forkScoped)
      const agent = ai && tee
        ? makeAgent({
          bitrefill: yield* Bitrefill,
          purchases,
          account: (accountId) => Effect.map(customer(accountId), accountOf),
          deposits,
          topUp: yield* TopUp,
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
      /** Buys an offer's cards (keyed by its id, so a repeat buys nothing new) and sends the chat each card's lines. */
      const buy = async (w: { readonly id: string; readonly accountId: string; readonly chatId: string; readonly cards: ReadonlyArray<Pending> }) => {
        const items = purchaseItems(w.id, w.cards)
        const lost = `I couldn't send all of your purchase details here. See them, and any codes, at ${webOrigin}/purchases`
        // Something unexpected: whether it went through is unknown, so send them to their purchases rather than say it failed.
        const unsure = `Something went wrong on my side, so I can't tell whether that went through. Check ${webOrigin}/purchases before buying again.`
        const outcome = await Effect.runPromise(
          (items.length === 1 ? Effect.map(purchases.create(w.accountId, items[0]!), (one) => [one]) : purchases.createCart(w.accountId, items)).pipe(
            Effect.match({
              onFailure: (e) => ({ cards: [[e.message]], notice: e.message }),
              onSuccess: (bought) => ({ cards: bought.map((p) => purchaseLines(p, webOrigin)), notice: lost })
            }),
            Effect.catchCause((cause) => Effect.as(Effect.logError("telegram buy failed", cause), { cards: [[unsure]], notice: unsure }))
          )
        )
        await deliver((text, other) => bot.api.sendMessage(w.chatId, text, other), outcome.cards, () =>
          Effect.runPromise(alerts.customer(w.accountId, outcome.notice).pipe(Effect.repeat({ schedule: Schedule.spaced("30 seconds"), until: (sent) => sent, times: 3 }))))
      }
      const say = (chatId: string, text: string) =>
        Effect.promise(() => bot.api.sendMessage(chatId, text).then(() => undefined, (e) => void console.error("telegram notice failed:", describe(e))))
      // Each waiting tap's purchase runs in its chat's order, after whatever that chat is doing.
      yield* waitingRound({
        balance: balanceOf,
        buy: (w) => Effect.promise(() => new Promise<void>((done) => inChat(Number(w.chatId), () => buy(w).finally(done)))),
        say
      }).pipe(
        withSql,
        Effect.catchCause((cause) => Effect.logError("telegram: the waiting Buy taps' round failed", cause)),
        Effect.repeat(Schedule.spaced(WAITING_POLL)),
        Effect.forkScoped
      )

      const limits = messageLimits()
      const balances = fundedCheck((accountId) => Effect.runPromise(Effect.map(balanceOf(accountId), (b) => b >= MIN_PRICE)))
      // Every few minutes, forget what can't matter any more: expired buttons, quiet chats, old counters.
      yield* Effect.sync(() => {
        const now = Date.now()
        offers.sweep(now)
        for (const [chat, h] of history) if (h.at < now - IDLE_MS) history.delete(chat)
        limits.sweep(now)
        balances.sweep(now)
      }).pipe(Effect.repeat(Schedule.spaced("5 minutes")), Effect.forkScoped)

      // A /start with a payload (an old link code) is answered like any other.
      bot.command("start", async (ctx) => {
        const accountId = await linkedAccount(ctx.from!.id)
        history.delete(ctx.chat.id)
        await ctx.reply(
          accountId
            ? `You're linked to ${accountId}. Tell me what you want, like ${testnet ? `"a $10 test gift card" (this is the test shop)` : `"a ₹500 Swiggy voucher"`}. Nothing is bought until you tap Buy.`
            : signInFirst
        )
      })

      // So the operator can find their chat id for ALERT_TELEGRAM_CHAT_ID.
      bot.command("chatid", (ctx) => ctx.reply(`This chat's id is ${ctx.chat.id}.`))

      /** A photo as the model takes it: a data URL (Telegram stores photos as JPEG). */
      const photoUrl = async (sizes: ReadonlyArray<PhotoSize>) => {
        const file = await bot.api.getFile(photoSize(sizes)!.file_id)
        if (!file.file_path) throw new Error("Telegram gave no file path")
        // The URL holds the bot token: never log it.
        const res = await fetch(`https://api.telegram.org/file/bot${bot.token}/${file.file_path}`, { signal: AbortSignal.timeout(20_000) })
        if (!res.ok) throw new Error(`Telegram file download answered ${res.status}`)
        return `data:image/jpeg;base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`
      }

      // ponytail: each photo of an album arrives as its own message, so it gets its own reply; group them by
      // media_group_id if people send albums.
      bot.on(["message:text", "message:photo"], (ctx) => inChat(ctx.chat.id, async () => {
        if (limits.check(ctx.from.id)) return void ctx.reply("That's a lot of messages; give me a minute.")
        const accountId = await linkedAccount(ctx.from.id)
        if (!accountId) return void ctx.reply(signInFirst)
        if (!agent) return void ctx.reply(offline)
        await ctx.replyWithChatAction("typing")
        // No passing TEE check on file, no chat: the model's replies couldn't be trusted.
        if (!(await tee!.ready())) return void ctx.reply(offline)
        const capped = `That's all I can chat today. You can still buy in the web app: ${webOrigin}/shop`
        // The cap that needs no Balance first; then an account with nothing to buy with gets fewer (fundedCheck).
        if (limits.capped(accountId, ctx.from.id)) return void ctx.reply(capped)
        const funded = await balances.funded(accountId)
        const over = limits.model(accountId, ctx.from.id, funded)
        if (over === "bot") {
          void Effect.runPromise(alerts.admin(
            `The Telegram Agent had ${UNFUNDED_BOT_MESSAGES_PER_DAY} messages today from accounts with no Balance; they get no answers until 00:00 UTC (funded customers still do). If that's real use, raise UNFUNDED_BOT_MESSAGES_PER_DAY.`
          ))
        }
        if (over) return void ctx.reply(funded ? capped : `That's all I can chat today until you add funds at ${webOrigin}/wallet. You can browse cards at ${webOrigin}/shop`)
        const photo = ctx.message.photo
        const image = photo && await photoUrl(photo).catch((e) => void console.error("telegram photo download failed:", describe(e)))
        if (photo && !image) return void ctx.reply("I couldn't open that photo. Try sending it again.")
        let failure: unknown
        // A forwarded message, or one sent through an inline bot, was written by someone else: the model
        // reads it, but it can't set the Checkout Email (ADR-0007). Nor can a photo: only its caption is typed.
        const turn = await agent(accountId, history.get(ctx.chat.id)?.messages ?? [], ctx.message.text ?? ctx.message.caption ?? "", typedText(ctx.message), image).catch((e) => {
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
        // The Deposit Address goes in code-written messages after the reply, the address alone in the last.
        const depositTo = async () => {
          for (const text of turn.deposit ? depositLines(turn.deposit) : []) await ctx.reply(text)
        }
        if (!offer) {
          for (const text of replyMessages(turn.reply || "…")) await ctx.reply(text)
          return depositTo()
        }
        const { id, withdrawn } = offers.add({ offer, telegramUserId: ctx.from.id, accountId, chatId: ctx.chat.id })
        for (const w of withdrawn) {
          if (w.messageId) void bot.api.editMessageReplyMarkup(w.chatId, w.messageId).catch(() => {})
        }
        const total = "cards" in offer ? offer.cards.reduce((s, c) => s + c.maxPrice, 0) : 0
        // The button always sits on the message with the code-written lines, whatever the model wrote above them.
        const [messages, keyboard] = "email" in offer
          ? [
            replyMessages(turn.reply, [`Your cards are also emailed to ${offer.email.from} now. Change that to ${offer.email.to}?`]),
            new InlineKeyboard().text("Change it", `email:${id}`).text("Keep it", `cancel:${id}`)
          ]
          : [
            buyMessages(turn.reply, offer.cards, offer.short),
            new InlineKeyboard()
              .text(`${offer.cards.length === 1 ? "Buy" : `Buy ${offer.cards.length} cards`} for ${usdUp(total)}${offer.short ? " once paid" : ""}`, `buy:${id}`)
              .text("Cancel", `cancel:${id}`)
          ]
        for (const text of messages.slice(0, -1)) await ctx.reply(text)
        const sent = await ctx.reply(messages.at(-1)!, { reply_markup: keyboard })
        offers.shownIn(id, sent.message_id)
        await depositTo()
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
        const total = offer.cards.reduce((s, c) => s + c.maxPrice, 0)
        const chatId = ctx.chat!.id
        // Short of money now: the tap waits for it until the quote expires (waitingRound). A Balance that can't be read
        // is tried as it is, and the program refuses what it can't cover.
        const balance = await Effect.runPromise(balanceOf(accountId).pipe(Effect.orElseSucceed(() => undefined)))
        if (balance !== undefined && balance < total) {
          const expiresAt = tap.held.quotedAt + QUOTE_TTL_MS
          await db(withSql(holdBuy({ id: id!, accountId, chatId, cards: offer.cards, expiresAt: new Date(expiresAt), balance })))
          await ctx.answerCallbackQuery({ text: "Waiting for your money…" })
          return void ctx.reply(
            `I'll buy ${offer.cards.length === 1 ? "it" : "them"} as soon as ${usdUp(total - balance)} more lands in your balance, until ${utc(expiresAt)}. Ask me where to send it if you haven't yet.`
          )
        }
        await ctx.answerCallbackQuery({ text: "Buying…" })
        inChat(chatId, () => buy({ id: id!, accountId, chatId: String(chatId), cards: offer.cards }))
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
      return Telegram.of({ status, unlink, attestation })
    })
  )
}
