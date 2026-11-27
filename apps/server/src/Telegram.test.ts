import { CheckoutEmail, Purchase, PurchaseInvalid, redemptionFields } from "@luckout/api"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { GrammyError } from "grammy"
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Pending } from "./Agent.ts"
import { DbMemory } from "./Db.ts"
import {
  buyMessages,
  buySummary,
  deliver,
  depositLines,
  describe,
  fundedCheck,
  holdBuy,
  makeOffers,
  messageLimits,
  photoSize,
  privateOnly,
  purchaseItems,
  purchaseLines,
  QUOTE_TTL_MS,
  replaceCheckoutEmail,
  replyMessages,
  typedText,
  unlinkAccount,
  waitingRound
} from "./Telegram.ts"

// The bot's pieces on an in-memory database; no bot needed.

const run = <A, E>(e: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.runPromise(e.pipe(Effect.provide(DbMemory)))

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

test("disconnecting Telegram here removes only that account's link", () =>
  run(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO telegram_links (telegram_user_id, account_id, chat_id) VALUES (1, 'alice', 1), (2, 'bob', 2)`
    yield* unlinkAccount("alice")
    assert.deepEqual((yield* sql<{ account_id: string }>`SELECT account_id FROM telegram_links`).map((r) => r.account_id), ["bob"])
  })))

test("each Telegram user gets so many messages a minute", () => {
  const limits = messageLimits({ perMinute: 2, perDay: 100, unfundedPerDay: 100, unfundedBotPerDay: 100 })
  const t = Date.UTC(2026, 10, 11, 12)
  assert.equal(limits.check(1, t), undefined)
  assert.equal(limits.check(1, t), undefined)
  assert.equal(limits.check(1, t), "minute")
  assert.equal(limits.check(2, t), undefined, "another user has their own")
  limits.sweep(t + 61_000)
  assert.equal(limits.check(1, t + 61_000), undefined, "a new minute")
})

test("messages that reach the model are counted per account and per Telegram user, fewer with no Balance, so re-linking starts nothing over", () => {
  const limits = messageLimits({ perMinute: 100, perDay: 3, unfundedPerDay: 1, unfundedBotPerDay: 100 })
  const t = Date.UTC(2026, 10, 11, 12)
  assert.equal(limits.model("alice.near", 1, false, t), undefined)
  assert.equal(limits.model("alice.near", 2, false, t), "day", "the same wallet linked to another Telegram account: its count carries on")
  assert.equal(limits.model("bob.near", 1, false, t), "day", "the same Telegram account linked to another wallet: its count carries on too")
  assert.equal(limits.model("carol.near", 3, false, t), undefined, "another wallet on another Telegram account has its own")
  assert.equal(limits.model("alice.near", 1, true, t), undefined, "once funded, the funded allowance counts")
  assert.equal(limits.model("alice.near", 1, true, t), undefined)
  assert.equal(limits.model("alice.near", 1, true, t), "day")
  limits.sweep(t + 61_000)
  assert.equal(limits.model("alice.near", 1, true, t + 61_000), "day", "a sweep keeps today's count")
  assert.equal(limits.model("alice.near", 1, true, t + 86_400_000), undefined, "a new UTC day")
})

test("a day's highest allowance used up is known without reading the Balance", () => {
  const limits = messageLimits({ perMinute: 100, perDay: 2, unfundedPerDay: 1, unfundedBotPerDay: 100 })
  const t = Date.UTC(2026, 10, 11, 12)
  assert.equal(limits.capped("alice.near", 1, t), false)
  limits.model("alice.near", 1, true, t)
  assert.equal(limits.capped("alice.near", 1, t), false, "one left at the funded allowance: the Balance decides")
  limits.model("alice.near", 1, true, t)
  assert.equal(limits.capped("alice.near", 1, t), true)
  assert.equal(limits.capped("bob.near", 1, t), true, "by Telegram user too")
  assert.equal(limits.capped("alice.near", 1, t + 86_400_000), false, "a new UTC day")
})

test("the whole bot's cap counts and stops only accounts with no Balance: a funded customer always gets through", () => {
  const limits = messageLimits({ perMinute: 100, perDay: 100, unfundedPerDay: 100, unfundedBotPerDay: 2 })
  const t = Date.UTC(2026, 10, 11, 12)
  assert.equal(limits.model("a.near", 1, false, t), undefined)
  assert.equal(limits.model("rich.near", 9, true, t), undefined, "funded messages don't use it up")
  assert.equal(limits.model("b.near", 2, false, t), undefined)
  assert.equal(limits.model("c.near", 3, false, t), "bot", "today's messages from accounts with no Balance are used up")
  assert.equal(limits.model("rich.near", 9, true, t), undefined, "a funded customer still gets through")
  assert.equal(limits.model("c.near", 3, false, t + 86_400_000), undefined, "a new UTC day")
})

test("an account's Balance is read at most once a minute, and a failed read counts as funded only for that minute", async () => {
  let reads = 0
  let answer: () => Promise<boolean> = async () => false
  const balances = fundedCheck(async () => (reads++, answer()))
  const t = 1_000_000
  assert.equal(await balances.funded("alice.near", t), false)
  assert.equal(await balances.funded("alice.near", t + 59_000), false)
  assert.equal(reads, 1, "a chatty or capped account costs one read a minute")
  assert.equal(await balances.funded("bob.near", t), false)
  assert.equal(reads, 2, "each account its own")
  answer = () => Promise.reject(new Error("429 Too Many Requests"))
  assert.equal(await balances.funded("alice.near", t + 61_000), true, "the RPC didn't answer: never shut out a paying customer")
  assert.equal(await balances.funded("alice.near", t + 100_000), true)
  assert.equal(reads, 3)
  answer = async () => false
  balances.sweep(t + 122_000)
  assert.equal(await balances.funded("alice.near", t + 122_000), false, "only for that minute")
  assert.equal(reads, 4)
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
  assert.equal(typedText({ caption: "me@example.com" }), "me@example.com", "a photo's caption is typed")
  assert.equal(typedText({ caption: "me@example.com", forward_origin: { type: "user" } }), "")
  assert.equal(typedText({}), "", "a photo with no caption")
})

test("the model gets a photo's largest size up to 1280 px", () => {
  const s = (width: number, height: number) => ({ width, height })
  assert.deepEqual(photoSize([s(41, 90), s(148, 320), s(370, 800), s(591, 1280), s(1170, 2532)]), s(591, 1280))
  assert.deepEqual(photoSize([s(1170, 2532), s(148, 320)]), s(148, 320), "in any order")
  assert.deepEqual(photoSize([s(1600, 3000)]), s(1600, 3000), "the only size there is")
})

const card = (over: Partial<Pending> = {}): Pending => ({
  voucherId: "v", voucherName: "Swiggy", value: "500", currency: "INR", country: "IN", mode: "normal", requestedMode: "normal", maxPrice: 5_530_000, referencePrice: 5_530_000, luckyAmount: 0, ...over
})

const expired = "This offer expired. Ask again."
const refusal = (tap: { held: unknown } | { refused: string; consumed: boolean }) => ("refused" in tap ? tap.refused : undefined)

test("a button works once, only for the Telegram user it was made for, for 10 minutes, while they're still linked to that account", () => {
  const offers = makeOffers()
  const t = 1_000_000
  const offer = { offer: { cards: [card()] }, telegramUserId: 1, accountId: "alice.near", chatId: 101 }
  const a = offers.add(offer, t)
  assert.equal(refusal(offers.take(a.id, 2, "buy", "alice.near", t)), expired, "someone else's tap")
  assert.ok("held" in offers.take(a.id, 1, "buy", "alice.near", t + 1), "the customer's tap")
  assert.equal(refusal(offers.take(a.id, 1, "buy", "alice.near", t + 2)), expired, "a second tap buys nothing")
  const b = offers.add(offer, t)
  assert.equal(refusal(offers.take(b.id, 1, "buy", "alice.near", t + 10 * 60_000 + 1)), expired, "past 10 minutes")
  const c = offers.add(offer, t)
  assert.deepEqual(offers.take(c.id, 1, "buy", "bob.near", t), { refused: "This Telegram account is no longer linked to that wallet.", consumed: true })
  assert.equal(refusal(offers.take(c.id, 1, "buy", "alice.near", t)), expired, "refused once, gone")
  const d = offers.add(offer, t)
  assert.equal(refusal(offers.take(d.id, 1, "buy", undefined, t)), "This Telegram account is no longer linked to that wallet.", "unlinked")
})

test("a tap counts for the offer's own kind: an email button can't complete a Buy, nor a Buy button change the email", () => {
  const offers = makeOffers()
  const buy = offers.add({ offer: { cards: [card()] }, telegramUserId: 1, accountId: "alice.near", chatId: 101 })
  assert.equal(refusal(offers.take(buy.id, 1, "email", "alice.near")), expired)
  assert.ok("held" in offers.take(buy.id, 1, "buy", "alice.near"), "its own button still works")
  const email = offers.add({ offer: { email: { from: "me@example.com", to: "new@example.com" } }, telegramUserId: 1, accountId: "alice.near", chatId: 101 })
  assert.equal(refusal(offers.take(email.id, 1, "buy", "alice.near")), expired)
  assert.ok("held" in offers.take(email.id, 1, "email", "alice.near"))
})

test("Cancel works even once they're unlinked: it only takes the buttons off", () => {
  const offers = makeOffers()
  const a = offers.add({ offer: { cards: [card()] }, telegramUserId: 1, accountId: "alice.near", chatId: 101 })
  assert.ok("held" in offers.take(a.id, 1, "cancel", undefined))
  const b = offers.add({ offer: { email: { from: "me@example.com", to: "new@example.com" } }, telegramUserId: 1, accountId: "alice.near", chatId: 101 })
  assert.ok("held" in offers.take(b.id, 1, "cancel", "bob.near"))
})

test("a new offer withdraws the same user's earlier ones, so their buttons can come off", () => {
  const offers = makeOffers()
  const first = offers.add({ offer: { cards: [card()] }, telegramUserId: 1, accountId: "alice.near", chatId: 101 })
  offers.shownIn(first.id, 7)
  const other = offers.add({ offer: { cards: [card()] }, telegramUserId: 2, accountId: "bob.near", chatId: 202 })
  const second = offers.add({ offer: { cards: [card(), card()] }, telegramUserId: 1, accountId: "alice.near", chatId: 101 })
  assert.deepEqual(second.withdrawn.map((w) => [w.chatId, w.messageId]), [[101, 7]])
  assert.equal(refusal(offers.take(first.id, 1, "buy", "alice.near")), expired, "the older cart can't be bought any more")
  assert.ok("held" in offers.take(other.id, 2, "buy", "bob.near"), "another user's offer stands")
  assert.ok("held" in offers.take(second.id, 1, "buy", "alice.near"))
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

const delivered = (n: number, redemption: Record<string, unknown> = {}) =>
  new Purchase({
    id: `p${n}`, voucherId: "amazon-us", voucherName: "Amazon", value: "25", status: "delivered", referencePrice: 25_000_000, createdAt: new Date(0).toISOString(),
    redemption: { code: `CODE-${n}`, link: `https://example.com/redeem?token=${"x".repeat(200)}`, expirationTime: "2027-03-30T00:00:00.000Z", ...redemption }
  })
const noPreview = JSON.stringify({ link_preview_options: { is_disabled: true } })

test("a delivered card's message: what they paid, the code, the link and the use-by date", () => {
  const text = purchaseLines(delivered(1), "https://luckout.test").join("\n")
  assert.match(text, /^Amazon 25 is yours\.\nYou paid \$25\.00\.\nCode: CODE-1\nLink: https:\/\/example\.com\/redeem/)
  assert.match(text, /Use it by 30 March 2027\.$/)
})

test("a big cart's codes go in as few messages as fit, none split, with link previews off", async () => {
  const sent: Array<{ text: string; other: object }> = []
  let notices = 0
  const cards = Array.from({ length: 15 }, (_, i) => purchaseLines(delivered(i), "https://luckout.test"))
  assert.ok(cards.map((c) => c.join("\n")).join("\n\n").length > 4096, "too long for one Telegram message")
  await deliver(async (text, other) => void sent.push({ text, other }), cards, async () => void notices++)
  assert.ok(sent.length > 1 && sent.every((s) => s.text.length <= 4096))
  assert.deepEqual(sent.flatMap((s) => s.text.split("\n\n")), cards.map((c) => c.join("\n")), "every card, whole, in order")
  assert.ok(sent.every((s) => JSON.stringify(s.other) === noPreview))
  assert.equal(notices, 0)
})

test("a message Telegram rejects doesn't stop the ones after it, and one notice goes at the end", async () => {
  const events: Array<string> = []
  const cards = Array.from({ length: 15 }, (_, i) => purchaseLines(delivered(i), "https://luckout.test"))
  await deliver(async (text) => {
    if (events.length === 0) {
      events.push("rejected")
      throw new GrammyError("Call to 'sendMessage' failed! (400: Bad Request)", { ok: false, error_code: 400, description: "Bad Request" }, "sendMessage", {})
    }
    events.push(text.includes("CODE-14") ? "last card sent" : "sent")
  }, cards, async () => void events.push("notice"))
  assert.equal(events[0], "rejected")
  assert.deepEqual(events.slice(-2), ["last card sent", "notice"], "the rest still went, then one notice")
  assert.equal(events.filter((e) => e === "notice").length, 1)
})

test("a card longer than one message has its free text split across messages; its code and link stay whole", async () => {
  const sent: Array<string> = []
  let notices = 0
  const other = Array.from({ length: 1500 }, (_, i) => `word${i}`).join(" ")
  const lines = purchaseLines(delivered(1, { other }), "https://luckout.test")
  await deliver(async (text) => void sent.push(text), [lines], async () => void notices++)
  assert.equal(notices, 0)
  assert.ok(sent.length > 1 && sent.every((t) => t.length <= 4096))
  assert.ok(sent.some((t) => t.split("\n").includes("Code: CODE-1")), "the code on a line of its own, whole")
  assert.ok(sent.some((t) => t.split("\n").includes(`Link: https://example.com/redeem?token=${"x".repeat(200)}`)), "the link whole")
  assert.equal(sent.join(" ").replace(/\s+/g, " ").includes(other), true, "all of the free text, in order")
})

test("the card after a split one starts a new message", async () => {
  const sent: Array<string> = []
  const other = Array.from({ length: 1500 }, (_, i) => `word${i}`).join(" ")
  const short = purchaseLines(delivered(2), "https://luckout.test")
  await deliver(async (text) => void sent.push(text), [purchaseLines(delivered(1, { other }), "https://luckout.test"), short], async () => {})
  assert.equal(sent.at(-1), short.join("\n"), "on its own, though it would fit after the split card's last lines")
  assert.ok(sent.at(-2)!.endsWith("Use it by 30 March 2027."), "the split card ends in the message before")
})

test("the Buy message fits Telegram: a long reply goes on its own, and the button's message always carries the code-written lines", () => {
  const summary = buySummary([card(), card({ voucherName: "Amazon" })]).split("\n")
  assert.deepEqual(replyMessages("Here they are, tap Buy.", summary), [`Here they are, tap Buy.\n\n${summary.join("\n")}`], "one message when it fits")
  const reply = "word ".repeat(800).trim()
  assert.deepEqual(replyMessages(reply, summary), [reply, summary.join("\n")], "too long together: the reply first, then every code-written line")
  // Fifteen cards with very long names: even the code-written lines need two messages, and the button's ends with the total.
  const many = buySummary(Array.from({ length: 15 }, (_, i) => card({ voucherName: `Gift card ${i} ${"with a very long name ".repeat(10)}` }))).split("\n")
  const messages = replyMessages(reply, many)
  assert.ok(messages.length > 2 && messages.every((m) => m.length <= 4096))
  assert.ok(messages.at(-1)!.endsWith(many.at(-1)!), "the total is on the button's message")
  assert.ok(many.every((line) => messages.some((m) => m.split("\n").includes(line))), "every code-written line, whole")
  assert.deepEqual(replyMessages("", summary), [summary.join("\n")], "no reply, just the lines")
})

test("when the Buy lines need several messages, the total on the button's message says which cards are above it", () => {
  const two = [card(), card({ voucherName: "Amazon" })]
  assert.deepEqual(buyMessages("Tap Buy.", two), [`Tap Buy.\n\n${buySummary(two)}`], "all on one message: nothing to point at")
  const cards = Array.from({ length: 15 }, (_, i) => card({ voucherName: `Gift card ${i} ${"with a very long name ".repeat(10)}` }))
  const lines = buySummary(cards).split("\n")
  const messages = buyMessages("Tap Buy.", cards)
  assert.ok(messages.length > 1 && messages.every((m) => m.length <= 4096))
  const last = messages.at(-1)!.split("\n")
  const above = lines.length - last.length
  assert.ok(above > 0 && above < 15)
  assert.deepEqual(last.slice(0, -1), lines.slice(above, -1), "the button's message carries the last cards")
  assert.equal(last.at(-1), `${lines.at(-1)} Cards 1 to ${above} are in the messages above.`)
  assert.ok(lines.slice(0, -1).every((line) => messages.some((m) => m.split("\n").includes(line))), "every card line, whole")
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

// ---------- a Buy tapped while short waits for its money (ADR-0015) ----------

const T = Date.UTC(2026, 10, 28, 12)

/**
 * A $15 Jackpot card tapped at T with $0.50 in the Balance, then one waiting round at `now` with `balance` in it:
 * what it bought and said, and whether the tap still waits.
 */
const waitThenLook = (looks: ReadonlyArray<{ readonly now: number; readonly balance: number }>) =>
  run(Effect.gen(function*() {
    const lucky = card({ voucherName: "Amazon", value: "10", mode: { lucky: 2 }, requestedMode: { lucky: 2 }, maxPrice: 15_000_000, referencePrice: 10_000_000, luckyAmount: 10_000_000 })
    yield* holdBuy({ id: "offer-0001", accountId: "alice", chatId: 101, cards: [lucky], expiresAt: new Date(T + QUOTE_TTL_MS), balance: 500_000 })
    yield* holdBuy({ id: "offer-0001", accountId: "alice", chatId: 101, cards: [lucky], expiresAt: new Date(T + QUOTE_TTL_MS), balance: 500_000 })
    const bought: Array<{ id: string; accountId: string; chatId: string; items: ReadonlyArray<{ maxPrice: number; luckyAmount?: number | undefined; idempotencyKey: string }> }> = []
    const said: Array<string> = []
    let balance = 0
    const deps = {
      balance: () => Effect.sync(() => balance),
      buy: (w: { id: string; accountId: string; chatId: string; cards: ReadonlyArray<Pending> }) =>
        Effect.sync(() => void bought.push({ id: w.id, accountId: w.accountId, chatId: w.chatId, items: purchaseItems(w.id, w.cards) })),
      say: (chatId: string, text: string) => Effect.sync(() => void said.push(`${chatId}: ${text}`))
    }
    for (const look of looks) {
      balance = look.balance
      yield* waitingRound(deps, look.now)
    }
    const sql = yield* SqlClient.SqlClient
    const waiting = (yield* sql`SELECT id FROM pending_buys`).length > 0
    return { bought, said, waiting }
  }))

test("money that lands before the quote expires buys the card, at the most it showed", async () => {
  const r = await waitThenLook([{ now: T + 60_000, balance: 500_000 }, { now: T + 10 * 60_000, balance: 20_500_000 }])
  assert.deepEqual(r.said, [], "nothing to say while nothing arrives")
  assert.deepEqual(r.bought.map((b) => [b.id, b.accountId, b.chatId]), [["offer-0001", "alice", "101"]])
  assert.deepEqual(r.bought[0]!.items.map((i) => [i.maxPrice, i.luckyAmount, i.idempotencyKey]), [[15_000_000, 10_000_000, "offer-0001"]], "the program checks max_debit")
  assert.equal(r.waiting, false, "bought once")
})

test("money that lands after the quote expired buys nothing, and they hear why once", async () => {
  const r = await waitThenLook([{ now: T + QUOTE_TTL_MS + 1, balance: 20_500_000 }, { now: T + QUOTE_TTL_MS + 60_000, balance: 20_500_000 }])
  assert.deepEqual(r.bought, [])
  assert.equal(r.said.length, 1)
  assert.match(r.said[0]!, /^101: The money for your Amazon 10 didn't arrive within 30 minutes, so I didn't buy it\. Anything that lands stays in your balance/)
  assert.equal(r.waiting, false)
})

test("money that lands short is said once with what's missing, buys nothing, and the rest can still arrive in time", async () => {
  const r = await waitThenLook([
    { now: T + 60_000, balance: 10_500_000 },
    { now: T + 120_000, balance: 10_500_000 },
    { now: T + 180_000, balance: 15_000_000 }
  ])
  assert.equal(r.said.length, 1, "told once, not every round")
  assert.equal(r.said[0], "101: $10.00 arrived, but your balance is still $4.50 short of $15.00, so I haven't bought your Amazon 10. Send $4.50 more by 12:30 UTC and I'll buy it then.")
  assert.deepEqual(r.bought.map((b) => b.id), ["offer-0001"], "bought once the rest arrived")
})

test("a short Buy line says the tap waits for the money, and a Deposit Address stands alone on its own line", () => {
  assert.equal(
    buySummary([card()], 2_000_000),
    "Swiggy, 500 INR: $5.53. Works in India only. Your balance is $2.00 short: tap Buy and I'll buy it once the money lands, within 30 minutes."
  )
  const address = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
  assert.deepEqual(depositLines({ address, token: "USDC", chain: "Solana", amount: 5_000_000, tapInApp: false }), [
    "Send at least $5.00 of USDC on Solana to your Deposit Address below. It reaches your balance by itself within a few minutes.",
    address
  ])
  assert.match(depositLines({ address, token: "USDT", chain: "Solana", amount: 5_000_000, tapInApp: true })[0]!, /after one tap in the app/)
})

test("a 1Click address says exactly what to send on which chain, the least, for how long, and where a failed swap refunds", () => {
  const refundTo = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
  const oneClick = { send: "20.21", least: "20.01", until: new Date(T + 30 * 60_000).toISOString(), refundTo }
  const d = { address: "TQ1c1ick", token: "USDT", chain: "Tron", amount: 20_000_000, tapInApp: false, oneClick }
  assert.deepEqual(depositLines(d, T), [
    "Send 20.21 USDT on Tron to 1Click's address below within 30 minutes (by 12:30 UTC), and about $20.00 lands in your balance. Only USDT on Tron: another token or network can't be swapped.",
    `More is fine, it's all swapped, but at least 20.01 USDT must arrive. If the swap fails, 1Click refunds it to ${refundTo} on Tron.`,
    "TQ1c1ick"
  ])
  const memo = depositLines({ ...d, oneClick: { send: "20.21", until: oneClick.until, refundTo, memo: "1234" } }, T)
  assert.deepEqual(memo.slice(1), [
    `More is fine, it's all swapped. If the swap fails, 1Click refunds it to ${refundTo} on Tron.`,
    "Include this memo, or 1Click can't match your transfer: 1234",
    "TQ1c1ick"
  ], "a memo before the address, which stays alone on the last line")
})

test("the bot's repeating round reads the clock each time it runs", () =>
  run(Effect.gen(function*() {
    const said: Array<string> = []
    // Built once and run again and again, as the bot repeats it.
    const look = waitingRound({ balance: () => Effect.succeed(0), buy: () => Effect.void, say: (_, text) => Effect.sync(() => void said.push(text)) })
    yield* holdBuy({ id: "offer-0002", accountId: "alice", chatId: 101, cards: [card()], expiresAt: new Date(Date.now() + 100), balance: 0 })
    yield* look
    assert.deepEqual(said, [])
    yield* Effect.sleep("150 millis")
    yield* look
    assert.equal(said.length, 1, "expired by the second run")
  })))
