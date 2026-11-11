import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { GrammyError } from "grammy"
import assert from "node:assert/strict"
import { test } from "node:test"
import { DbMemory } from "./Db.ts"
import { addLinkCode, describe, messageLimits, redeemLinkCode, unlinkAccount } from "./Telegram.ts"

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
