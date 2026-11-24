import { CheckoutEmail, Purchase, PurchaseInvalid, redemptionFields } from "@luckout/api"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { GrammyError } from "grammy"
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Pending } from "./Agent.ts"
import { DbMemory } from "./Db.ts"
import {
  addLinkCode,
  buySummary,
  deliver,
  describe,
  makeOffers,
  messageLimits,
  privateOnly,
  purchaseItems,
  purchaseMessage,
  redeemLinkCode,
  replaceCheckoutEmail,
  typedText,
  unlinkAccount
} from "./Telegram.ts"

// Linking and limits on an in-memory database; no bot needed.

const run = <A, E>(e: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.runPromise(e.pipe(Effect.provide(DbMemory)))
const soon = () => new Date(Date.now() + 10 * 60_000)
const alice = { id: 1, chatId: 101, name: "@alice" }
const mallory = { id: 2, chatId: 202, name: "@mallory" }

test("a failed send is logged without the message it carried", () => {
  const e = new GrammyError(
    "Call to 'sendMessage' failed! (403: Forbidden: bot was blocked by the user)",
    { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
    "sendMessage",
    { chat_id: 101, text: "Test Card 10 is yours.\nCode: SECRET-123\nPIN: 9876" }
  )
  assert.equal(describe(e), "sendMessage: 403 Forbidden: bot was blocked by the user")
  assert.equal(describe(new TypeError("fetch failed")), "TypeError: fetch failed")
  assert.equal(describe({ payload: { text: "Code: SECRET-123" } }), "object")
})

test("a card's code and PIN are labelled from wherever Bitrefill puts them", () => {
  // Swiggy: the gift code comes as `pin`, the PIN in extraFields, and `other` repeats it.
  const swiggy = redemptionFields({ pin: "GIFTCODE00000001", other: "PIN Code: 123456", expirationTime: "2027-03-30T00:00:00.000Z", extraFields: { "PIN Code": "123456" } })
  assert.deepEqual(swiggy.secrets, [{ label: "Code", value: "GIFTCODE00000001" }, { label: "PIN Code", value: "123456" }])
  assert.equal(swiggy.other, undefined, "a repeat of the PIN isn't shown twice")
  assert.equal(swiggy.expires, "2027-03-30T00:00:00.000Z")
  assert.deepEqual(redemptionFields({ code: "SECRET-123", pin: "9876" }).secrets, [{ label: "Code", value: "SECRET-123" }, { label: "PIN", value: "9876" }])
  assert.deepEqual(redemptionFields({ pin: "9876", other: "Dial *123#" }), { secrets: [{ label: "PIN", value: "9876" }], other: "Dial *123#", link: undefined, instructions: undefined, expires: undefined })
  assert.deepEqual(redemptionFields(undefined).secrets, [])
})

test("only the latest link works, and disconnecting cancels links not opened yet", () =>
  run(Effect.gen(function*() {
    yield* addLinkCode("alice.testnet", "first", soon())
    yield* addLinkCode("alice.testnet", "second", soon())
    assert.equal(yield* redeemLinkCode("first", alice), undefined, "replaced by the second link")
    yield* addLinkCode("alice.testnet", "third", soon())
    yield* unlinkAccount("alice.testnet")
    assert.equal(yield* redeemLinkCode("third", alice), undefined, "cancelled by disconnecting")
    const sql = yield* SqlClient.SqlClient
    assert.deepEqual(yield* sql`SELECT code FROM telegram_link_codes`, [])
  })))

test("a link that replaces another chat says which, so that chat can be told", () =>
  run(Effect.gen(function*() {
    yield* addLinkCode("bob.testnet", "a", soon())
    assert.deepEqual(yield* redeemLinkCode("a", alice), { accountId: "bob.testnet" })
    yield* addLinkCode("bob.testnet", "b", soon())
    assert.deepEqual(yield* redeemLinkCode("b", alice), { accountId: "bob.testnet" }, "same chat again: nothing to tell")
    yield* addLinkCode("bob.testnet", "c", soon())
    assert.deepEqual(yield* redeemLinkCode("c", mallory), { accountId: "bob.testnet", replacedChat: "101" })
    assert.equal(yield* redeemLinkCode("c", alice), undefined, "a code links once")
    const sql = yield* SqlClient.SqlClient
    const links = yield* sql<{ telegram_user_id: string | number }>`SELECT telegram_user_id FROM telegram_links WHERE account_id = 'bob.testnet'`
    assert.deepEqual(links.map((l) => Number(l.telegram_user_id)), [2])
  })))

test("each Telegram user gets so many messages a minute", () => {
  const limits = messageLimits({ perMinute: 2, perDay: 100, unfundedPerDay: 100, botPerDay: 100 })
  const t = Date.UTC(2026, 10, 11, 12)
  assert.equal(limits.check(1, t), undefined)
  assert.equal(limits.check(1, t), undefined)
  assert.equal(limits.check(1, t), "minute")
  assert.equal(limits.check(2, t), undefined, "another user has their own")
  limits.sweep(t + 61_000)
  assert.equal(limits.check(1, t + 61_000), undefined, "a new minute")
})

test("messages that reach the model: fewer a day for an account with no Balance, and a cap for the whole bot", () => {
  const limits = messageLimits({ perMinute: 100, perDay: 3, unfundedPerDay: 1, botPerDay: 5 })
  const t = Date.UTC(2026, 10, 11, 12)
  assert.equal(limits.model(1, false, t), undefined)
  assert.equal(limits.model(1, false, t), "day", "no Balance: one a day here")
  assert.equal(limits.model(1, true, t), undefined, "once funded, the funded allowance counts")
  assert.equal(limits.model(1, true, t), undefined)
  assert.equal(limits.model(1, true, t), "day")
  limits.sweep(t + 61_000)
  assert.equal(limits.model(1, true, t + 61_000), "day", "a sweep keeps today's count")
  assert.equal(limits.model(2, true, t), undefined)
  assert.equal(limits.model(3, true, t), undefined, "the bot's fifth today")
  assert.equal(limits.model(4, true, t), "bot", "the whole bot is over today's cap")
  assert.equal(limits.model(1, true, t + 86_400_000), undefined, "a new UTC day")
  assert.equal(limits.model(4, true, t + 86_400_000), undefined)
})

test("the Buy line says where the card is emailed, when it needs an email", () => {
  const p = { voucherId: "v", voucherName: "Swiggy", value: "500", currency: "INR", country: "IN", mode: "normal" as const, requestedMode: "normal" as const, maxPrice: 5_530_000, referencePrice: 5_530_000, luckyAmount: 0 }
  assert.equal(buySummary([p]), "Swiggy, 500 INR: $5.53. Works in India only.")
  assert.equal(buySummary([{ ...p, receiptTo: "me@example.com" }]), "Swiggy, 500 INR: $5.53. Works in India only. Also emailed to me@example.com.")
  assert.equal(buySummary([{ ...p, useBy: "2027-03-30T18:29:59.000Z" }]), "Swiggy, 500 INR: $5.53. Works in India only. Use it by about 30 March 2027.")
  // A cart: each card on its own line, then the total, and the email once.
  const lucky = { ...p, voucherName: "Amazon", value: "10", currency: "USD", country: "US", mode: { lucky: 1 } as const, requestedMode: { lucky: 1 } as const, maxPrice: 12_000_000, referencePrice: 10_000_000, luckyAmount: 10_000_000 }
  assert.equal(
    buySummary([{ ...p, receiptTo: "me@example.com" }, { ...lucky, receiptTo: "me@example.com" }]),
    "1. Swiggy, 500 INR: $5.53. Works in India only.\n2. Amazon, 10 USD on Classic: $12.00 now (price $10.00). Works in United States only.\n2 cards: $17.53 in all. Also emailed to me@example.com."
  )
})

test("a Lucky card bought at Normal says so on its Buy line", () => {
  const p = { voucherId: "v", voucherName: "Amazon", value: "10", currency: "USD", country: "US", mode: "normal" as const, requestedMode: { lucky: 1 } as const, maxPrice: 10_000_000, referencePrice: 10_000_000, luckyAmount: 0 }
  assert.equal(
    buySummary([p]),
    "Amazon, 10 USD: $10.00 on Normal: the Cashback Reserve can't cover Classic right now, so there's no Draw. Works in United States only."
  )
  assert.equal(buySummary([{ ...p, requestedMode: "normal" }]), "Amazon, 10 USD: $10.00. Works in United States only.", "Normal as asked: nothing to explain")
})

test("only private chats get through: the bot ignores groups and channels", async () => {
  const passed: Array<string> = []
  for (const type of ["private", "group", "supergroup", "channel"]) await privateOnly({ chat: { type } }, async () => void passed.push(type))
  await privateOnly({}, async () => void passed.push("no chat"))
  assert.deepEqual(passed, ["private"])
})

test("a forwarded or inline-bot message wasn't typed by the customer", () => {
  assert.equal(typedText({ text: "me@example.com" }), "me@example.com")
  assert.equal(typedText({ text: "me@example.com", forward_origin: { type: "user" } }), "")
  assert.equal(typedText({ text: "me@example.com", via_bot: { id: 1 } }), "")
})

const card = (over: Partial<Pending> = {}): Pending => ({
  voucherId: "v", voucherName: "Swiggy", value: "500", currency: "INR", country: "IN", mode: "normal", requestedMode: "normal", maxPrice: 5_530_000, referencePrice: 5_530_000, luckyAmount: 0, ...over
})

test("a button works once, only for the Telegram user it was made for, for 10 minutes, while they're still linked to that account", () => {
  const offers = makeOffers()
  const t = 1_000_000
  const offer = { offer: { cards: [card()] }, telegramUserId: 1, accountId: "alice.near", chatId: 101 }
  const a = offers.add(offer, t)
  assert.equal(offers.take(a.id, 2, "alice.near", t), "This offer expired. Ask again.", "someone else's tap")
  assert.equal(typeof offers.take(a.id, 1, "alice.near", t + 1), "object", "the customer's tap")
  assert.equal(offers.take(a.id, 1, "alice.near", t + 2), "This offer expired. Ask again.", "a second tap buys nothing")
  const b = offers.add(offer, t)
  assert.equal(offers.take(b.id, 1, "alice.near", t + 10 * 60_000 + 1), "This offer expired. Ask again.", "past 10 minutes")
  const c = offers.add(offer, t)
  assert.equal(offers.take(c.id, 1, "bob.near", t), "This Telegram account is no longer linked to that wallet.")
  assert.equal(offers.take(c.id, 1, "alice.near", t), "This offer expired. Ask again.", "refused once, gone")
  const d = offers.add(offer, t)
  assert.equal(offers.take(d.id, 1, undefined, t), "This Telegram account is no longer linked to that wallet.", "unlinked")
})

test("a new offer withdraws the same user's earlier ones, so their buttons can come off", () => {
  const offers = makeOffers()
  const first = offers.add({ offer: { cards: [card()] }, telegramUserId: 1, accountId: "alice.near", chatId: 101 })
  offers.shownIn(first.id, 7)
  const other = offers.add({ offer: { cards: [card()] }, telegramUserId: 2, accountId: "bob.near", chatId: 202 })
  const second = offers.add({ offer: { cards: [card(), card()] }, telegramUserId: 1, accountId: "alice.near", chatId: 101 })
  assert.deepEqual(second.withdrawn.map((w) => [w.chatId, w.messageId]), [[101, 7]])
  assert.equal(offers.take(first.id, 1, "alice.near"), "This offer expired. Ask again.", "the older cart can't be bought any more")
  assert.equal(typeof offers.take(other.id, 2, "bob.near"), "object", "another user's offer stands")
  assert.equal(typeof offers.take(second.id, 1, "alice.near"), "object")
})

test("a Buy tap's purchases: each card at the maximum it showed, keyed by the button so a repeat buys nothing new", () => {
  const lucky = card({ mode: { lucky: 1 }, requestedMode: { lucky: 1 }, maxPrice: 12_000_000, referencePrice: 10_000_000, luckyAmount: 10_000_000 })
  const [one] = purchaseItems("offer-0001", [lucky])
  assert.equal(one!.idempotencyKey, "offer-0001")
  assert.deepEqual([one!.mode, one!.maxPrice, one!.luckyAmount], [{ lucky: 1 }, 12_000_000, 10_000_000])
  const cart = purchaseItems("offer-0002", [card(), lucky, card({ mode: "normal", requestedMode: { lucky: 2 } })])
  assert.deepEqual(cart.map((p) => p.idempotencyKey), ["offer-0002:0", "offer-0002:1", "offer-0002:2"])
  assert.deepEqual(cart.map((p) => [p.mode, p.luckyAmount]), [["normal", undefined], [{ lucky: 1 }, 10_000_000], ["normal", undefined]], "a card going at Normal is bought at Normal")
})

const delivered = (n: number) =>
  new Purchase({
    id: `p${n}`, voucherId: "amazon-us", voucherName: "Amazon", value: "25", status: "delivered", referencePrice: 25_000_000, createdAt: new Date(0).toISOString(),
    redemption: { code: `CODE-${n}`, link: `https://example.com/redeem?token=${"x".repeat(200)}`, expirationTime: "2027-03-30T00:00:00.000Z" }
  })

test("a delivered card's message: what they paid, the code, the link and the use-by date", () => {
  const text = purchaseMessage(delivered(1), "https://luckout.test")
  assert.match(text, /^Amazon 25 is yours\.\nYou paid \$25\.00\.\nCode: CODE-1\nLink: https:\/\/example\.com\/redeem/)
  assert.match(text, /Use it by 30 March 2027\.$/)
})

test("a big cart's codes go in as few messages as fit, none split, with link previews off", async () => {
  const sent: Array<{ text: string; other: object }> = []
  let notices = 0
  const texts = Array.from({ length: 15 }, (_, i) => purchaseMessage(delivered(i), "https://luckout.test"))
  assert.ok(texts.join("\n\n").length > 4096, "too long for one Telegram message")
  await deliver(async (text, other) => void sent.push({ text, other }), texts, async () => void notices++)
  assert.ok(sent.length > 1 && sent.every((s) => s.text.length <= 4096))
  assert.deepEqual(sent.flatMap((s) => s.text.split("\n\n")), texts, "every card, whole, in order")
  assert.ok(sent.every((s) => JSON.stringify(s.other) === JSON.stringify({ link_preview_options: { is_disabled: true } })))
  assert.equal(notices, 0)
})

test("if Telegram won't take a delivery message, one short notice goes instead and nothing more is tried", async () => {
  let tries = 0
  let notices = 0
  await deliver(async () => {
    tries++
    throw new GrammyError("Call to 'sendMessage' failed! (400: Bad Request: message is too long)", { ok: false, error_code: 400, description: "Bad Request: message is too long" }, "sendMessage", {})
  }, ["Amazon 25 is yours.", "Swiggy 500 is yours."], async () => void notices++)
  assert.equal(tries, 1)
  assert.equal(notices, 1)
})

test("a tap on Change it saves the new Checkout Email, unless the one it replaces has changed since", async () => {
  let email = "me@example.com"
  const purchases = {
    checkoutEmail: () => Effect.sync(() => new CheckoutEmail({ needed: true, email })),
    setCheckoutEmail: (_: string, e: string) =>
      e.includes("@") ? Effect.sync(() => new CheckoutEmail({ needed: true, email: (email = e) })) : Effect.fail(new PurchaseInvalid({ message: "That doesn't look like an email address." }))
  }
  assert.match(await Effect.runPromise(replaceCheckoutEmail(purchases, "alice.near", { from: "other@example.com", to: "new@example.com" })), /changed since/)
  assert.equal(email, "me@example.com")
  assert.match(await Effect.runPromise(replaceCheckoutEmail(purchases, "alice.near", { from: "me@example.com", to: "nope" })), /doesn't look like an email/)
  assert.match(await Effect.runPromise(replaceCheckoutEmail(purchases, "alice.near", { from: "me@example.com", to: "new@example.com" })), /new@example\.com/)
  assert.equal(email, "new@example.com")
})
