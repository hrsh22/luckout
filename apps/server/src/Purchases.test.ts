import { CreditSettings, NewPurchase, ShopStatus, Voucher } from "@luckout/api"
import { ConfigProvider, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Alerts } from "./Alerts.ts"
import { Bitrefill, type Order } from "./Bitrefill.ts"
import { Credit, CREDIT_DEFAULTS } from "./Credit.ts"
import { DbMemory } from "./Db.ts"
import { ContractRejected, Near, type Outcome } from "./Near.ts"
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
  confirm?: "ok" | "refused"
  onchain?: string
  /** A real card (paid from our Bitrefill credit) instead of a free test card. */
  real?: boolean
  price?: number
  /** Our Bitrefill credit, micro-USDC; change it with `w.setCredit`. */
  credit?: number
  orders?: Array<Order["_tag"]>
} = {}) => {
  const calls: Array<string> = []
  const alerts: Array<string> = []
  let creditBalance = opts.credit ?? 1_000_000_000
  const orders = [...(opts.orders ?? [])]
  let kicks = 0
  let shop = new ShopStatus({ open: true })
  const price = opts.price ?? 10_000_000
  const voucherId = opts.real ? "amazon-us" : "test-card"
  const outcome = (value: unknown, events: Outcome["events"] = []): Outcome => ({ hash: "h", value, events, failures: [] })
  const near = fakeNear({
    view: <A>(method: string) =>
      Effect.succeed(
        (method === "get_account" ? (opts.account === undefined ? account : opts.account) : { status: opts.onchain ?? "Pending" }) as A
      ),
    call: (method, _args, persist) =>
      Effect.gen(function*() {
        calls.push(method)
        yield* persist({ hash: `${method}-tx`, bytes: "" })
        if (method === "purchase") {
          return outcome(7, [{ event: "purchase", data: [{ purchase: { mode: "normal", max_price: String(price), lucky_amount: "0" } }] }])
        }
        if (opts.confirm === "refused") return yield* new ContractRejected({ message: "Purchase is already closed" })
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
    credit: Effect.sync(() => ({ balance: creditBalance, room: 2_000_000_000 }))
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
      Layer.succeed(Alerts, Alerts.of({ admin: (t) => Effect.sync(() => void alerts.push(t)), customer: () => Effect.void }))
    )),
    Layer.provideMerge(DbMemory),
    // Real cards are only sold on mainnet.
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({
      env: { ...(process.env as Record<string, string>), NEAR_NETWORK: opts.real ? "mainnet" : "testnet" }
    })))
  )
  const buy = (key: string = crypto.randomUUID(), who = "alice.test") =>
    Purchases.use((p) => p.create(who, new NewPurchase({ voucherId, value: "10", mode: "normal", maxPrice: price, idempotencyKey: key })))
  const run = <A, E>(e: Effect.Effect<A, E, Purchases | Credit | SqlClient.SqlClient>) => Effect.runPromise(Effect.scoped(e).pipe(Effect.provide(layer)))
  return {
    calls,
    alerts,
    layer,
    buy,
    run,
    kicks: () => kicks,
    setCredit: (micro: number) => void (creditBalance = micro),
    setShop: (s: ShopStatus) => void (shop = s)
  }
}

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

