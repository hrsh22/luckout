import { ConfigProvider, Effect, Exit, Layer } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { DbMemory, DeploymentLock } from "./Db.ts"

// Two made-up program addresses.
const PRODUCTION = "11111111111111111111111111111112"
const STAGING = "11111111111111111111111111111113"

const start = (env: Record<string, string>) =>
  Layer.build(DeploymentLock).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))))

test("a database stays with the deployment that first used it: staging and production never share one", async () => {
  const exits = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const production = { SOLANA_CLUSTER: "mainnet", SOLANA_PROGRAM_ID: PRODUCTION }
    return [
      yield* Effect.exit(start(production)),
      yield* Effect.exit(start(production)),
      yield* Effect.exit(start({ SOLANA_CLUSTER: "mainnet", SOLANA_PROGRAM_ID: STAGING })),
      yield* Effect.exit(start({ SOLANA_CLUSTER: "devnet", SOLANA_PROGRAM_ID: PRODUCTION }))
    ]
  })).pipe(Effect.provide(DbMemory)))
  assert.deepEqual(exits.map(Exit.isSuccess), [true, true, false, false])
})

test("the NEAR deployment's database is refused: the Solana one starts on a fresh database", async () => {
  const { SqlClient } = await import("effect/sql")
  const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO settings (key, value, updated_by) VALUES ('contract', '"app.luckout.near"'::jsonb, 'server')`
    return yield* Effect.exit(start({ SOLANA_CLUSTER: "mainnet", SOLANA_PROGRAM_ID: PRODUCTION }))
  })).pipe(Effect.provide(DbMemory)))
  assert.equal(Exit.isSuccess(exit), false)
})

test("every purchase made before carts becomes a checkout of its own, under its own id, with its invoice and payment", async () => {
  const { PGlite } = await import("@electric-sql/pglite")
  const { PgliteClient } = await import("@effect/sql-pglite")
  const { Migrator, SqlClient } = await import("effect/sql")
  const { migrationSteps } = await import("./Db.ts")
  const pg = await PGlite.create()
  const before = Object.fromEntries(Object.entries(migrationSteps).filter(([name]) => name < "0025"))
  const rows = await Effect.runPromise(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* Migrator.make({})({ loader: Migrator.fromRecord(before) })
    // One paid and on its way, one settled, one waiting to be confirmed onchain.
    yield* sql`INSERT INTO purchases (id, account_id, idempotency_key, voucher_id, voucher_name, package_value, reference_price, step, invoice_id,
                                      invoice_token, invoice_at, pay_to, pay_amount, pay_tx, buyer, email_key, attempts)
               VALUES ('00000000-0000-0000-0000-0000000000a1', 'alice.near', 'k1', 'amazon-us', 'Card', '10', 10000000, 'delivery', 'inv-1',
                       'sealed', now(), '0xabc', 10000000, '{"hash":"0xpay"}', 'guest', 'ek', 3),
                      ('00000000-0000-0000-0000-0000000000a2', 'alice.near', 'k2', 'amazon-us', 'Card', '10', 10000000, 'settled', 'inv-2',
                       NULL, NULL, NULL, NULL, NULL, 'guest', 'ek', 0)`
    yield* sql`INSERT INTO purchases (id, account_id, idempotency_key, voucher_id, voucher_name, package_value, reference_price, step, settle_tx)
               VALUES ('00000000-0000-0000-0000-0000000000a3', 'bob.near', 'k3', 'amazon-us', 'Card', '10', 10000000, 'confirm', '{"hash":"t"}')`
    yield* Migrator.make({})({ loader: Migrator.fromRecord(migrationSteps) })
    return yield* sql<{ id: string; card: string; step: string; card_step: string; pay_amount: string | null; pay_tx: unknown; invoice_token: string | null; settle_tx: unknown; attempts: number }>`
      SELECT c.id, p.id AS card, c.step, p.step AS card_step, c.pay_amount::text, c.pay_tx, c.invoice_token, c.settle_tx, c.attempts
      FROM purchases p JOIN checkouts c ON c.id = p.checkout_id ORDER BY p.id`
  }).pipe(Effect.provide(PgliteClient.layer({ liveClient: pg }))))
  await pg.close()
  assert.deepEqual(rows.map((r) => r.id === r.card), [true, true, true], "the same id, so its sealed invoice token still opens")
  assert.deepEqual(rows.map((r) => [r.step, r.card_step]), [["delivery", "delivery"], ["done", "settled"], ["settle", "confirm"]])
  assert.deepEqual([rows[0]!.pay_amount, rows[0]!.pay_tx, rows[0]!.invoice_token, rows[0]!.attempts], ["10000000", { hash: "0xpay" }, "sealed", 3])
  assert.deepEqual(rows[2]!.settle_tx, { hash: "t" }, "a confirmation in flight resumes as the checkout's settlement")
})
