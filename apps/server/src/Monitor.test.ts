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
const round = (near: Near["Service"], seed: Effect.Effect<unknown, unknown, SqlClient.SqlClient>) => {
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
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { NEAR_NETWORK: "testnet" } })))
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
