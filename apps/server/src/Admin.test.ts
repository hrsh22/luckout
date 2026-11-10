import { CreditSettings } from "@luckout/api"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Admin } from "./Admin.ts"
import { Alerts } from "./Alerts.ts"
import { Bitrefill } from "./Bitrefill.ts"
import { Credit } from "./Credit.ts"
import { DbMemory } from "./Db.ts"
import { Near } from "./Near.ts"
import { Refill } from "./Refill.ts"
import { Relay } from "./Relay.ts"
import { Sales } from "./Sales.ts"
import { fakeBitrefill, fakeNear } from "./testing.ts"

// The admin panel's server side on an in-memory database, with NEAR and Bitrefill faked.
process.env.NEAR_NETWORK = "testnet"
process.env.ADMIN_ACCOUNTS = "boss.testnet, luckout.testnet"

const NEAR = 10n ** 24n
const near = fakeNear({
  relayerId: "relayer.test",
  view: <A>(method: string) =>
    Effect.succeed(({
      get_config: { owner: "luckout.testnet", operator: "server.test", usdc: "usdc.test", paused: false, max_cashback: "50000000" },
      get_reserve: { free: "1000000000", locked: "5000000", discount_cap: "200000000", proceeds: "236000000" },
      get_stats: { lucky_settled: 4, lucky_amount_total: "40000000", lucky_paid_total: "37200000" }
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
    Layer.succeed(Refill, refill),
    Layer.succeed(Alerts, Alerts.of({ admin: (t) => Effect.sync(() => void alerts.push(t)), customer: () => Effect.void }))
  )),
  Layer.provideMerge(DbMemory)
)
const run = <A, E>(e: Effect.Effect<A, E, Admin | Relay | Credit | Sales | SqlClient.SqlClient>) => Effect.runPromise(Effect.scoped(e).pipe(Effect.provide(layer)))

const purchase = (id: string, step: string, error: string | null, minutesAgo = 30) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`INSERT INTO purchases (id, account_id, idempotency_key, voucher_name, voucher_id, package_value, reference_price, step, error, created_at)
        VALUES (${id}, 'alice.testnet', ${id}, 'Test Card', 'test-card', '10', 10000000, ${step}, ${error}, now() - make_interval(mins => ${minutesAgo}))`)

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
    const o = yield* (yield* Admin).overview
    assert.equal(o.contract.owner, "luckout.testnet")
    assert.equal(o.reserve.free, 1_000_000_000)
    assert.equal(o.reserve.proceeds, 236_000_000)
    assert.deepEqual(o.gas.map((g) => [g.role, BigInt(g.spendable) < BigInt(g.alertBelow) ? "low" : "ok"]), [["operator", "ok"], ["relayer", "low"], ["contract", "ok"]])
    assert.equal(o.relay.settings.enabled, true)
    assert.equal(o.purchases.today, 2)
    assert.equal(o.purchases.deliveredToday, 1)
    assert.deepEqual(o.purchases.attention.map((a) => [a.step, a.retryable]), [["stuck", false]])
    assert.equal(o.credit.balance, undefined, "testnet sells only free test cards: no Bitrefill credit to track")
    assert.equal(o.credit.target, 100_000_000, "no sales yet: the floor")
    assert.equal(o.credit.refillsAvailable, false)
  })))

test("Retry now only touches purchases NEAR can safely repeat", () =>
  run(Effect.gen(function*() {
    const admin = yield* Admin
    const sql = yield* SqlClient.SqlClient
    const open = "00000000-0000-4000-8000-000000000011"
    const confirm = "00000000-0000-4000-8000-000000000012"
    const ordering = "00000000-0000-4000-8000-000000000013"
    yield* purchase(open, "delivery", "Bitrefill still delivering")
    yield* purchase(confirm, "stuck", "Gave up after 12 attempts at confirm: NEAR timed out")
    yield* purchase(ordering, "stuck", "Bitrefill order outcome unknown; check the Bitrefill account")
    yield* admin.retry(open, "boss.testnet")
    yield* admin.retry(confirm, "boss.testnet")
    const refused = yield* admin.retry(ordering, "boss.testnet").pipe(Effect.flip)
    assert.equal(refused._tag, "PurchaseInvalid")
    const rows = yield* sql<{ id: string; step: string; attempts: number }>`SELECT id, step, attempts FROM purchases WHERE id IN (${open}, ${confirm}, ${ordering}) ORDER BY id`
    assert.deepEqual(rows.map((r) => [r.step, r.attempts]), [["delivery", 0], ["confirm", 0], ["stuck", 0]])
  })))

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

