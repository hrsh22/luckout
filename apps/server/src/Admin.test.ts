import { Api } from "@luckout/api"
import { Keypair } from "@solana/web3.js"
import { Effect, Exit, Layer } from "effect"
import { OpenApi } from "effect/http-api"
import { SqlClient } from "effect/sql"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Admin } from "./Admin.ts"
import { Alerts } from "./Alerts.ts"
import { Bitrefill } from "./Bitrefill.ts"
import { DbMemory } from "./Db.ts"
import { Sales } from "./Sales.ts"
import { Chain, SolanaUnavailable } from "./Solana.ts"
import { fakeBitrefill, solanaLayer, solanaWorld, type SolanaWorld } from "./testing.ts"

// The admin panel's server side on an in-memory database and the real program on LiteSVM, with Bitrefill faked.
process.env.ADMIN_ACCOUNTS = "boss, luckout"

const USDC = 1_000_000

/** A world where alice holds $120 in her Balance, on top of the world's $1,000 reserve. */
const funded = () => {
  const world = solanaWorld()
  const alice = world.shopper()
  world.give(alice.usdc, 120n * BigInt(USDC))
  const p = world.program
  world.send([
    p.instruction("deposit_for", { config: p.config, customer: p.customer(alice.wallet.publicKey), source: alice.usdc, vault: p.vault, vault_authority: p.vaultAuthority })
  ], [])
  return { world, alice: alice.wallet.publicKey.toBase58() }
}

const alerts: Array<string> = []
const layerFor = (world: SolanaWorld, chain: Chain["Service"] = world.chain) =>
  Admin.layer.pipe(
    Layer.provideMerge(Sales.layer),
    Layer.provide(Layer.mergeAll(
      solanaLayer({ ...world, chain }),
      Layer.succeed(Bitrefill, fakeBitrefill()),
      Layer.succeed(Alerts, Alerts.of({ admin: (t) => Effect.sync(() => void alerts.push(t)), customer: () => Effect.succeed(true) }))
    )),
    Layer.provideMerge(DbMemory)
  )

const { world, alice } = funded()
const layer = layerFor(world)
const run = <A, E>(e: Effect.Effect<A, E, Admin | Sales | SqlClient.SqlClient>) => Effect.runPromise(Effect.scoped(e).pipe(Effect.provide(layer)))

const purchase = (id: string, step: string, error: string | null, minutesAgo = 30, account = alice) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`WITH co AS (INSERT INTO checkouts (account_id, step) VALUES ('test', 'done') RETURNING id) INSERT INTO purchases (checkout_id, id, account_id, idempotency_key, voucher_name, voucher_id, package_value, reference_price, step, error, created_at)
        VALUES ((SELECT id FROM co), ${id}, ${account}, ${id}, 'Test Card', 'test-card', '10', 10000000, ${step}, ${error}, now() - make_interval(mins => ${minutesAgo}))`)

test("only whitelisted accounts are admins", () =>
  run(Effect.gen(function*() {
    const admin = yield* Admin
    assert.equal(admin.isAdmin("boss"), true)
    assert.equal(admin.isAdmin("luckout"), true)
    assert.equal(admin.isAdmin(alice), false)
  })))

test("the overview reads the program's Config and Vault, the fee payer's SOL, the Pay Wallet's float, the repay cap and the paying limits", () =>
  run(Effect.gen(function*() {
    yield* purchase("00000000-0000-4000-8000-000000000001", "settled", null, 5)
    yield* purchase("00000000-0000-4000-8000-000000000002", "stuck", "Bitrefill order outcome unknown; check the Bitrefill account")
    const o = yield* (yield* Admin).overview
    assert.equal(o.cluster, "localnet")
    assert.equal(o.program.id, world.program.id.toBase58())
    assert.equal(o.program.owner, world.owner.publicKey.toBase58())
    assert.equal(o.program.operator, world.operator.publicKey.toBase58())
    assert.equal(o.program.payWallet, world.payWalletUsdc.toBase58())
    assert.equal(o.program.paused, false)
    assert.equal(o.reserve.free, 1_000 * USDC)
    assert.equal(o.reserve.held, 1_120 * USDC, "the Vault: the reserve and alice's Balance")
    assert.equal(o.reserve.customers, 120 * USDC, "what the Vault holds minus the reserve and Proceeds")
    assert.equal(o.reserve.maxCashback, 50 * USDC, "the lower of the fixed $50 and 20% of the reserve")
    assert.deepEqual(o.repay, { dailyCap: 500 * USDC, repaidToday: 0 })
    assert.deepEqual(
      o.keys.map((k) => [k.role, k.address, BigInt(k.balance) < BigInt(k.alertBelow) ? "low" : "ok"]),
      [["feePayer", world.feePayer.publicKey.toBase58(), "ok"], ["payWallet", world.payWalletUsdc.toBase58(), "low"]],
      "the fee payer has its SOL; the Pay Wallet has no float yet"
    )
    assert.deepEqual(o.paying, { daily: 0, monthly: 0, limits: { daily: 10_000 * USDC, monthly: 50_000 * USDC } })
    assert.equal(o.purchases.today, 2)
    assert.equal(o.purchases.deliveredToday, 1)
    assert.deepEqual(o.purchases.attention.map((a) => [a.step, a.retryable]), [["stuck", false]])
  })))

/** A checkout at `step` with its cards, each `[id, step, error]`, as the reconciler and giveUp leave them. */
const checkout = (step: string, cards: ReadonlyArray<readonly [string, string, string | null]>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.gen(function*() {
      const [co] = yield* sql<{ id: string }>`
        INSERT INTO checkouts (account_id, step, attempts, next_attempt_at, invoice_id) VALUES (${alice}, ${step}, 5, now() + interval '1 hour', 'inv-1') RETURNING id`
      for (const [i, [id, cardStep, error]] of cards.entries()) {
        yield* sql`INSERT INTO purchases (checkout_id, position, id, account_id, idempotency_key, voucher_name, voucher_id, package_value, reference_price, step, error, invoice_id)
                   VALUES (${co!.id}, ${i}, ${id}, ${alice}, ${id}, 'Test Card', 'test-card', '10', 10000000, ${cardStep}, ${error}, 'inv-1')`
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
    yield* admin.retry(id(21), "boss")
    const [openCo, openCards] = yield* steps(open)
    assert.deepEqual([openCo.step, openCo.attempts, openCo.due], ["delivery", 0, true])
    assert.deepEqual(openCards, ["delivery"])

    // Gave up at settle: the delivered card goes back to confirm, the failed one to fail, the slow one to delivery.
    const gaveUp = yield* checkout("stuck", [
      [id(22), "stuck", "Gave up after 12 attempts at confirm: send: timed out"],
      [id(23), "stuck", "Gave up after 12 attempts at fail: send: timed out"],
      [id(24), "stuck", "Gave up after 12 attempts at delivery: send: timed out"]
    ])
    yield* admin.retry(id(24), "boss")
    const [gaveUpCo, gaveUpCards] = yield* steps(gaveUp)
    assert.deepEqual([gaveUpCo.step, gaveUpCo.attempts, gaveUpCo.due, gaveUpCo.error], ["settle", 0, true, null])
    assert.deepEqual(gaveUpCards, ["confirm", "fail", "delivery"])
    assert.match(alerts.at(-1) ?? "", new RegExp(`boss retried purchase ${id(24)} at delivery`))

    // Gave up asking Bitrefill only: back to delivery.
    const slow = yield* checkout("stuck", [[id(25), "stuck", "Gave up after 12 attempts at delivery: invoice inv-1 is still pending"]])
    yield* admin.retry(id(25), "boss")
    assert.deepEqual((yield* steps(slow)).map((x) => (Array.isArray(x) ? x : x.step)), ["delivery", ["delivery"]])

    // Where going again could pay or order twice, or nobody knows what happened: a human looks.
    const pay = yield* checkout("stuck", [[id(26), "stuck", "Gave up after 12 attempts at pay: send: fetch failed"]])
    const unknown = yield* checkout("stuck", [[id(27), "stuck", "Bitrefill order outcome unknown; check the Bitrefill account"]])
    for (const n of [26, 27]) {
      const refused = yield* admin.retry(id(n), "boss").pipe(Effect.flip)
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

test("any admin can stop and restart sales, and it's announced", () =>
  run(Effect.gen(function*() {
    const admin = yield* Admin
    const stopped = yield* admin.setSales(false, "boss")
    assert.deepEqual([stopped.open, stopped.reason], [false, "stopped"])
    assert.equal((yield* admin.overview).salesStopped, true)
    assert.match(alerts.at(-1) ?? "", /boss stopped sales/)
    const open = yield* admin.setSales(true, "boss")
    assert.equal(open.open, true)
  })))

test("the purchases and users lists show what each customer bought, paid and holds", () =>
  run(Effect.gen(function*() {
    const admin = yield* Admin
    const sql = yield* SqlClient.SqlClient
    const lucky = "00000000-0000-4000-8000-000000000021"
    const bob = Keypair.generate().publicKey.toBase58()
    yield* purchase(lucky, "settled", null, 2)
    yield* sql`UPDATE purchases SET admitted = ${JSON.stringify({ mode: { lucky: 2 }, max_price: "11000000", lucky_amount: "10000000" })}::jsonb,
               draw = ${JSON.stringify({ game_version: 2, final_price: "8000000", cashback: "3000000" })}::jsonb WHERE id = ${lucky}`
    yield* sql`INSERT INTO known_accounts (account_id) VALUES (${alice}), (${bob}) ON CONFLICT DO NOTHING`
    const [p] = yield* admin.purchases(alice)
    assert.deepEqual([p?.id, p?.paid, p?.cashback, p?.maxPrice], [lucky, 8_000_000, 3_000_000, 11_000_000])
    const users = yield* admin.users
    const a = users.find((u) => u.accountId === alice)
    assert.equal(a?.balance, 120 * USDC)
    assert.equal(a?.perPurchaseLimit, "200000000", "the program's default limits")
    assert.equal(a?.cashback, 3_000_000)
    assert.ok((a?.spent ?? 0) >= 8_000_000, "the Lucky Buy counts at its final price")
    assert.equal(users.find((u) => u.accountId === bob)?.balance, 0, "never made the approval: nothing held")
  })))

test("the overview shows how near the busiest Checkout Email is to Bitrefill's limits", () =>
  run(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO checkout_emails (account_id, email, email_key) VALUES ('alice', 'sealed', 'k1'), ('bob', 'sealed', 'k2')`
    // Two cards for one email today, one for the other, one rejected (never reached Bitrefill) and one 2 days old.
    const add = (id: string, key: string, step: string, price: number, hoursAgo: number, invoice: string | null) =>
      sql`WITH co AS (INSERT INTO checkouts (account_id, step) VALUES ('test', 'done') RETURNING id) INSERT INTO purchases (checkout_id, id, account_id, idempotency_key, voucher_name, voucher_id, package_value, reference_price, step, email_key, invoice_id, created_at)
          VALUES ((SELECT id FROM co), ${id}, 'alice', ${id}, 'Card', 'amazon-us', '10', ${price}, ${step}, ${key}, ${invoice}, now() - make_interval(hours => ${hoursAgo}))`
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

test("Stop sales and the shop's status need only the database: they work while Solana doesn't answer, and the overview doesn't", async () => {
  const down = new SolanaUnavailable({ message: "accounts: fetch failed" })
  const outage = layerFor(world, Chain.of({ ...world.chain, accounts: () => Effect.fail(down), balance: () => Effect.fail(down) }))
  const r = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const admin = yield* Admin
    const sales = yield* Sales
    const overview = yield* Effect.exit(admin.overview)
    const stopped = yield* admin.setSales(false, "boss")
    const seen = yield* sales.status
    const restarted = yield* admin.setSales(true, "boss")
    return { overview, stopped, seen, restarted }
  })).pipe(Effect.provide(outage)))
  assert.ok(Exit.isFailure(r.overview), "the overview reads the program, so it fails without Solana")
  assert.deepEqual([r.stopped.open, r.stopped.reason], [false, "stopped"])
  assert.equal(r.seen.reason, "stopped", "what the panel shows when the overview can't load")
  assert.equal(r.restarted.open, true, "an unreadable pause counts as not paused")
})

test("the program's pause closes the shop", async () => {
  const paused = funded().world
  paused.send([paused.program.instruction("set_paused", { owner: paused.owner.publicKey, config: paused.program.config }, { paused: true })], [paused.owner])
  const r = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    return [yield* (yield* Sales).status, (yield* (yield* Admin).overview).program.paused] as const
  })).pipe(Effect.provide(layerFor(paused))))
  assert.deepEqual([r[0].open, r[0].reason, r[1]], [false, "paused", true])
})

test("the users list shows the 300 most recent customers, and sign-ups that never deposited can't crowd out one who did", () =>
  run(Effect.gen(function*() {
    const admin = yield* Admin
    const sql = yield* SqlClient.SqlClient
    // alice deposited a month ago and never bought; 320 accounts have signed in since and done nothing else.
    yield* sql`INSERT INTO known_accounts (account_id, first_seen, onchain) VALUES (${alice}, now() - interval '30 days', true)`
    const signups = Array.from({ length: 320 }, () => Keypair.generate().publicKey.toBase58())
    yield* sql`INSERT INTO known_accounts (account_id) SELECT unnest(${signups}::text[])`
    const users = yield* admin.users
    assert.equal(users.length, 300, "one account read each, so the list is bounded")
    assert.equal(users[0]?.accountId, alice)
    assert.equal(users[0]?.balance, 120 * USDC)
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
               SELECT (SELECT id FROM co), ${alice}, 'k' || n, 'Test Card', 'test-card', '10', 10000000, 'settled' FROM generate_series(1, 300) n`
    const mine = yield* admin.purchases(alice)
    assert.equal(mine.length, 300)
    assert.ok(!mine.some((p) => p.id === old), "it is past the latest 300")
    assert.deepEqual((yield* admin.purchases(undefined, old)).map((p) => p.id), [old])
    assert.deepEqual(yield* admin.purchases(undefined, "00000000-0000-4000-8000-000000000999"), [], "no such purchase")
  })))
