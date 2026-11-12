import { CreditSettings, type Mode, NewPurchase, ShopStatus, Voucher } from "@luckout/api"
import { ConfigProvider, Effect, Fiber, Layer } from "effect"
import { SqlClient } from "effect/sql"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Alerts } from "./Alerts.ts"
import { Bitrefill, type Order } from "./Bitrefill.ts"
import { Credit, CREDIT_DEFAULTS } from "./Credit.ts"
import { DbMemory } from "./Db.ts"
import { ContractRejected, Near, NearUnavailable, type Outcome } from "./Near.ts"
import { Purchases } from "./Purchases.ts"
import { Refill } from "./Refill.ts"
import { Sales } from "./Sales.ts"
import { fakeBitrefill, fakeNear } from "./testing.ts"

// The purchase workflow end to end on an in-memory database, with NEAR and Bitrefill faked.
process.env.NEAR_NETWORK = "testnet"
process.env.REDEMPTION_KEY = "11".repeat(32)

const account = { balance: "500000000", per_purchase_limit: "500000000", daily_limit: "500000000", day: 0, spent_today: "0" }

const world = (opts: {
  account?: typeof account | null
  /** "down": NEAR doesn't answer the confirmation, so the run pauses there. */
  confirm?: "ok" | "refused" | "down"
  onchain?: string
  /** More of the contract's record of the purchase (get_purchase). */
  onchainPurchase?: Record<string, unknown>
  /** The mode the customer buys in. */
  mode?: Mode
  /** The contract refuses admission with this message. */
  admitRefused?: string
  /** A real card (paid from our Bitrefill credit) instead of a free test card. */
  real?: boolean
  price?: number
  /** Our Bitrefill credit, micro-USDC; change it with `w.setCredit`. */
  credit?: number
  orders?: Array<Order["_tag"]>
} = {}) => {
  const calls: Array<string> = []
  const alerts: Array<string> = []
  /** What admission was asked for, each time. */
  const admits: Array<Record<string, unknown>> = []
  let creditBalance = opts.credit ?? 1_000_000_000
  let creditDelay = 0
  const orders = [...(opts.orders ?? [])]
  let kicks = 0
  let shop = new ShopStatus({ open: true })
  const price = opts.price ?? 10_000_000
  const mode = opts.mode ?? "normal"
  const voucherId = opts.real ? "amazon-us" : "test-card"
  const outcome = (value: unknown, events: Outcome["events"] = []): Outcome => ({ hash: "h", value, events, failures: [] })
  const near = fakeNear({
    view: <A>(method: string) =>
      Effect.succeed(
        (method === "get_account"
          ? (opts.account === undefined ? account : opts.account)
          : method === "quote"
          // The reserve covers $6 of a Lucky Buy right now.
          ? { mode, reference_price: String(price), lucky_amount: "6000000", max_price: String(price + 1_200_000) }
          : { status: opts.onchain ?? "Pending", ...opts.onchainPurchase }) as A
      ),
    call: (method, args, persist) =>
      Effect.gen(function*() {
        calls.push(method)
        yield* persist({ hash: `${method}-tx`, bytes: "" })
        if (method === "purchase") {
          admits.push(args as Record<string, unknown>)
          if (opts.admitRefused) return yield* new ContractRejected({ message: opts.admitRefused })
          return outcome(7, [{ event: "purchase", data: [{ purchase: { mode: "normal", max_price: String(price), lucky_amount: "0" } }] }])
        }
        if (opts.confirm === "refused") return yield* new ContractRejected({ message: "Purchase is already closed" })
        if (opts.confirm === "down" && method === "confirm_delivery") return yield* new NearUnavailable({ message: "send: timed out" })
        return outcome(null)
      })
  })
  const bitrefill = fakeBitrefill({
    voucher: () =>
      Effect.succeed(new Voucher({ id: voucherId, name: "Card", countryCode: "US", currency: "USD", packages: [{ value: "10", priceMicroUsdc: price }] })),
    order: () =>
      Effect.sync((): Order => {
        calls.push("order")
        const tag = orders.shift() ?? "Ordered"
        if (tag === "NoCredit") return { _tag: "NoCredit", reason: "Balance too low (INVALID_INPUT)" }
        // Ordering spends the credit, as Bitrefill would.
        creditBalance -= price
        return { _tag: "Ordered", invoiceId: "inv-1" }
      }),
    delivery: () => Effect.succeed({ _tag: "Delivered" as const, invoiceId: "inv-1", orderId: "o-1", redemption: { code: "ABC-123" } }),
    // Each read takes `creditDelay` (set when it starts), like a slow Bitrefill.
    credit: Effect.suspend(() => Effect.delay(Effect.sync(() => ({ balance: creditBalance, room: 2_000_000_000 })), creditDelay))
  })
  const refill = Refill.of({
    kick: Effect.sync(() => void kicks++),
    request: () => Effect.die("not used"),
    resolve: () => Effect.die("not used"),
    process: Effect.void,
    status: Effect.die("not used")
  })
  const layer = Purchases.layer.pipe(
    Layer.provideMerge(Credit.layer),
    Layer.provide(Layer.mergeAll(
      Layer.succeed(Near, near),
      Layer.succeed(Bitrefill, bitrefill),
      Layer.succeed(Refill, refill),
      Layer.succeed(Sales, Sales.of({ status: Effect.sync(() => shop), setOpen: () => Effect.die("not used") })),
      Layer.succeed(Alerts, Alerts.of({ admin: (t) => Effect.sync(() => void alerts.push(t)), customer: () => Effect.succeed(true) }))
    )),
    Layer.provideMerge(DbMemory),
    // Real cards are only sold on mainnet.
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({
      env: { ...(process.env as Record<string, string>), NEAR_NETWORK: opts.real ? "mainnet" : "testnet" }
    })))
  )
  const buy = (key: string = crypto.randomUUID(), who = "alice.test") =>
    Purchases.use((p) => p.create(who, new NewPurchase({ voucherId, value: "10", mode, maxPrice: price + (mode === "normal" ? 0 : 1_200_000), idempotencyKey: key })))
  const run = <A, E>(e: Effect.Effect<A, E, Purchases | Credit | SqlClient.SqlClient>) => Effect.runPromise(Effect.scoped(e).pipe(Effect.provide(layer)))
  return {
    calls,
    alerts,
    admits,
    layer,
    buy,
    run,
    kicks: () => kicks,
    setCredit: (micro: number) => void (creditBalance = micro),
    setCreditDelay: (ms: number) => void (creditDelay = ms),
    setShop: (s: ShopStatus) => void (shop = s)
  }
}

/** A purchase's row as saved. */
const rowOf = (id: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ step: string; attempts: number; due: boolean; quoted_lucky_amount: string | null }>`
      SELECT step, attempts, next_attempt_at <= now() AS due, quoted_lucky_amount::text FROM purchases WHERE id = ${id}`).pipe(Effect.map((r) => r[0]!))

/** Lets the workflow's own fiber run until the purchase stops moving. */
const settled = (id: string) =>
  Effect.gen(function*() {
    let last = ""
    for (let i = 0; i < 40; i++) {
      yield* Effect.sleep("50 millis")
      const { step } = yield* rowOf(id)
      if (step === last) return step
      last = step
    }
    return last
  })

/** A charged purchase saved as waiting for credit, admitted `admittedHoursAgo` and created `createdHoursAgo`. */
const restockRow = (createdHoursAgo: number, admittedHoursAgo: number) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ id: string }>`
      INSERT INTO purchases (account_id, idempotency_key, voucher_id, voucher_name, package_value, requested_mode, reference_price, max_debit,
                             step, contract_purchase_id, admitted, created_at)
      VALUES ('alice.test', ${crypto.randomUUID()}, 'amazon-us', 'Card', '10', '"normal"', 10000000, 10000000, 'restock', 7,
              ${JSON.stringify({ mode: "normal", max_price: "10000000", lucky_amount: "0", created_at: (Date.now() - admittedHoursAgo * 3_600_000) * 1e6 })},
              now() - make_interval(mins => ${Math.round(createdHoursAgo * 60)}))
      RETURNING id`).pipe(Effect.map((r) => r[0]!.id))

test("a purchase walks every step and shows the code only once delivered", async () => {
  const w = world()
  const p = await w.run(w.buy())
  assert.equal(p.status, "delivered")
  assert.equal(p.redemption?.code, "ABC-123")
  assert.deepEqual(w.calls, ["purchase", "order", "confirm_delivery"])
})

test("the same idempotency key never buys twice", async () => {
  const w = world()
  const [a, b] = await w.run(Effect.all([w.buy("same-key-1"), w.buy("same-key-1")]))
  assert.equal(a.id, b.id)
  assert.deepEqual(w.calls, ["purchase", "order", "confirm_delivery"])
})

test("an account with no balance is refused before anything is signed", async () => {
  const w = world({ account: null })
  const e = await w.run(w.buy().pipe(Effect.flip))
  assert.match(e.message, /No balance/)
  assert.deepEqual(w.calls, [])
})

test("over the per-purchase limit is refused before anything is signed", async () => {
  const w = world({ account: { ...account, per_purchase_limit: "5000000" } })
  const e = await w.run(w.buy().pipe(Effect.flip))
  assert.match(e.message, /per-purchase spending limit/)
  assert.deepEqual(w.calls, [])
})

test("a refused confirmation reads the chain: reclaimed means refunded, and a human is told", async () => {
  const w = world({ confirm: "refused", onchain: "Reclaimed" })
  const p = await w.run(w.buy())
  assert.equal(p.status, "failed")
  assert.match(p.error ?? "", /reclaimed/)
  assert.equal(p.redemption, undefined)
  assert.equal(w.alerts.length, 1)
})

test("a refused confirmation that is still open onchain stays pending for the reconciler", async () => {
  const w = world({ confirm: "refused", onchain: "Drawing" })
  const p = await w.run(w.buy())
  assert.equal(p.status, "pending")
  assert.equal(p.settleTx, undefined, "the next attempt signs a fresh transaction")
})

// ---------- Bitrefill credit (ADR-0009) ----------

test("a real card the credit covers goes straight through, without a refill", async () => {
  const w = world({ real: true, credit: 100_000_000 })
  const p = await w.run(w.buy())
  assert.equal(p.status, "delivered")
  assert.equal(w.kicks(), 0)
})

test("a card the credit can't cover waits uncharged, then goes on once the credit arrives", async () => {
  const w = world({ real: true, price: 12_000_000, credit: 5_000_000 })
  const r = await w.run(Effect.gen(function*() {
    const p = yield* w.buy()
    const calledBefore = [...w.calls]
    w.setCredit(30_000_000)
    yield* Effect.flatMap(Credit, (c) => c.refresh)
    yield* Effect.flatMap(Purchases, (s) => s.promoteWaiting)
    // The workflow runs in its own fiber; give it a moment.
    yield* Effect.sleep("300 millis")
    const after = yield* Effect.flatMap(Purchases, (s) => s.get("alice.test", p.id))
    return { first: p.status, calledBefore, after: after.status }
  }))
  assert.equal(r.first, "waiting")
  assert.deepEqual(r.calledBefore, [], "nothing signed or ordered while waiting")
  assert.equal(w.kicks(), 1, "a refill was asked for")
  assert.equal(r.after, "delivered")
})

test("two purchases can never count on the same credit", async () => {
  const w = world({ real: true, price: 10_000_000, credit: 15_000_000 })
  const statuses = await w.run(Effect.all([w.buy(), w.buy(undefined, "bob.test")], { concurrency: 2 }).pipe(Effect.map((ps) => ps.map((p) => p.status).sort())))
  assert.deepEqual(statuses, ["delivered", "waiting"])
})

test("a card far bigger than our credit isn't refused: it waits, uncharged, and a refill starts", async () => {
  const w = world({ real: true, price: 250_000_000, credit: 10_000_000 })
  const p = await w.run(w.buy())
  assert.equal(p.status, "waiting")
  assert.deepEqual(w.calls, [], "nothing charged yet")
  assert.equal(w.kicks(), 1)
})

test("only a card bigger than Bitrefill lets our account hold is refused", async () => {
  const w = world({ real: true, price: 2_100_000_000, credit: 0 })
  const e = await w.run(w.buy().pipe(Effect.flip))
  assert.match(e.message, /bigger than we can buy right now \(up to \$2000\.00\)/)
  assert.deepEqual(w.calls, [])
})

test("a waiting purchase can be cancelled, uncharged; one going through can't", async () => {
  const w = world({ real: true, price: 12_000_000, credit: 0 })
  const r = await w.run(Effect.gen(function*() {
    const purchases = yield* Purchases
    const waiting = yield* w.buy()
    const cancelled = yield* purchases.cancel("alice.test", waiting.id)
    w.setCredit(100_000_000)
    yield* Effect.flatMap(Credit, (c) => c.refresh)
    const going = yield* w.buy(undefined, "bob.test")
    const refused = yield* purchases.cancel("bob.test", going.id).pipe(Effect.flip)
    const notYours = yield* purchases.cancel("bob.test", waiting.id).pipe(Effect.flip)
    return { cancelled, refused, notYours }
  }))
  assert.equal(r.cancelled.status, "rejected")
  assert.match(r.cancelled.error ?? "", /You cancelled it\. You weren't charged/)
  assert.match(r.refused.message, /already going through/)
  assert.equal(r.notYours._tag, "NotFound")
  assert.deepEqual(w.calls.filter((c) => c === "purchase"), ["purchase"], "only bob's went through")
})

test("one account can have only one purchase waiting", async () => {
  const w = world({ real: true, price: 12_000_000, credit: 0 })
  const e = await w.run(Effect.gen(function*() {
    yield* w.buy()
    return yield* w.buy().pipe(Effect.flip)
  }))
  assert.match(e.message, /already have a card on its way/)
})

test("a purchase that waits too long is cancelled, and nothing was charged", async () => {
  const w = world({ real: true, price: 12_000_000, credit: 0 })
  const p = await w.run(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const p = yield* w.buy()
    yield* sql`UPDATE purchases SET created_at = now() - make_interval(mins => ${CREDIT_DEFAULTS.mainnet.waitMinutes + 1}) WHERE id = ${p.id}`
    yield* Effect.flatMap(Purchases, (s) => s.promoteWaiting)
    return yield* Effect.flatMap(Purchases, (s) => s.get("alice.test", p.id))
  }))
  assert.equal(p.status, "rejected")
  assert.match(p.error ?? "", /weren't charged/)
  assert.deepEqual(w.calls, [])
})

test("if Bitrefill says the credit is too low after all, the charged purchase waits, then is refunded in full", async () => {
  const w = world({ real: true, credit: 100_000_000, orders: ["NoCredit", "NoCredit"] })
  const r = await w.run(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const p = yield* w.buy()
    const waiting = p.status
    yield* sql`UPDATE purchases SET created_at = now() - make_interval(mins => ${CREDIT_DEFAULTS.mainnet.waitMinutes + 1}) WHERE id = ${p.id}`
    yield* Effect.flatMap(Purchases, (s) => s.promoteWaiting)
    yield* Effect.sleep("300 millis")
    return { waiting, after: (yield* Effect.flatMap(Purchases, (s) => s.get("alice.test", p.id))).status }
  }))
  assert.equal(r.waiting, "waiting")
  assert.equal(r.after, "failed")
  assert.deepEqual(w.calls, ["purchase", "order", "fail_purchase"], "charged once, ordered once, refunded")
  assert.equal(w.kicks(), 1)
})

test("credit settings are refused when they don't hang together", async () => {
  const { settingsProblem } = await import("./Credit.ts")
  assert.match(settingsProblem(new CreditSettings({ ...CREDIT_DEFAULTS.testnet, floor: 600_000_000 })) ?? "", /floor/)
  assert.match(settingsProblem(new CreditSettings({ ...CREDIT_DEFAULTS.testnet, dailyRefill: 5_000_000 })) ?? "", /daily refill limit/)
  assert.equal(settingsProblem(CREDIT_DEFAULTS.testnet), undefined)
  assert.equal(settingsProblem(CREDIT_DEFAULTS.mainnet), undefined)
})

test("while sales are closed, new purchases are refused and waiting ones keep their place", async () => {
  const w = world({ real: true, price: 12_000_000, credit: 0 })
  const r = await w.run(Effect.gen(function*() {
    const waiting = yield* w.buy()
    w.setShop(new ShopStatus({ open: false, reason: "stopped" }))
    const refused = yield* w.buy(undefined, "bob.test").pipe(Effect.flip)
    w.setCredit(30_000_000)
    yield* Effect.flatMap(Credit, (c) => c.refresh)
    yield* Effect.flatMap(Purchases, (s) => s.promoteWaiting)
    const held = (yield* Effect.flatMap(Purchases, (s) => s.get("alice.test", waiting.id))).status
    w.setShop(new ShopStatus({ open: true }))
    yield* Effect.flatMap(Purchases, (s) => s.promoteWaiting)
    yield* Effect.sleep("300 millis")
    return { refused: refused.message, held, after: (yield* Effect.flatMap(Purchases, (s) => s.get("alice.test", waiting.id))).status }
  }))
  assert.match(r.refused, /paused for a few minutes/)
  assert.equal(r.held, "waiting", "not admitted while closed")
  assert.equal(r.after, "delivered")
})

// ---------- audit fixes ----------

test("a charged purchase is never moved on while its own run is still reading the credit", async () => {
  const w = world({ real: true, credit: 100_000_000, orders: ["NoCredit"] })
  const r = await w.run(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const purchases = yield* Purchases
    // Bitrefill is slow to answer, so the run that hit "balance too low" is still reading it when promote comes by.
    w.setCreditDelay(600)
    const buying = yield* Effect.forkChild(w.buy())
    let step: string | undefined
    while (step !== "restock") {
      yield* Effect.sleep("10 millis")
      step = (yield* sql<{ step: string }>`SELECT step FROM purchases`)[0]?.step
    }
    // Meanwhile another read lands (say, the two-minute refresh), newer than Bitrefill's refusal.
    w.setCreditDelay(0)
    yield* Effect.flatMap(Credit, (c) => c.refresh)
    yield* purchases.promoteWaiting
    const during = (yield* sql<{ step: string }>`SELECT step FROM purchases`)[0]!.step
    const p = yield* Fiber.join(buying)
    yield* purchases.promoteWaiting
    return { during, after: yield* settled(p.id) }
  }))
  assert.equal(r.during, "restock", "left alone while its run is still going")
  assert.equal(r.after, "settled", "then ordered again by a run of its own, never left at ordering with nothing running it")
  assert.deepEqual(w.calls, ["purchase", "order", "order", "confirm_delivery"])
})

test("a charged purchase is ordered again only on a balance read after Bitrefill's refusal", async () => {
  const w = world({ real: true, credit: 100_000_000 })
  const r = await w.run(Effect.gen(function*() {
    const purchases = yield* Purchases
    yield* Effect.flatMap(Credit, (c) => c.refresh)
    yield* Effect.sleep("20 millis")
    // Bitrefill refused it for credit after that read: the estimate that let it through was wrong.
    const id = yield* restockRow(1, 1)
    yield* purchases.promoteWaiting
    const before = (yield* rowOf(id)).step
    yield* Effect.flatMap(Credit, (c) => c.refresh)
    yield* purchases.promoteWaiting
    return { before, after: yield* settled(id) }
  }))
  assert.equal(r.before, "restock", "not on the old estimate")
  assert.equal(r.after, "settled")
  assert.deepEqual(w.calls, ["order", "confirm_delivery"])
})

test("each step gets its own retries: a backoff earned earlier never delays the next step", async () => {
  const w = world({ real: true, price: 12_000_000, credit: 0, confirm: "down" })
  const r = await w.run(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const p = yield* w.buy()
    // Retries used up and an hour's backoff earned before it moves on.
    yield* sql`UPDATE purchases SET attempts = 11, next_attempt_at = now() + interval '1 hour' WHERE id = ${p.id}`
    w.setCredit(30_000_000)
    yield* Effect.flatMap(Credit, (c) => c.refresh)
    yield* Effect.flatMap(Purchases, (s) => s.promoteWaiting)
    yield* settled(p.id)
    return yield* rowOf(p.id)
  }))
  assert.equal(r.step, "confirm", "paused where NEAR didn't answer")
  assert.equal(r.attempts, 0, "with all its retries still ahead")
  assert.equal(r.due, true, "and no backoff carried over, so the code isn't held up")
})

test("a charged purchase still waiting for credit is refunded an hour before the customer could reclaim it", async () => {
  const w = world({ real: true, credit: 100_000_000 })
  const r = await w.run(Effect.gen(function*() {
    yield* Effect.flatMap(Credit, (c) => c.refresh)
    // Admitted 23½ hours ago: Reclaim opens in half an hour.
    const old = yield* restockRow(23.6, 23.5)
    // Waited uncharged most of a day, but admitted an hour ago: Reclaim is a day away.
    const late = yield* restockRow(23.5, 1)
    yield* Effect.sleep("20 millis")
    yield* Effect.flatMap(Credit, (c) => c.refresh)
    yield* Effect.flatMap(Purchases, (s) => s.promoteWaiting)
    return { old: yield* settled(old), late: yield* settled(late) }
  }))
  assert.equal(r.old, "failed", "refunded in full, not ordered")
  assert.equal(r.late, "settled", "measured from admission, not creation")
  assert.deepEqual(w.calls.filter((c) => c !== "confirm_delivery").sort(), ["fail_purchase", "order"])
})

test("a Lucky Buy is admitted at the Lucky Amount it was accepted under, or refused like a changed price", async () => {
  const lucky = world({ mode: { lucky: 1 } })
  const r = await lucky.run(Effect.flatMap(lucky.buy(), (p) => rowOf(p.id)))
  assert.equal(r.quoted_lucky_amount, "6000000", "the contract's quote when it was accepted")
  assert.equal(lucky.admits[0]!.lucky_amount, "6000000")

  const normal = world()
  await normal.run(normal.buy())
  assert.equal("lucky_amount" in normal.admits[0]!, false, "a Normal purchase sends none")

  const moved = world({ mode: { lucky: 1 }, admitRefused: "The Cashback Reserve moved since you confirmed; please confirm again" })
  const refused = await moved.run(moved.buy())
  assert.equal(refused.status, "rejected")
  assert.match(refused.error ?? "", /Cashback Reserve moved since you confirmed/)
  assert.deepEqual(moved.calls, ["purchase"], "nothing ordered or charged")
})

test("a Lucky Buy whose Draw was re-run elsewhere shows its Cashback from the chain", async () => {
  const w = world({
    mode: { lucky: 1 },
    confirm: "refused",
    onchain: "Delivered",
    onchainPurchase: { mode: { lucky: 1 }, reference_price: "10000000", lucky_amount: "6000000", max_price: "11200000", cashback: "3360000" }
  })
  const p = await w.run(w.buy())
  assert.equal(p.status, "delivered")
  assert.equal(p.draw?.cashback, 3_360_000)
  assert.equal(p.draw?.finalPrice, 7_840_000, "the Maximum Price less the Cashback")
  assert.equal(p.draw?.gameVersion, 1)
  assert.equal(p.draw?.seed, "", "no seed: there's no proof to show")
  assert.equal(p.settleTx, undefined, "the transaction that drew isn't known, and ours was refused")
  assert.equal(p.redemption?.code, "ABC-123")
})

test("the Lucky Amount the customer saw is the one bound; an impossible one is refused", async () => {
  const w = world({ mode: { lucky: 1 } })
  const create = (luckyAmount: number) =>
    Purchases.use((p) =>
      p.create("alice.test", new NewPurchase({ voucherId: "test-card", value: "10", mode: { lucky: 1 }, maxPrice: 11_200_000, luckyAmount, idempotencyKey: crypto.randomUUID() }))
    )
  const r = await w.run(Effect.gen(function*() {
    const p = yield* create(5_000_000)
    const bad = yield* create(20_000_000).pipe(Effect.flip)
    return { row: yield* rowOf(p.id), bad }
  }))
  assert.equal(r.row.quoted_lucky_amount, "5000000", "what the customer saw, not the contract's quote now")
  assert.equal(w.admits[0]!.lucky_amount, "5000000")
  assert.equal(r.bad._tag, "PurchaseInvalid", "more than the price can never have been quoted")
  assert.equal(w.admits.length, 1)
})

test("a purchase that waited for credit is admitted at today's price", async () => {
  const w = world({ price: 10_000_000 })
  const step = await w.run(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // Accepted 20 minutes ago at $9, when Bitrefill's price was lower; it's $10 now.
    const [row] = yield* sql<{ id: string }>`
      INSERT INTO purchases (account_id, idempotency_key, voucher_id, voucher_name, package_value, reference_price, max_debit, step, created_at)
      VALUES ('alice.test', 'waited-key-1', 'test-card', 'Card', '10', 9000000, 11000000, 'waiting', now() - interval '20 minutes')
      RETURNING id`
    yield* Effect.flatMap(Purchases, (s) => s.promoteWaiting)
    return yield* settled(row!.id)
  }))
  assert.equal(step, "settled")
  assert.equal(w.admits[0]!.reference_price, "10000000", "admitted at the current price, within what they confirmed")
})
