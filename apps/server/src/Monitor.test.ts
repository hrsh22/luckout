import { ConfigProvider, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Alerts } from "./Alerts.ts"
import { Base } from "./Base.ts"
import { DbMemory } from "./Db.ts"
import { Monitor, secretWarning } from "./Monitor.ts"
import { Near, NearUnavailable } from "./Near.ts"
import { OPEN_STEPS } from "./Purchases.ts"
import { fakeBase, fakeNear } from "./testing.ts"

// The Monitor's first round runs as soon as its layer is built: seed the database, build it, read the alerts.
const round = (near: Near["Service"], seed: Effect.Effect<unknown, unknown, SqlClient.SqlClient>, env: Record<string, string> = {}) => {
  const alerts: Array<string> = []
  const deps = Layer.mergeAll(
    Layer.succeed(Near, near),
    Layer.succeed(Base, fakeBase({ configured: false })),
    Layer.succeed(Alerts, Alerts.of({ admin: (t) => Effect.sync(() => void alerts.push(t)), customer: () => Effect.succeed(true) }))
  )
  return Effect.runPromise(
    Effect.gen(function*() {
      yield* seed
      yield* Layer.build(Monitor.pipe(Layer.provide(deps)))
      yield* Effect.sleep("300 millis")
      return alerts
    }).pipe(
      Effect.scoped,
      Effect.provide(DbMemory),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { NEAR_NETWORK: "testnet", ...env } })))
    )
  )
}

const healthy = fakeNear({
  account: () => Effect.succeed({ amount: 10n ** 26n, storageUsage: 0 }),
  view: <A>(method: string) =>
    Effect.succeed((method === "ft_balance_of" ? "0" : method === "get_reserve" ? { free: "0", locked: "0", proceeds: "0" } : null) as A)
})

const purchaseAt = (step: string, minutesAgo: number) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`INSERT INTO purchases (account_id, idempotency_key, voucher_id, voucher_name, package_value, reference_price, step, created_at)
        VALUES ('alice.test', ${crypto.randomUUID()}, 'amazon-us', 'Card', '10', 10000000, ${step}, now() - make_interval(mins => ${minutesAgo}))`)

test("a purchase unfinished after 15 minutes raises an alert at every open step, `pay` included", async () => {
  for (const step of OPEN_STEPS) {
    const alerts = await round(healthy, purchaseAt(step, 20))
    assert.ok(alerts.some((a) => a.includes("1 purchase(s) still unfinished after 15 minutes")), `${step}: ${JSON.stringify(alerts)}`)
  }
  assert.deepEqual(await round(healthy, purchaseAt("pay", 5)), [], "a young one is left alone")
})

test("NEAR being unreachable never hides the purchase alerts", async () => {
  const down = fakeNear({
    account: () => Effect.fail(new NearUnavailable({ message: "account: RPC unreachable" })),
    view: () => Effect.fail(new NearUnavailable({ message: "view: RPC unreachable" }))
  })
  const alerts = await round(down, Effect.all([purchaseAt("pay", 20), purchaseAt("stuck", 1)]))
  assert.ok(alerts.some((a) => a.includes("1 purchase(s) stuck")), JSON.stringify(alerts))
  assert.ok(alerts.some((a) => a.includes("1 purchase(s) still unfinished after 15 minutes")), JSON.stringify(alerts))
})

test("the reconciler's index covers every open step", async () => {
  const def = await Effect.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ indexdef: string }>`SELECT indexdef FROM pg_indexes WHERE indexname = 'purchases_open'`).pipe(
      Effect.map((r) => r[0]!.indexdef),
      Effect.provide(DbMemory)
    )
  )
  for (const step of OPEN_STEPS) assert.ok(def.includes(`'${step}'`), `${step} missing from: ${def}`)
})

// Once the Bitrefill client secret lapses no card can be bought, so the admin hears ahead of time.

test("the Bitrefill client secret is flagged from two weeks before it expires, and after", () => {
  const expires = 1_802_528_701 // 13 Feb 2027, as Bitrefill's registration reply gives it
  const day = 86_400_000
  assert.equal(secretWarning(expires, expires * 1000 - 15 * day), undefined, "more than two weeks away")
  assert.match(secretWarning(expires, expires * 1000 - 14 * day)!, /expires on 2027-02-13, in 14 day/)
  assert.match(secretWarning(expires, expires * 1000 - 13 * day)!, /expires on 2027-02-13, in 13 day/)
  assert.match(secretWarning(expires, expires * 1000 + 1)!, /expired on 2027-02-13/)
  assert.equal(secretWarning(0, Date.now()), undefined, "0 means the secret never expires")
})

test("an expiry in milliseconds, or not a finite number, stops the server at start instead of never warning", async () => {
  await assert.rejects(round(healthy, Effect.void, { BITREFILL_CLIENT_SECRET_EXPIRES_AT: "1802528701000" }), /not milliseconds/)
  await assert.rejects(round(healthy, Effect.void, { BITREFILL_CLIENT_SECRET_EXPIRES_AT: "NaN" }), /finite number/)
})

// ---------- signing in is free: the solvency check's work stays bounded ----------

/** One Monitor round over seeded `known_accounts`; returns the alerts, the accounts whose balance was read, and which ended up marked. */
const solvencyRound = (o: { held: string; balances: Record<string, string>; seed: Effect.Effect<unknown, unknown, SqlClient.SqlClient> }) => {
  const alerts: Array<string> = []
  const read: Array<string> = []
  const near = fakeNear({
    account: () => Effect.succeed({ amount: 10n ** 26n, storageUsage: 0 }),
    view: <A>(method: string, args?: Record<string, unknown>) =>
      Effect.sync(() => {
        if (method === "ft_balance_of") return o.held as A
        if (method === "get_reserve") return { free: "0", locked: "0", proceeds: "0" } as A
        const id = String(args?.account_id)
        read.push(id)
        return (id in o.balances ? { balance: o.balances[id] } : null) as A
      })
  })
  const deps = Layer.mergeAll(
    Layer.succeed(Near, near),
    Layer.succeed(Base, fakeBase({ configured: false })),
    Layer.succeed(Alerts, Alerts.of({ admin: (t) => Effect.sync(() => void alerts.push(t)), customer: () => Effect.succeed(true) }))
  )
  return Effect.runPromise(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* o.seed
      yield* Layer.build(Monitor.pipe(Layer.provide(deps)))
      yield* Effect.sleep("300 millis")
      const marked = yield* sql<{ account_id: string }>`SELECT account_id FROM known_accounts WHERE onchain ORDER BY account_id`
      return { alerts, read, marked: marked.map((m) => m.account_id) }
    }).pipe(
      Effect.scoped,
      Effect.provide(DbMemory),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { NEAR_NETWORK: "testnet" } })))
    )
  )
}

test("the solvency check reads every account the contract knows and only a few of the rest each round, however many signed in", async () => {
  const r = await solvencyRound({
    // The contract holds $5, but owes alice $4 and bob $3.
    held: "5000000",
    balances: { "alice.test": "4000000", "bob.test": "3000000" },
    seed: Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.all([
        // alice is known to the contract; bob signed in a while ago and has deposited since; 200 others only signed in.
        sql`INSERT INTO known_accounts (account_id, onchain) VALUES ('alice.test', true)`,
        sql`INSERT INTO known_accounts (account_id, first_seen) VALUES ('bob.test', now() - interval '1 day')`,
        sql`INSERT INTO known_accounts (account_id) SELECT 'signup' || n || '.test' FROM generate_series(1, 200) n`
      ]))
  })
  assert.equal(r.read.length, 51, "alice, plus fifty of those the contract isn't known to hold money for")
  assert.ok(r.read.includes("alice.test") && r.read.includes("bob.test"), "the longest unchecked go first")
  assert.deepEqual(r.marked, ["alice.test", "bob.test"], "the contract knows bob: from now on he's read every round")
  assert.ok(r.alerts.some((a) => a.includes("holds 5 USDC, less than it owes") && a.includes("customers' balances 7")), JSON.stringify(r.alerts))
})

test("an account that bought or was relayed is read every round, wherever it stands in the queue", async () => {
  const r = await solvencyRound({
    held: "0",
    balances: {},
    seed: Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.all([
        sql`INSERT INTO known_accounts (account_id) SELECT 'signup' || n || '.test' FROM generate_series(1, 200) n`,
        // Signed in after all of them, so last in the queue.
        sql`INSERT INTO known_accounts (account_id, first_seen) VALUES ('buyer.test', now() + interval '1 minute'), ('relayed.test', now() + interval '1 minute')`,
        sql`INSERT INTO purchases (account_id, idempotency_key, voucher_id, voucher_name, package_value, reference_price, step)
            VALUES ('buyer.test', 'k1', 'amazon-us', 'Card', '10', 10000000, 'settled')`,
        sql`INSERT INTO relays (delegate_hash, account_id, signed_tx) VALUES ('h1', 'relayed.test', '{}'::jsonb)`
      ]))
  })
  assert.ok(r.read.includes("buyer.test") && r.read.includes("relayed.test"))
  assert.equal(r.read.length, 52)
})
