import { Api, CreditSettings } from "@luckout/api"
import { ConfigProvider, Effect, Exit, Layer } from "effect"
import { OpenApi } from "effect/http-api"
import { SqlClient } from "effect/sql"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Admin } from "./Admin.ts"
import { Alerts } from "./Alerts.ts"
import { Base } from "./Base.ts"
import { Bitrefill } from "./Bitrefill.ts"
import { Credit } from "./Credit.ts"
import { DbMemory } from "./Db.ts"
import { Near, NearUnavailable } from "./Near.ts"
import { Refill } from "./Refill.ts"
import { Relay } from "./Relay.ts"
import { Sales } from "./Sales.ts"
import { fakeBitrefill, fakeNear, fakeBase } from "./testing.ts"

// The admin panel's server side on an in-memory database, with NEAR and Bitrefill faked.
process.env.NEAR_NETWORK = "testnet"
process.env.ADMIN_ACCOUNTS = "boss.testnet, luckout.testnet"

const NEAR = 10n ** 24n
const near = fakeNear({
  relayerId: "relayer.test",
  view: <A>(method: string, args?: { account_id?: string }) =>
    Effect.succeed(({
      get_account: args?.account_id === "alice.testnet" ? { balance: "120000000", per_purchase_limit: "200000000", daily_limit: "1000000000" } : null,
      get_config: { owner: "luckout.testnet", operator: "server.test", usdc: "usdc.test", paused: false, cashback_cap: { fixed: "50000000", reserve_bps: 2_000 } },
      get_reserve: { free: "1000000000", locked: "5000000", max_cashback: "50000000", proceeds: "236000000" },
      get_stats: { lucky_settled: 4, lucky_amount_total: "40000000", lucky_paid_total: "37200000" },
      // The contract's USDC: customers' $120 plus the reserve and proceeds above.
      ft_balance_of: "1361000000"
    } as Record<string, unknown>)[method] as A),
  account: (id) => Effect.succeed({ amount: id === "relayer.test" ? NEAR / 4n : 2n * NEAR, storageUsage: 100 })
})
const bitrefill = fakeBitrefill({ credit: Effect.succeed({ balance: 120_500_000, room: 1_879_500_000 }) })
const refill = Refill.of({
  kick: Effect.void,
  request: () => Effect.die("not used"),
  resolve: () => Effect.die("not used"),
  process: Effect.void,
  status: Effect.succeed({
    refills: [],
    refilledToday: 0,
    paused: "Refills run on mainnet: NEAR Intents doesn't run on testnet, and test cards are free.",
    available: false,
    needs: undefined,
    treasury: { accountId: undefined, contractTreasury: undefined, dailyCap: 0, sweptToday: 0, proceeds: 236_000_000, usdc: 0 },
    wallet: undefined
  })
})
const alerts: Array<string> = []
const layer = Admin.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Relay.layer, Credit.layer, Sales.layer)),
  Layer.provide(Layer.mergeAll(
    Layer.succeed(Near, near),
    Layer.succeed(Bitrefill, bitrefill),
    Layer.succeed(Base, fakeBase()),
    Layer.succeed(Refill, refill),
    Layer.succeed(Alerts, Alerts.of({ admin: (t) => Effect.sync(() => void alerts.push(t)), customer: () => Effect.succeed(true) }))
  )),
  Layer.provideMerge(DbMemory)
)
const run = <A, E>(e: Effect.Effect<A, E, Admin | Relay | Credit | Sales | SqlClient.SqlClient>) => Effect.runPromise(Effect.scoped(e).pipe(Effect.provide(layer)))

const purchase = (id: string, step: string, error: string | null, minutesAgo = 30) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`WITH co AS (INSERT INTO checkouts (account_id, step) VALUES ('test', 'done') RETURNING id) INSERT INTO purchases (checkout_id, id, account_id, idempotency_key, voucher_name, voucher_id, package_value, reference_price, step, error, created_at)
        VALUES ((SELECT id FROM co), ${id}, 'alice.testnet', ${id}, 'Test Card', 'test-card', '10', 10000000, ${step}, ${error}, now() - make_interval(mins => ${minutesAgo}))`)

test("only whitelisted accounts are admins", () =>
  run(Effect.gen(function*() {
    const admin = yield* Admin
    assert.equal(admin.isAdmin("boss.testnet"), true)
    assert.equal(admin.isAdmin("luckout.testnet"), true)
    assert.equal(admin.isAdmin("alice.testnet"), false)
  })))

test("the overview reads the contract, gas, relays, purchases and Bitrefill", () =>
  run(Effect.gen(function*() {
    yield* purchase("00000000-0000-4000-8000-000000000001", "settled", null, 5)
    yield* purchase("00000000-0000-4000-8000-000000000002", "stuck", "Bitrefill order outcome unknown; check the Bitrefill account")
    // Two relays the caps count, and a Top-Up's move-in they don't.
    const sql = yield* SqlClient.SqlClient
    for (const [hash, counted] of [["r1", true], ["r2", true], ["move-in", false]] as const) {
      yield* sql`INSERT INTO relays (delegate_hash, account_id, signed_tx, counted) VALUES (${hash}, 'alice.testnet', '{}'::jsonb, ${counted})`
    }
    const o = yield* (yield* Admin).overview
    assert.equal(o.contract.owner, "luckout.testnet")
    assert.equal(o.reserve.free, 1_000_000_000)
    assert.equal(o.reserve.proceeds, 236_000_000)
    assert.equal(o.reserve.customers, 120_000_000, "what the contract holds minus the reserve and proceeds")
    assert.deepEqual(o.gas.map((g) => [g.role, BigInt(g.spendable) < BigInt(g.alertBelow) ? "low" : "ok"]), [["operator", "ok"], ["relayer", "low"], ["contract", "ok"]])
    assert.equal(o.relay.settings.enabled, true)
    assert.equal(o.relay.usedToday, 2, "only what the caps count")
    assert.deepEqual(o.relay.topAccounts, [{ accountId: "alice.testnet", count: 2 }])
    assert.equal(o.purchases.today, 2)
    assert.equal(o.purchases.deliveredToday, 1)
    assert.deepEqual(o.purchases.attention.map((a) => [a.step, a.retryable]), [["stuck", false]])
    assert.equal(o.credit.balance, undefined, "testnet sells only free test cards: no Bitrefill credit to track")
    assert.equal(o.credit.target, 100_000_000, "no sales yet: the floor")
    assert.equal(o.credit.refillsAvailable, false)
  })))

/** A checkout at `step` with its cards, each `[id, step, error]`, as the reconciler and giveUp leave them. */
const checkout = (step: string, cards: ReadonlyArray<readonly [string, string, string | null]>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.gen(function*() {
      const [co] = yield* sql<{ id: string }>`
        INSERT INTO checkouts (account_id, step, attempts, next_attempt_at, invoice_id) VALUES ('alice.testnet', ${step}, 5, now() + interval '1 hour', 'inv-1') RETURNING id`
      for (const [i, [id, cardStep, error]] of cards.entries()) {
        yield* sql`INSERT INTO purchases (checkout_id, position, id, account_id, idempotency_key, voucher_name, voucher_id, package_value, reference_price, step, error, invoice_id)
                   VALUES (${co!.id}, ${i}, ${id}, 'alice.testnet', ${id}, 'Test Card', 'test-card', '10', 10000000, ${cardStep}, ${error}, 'inv-1')`
      }
      return co!.id
    })
  )

test("Retry now moves the checkout the reconciler runs, with its cards, and only where repeating is safe", () =>
  run(Effect.gen(function*() {
    const admin = yield* Admin
    const sql = yield* SqlClient.SqlClient
    const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`
    const steps = (co: string) =>
      Effect.all([
        sql<{ step: string; attempts: number; due: boolean; error: string | null }>`
          SELECT step, attempts, next_attempt_at <= now() AND updated_at < now() - interval '30 seconds' AS due, error FROM checkouts WHERE id = ${co}`.pipe(
          Effect.map((r) => r[0]!)
        ),
        sql<{ step: string }>`SELECT step FROM purchases WHERE checkout_id = ${co} ORDER BY position`.pipe(Effect.map((r) => r.map((c) => c.step)))
      ])

    // Still running, with a backoff: due on the next pass, cards untouched.
    const open = yield* checkout("delivery", [[id(21), "delivery", null]])
    yield* admin.retry(id(21), "boss.testnet")
    const [openCo, openCards] = yield* steps(open)
    assert.deepEqual([openCo.step, openCo.attempts, openCo.due], ["delivery", 0, true])
    assert.deepEqual(openCards, ["delivery"])

    // Gave up at settle: the delivered card goes back to confirm, the failed one to fail, the slow one to delivery.
    const gaveUp = yield* checkout("stuck", [
      [id(22), "stuck", "Gave up after 12 attempts at confirm: send: timed out"],
      [id(23), "stuck", "Gave up after 12 attempts at fail: send: timed out"],
      [id(24), "stuck", "Gave up after 12 attempts at delivery: send: timed out"]
    ])
    yield* admin.retry(id(24), "boss.testnet")
    const [gaveUpCo, gaveUpCards] = yield* steps(gaveUp)
    assert.deepEqual([gaveUpCo.step, gaveUpCo.attempts, gaveUpCo.due, gaveUpCo.error], ["settle", 0, true, null])
    assert.deepEqual(gaveUpCards, ["confirm", "fail", "delivery"])
    assert.match(alerts.at(-1) ?? "", new RegExp(`boss\\.testnet retried purchase ${id(24)} at delivery`))

    // Gave up asking Bitrefill only: back to delivery.
    const slow = yield* checkout("stuck", [[id(25), "stuck", "Gave up after 12 attempts at delivery: invoice inv-1 is still pending"]])
    yield* admin.retry(id(25), "boss.testnet")
    assert.deepEqual((yield* steps(slow)).map((x) => (Array.isArray(x) ? x : x.step)), ["delivery", ["delivery"]])

    // Where going again could pay or order twice, or nobody knows what happened: a human looks.
    const pay = yield* checkout("stuck", [[id(26), "stuck", "Gave up after 12 attempts at pay: Base nonce: fetch failed"]])
    const unknown = yield* checkout("stuck", [[id(27), "stuck", "Bitrefill order outcome unknown; check the Bitrefill account"]])
    for (const n of [26, 27]) {
      const refused = yield* admin.retry(id(n), "boss.testnet").pipe(Effect.flip)
      assert.match(refused.message, /needs a manual check/)
    }
    assert.deepEqual((yield* steps(pay))[1], ["stuck"])
    assert.deepEqual((yield* steps(unknown))[1], ["stuck"])

    // The panel offers Retry now exactly where it works, and labels a payment as the checkout's.
    const attention = (yield* admin.overview).purchases.attention
    assert.deepEqual(attention.filter((a) => [id(26), id(27)].includes(a.id)).map((a) => a.retryable), [false, false])
    const [listed] = yield* admin.purchases(undefined, id(22))
    assert.equal(listed!.checkoutId, gaveUp)
  })))

test("the published API spec leaves the admin endpoints out", () => {
  const paths = Object.keys(OpenApi.fromApi(Api).paths)
  assert.ok(paths.includes("/quote"))
  assert.deepEqual(paths.filter((p) => p.startsWith("/admin")), [])
})

test("relayer changes are announced to the admin channel", () =>
  run(Effect.gen(function*() {
    const admin = yield* Admin
    const relay = yield* Relay
    yield* admin.configureRelay({ ...(yield* relay.settings), enabled: false }, "boss.testnet")
    assert.equal((yield* relay.settings).enabled, false)
    assert.match(alerts.at(-1) ?? "", /boss\.testnet set the relayer off/)
  })))

test("credit settings that don't hang together are refused, and changes are announced", () =>
  run(Effect.gen(function*() {
    const admin = yield* Admin
    const credit = yield* Credit
    const s = yield* credit.settings
    const bad = yield* admin.configureCredit(new CreditSettings({ ...s, floor: s.ceiling + 1 }), "boss.testnet").pipe(Effect.flip)
    assert.equal(bad._tag, "AdminInvalid")
    yield* admin.configureCredit(new CreditSettings({ ...s, ceiling: 800_000_000 }), "boss.testnet")
    assert.equal((yield* credit.settings).ceiling, 800_000_000)
    assert.match(alerts.at(-1) ?? "", /boss\.testnet set Bitrefill credit/)
  })))

test("any admin can stop and restart sales, and it's announced", () =>
  run(Effect.gen(function*() {
    const admin = yield* Admin
    const stopped = yield* admin.setSales(false, "boss.testnet")
    assert.deepEqual([stopped.open, stopped.reason], [false, "stopped"])
    assert.equal((yield* admin.overview).salesStopped, true)
    assert.match(alerts.at(-1) ?? "", /boss\.testnet stopped sales/)
    const open = yield* admin.setSales(true, "boss.testnet")
    assert.equal(open.open, true)
  })))


test("the purchases and users lists show what each customer bought, paid and holds", () =>
  run(Effect.gen(function*() {
    const admin = yield* Admin
    const sql = yield* SqlClient.SqlClient
    const lucky = "00000000-0000-4000-8000-000000000021"
    yield* purchase(lucky, "settled", null, 2)
    yield* sql`UPDATE purchases SET admitted = ${JSON.stringify({ mode: { lucky: 2 }, max_price: "11000000", lucky_amount: "10000000" })}::jsonb,
               draw = ${JSON.stringify({ game_version: 2, final_price: "8000000", cashback: "3000000" })}::jsonb WHERE id = ${lucky}`
    yield* sql`INSERT INTO known_accounts (account_id) VALUES ('alice.testnet'), ('bob.testnet') ON CONFLICT DO NOTHING`
    const [p] = yield* admin.purchases("alice.testnet")
    assert.deepEqual([p?.id, p?.paid, p?.cashback, p?.maxPrice], [lucky, 8_000_000, 3_000_000, 11_000_000])
    const users = yield* admin.users
    const alice = users.find((u) => u.accountId === "alice.testnet")
    assert.equal(alice?.balance, 120_000_000)
    assert.equal(alice?.cashback, 3_000_000)
    assert.ok((alice?.spent ?? 0) >= 8_000_000, "the Lucky Buy counts at its final price")
    assert.equal(users.find((u) => u.accountId === "bob.testnet")?.balance, 0, "never deposited")
  })))

test("the overview shows how near the busiest Checkout Email is to Bitrefill's limits", () =>
  run(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO checkout_emails (account_id, email, email_key) VALUES ('alice.testnet', 'sealed', 'k1'), ('bob.testnet', 'sealed', 'k2')`
    // Two cards for one email today, one for the other, one rejected (never reached Bitrefill) and one 2 days old.
    const add = (id: string, key: string, step: string, price: number, hoursAgo: number, invoice: string | null) =>
      sql`WITH co AS (INSERT INTO checkouts (account_id, step) VALUES ('test', 'done') RETURNING id) INSERT INTO purchases (checkout_id, id, account_id, idempotency_key, voucher_name, voucher_id, package_value, reference_price, step, email_key, invoice_id, created_at)
          VALUES ((SELECT id FROM co), ${id}, 'alice.testnet', ${id}, 'Card', 'amazon-us', '10', ${price}, ${step}, ${key}, ${invoice}, now() - make_interval(hours => ${hoursAgo}))`
    yield* add("00000000-0000-0000-0000-0000000000c1", "k1", "settled", 10_000_000, 1, "i1")
    yield* add("00000000-0000-0000-0000-0000000000c2", "k1", "pay", 5_000_000, 2, "i2")
    yield* add("00000000-0000-0000-0000-0000000000c3", "k1", "rejected", 50_000_000, 1, null)
    yield* add("00000000-0000-0000-0000-0000000000c4", "k1", "settled", 20_000_000, 48, "i4")
    yield* add("00000000-0000-0000-0000-0000000000c5", "k2", "settled", 7_000_000, 1, "i5")
    const o = yield* (yield* Admin).overview
    assert.equal(o.checkout.guest, false)
    assert.equal(o.checkout.emails, 2)
    assert.deepEqual(o.checkout.limits, { orders: 15, daily: 500_000_000, monthly: 1_000_000_000 })
    assert.deepEqual(o.checkout.busiest, { orders: 2, daily: 15_000_000, monthly: 35_000_000 })
  })))

test("Stop sales and the shop's status need only the database: they work while NEAR doesn't answer, and the overview doesn't", async () => {
  const down = fakeNear({
    relayerId: "relayer.test",
    view: () => Effect.fail(new NearUnavailable({ message: "NEAR isn't answering" })),
    account: () => Effect.fail(new NearUnavailable({ message: "NEAR isn't answering" }))
  })
  const outage = Admin.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(Relay.layer, Credit.layer, Sales.layer)),
    Layer.provide(Layer.mergeAll(
      Layer.succeed(Near, down),
      Layer.succeed(Bitrefill, bitrefill),
      Layer.succeed(Base, fakeBase()),
      Layer.succeed(Refill, refill),
      Layer.succeed(Alerts, Alerts.of({ admin: () => Effect.void, customer: () => Effect.succeed(true) }))
    )),
    Layer.provideMerge(DbMemory)
  )
  const r = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const admin = yield* Admin
    const sales = yield* Sales
    const overview = yield* Effect.exit(admin.overview)
    const stopped = yield* admin.setSales(false, "boss.testnet")
    const seen = yield* sales.status
    const restarted = yield* admin.setSales(true, "boss.testnet")
    return { overview, stopped, seen, restarted }
  })).pipe(Effect.provide(outage)))
  assert.ok(Exit.isFailure(r.overview), "the overview reads the contract, so it fails without NEAR")
  assert.deepEqual([r.stopped.open, r.stopped.reason], [false, "stopped"])
  assert.equal(r.seen.reason, "stopped", "what the panel shows when the overview can't load")
  assert.equal(r.restarted.open, true, "an unreadable pause counts as not paused")
})

test("saving the relayer's caps leaves its switch as it is now, and flipping the switch leaves the caps", () =>
  run(Effect.gen(function*() {
    const admin = yield* Admin
    const relay = yield* Relay
    // One admin turns the relayer off during an incident...
    yield* admin.configureRelay({ enabled: false }, "boss.testnet")
    // ...and another, whose panel still shows it on, saves new caps.
    const saved = yield* admin.configureRelay({ perAccountDaily: 7, allDaily: 70 }, "luckout.testnet")
    assert.deepEqual({ ...saved }, { enabled: false, perAccountDaily: 7, allDaily: 70 })
    assert.match(alerts.at(-1) ?? "", /luckout\.testnet set the relayer off: 7 free per account, 70 in all per day/)
    yield* admin.configureRelay({ enabled: true }, "boss.testnet")
    assert.deepEqual({ ...(yield* relay.settings) }, { enabled: true, perAccountDaily: 7, allDaily: 70 })
  })))

test("saving the credit numbers leaves automatic refills as they are now, and the merged settings must still hang together", () =>
  run(Effect.gen(function*() {
    const admin = yield* Admin
    const credit = yield* Credit
    const before = yield* credit.settings
    yield* admin.configureCredit({ autoRefill: false }, "boss.testnet")
    const saved = yield* admin.configureCredit({ ceiling: 800_000_000, waitMinutes: 60 }, "luckout.testnet")
    assert.deepEqual([saved.autoRefill, saved.ceiling, saved.waitMinutes, saved.floor], [false, 800_000_000, 60, before.floor])
    assert.match(alerts.at(-1) ?? "", /luckout\.testnet set .*: auto-refill off/)
    // The check runs on what would be saved, not only on the fields sent.
    const bad = yield* admin.configureCredit({ floor: 800_000_001 }, "boss.testnet").pipe(Effect.flip)
    assert.equal(bad._tag, "AdminInvalid")
    yield* admin.configureCredit({ autoRefill: true }, "boss.testnet")
    assert.deepEqual([(yield* credit.settings).autoRefill, (yield* credit.settings).ceiling], [true, 800_000_000])
  })))

test("the users list shows the 300 most recent customers, and sign-ups that never deposited can't crowd out one who did", () =>
  run(Effect.gen(function*() {
    const admin = yield* Admin
    const sql = yield* SqlClient.SqlClient
    // alice deposited a month ago and never bought; 320 accounts have signed in since and done nothing else.
    yield* sql`INSERT INTO known_accounts (account_id, first_seen, onchain) VALUES ('alice.testnet', now() - interval '30 days', true)`
    yield* sql`INSERT INTO known_accounts (account_id) SELECT 'signup' || n || '.testnet' FROM generate_series(1, 320) n`
    const users = yield* admin.users
    assert.equal(users.length, 300, "one contract view each, so the list is bounded")
    assert.equal(users[0]?.accountId, "alice.testnet")
    assert.equal(users[0]?.balance, 120_000_000)
  })))

test("the attention list shows the oldest first, closest to the customer's Reclaim, and says how many there are in all", () =>
  run(Effect.gen(function*() {
    // 25 stuck purchases, a minute apart.
    for (let i = 0; i < 25; i++) {
      yield* purchase(`00000000-0000-4000-8000-0000000003${String(i).padStart(2, "0")}`, "stuck", "Bitrefill order outcome unknown", 60 + i)
    }
    const o = yield* (yield* Admin).overview
    assert.equal(o.purchases.attentionTotal, 25)
    assert.equal(o.purchases.attention.length, 20)
    assert.equal(o.purchases.attention[0]?.id, "00000000-0000-4000-8000-000000000324", "the oldest first")
  })))

test("a purchase is found by its id however old, past the latest 300 an account's list holds", () =>
  run(Effect.gen(function*() {
    const admin = yield* Admin
    const sql = yield* SqlClient.SqlClient
    const old = "00000000-0000-4000-8000-000000000400"
    yield* purchase(old, "settled", null, 60 * 24 * 40)
    // 300 newer ones by the same customer.
    yield* sql`WITH co AS (INSERT INTO checkouts (account_id, step) VALUES ('test', 'done') RETURNING id) INSERT INTO purchases (checkout_id, account_id, idempotency_key, voucher_name, voucher_id, package_value, reference_price, step)
               SELECT (SELECT id FROM co), 'alice.testnet', 'k' || n, 'Test Card', 'test-card', '10', 10000000, 'settled' FROM generate_series(1, 300) n`
    const mine = yield* admin.purchases("alice.testnet")
    assert.equal(mine.length, 300)
    assert.ok(!mine.some((p) => p.id === old), "it is past the latest 300")
    assert.deepEqual((yield* admin.purchases(undefined, old)).map((p) => p.id), [old])
    assert.deepEqual(yield* admin.purchases(undefined, "00000000-0000-4000-8000-000000000999"), [], "no such purchase")
  })))

test("with guest checkout the overview's credit figures are the Base Float, read from the Base Wallet, never from Bitrefill", async () => {
  const guestLayer = Admin.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(Relay.layer, Credit.layer, Sales.layer)),
    Layer.provide(Layer.mergeAll(
      Layer.succeed(Near, near),
      // No `credit` here: the fake dies if Bitrefill's credit is read, which guest checkout must never do.
      Layer.succeed(Bitrefill, fakeBitrefill({ guest: true })),
      Layer.succeed(Base, fakeBase({ balances: Effect.succeed({ usdc: 65_000_000, eth: 10n ** 15n }) })),
      Layer.succeed(Refill, refill),
      Layer.succeed(Alerts, Alerts.of({ admin: () => Effect.void, customer: () => Effect.succeed(true) }))
    )),
    Layer.provideMerge(DbMemory),
    // The Base Float is only tracked on mainnet.
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...(process.env as Record<string, string>), NEAR_NETWORK: "mainnet" } })))
  )
  const o = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    yield* Effect.flatMap(Credit, (c) => c.refresh)
    return yield* (yield* Admin).overview
  })).pipe(Effect.provide(guestLayer)))
  assert.equal(o.checkout.guest, true)
  assert.equal(o.credit.balance, 65_000_000, "the USDC in the Base Wallet")
  assert.equal(o.credit.free, 65_000_000)
})

test("with guest checkout, a settings change is announced as the Base Float's", async () => {
  const said: Array<string> = []
  const guestLayer = Admin.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(Relay.layer, Credit.layer, Sales.layer)),
    Layer.provide(Layer.mergeAll(
      Layer.succeed(Near, near),
      Layer.succeed(Bitrefill, fakeBitrefill({ guest: true })),
      Layer.succeed(Base, fakeBase()),
      Layer.succeed(Refill, refill),
      Layer.succeed(Alerts, Alerts.of({ admin: (t) => Effect.sync(() => void said.push(t)), customer: () => Effect.succeed(true) }))
    )),
    Layer.provideMerge(DbMemory)
  )
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const admin = yield* Admin
    const s = yield* (yield* Credit).settings
    yield* admin.configureCredit(new CreditSettings({ ...s, ceiling: 800_000_000 }), "boss.testnet")
  })).pipe(Effect.provide(guestLayer)))
  assert.match(said.at(-1) ?? "", /^boss\.testnet set the Base Float: auto-refill /)
})
