import { Api, type OwnerAction } from "@luckout/api"
import { address, lamports } from "@solana/kit"
import { getAssociatedTokenAddressSync } from "@solana/spl-token"
import { Keypair, type PublicKey, SystemProgram, Transaction } from "@solana/web3.js"
import { Effect, Exit, Layer } from "effect"
import { OpenApi } from "effect/http-api"
import { SqlClient } from "effect/sql"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { Admin } from "./Admin.ts"
import { Alerts } from "./Alerts.ts"
import { Bitrefill } from "./Bitrefill.ts"
import { DbMemory } from "./Db.ts"
import { Sales } from "./Sales.ts"
import { base58 } from "./Program.ts"
import { Chain, Solana, SolanaUnavailable } from "./Solana.ts"
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
    Layer.provideMerge(Layer.mergeAll(
      solanaLayer({ ...world, chain }),
      Layer.succeed(Bitrefill, fakeBitrefill()),
      Layer.succeed(Alerts, Alerts.of({ admin: (t) => Effect.sync(() => void alerts.push(t)), customer: () => Effect.succeed(true) }))
    )),
    Layer.provideMerge(DbMemory)
  )

const { world, alice } = funded()
const layer = layerFor(world)
const run = <A, E>(e: Effect.Effect<A, E, Admin | Sales | Solana | SqlClient.SqlClient>) => Effect.runPromise(Effect.scoped(e).pipe(Effect.provide(layer)))

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
    assert.deepEqual(o.repay, { dailyCap: 500 * USDC, repaidToday: 0, advanced: 0, refundsPending: 0 })
    assert.deepEqual(o.undelivered, [])
    assert.deepEqual(
      o.keys.map((k) => [k.role, k.address, k.usdcAccount, BigInt(k.balance) < BigInt(k.alertBelow) ? "low" : "ok"]),
      [["feePayer", world.feePayer.publicKey.toBase58(), undefined, "ok"], ["payWallet", world.payWallet.publicKey.toBase58(), world.payWalletUsdc.toBase58(), "low"]],
      "the fee payer has its SOL; the Pay Wallet has no float yet. Each shows the wallet to send to; the Pay Wallet's USDC account is only a detail"
    )
    assert.deepEqual(o.paying, { daily: 0, monthly: 0, limits: { daily: 10_000 * USDC, monthly: 50_000 * USDC } }, "test cards are free")
    assert.equal(o.purchases.today, 2)
    assert.equal(o.purchases.deliveredToday, 1)
    assert.deepEqual(o.purchases.attention.map((a) => [a.step, a.retryable]), [["stuck", false]])
  })))

test("our paying address counts every card the Pay Wallet paid: a guest's and one on a customer's own Bitrefill account", () =>
  run(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    for (const [key, price, buyer, emailKey] of [["g", 10, "guest", "ek"], ["a", 20, "account", null]] as const) {
      yield* sql`WITH co AS (INSERT INTO checkouts (account_id, step) VALUES ('test', 'done') RETURNING id)
                 INSERT INTO purchases (checkout_id, account_id, idempotency_key, voucher_id, voucher_name, package_value, reference_price, step, buyer, email_key, invoice_id, ordered_at)
                 VALUES ((SELECT id FROM co), ${alice}, ${key}, 'amazon-us', 'Card', '10', ${price * USDC}, 'settled', ${buyer}, ${emailKey}, 'inv', now())`
    }
    const o = yield* (yield* Admin).overview
    assert.deepEqual([o.paying.daily, o.paying.monthly], [30 * USDC, 30 * USDC])
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

    // Gave up at admit or pay: back there, where the saved transaction is looked up before anything is signed again.
    const pay = yield* checkout("stuck", [[id(26), "stuck", "Gave up after 12 attempts at pay: send: fetch failed"]])
    const admit = yield* checkout("stuck", [[id(28), "stuck", "Gave up after 12 attempts at admit: send: fetch failed"]])
    yield* admin.retry(id(26), "boss")
    yield* admin.retry(id(28), "boss")
    assert.deepEqual((yield* steps(pay)).map((x) => (Array.isArray(x) ? x : x.step)), ["pay", ["pay"]])
    assert.deepEqual((yield* steps(admit)).map((x) => (Array.isArray(x) ? x : x.step)), ["admit", ["admit"]])

    // Where nobody knows what happened (an order on our own account), or a dump was restored: a human looks.
    const unknown = yield* checkout("stuck", [[id(27), "stuck", "Bitrefill order outcome unknown; check the Bitrefill account"]])
    const restored = yield* checkout("stuck", [[id(29), "stuck", "Restored from a dump at pay: check by hand"]])
    for (const n of [27, 29]) {
      const refused = yield* admin.retry(id(n), "boss").pipe(Effect.flip)
      assert.match(refused.message, /needs a manual check/)
    }
    assert.deepEqual((yield* steps(unknown))[1], ["stuck"])
    assert.deepEqual((yield* steps(restored))[1], ["stuck"])

    // The panel offers Retry now exactly where it works, and labels a payment as the checkout's.
    yield* checkout("stuck", [[id(30), "stuck", "Gave up after 12 attempts at pay: send: fetch failed"]])
    const attention = (yield* admin.overview).purchases.attention
    assert.deepEqual(attention.filter((a) => [id(27), id(29), id(30)].includes(a.id)).map((a) => [a.id, a.retryable]), [[id(27), false], [id(29), false], [id(30), true]])
    const [listed] = yield* admin.purchases(undefined, id(22))
    assert.equal(listed!.checkoutId, gaveUp)
  })))

test("each card we paid for and Bitrefill didn't deliver is listed with its customer's refund, until an admin marks Bitrefill's refund received", () =>
  run(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const sig = (n: number) => base58.encode(Buffer.alloc(64, n))
    const signed = (n: number) => JSON.stringify({ signature: sig(n), bytes: "", lastValidBlockHeight: 0 })
    const [co] = yield* sql<{ id: string }>`
      INSERT INTO checkouts (account_id, step, invoice_id, pay_tx, advance, ordered_at)
      VALUES (${alice}, 'done', 'inv-9', ${signed(1)}::jsonb, 7000000, now() - interval '1 hour') RETURNING id`
    // Unpaid ones aren't listed: nothing to claim from Bitrefill.
    const [unpaid] = yield* sql<{ id: string }>`INSERT INTO checkouts (account_id, step) VALUES (${alice}, 'done') RETURNING id`
    const card = (id: string, checkout: string, position: number, step: string, extra: { pending?: number; paid?: string; settle?: string } = {}) =>
      sql`INSERT INTO purchases (checkout_id, position, id, account_id, idempotency_key, voucher_name, voucher_id, package_value, reference_price, step, invoice_id,
                                 refund_pending, refund_paid_at, refund_tx, settle_tx)
          VALUES (${checkout}, ${position}, ${id}, ${alice}, ${id}, 'Card', 'amazon-us', '10', 10000000, ${step}, 'inv-9', ${extra.pending ?? null},
                  ${extra.paid ? new Date() : null}, ${extra.paid ?? null}, ${extra.settle ? JSON.stringify({ signature: extra.settle }) : null}::jsonb)`
    yield* card("00000000-0000-4000-8000-0000000000a1", co!.id, 0, "settled")
    yield* card("00000000-0000-4000-8000-0000000000a2", co!.id, 1, "failed", { settle: sig(2) })
    yield* card("00000000-0000-4000-8000-0000000000a3", co!.id, 2, "failed", { pending: 7000000 })
    yield* card("00000000-0000-4000-8000-0000000000a4", unpaid!.id, 0, "failed")
    const admin = yield* Admin
    const listed = (yield* admin.overview).undelivered
    assert.deepEqual(listed.map((u) => [u.purchaseId.slice(-2), u.refund, u.refundPending, u.refundTx]), [
      ["a2", "paid", undefined, sig(2)],
      ["a3", "pending", 7 * USDC, undefined]
    ])
    assert.deepEqual([listed[0]!.invoiceId, listed[0]!.payTx, listed[0]!.amount, listed[0]!.advance, listed[0]!.claimed], ["inv-9", sig(1), 10 * USDC, 7 * USDC, undefined])
    assert.ok(listed[0]!.paidAt)

    assert.equal((yield* admin.claimed(co!.id, "not a signature", "boss").pipe(Effect.flip))._tag, "AdminInvalid")
    assert.equal((yield* admin.claimed(unpaid!.id, sig(3), "boss").pipe(Effect.flip))._tag, "NotFound", "nothing we paid for")
    yield* admin.claimed(co!.id, sig(3), "boss")
    const after = (yield* admin.overview).undelivered
    assert.deepEqual(after.map((u) => u.claimed?.tx), [sig(3), sig(3)])
    assert.equal(after[0]!.claimed?.by, "boss")
    assert.match(alerts.at(-1)!, /^boss marked Bitrefill's refund for invoice inv-9 \(checkout .*\) received: /)
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

// ---------- owner transactions (ADR-0015): prepared here, paid for and signed in the owner's own wallet, sent as signed ----------

/** What a wallet does with a prepared transaction: signs it, and hands it back. */
const signAs = (wallet: Keypair, transaction: string) => {
  const tx = Transaction.from(Buffer.from(transaction, "base64"))
  tx.partialSign(wallet)
  return tx.serialize({ requireAllSignatures: false }).toString("base64")
}

/** Runs `f` on a fresh world, with `sign`: admin "boss" prepares the action and `key` (the owner by default) signs it. */
const asOwner = <A, E>(f: (w: SolanaWorld, sign: (action: OwnerAction, key?: Keypair) => Effect.Effect<unknown, unknown>) => Effect.Effect<A, E, Admin | Solana>) => {
  const w = solanaWorld()
  return Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const admin = yield* Admin
    const solana = yield* Solana
    const sign = (action: OwnerAction, key = w.owner) =>
      admin.ownerTransaction("boss", action).pipe(Effect.flatMap((t) => admin.sendOwner("boss", signAs(key, t.transaction))))
    return yield* f(w, sign)
  })).pipe(Effect.provide(layerFor(w))))
}

test("the owner pauses and sets the caps from their own wallet; a non-admin can't prepare anything", () =>
  asOwner((w, sign) =>
    Effect.gen(function*() {
      const admin = yield* Admin
      const solana = yield* Solana
      const refused = yield* Effect.flip(admin.ownerTransaction(alice, { _tag: "set_paused", paused: true }))
      assert.equal(refused._tag, "NotFound", "to anyone else the endpoint doesn't exist")

      yield* sign({ _tag: "set_paused", paused: true })
      yield* sign({ _tag: "set_cashback_cap", fixed: null, reserveBps: 3_000 })
      yield* sign({ _tag: "set_repay_cap", daily: 900 * USDC })
      yield* sign({ _tag: "set_min_lucky_checkout", amount: 4 * USDC })
      const c = yield* solana.config
      assert.equal(c.paused, true)
      assert.deepEqual(c.cashback_cap, { fixed: null, reserve_bps: 3_000 })
      assert.deepEqual([c.repay_daily_cap, c.min_lucky_checkout], [900n * BigInt(USDC), 4n * BigInt(USDC)])
      const o = yield* admin.overview
      assert.deepEqual([o.program.paused, o.reserve.maxCashback, o.repay.dailyCap], [true, 300 * USDC, 900 * USDC])

      const resume = yield* admin.ownerTransaction("boss", { _tag: "set_paused", paused: false })
      assert.throws(() => signAs(Keypair.generate(), resume.transaction), /unknown signer/, "only the owner's key can sign it")
      assert.match((yield* Effect.flip(admin.sendOwner("boss", resume.transaction))).message, /fully signed/, "nothing goes out unsigned")
      assert.equal((yield* Effect.flip(admin.sendOwner(alice, resume.transaction)))._tag, "NotFound")
      // The owner's wallet may add its own checks before signing, as Phantom does: it signs alone, so it still lands.
      const theirs = Transaction.from(Buffer.from(resume.transaction, "base64"))
      theirs.add(SystemProgram.transfer({ fromPubkey: w.owner.publicKey, toPubkey: w.owner.publicKey, lamports: 0 }))
      theirs.sign(w.owner)
      yield* admin.sendOwner("boss", theirs.serialize().toString("base64"))
      assert.equal((yield* solana.config).paused, false)
    })))

test("the reserve leaves only for the owner's USDC account, opened at the owner's cost, and comes back from it", () =>
  asOwner((w, sign) =>
    Effect.gen(function*() {
      const solana = yield* Solana
      const ownerUsdc = getAssociatedTokenAddressSync(w.mint, w.owner.publicKey)
      assert.equal(yield* solana.account(ownerUsdc), undefined, "no USDC account yet")
      yield* sign({ _tag: "withdraw_reserve", amount: 100 * USDC })
      assert.equal(w.tokens(ownerUsdc), 100n * BigInt(USDC))
      yield* sign({ _tag: "fund_reserve", amount: 40 * USDC })
      assert.equal(w.tokens(ownerUsdc), 60n * BigInt(USDC))
      assert.equal((yield* solana.config).free_reserve, 940n * BigInt(USDC))
      const tooMuch = yield* Effect.flip(sign({ _tag: "withdraw_reserve", amount: 10_000 * USDC }))
      assert.match(String((tooMuch as { message?: string }).message), /free reserve/i, "the program refuses more than is free")
    })))

test("the owner names a new operator and Pay Wallet, and hands over to a proposed owner who accepts in their own wallet", () =>
  asOwner((w, sign) =>
    Effect.gen(function*() {
      const admin = yield* Admin
      const solana = yield* Solana
      const [operator, payWallet, next] = [Keypair.generate(), Keypair.generate(), Keypair.generate()]
      const nothing = yield* Effect.flip(admin.ownerTransaction("boss", { _tag: "accept_owner" }))
      assert.match(nothing.message, /No new owner is proposed/)
      const bad = yield* Effect.flip(admin.ownerTransaction("boss", { _tag: "set_operator", operator: "not-a-key" }))
      assert.match(bad.message, /isn't a Solana address/)

      yield* sign({ _tag: "set_operator", operator: operator.publicKey.toBase58() })
      yield* sign({ _tag: "set_pay_wallet", payWallet: payWallet.publicKey.toBase58() })
      yield* sign({ _tag: "propose_owner", newOwner: next.publicKey.toBase58() })
      const proposed = yield* solana.config
      assert.ok(proposed.operator.equals(operator.publicKey))
      assert.ok(proposed.pay_wallet.equals(getAssociatedTokenAddressSync(w.mint, payWallet.publicKey)), "its USDC account, opened at the owner's cost")
      assert.ok(proposed.pending_owner?.equals(next.publicKey))

      // The proposed owner's wallet pays its own fee too.
      w.svm.airdrop(address(next.publicKey.toBase58()), lamports(10_000_000n))
      yield* sign({ _tag: "accept_owner" }, next)
      const after = yield* solana.config
      assert.ok(after.owner.equals(next.publicKey))
      assert.equal(after.pending_owner, null)
    })))

test("the owner names a guardian, who shows in the overview, and removes it", () =>
  asOwner((_, sign) =>
    Effect.gen(function*() {
      const admin = yield* Admin
      const guardian = Keypair.generate().publicKey.toBase58()
      assert.equal((yield* admin.overview).program.guardian, undefined)
      yield* sign({ _tag: "set_guardian", guardian })
      assert.equal((yield* admin.overview).program.guardian, guardian)
      yield* sign({ _tag: "set_guardian", guardian: null })
      assert.equal((yield* admin.overview).program.guardian, undefined)
    })))

test("an upgrade shows the buffer's hash first, takes only one the upgrade authority holds, and returns its rent to it", () =>
  asOwner((w, sign) =>
    Effect.gen(function*() {
      const admin = yield* Admin
      const so = readFileSync(new URL("../../../programs/target/deploy/luckout.so", import.meta.url))
      const buffer = (authority: PublicKey, build = so) => {
        const at = Keypair.generate().publicKey.toBase58()
        const data = Buffer.concat([Buffer.from([1, 0, 0, 0, 1]), authority.toBuffer(), build])
        w.svm.setAccount({
          address: address(at),
          data,
          executable: false,
          lamports: lamports(5_000_000_000n),
          programAddress: address("BPFLoaderUpgradeab1e11111111111111111111111"),
          space: BigInt(data.length)
        })
        return at
      }
      const owner = address(w.owner.publicKey.toBase58())
      const ours = buffer(w.owner.publicKey)
      const checked = yield* admin.buffer("boss", ours)
      // As solana-verify hashes a build: without its trailing zeros (checked against a CI build's printed hash).
      const hash = createHash("sha256").update(so.subarray(0, so.findLastIndex((b) => b !== 0) + 1)).digest("hex")
      assert.deepEqual([checked.hash, checked.size, checked.authority], [hash, so.length, w.owner.publicKey.toBase58()], "the hash CI prints for this build")
      assert.deepEqual(checked.program, { hash, upgradeAuthority: w.owner.publicKey.toBase58(), room: checked.program.room })
      assert.ok(checked.program.room >= so.length)

      assert.equal((yield* Effect.flip(admin.buffer(alice, ours)))._tag, "NotFound")
      assert.match((yield* Effect.flip(admin.buffer("boss", w.mint.toBase58()))).message, /isn't a program buffer/)
      const theirs = buffer(Keypair.generate().publicKey)
      assert.match((yield* Effect.flip(admin.ownerTransaction("boss", { _tag: "upgrade", buffer: theirs }))).message, /not the upgrade authority/)
      const big = buffer(w.owner.publicKey, Buffer.concat([so, Buffer.alloc(checked.program.room, 1)]))
      assert.match((yield* Effect.flip(admin.ownerTransaction("boss", { _tag: "upgrade", buffer: big }))).message, /extend it first/)

      // The loader refuses an upgrade in the slot the program was deployed in, and LiteSVM deployed it in slot 0.
      w.svm.warpToSlot(w.svm.getClock().slot + 1n)
      const before = w.svm.getBalance(owner) ?? 0n
      yield* sign({ _tag: "upgrade", buffer: ours })
      assert.equal(w.svm.getAccount(address(ours)).exists, false, "the buffer is spent")
      const back = (w.svm.getBalance(owner) ?? 0n) - before
      assert.ok(back > 4_999_000_000n && back < 5_000_000_000n, "its rent went back to the owner, less the fee its wallet paid")
    })))
