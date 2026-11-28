import { address, lamports } from "@solana/kit"
import { type PublicKey } from "@solana/web3.js"
import { ConfigProvider, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Alerts } from "./Alerts.ts"
import { DbMemory } from "./Db.ts"
import { LOW_LINES, Monitor, secretWarning } from "./Monitor.ts"
import { decodeAccount, encode } from "./Program.ts"
import { CHECKOUT_OPEN_STEPS, OPEN_STEPS } from "./Purchases.ts"
import { Chain, SolanaUnavailable } from "./Solana.ts"
import { solanaLayer, solanaWorld, type SolanaWorld } from "./testing.ts"

// The Monitor on an in-memory database and the real program on LiteSVM. Its first round runs as soon as its layer is
// built: seed the database, build it, read the alerts.

const USDC = 1_000_000n

/** A world whose Pay Wallet has its float, so only what a test changes raises an alert. */
const healthyWorld = () => {
  const world = solanaWorld()
  world.give(world.payWalletUsdc, 200n * USDC)
  return world
}

/** Sets a token account's balance outright. */
const setTokens = (world: SolanaWorld, account: PublicKey, amount: bigint) => {
  const a = world.svm.getAccount(address(account.toBase58()))
  if (!a.exists) throw new Error("no such token account")
  const data = Buffer.from(a.data)
  data.writeBigUInt64LE(amount, 64)
  world.svm.setAccount({ ...a, data })
}

/** Changes Config's fields outright, as only the program could. */
const patchConfig = (world: SolanaWorld, change: Record<string, unknown>) => {
  const a = world.svm.getAccount(address(world.program.config.toBase58()))
  if (!a.exists) throw new Error("no Config")
  const data = Buffer.from(a.data)
  const out: Array<Uint8Array> = [data.subarray(0, 8)]
  encode({ defined: { name: "Config" } }, { ...decodeAccount<Record<string, unknown>>("Config", data), ...change }, out)
  const next = Buffer.alloc(data.length)
  Buffer.concat(out).copy(next)
  world.svm.setAccount({ ...a, data: next })
}

const setSol = (world: SolanaWorld, key: PublicKey, sol: bigint) => {
  const a = world.svm.getAccount(address(key.toBase58()))
  if (!a.exists) throw new Error("no such account")
  world.svm.setAccount({ ...a, lamports: lamports(sol) })
}

/** A chain whose RPC doesn't answer. */
const down = (world: SolanaWorld) => {
  const e = new SolanaUnavailable({ message: "accounts: fetch failed" })
  return Chain.of({ ...world.chain, accounts: () => Effect.fail(e), balance: () => Effect.fail(e) })
}

const monitorWith = (world: SolanaWorld, alerts: Array<string>, chain: Chain["Service"] = world.chain) =>
  Monitor.pipe(Layer.provide(Layer.mergeAll(
    solanaLayer({ ...world, chain }),
    Layer.succeed(Alerts, Alerts.of({ admin: (t) => Effect.sync(() => void alerts.push(t)), customer: () => Effect.succeed(true) }))
  )))

const round = (
  world: SolanaWorld,
  seed: Effect.Effect<unknown, unknown, SqlClient.SqlClient>,
  o: { env?: Record<string, string>; chain?: Chain["Service"] } = {}
) => {
  const alerts: Array<string> = []
  return Effect.runPromise(
    Effect.gen(function*() {
      yield* seed
      yield* Layer.build(monitorWith(world, alerts, o.chain))
      yield* Effect.sleep("300 millis")
      return alerts
    }).pipe(
      Effect.scoped,
      Effect.provide(DbMemory),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: o.env ?? {} })))
    )
  )
}

const healthy = healthyWorld()

const purchaseAt = (step: string, minutesAgo: number) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`WITH co AS (INSERT INTO checkouts (account_id, step) VALUES ('test', 'done') RETURNING id) INSERT INTO purchases (checkout_id, account_id, idempotency_key, voucher_id, voucher_name, package_value, reference_price, step, created_at)
        VALUES ((SELECT id FROM co), 'alice', ${crypto.randomUUID()}, 'amazon-us', 'Card', '10', 10000000, ${step}, now() - make_interval(mins => ${minutesAgo}))`)

test("a purchase unfinished after 15 minutes raises an alert at every open step, `pay` included", async () => {
  for (const step of OPEN_STEPS) {
    const alerts = await round(healthy, purchaseAt(step, 20))
    assert.ok(alerts.some((a) => a.includes("1 purchase(s) still unfinished after 15 minutes")), `${step}: ${JSON.stringify(alerts)}`)
  }
  assert.deepEqual(await round(healthy, purchaseAt("pay", 5)), [], "a young one is left alone")
})

test("Solana being unreachable never hides the purchase alerts", async () => {
  const alerts = await round(healthy, Effect.all([purchaseAt("pay", 20), purchaseAt("stuck", 1)]), { chain: down(healthy) })
  assert.ok(alerts.some((a) => a.includes("1 purchase(s) stuck")), JSON.stringify(alerts))
  assert.ok(alerts.some((a) => a.includes("1 purchase(s) still unfinished after 15 minutes")), JSON.stringify(alerts))
})

test("a Draw still unfinished after 10 minutes raises an alert; a younger one doesn't", async () => {
  const drawing = (minutesAgo: number) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`INSERT INTO checkouts (account_id, step, updated_at) VALUES ('alice', 'draw', now() - make_interval(mins => ${minutesAgo}))`)
  assert.deepEqual(await round(healthy, drawing(5)), [])
  assert.deepEqual(await round(healthy, Effect.all([drawing(11), drawing(5)])), ["1 checkout(s) have a Draw still unfinished after 10 minutes"])
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

test("the checkout reconciler's index covers every open checkout step", async () => {
  const def = await Effect.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ indexdef: string }>`SELECT indexdef FROM pg_indexes WHERE indexname = 'checkouts_open'`).pipe(
      Effect.map((r) => r[0]!.indexdef),
      Effect.provide(DbMemory)
    )
  )
  for (const step of CHECKOUT_OPEN_STEPS) assert.ok(def.includes(`'${step}'`), `${step} missing from: ${def}`)
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
  await assert.rejects(round(healthy, Effect.void, { env: { BITREFILL_CLIENT_SECRET_EXPIRES_AT: "1802528701000" } }), /not milliseconds/)
  await assert.rejects(round(healthy, Effect.void, { env: { BITREFILL_CLIENT_SECRET_EXPIRES_AT: "NaN" } }), /finite number/)
})

// ---------- the money: solvency, and the keys that keep purchases going ----------

test("the Vault must hold every Balance, the reserve and the Proceeds: drained below them, the owner hears at once", async () => {
  const world = healthyWorld()
  const alice = world.shopper()
  world.give(alice.usdc, 120n * USDC)
  const p = world.program
  world.send([
    p.instruction("deposit_for", { config: p.config, customer: p.customer(alice.wallet.publicKey), source: alice.usdc, vault: p.vault, vault_authority: p.vaultAuthority })
  ], [])
  const known = Effect.flatMap(SqlClient.SqlClient, (sql) => sql`INSERT INTO known_accounts (account_id) VALUES (${alice.wallet.publicKey.toBase58()}), ('not-a-wallet')`)
  assert.deepEqual(await round(world, known), [], "the reserve's $1,000 and alice's $120, all there")
  setTokens(world, p.vault, 1_100n * USDC)
  const alerts = await round(world, known)
  assert.equal(alerts.length, 1)
  assert.match(alerts[0]!, /^the Vault holds 1100 USDC, less than the program owes: 1120 \(Balances 120, reserve and Proceeds 1000, open Checkouts 0\)\. Pause the program/)
})

test("the fee payer's SOL and the Pay Wallet's float: said when they drop and once a day while they last, not at each restart; recovered, the next drop is said again", async () => {
  const world = healthyWorld()
  setSol(world, world.feePayer.publicKey, LOW_LINES.feePayer / 2n)
  setTokens(world, world.payWalletUsdc, LOW_LINES.float / 2n)
  const alerts: Array<string> = []
  // One server start: its first round runs at once.
  const start = Effect.scoped(Effect.gen(function*() {
    yield* Layer.build(monitorWith(world, alerts))
    yield* Effect.sleep("300 millis")
  }))
  const said = () => [alerts.filter((a) => a.startsWith("the fee payer")).length, alerts.filter((a) => a.startsWith("the Pay Wallet's float")).length]
  const r = await Effect.runPromise(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* start
      const dropped = said()
      yield* start
      const restarted = said()
      setSol(world, world.feePayer.publicKey, 100n * LOW_LINES.feePayer)
      setTokens(world, world.payWalletUsdc, 200n * USDC)
      yield* start
      const recovered = said()
      setTokens(world, world.payWalletUsdc, LOW_LINES.float / 2n)
      yield* start
      const droppedAgain = said()
      // A day after it was last said, still low.
      yield* sql`UPDATE settings SET value = jsonb_set(value, '{float}', '0'::jsonb) WHERE key = 'low_balances'`
      yield* start
      return { dropped, restarted, recovered, droppedAgain, dayLater: said() }
    }).pipe(Effect.provide(DbMemory), Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))))
  )
  assert.deepEqual(r, { dropped: [1, 1], restarted: [1, 1], recovered: [1, 1], droppedAgain: [1, 2], dayLater: [1, 3] })
  assert.match(alerts.find((a) => a.startsWith("the Pay Wallet's float"))!, /down to 50 USDC/)
})

test("the owner hears when today's repayments to the Pay Wallet reach 80% of the daily cap", async () => {
  const world = healthyWorld()
  const today = BigInt(Math.floor(Date.now() / 86_400_000))
  patchConfig(world, { repay_daily_cap: 500n * USDC, repay_day: today, repaid_today: 399n * USDC })
  assert.deepEqual(await round(world, Effect.void), [], "79.8%")
  patchConfig(world, { repaid_today: 400n * USDC })
  assert.deepEqual(await round(world, Effect.void), [
    "today's repayments to the Pay Wallet reached 400 of the 500 USDC daily cap; raise it in the admin panel"
  ])
  patchConfig(world, { repay_day: today - 1n })
  assert.deepEqual(await round(world, Effect.void), [], "yesterday's repayments don't count")
})
