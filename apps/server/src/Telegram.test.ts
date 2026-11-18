import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { GrammyError } from "grammy"
import { redemptionFields } from "@luckout/api"
import assert from "node:assert/strict"
import { test } from "node:test"
import { DbMemory } from "./Db.ts"
import { addLinkCode, buySummary, describe, messageLimits, redeemLinkCode, unlinkAccount } from "./Telegram.ts"

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

test("each Telegram user gets so many messages a minute and a day; a sweep keeps today's count", () => {
  const limits = messageLimits(2, 3)
  const t = Date.UTC(2026, 10, 11, 12)
  assert.equal(limits.check(1, t), undefined)
  assert.equal(limits.check(1, t), undefined)
  assert.equal(limits.check(1, t), "minute")
  assert.equal(limits.check(2, t), undefined, "another user has their own")
  assert.equal(limits.check(1, t + 61_000), undefined, "a new minute; the third today")
  limits.sweep(t + 2 * 61_000)
  assert.equal(limits.check(1, t + 2 * 61_000), "day")
  assert.equal(limits.check(1, t + 86_400_000), undefined, "a new UTC day")
})

test("the Buy line says where the card is emailed, when it needs an email", () => {
  const p = { voucherId: "v", voucherName: "Swiggy", value: "500", currency: "INR", country: "IN", mode: "normal" as const, maxPrice: 5_530_000, referencePrice: 5_530_000, luckyAmount: 0 }
  assert.equal(buySummary(p), "Swiggy, 500 INR: $5.53. Works in India only.")
  assert.equal(buySummary({ ...p, receiptTo: "me@example.com" }), "Swiggy, 500 INR: $5.53. Works in India only. Also emailed to me@example.com.")
  assert.equal(buySummary({ ...p, useBy: "2027-03-30T18:29:59.000Z" }), "Swiggy, 500 INR: $5.53. Works in India only. Use it by about 30 March 2027.")
})
