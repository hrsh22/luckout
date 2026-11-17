import { BitrefillUnavailable, CreditSettings, type Mode, NewPurchase, ShopStatus, Voucher } from "@luckout/api"
import { ConfigProvider, Effect, Fiber, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Alerts } from "./Alerts.ts"
import { Base, BaseUnavailable, type PaymentStatus, type SignedPayment } from "./Base.ts"
import { Bitrefill, type Order } from "./Bitrefill.ts"
import { Connect } from "./Connect.ts"
import { Credit, CREDIT_DEFAULTS } from "./Credit.ts"
import { DbMemory } from "./Db.ts"
import { ContractRejected, Near, NearUnavailable, type Outcome } from "./Near.ts"
import { Purchases } from "./Purchases.ts"
import { Refill } from "./Refill.ts"
import { Sales } from "./Sales.ts"
import { fakeBase, fakeBitrefill, fakeBitrefillOAuth, fakeNear } from "./testing.ts"

// The purchase workflow end to end on an in-memory database, with NEAR and Bitrefill faked.
process.env.NEAR_NETWORK = "testnet"
process.env.REDEMPTION_KEY = "11".repeat(32)

const account = { balance: "500000000", per_purchase_limit: "500000000", daily_limit: "500000000", day: 0, spent_today: "0", default_mode: "normal" as Mode }

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
  /** Guest checkout (ADR-0012): orders are invoices paid from the Base Float, whose USDC is `credit`. */
  guest?: boolean
  /** What a guest invoice costs; the card's price unless set. */
  invoiceAmount?: number
  /** How each Base payment ends; "success" unless set. */
  payments?: Array<PaymentStatus>
  /** Bitrefill's OAuth endpoints, for customers who connect their own Bitrefill account. */
  oauth?: ReturnType<typeof fakeBitrefillOAuth>
  /** Why an order tagged "Refused" is refused; a lapsed login (401) unless set. */
  refusal?: string
  /** Bitrefill takes this long (ms) to deliver. */
  deliveryDelay?: number
  /** How long a buy request waits (ms) before answering "pending". */
  requestWait?: number
  /** Bitrefill has no such card: every price lookup fails. */
  noCard?: boolean
  /** Signing a Base payment takes this long (ms): the wait for the wallet and for Chain Signatures. */
  payDelay?: number
  /** Base can't be reached when a payment is about to be signed: nothing is signed or saved. */
  payDown?: boolean
  /** What Base says when it is only asked where a saved payment is; "pending" unless set. */
  statuses?: Array<PaymentStatus>
} = {}) => {
  const calls: Array<string> = []
  const alerts: Array<string> = []
  /** Telegram notices to customers. */
  const notices: Array<string> = []
  /** What admission was asked for, each time. */
  const admits: Array<Record<string, unknown>> = []
  let creditBalance = opts.credit ?? 1_000_000_000
  let creditDelay = 0
  const orders = [...(opts.orders ?? [])]
  let kicks = 0
  /** Price lookups made at Bitrefill. */
  let lookups = 0
  let shop = new ShopStatus({ open: true })
  const price = opts.price ?? 10_000_000
  const mode = opts.mode ?? "normal"
  const voucherId = opts.real ? "amazon-us" : "test-card"
  const outcome = (value: unknown, events: Outcome["events"] = []): Outcome => ({ hash: "h", value, events, failures: [] })
  /** Base payments made: each signed once, then sent (again only as the same bytes). */
  const paid: Array<{ to: string; amount: number; resent: boolean }> = []
  const payments = [...(opts.payments ?? [])]
  const statuses = [...(opts.statuses ?? [])]
  /** Payments Base was only asked about, without sending anything. */
  const asked: Array<string> = []
  const base = fakeBase({
    balances: Effect.suspend(() => Effect.succeed({ usdc: creditBalance, eth: 10n ** 15n })),
    pay: (to, amount, saved, save) =>
      Effect.gen(function*() {
        if (!saved) yield* Effect.sleep(opts.payDelay ?? 0)
        if (opts.payDown) return yield* new BaseUnavailable({ message: "Base nonce: fetch failed" })
        const p = saved ?? ({ to, amount: String(amount), nonce: paid.length, maxFeePerGas: "1", maxPriorityFeePerGas: "1", raw: "0x01", hash: `0x${paid.length}` } as SignedPayment)
        if (!saved) yield* save(p)
        paid.push({ to, amount, resent: !!saved })
        const status = payments.shift() ?? "success"
        if (status === "success" && !saved) creditBalance -= amount
        return status
      }),
    status: (hash) => Effect.sync(() => (asked.push(hash), statuses.shift() ?? "pending"))
  })
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
    guest: opts.guest ?? false,
    voucher: () =>
      Effect.suspend(() => {
        lookups++
        return opts.noCard
          ? Effect.fail(new BitrefillUnavailable({ message: "No such voucher" }))
          : Effect.succeed(new Voucher({ id: voucherId, name: "Card", countryCode: "US", currency: "USD", packages: [{ value: "10", priceMicroUsdc: price }] }))
      }),
    order: (_id, _value, buyer) =>
      Effect.sync((): Order => {
        calls.push(!opts.guest ? "order" : buyer && "token" in buyer ? `order:token:${buyer.token}` : `order:${buyer?.email}`)
        const tag = orders.shift() ?? (opts.guest ? "Invoiced" : "Ordered")
        // A token Bitrefill no longer takes: the tool never ran.
        if (tag === "Refused") return { _tag: "Refused", reason: opts.refusal ?? "HTTP 401 invalid_token" }
        if (tag === "Invoiced") return { _tag: "Invoiced", invoiceId: `inv-${calls.length}`, accessToken: "secret-token", payTo: "0x1306efa7dc204B6e995AeD34ADBC24C9889c7f4F", amount: opts.invoiceAmount ?? price }
        if (tag === "NoCredit") return { _tag: "NoCredit", reason: "Balance too low (INVALID_INPUT)" }
        // Ordering spends the credit, as Bitrefill would.
        creditBalance -= price
        return { _tag: "Ordered", invoiceId: "inv-1" }
      }),
    delivery: (invoiceId, token) =>
      Effect.sync(() => {
        if (token) calls.push(`delivery:${token}`)
        return { _tag: "Delivered" as const, invoiceId, orderId: "o-1", redemption: { code: "ABC-123" } }
      }).pipe(Effect.delay(opts.deliveryDelay ?? 0)),
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
    Layer.provideMerge(Layer.mergeAll(Credit.layer, Connect.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, (opts.oauth ?? fakeBitrefillOAuth()).fetch))))),
    Layer.provide(Layer.mergeAll(
      Layer.succeed(Near, near),
      Layer.succeed(Bitrefill, bitrefill),
      Layer.succeed(Base, base),
      Layer.succeed(Refill, refill),
      Layer.succeed(Sales, Sales.of({ status: Effect.sync(() => shop), setOpen: () => Effect.die("not used") })),
      Layer.succeed(Alerts, Alerts.of({ admin: (t) => Effect.sync(() => void alerts.push(t)), customer: (_, t) => Effect.sync(() => (notices.push(t), true)) }))
    )),
    Layer.provideMerge(DbMemory),
    // Real cards are only sold on mainnet.
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({
      env: {
        ...(process.env as Record<string, string>),
        NEAR_NETWORK: opts.real ? "mainnet" : "testnet",
        BITREFILL_REDIRECT_URI: "https://api.luckout.test/bitrefill/callback",
        ...(opts.requestWait ? { PURCHASE_REQUEST_WAIT_MS: String(opts.requestWait) } : {})
      }
    })))
  )
  const buy = (key: string = crypto.randomUUID(), who = "alice.test") =>
    Purchases.use((p) => p.create(who, new NewPurchase({ voucherId, value: "10", mode, maxPrice: price + (mode === "normal" ? 0 : 1_200_000), idempotencyKey: key })))
  const run = <A, E>(e: Effect.Effect<A, E, Purchases | Credit | Connect | SqlClient.SqlClient>) => Effect.runPromise(Effect.scoped(e).pipe(Effect.provide(layer)))
  return {
    calls,
    alerts,
    notices,
    admits,
    paid,
    asked,
    layer,
    buy,
    run,
    kicks: () => kicks,
    lookups: () => lookups,
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
  assert.match(settingsProblem(new CreditSettings({ ...CREDIT_DEFAULTS.mainnet, floor: 200_000_000, ceiling: 300_000_000, refillBelow: 195_000_000 })) ?? "", /Refill when below/)
  assert.equal(settingsProblem(new CreditSettings({ ...CREDIT_DEFAULTS.mainnet, floor: 200_000_000, ceiling: 300_000_000, refillBelow: 160_000_000 })), undefined)
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

// Guest checkout (ADR-0012): each real card is a guest invoice carrying the customer's Checkout Email,
// paid exactly once from the Base Float.
const withEmail = (email: string, who = "alice.test") => Purchases.use((p) => p.setCheckoutEmail(who, email))

test("a guest card carries the customer's email, is paid once from the Base Float, and is delivered", async () => {
  const w = world({ real: true, guest: true, credit: 100_000_000 })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("  Alice@Example.com ")
    const p = yield* w.buy()
    const sql = yield* SqlClient.SqlClient
    const [stored] = yield* sql<{ email: string }>`SELECT email FROM checkout_emails WHERE account_id = 'alice.test'`
    const seen = yield* Purchases.use((s) => s.checkoutEmail("alice.test"))
    return { p, stored: stored!.email, seen }
  }))
  assert.equal(r.p.status, "delivered")
  assert.equal(r.p.redemption?.code, "ABC-123")
  assert.deepEqual(w.calls, ["purchase", "order:alice@example.com", "delivery:secret-token", "confirm_delivery"])
  assert.deepEqual(w.paid, [{ to: "0x1306efa7dc204B6e995AeD34ADBC24C9889c7f4F", amount: 10_000_000, resent: false }])
  assert.ok(!r.stored.includes("alice"), "the email is sealed at rest")
  assert.deepEqual({ needed: r.seen.needed, email: r.seen.email }, { needed: true, email: "alice@example.com" })
})

test("a buy request stops waiting after its limit and answers pending; the card still arrives and Telegram says so", async () => {
  const w = world({ real: true, guest: true, credit: 100_000_000, deliveryDelay: 400, requestWait: 50 })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    const p = yield* w.buy()
    const before = [...w.notices]
    yield* Effect.sleep("1 second")
    const after = yield* Purchases.use((s) => s.get("alice.test", p.id))
    return { p, before, after }
  }))
  assert.equal(r.p.status, "pending", "the request answered before the card arrived")
  assert.deepEqual(r.before, [])
  assert.equal(r.after.status, "delivered")
  assert.equal(w.notices.length, 1)
  assert.match(w.notices[0]!, /is ready/)
  // A card that arrives within the wait is answered in the request, with no extra message.
  const fast = world({ real: true, guest: true, credit: 100_000_000 })
  const q = await fast.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    return yield* fast.buy()
  }))
  assert.equal(q.status, "delivered")
  assert.deepEqual(fast.notices, [])
})

test("a guest card needs the customer's email first, and a malformed one is refused", async () => {
  const w = world({ real: true, guest: true })
  const r = await w.run(Effect.gen(function*() {
    const noEmail = yield* w.buy().pipe(Effect.flip)
    const bad = yield* withEmail("not an email").pipe(Effect.flip)
    return { noEmail, bad }
  }))
  assert.match(r.noEmail.message, /Add the email for your cards first/)
  assert.match(r.bad.message, /doesn't look like an email/)
  assert.deepEqual(w.calls, [], "nothing signed or ordered")
})

test("Bitrefill's limits count per email, across accounts: the 16th card in a day is refused before anything is signed", async () => {
  const w = world({ real: true, guest: true, credit: 100_000_000 })
  const e = await w.run(Effect.gen(function*() {
    yield* withEmail("shared@example.com", "bob.test")
    yield* withEmail("SHARED@example.com")
    const sql = yield* SqlClient.SqlClient
    const [{ email_key }] = (yield* sql<{ email_key: string }>`SELECT email_key FROM checkout_emails WHERE account_id = 'bob.test'`) as [{ email_key: string }]
    for (let i = 0; i < 15; i++) {
      yield* sql`INSERT INTO purchases (account_id, idempotency_key, voucher_id, voucher_name, package_value, reference_price, step, email_key, invoice_id)
                 VALUES ('bob.test', ${`k${i}`}, 'amazon-us', 'Card', '1', 1000000, 'settled', ${email_key}, ${`inv${i}`})`
    }
    return yield* w.buy().pipe(Effect.flip)
  }))
  assert.match(e.message, /15 cards a day per email/)
  assert.deepEqual(w.calls, [])
})

test("a guest invoice costing more than the admitted price is never paid: the customer is refunded in full", async () => {
  const w = world({ real: true, guest: true, credit: 100_000_000, invoiceAmount: 10_000_001 })
  const p = await w.run(Effect.andThen(withEmail("alice@example.com"), w.buy()))
  assert.equal(p.status, "failed")
  assert.deepEqual(w.paid, [], "nothing paid")
  assert.deepEqual(w.calls, ["purchase", "order:alice@example.com", "fail_purchase"])
})

test("a reverted Base payment moves nothing: the card waits for the float, then a fresh invoice is paid once", async () => {
  const w = world({ real: true, guest: true, credit: 100_000_000, payments: ["reverted"] })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    const p = yield* w.buy()
    yield* Effect.flatMap(Purchases, (s) => s.promoteWaiting)
    yield* Effect.sleep("300 millis")
    const after = yield* Effect.flatMap(Purchases, (s) => s.get("alice.test", p.id))
    return { first: p.status, after: after.status }
  }))
  assert.equal(r.first, "waiting")
  assert.equal(r.after, "delivered")
  assert.deepEqual(w.paid.map((x) => x.resent), [false, false], "two separate payments: the first reverted, the second went through")
  assert.equal(w.calls.filter((c) => c.startsWith("order:")).length, 2, "a fresh invoice for the second payment")
  assert.match(w.alerts.join(" "), /reverted/)
})

// Connect Bitrefill: a customer who logs in to their own Bitrefill account has their cards ordered on it, under its
// limits instead of a guest's, and still paid from the Base Float.

/** Connects `who`'s Bitrefill account the way the browser does: our authorize URL, Bitrefill's redirect back, then the Wallet page. */
const connectAs = (who = "alice.test") =>
  Connect.use((c) =>
    Effect.gen(function*() {
      const state = new URL(yield* c.url(who)).searchParams.get("state")!
      const back = new URL(yield* c.callback(new URLSearchParams({ code: "the-code", state, iss: "https://api.bitrefill.com/oauth/mcp" }))).searchParams
      yield* c.finish(who, back.get("code")!, back.get("state")!)
      return back.get("bitrefill")
    })
  )
const buyerOf = (id: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ buyer: string | null; email_key: string | null }>`SELECT buyer, email_key FROM purchases WHERE id = ${id}`).pipe(Effect.map((r) => r[0]!))

test("a connected customer's card is ordered on their own Bitrefill account, with no email and none of the guest limits", async () => {
  const w = world({ real: true, guest: true, credit: 100_000_000 })
  const r = await w.run(Effect.gen(function*() {
    // Their email has had a day's 15 guest cards, so as a guest the next would be refused.
    yield* withEmail("alice@example.com")
    const sql = yield* SqlClient.SqlClient
    const [{ email_key }] = (yield* sql<{ email_key: string }>`SELECT email_key FROM checkout_emails WHERE account_id = 'alice.test'`) as [{ email_key: string }]
    for (let i = 0; i < 15; i++) {
      yield* sql`INSERT INTO purchases (account_id, idempotency_key, voucher_id, voucher_name, package_value, reference_price, step, email_key, invoice_id)
                 VALUES ('alice.test', ${`k${i}`}, 'amazon-us', 'Card', '1', 1000000, 'settled', ${email_key}, ${`inv${i}`})`
    }
    const connected = yield* connectAs()
    const seen = yield* Purchases.use((s) => s.checkoutEmail("alice.test"))
    const p = yield* w.buy()
    return { connected, seen, p, row: yield* buyerOf(p.id) }
  }))
  assert.equal(r.connected, "finish")
  assert.deepEqual({ needed: r.seen.needed, bitrefill: r.seen.bitrefill }, { needed: false, bitrefill: true })
  assert.equal(r.p.status, "delivered")
  assert.deepEqual(w.calls, ["purchase", "order:token:access-1", "delivery:secret-token", "confirm_delivery"], "their token and no email; delivery still reads the invoice by its access token")
  assert.deepEqual(r.row, { buyer: "account", email_key: null }, "not counted against the email's guest limits")
  assert.equal(w.paid.length, 1, "paid once from the Base Float, as any card")
})

test("a lapsed Bitrefill login falls back to a guest order with the Checkout Email, or with none fails and refunds in full", async () => {
  // The login from connecting ends within a minute, so the order renews it first, and Bitrefill refuses.
  const oauth = fakeBitrefillOAuth(60)
  const w = world({ real: true, guest: true, credit: 100_000_000, oauth })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    yield* connectAs()
    oauth.lapse()
    const p = yield* w.buy()
    return { p, row: yield* buyerOf(p.id), seen: yield* Purchases.use((s) => s.checkoutEmail("alice.test")) }
  }))
  assert.equal(r.p.status, "delivered")
  assert.deepEqual(w.calls, ["purchase", "order:alice@example.com", "delivery:secret-token", "confirm_delivery"])
  assert.equal(r.row.buyer, "guest")
  assert.ok(r.row.email_key, "counted against the email's guest limits")
  assert.deepEqual({ needed: r.seen.needed, bitrefill: r.seen.bitrefill }, { needed: true, bitrefill: false }, "the lapsed login is forgotten")

  const lapsing = fakeBitrefillOAuth(60)
  const bare = world({ real: true, guest: true, credit: 100_000_000, oauth: lapsing })
  const p = await bare.run(Effect.gen(function*() {
    yield* connectAs()
    lapsing.lapse()
    return yield* bare.buy()
  }))
  assert.equal(p.status, "failed")
  assert.match(p.error ?? "", /Your Bitrefill login expired\. Connect again or add an email in Wallet\. The full amount went back/)
  assert.deepEqual(bare.calls, ["purchase", "fail_purchase"], "nothing ordered")
  assert.deepEqual(bare.paid, [])
})

test("two purchases at once renew a login only once: its refresh token works once", async () => {
  const oauth = fakeBitrefillOAuth(60)
  const w = world({ real: true, guest: true, credit: 100_000_000, oauth })
  const ps = await w.run(Effect.andThen(connectAs(), Effect.all([w.buy(), w.buy()], { concurrency: "unbounded" })))
  assert.deepEqual(ps.map((p) => p.status), ["delivered", "delivered"])
  assert.equal(oauth.grants("refresh_token").length, 1)
  assert.deepEqual(w.calls.filter((c) => c.startsWith("order:")), ["order:token:access-2", "order:token:access-2"])
})

test("a login Bitrefill stops taking (401) is renewed once and the card ordered again; its limit reads as the account's", async () => {
  const w = world({ real: true, guest: true, credit: 100_000_000, orders: ["Refused"] })
  const p = await w.run(Effect.andThen(connectAs(), w.buy()))
  assert.equal(p.status, "delivered")
  assert.deepEqual(w.calls.filter((c) => c.startsWith("order:")), ["order:token:access-1", "order:token:access-2"])

  const limited = world({ real: true, guest: true, credit: 100_000_000, orders: ["Refused"], refusal: "Purchase limit reached (INVALID_INPUT)" })
  const refused = await limited.run(Effect.andThen(connectAs(), limited.buy()))
  assert.equal(refused.status, "failed")
  assert.match(refused.error ?? "", /^Your Bitrefill account's limit was reached/)
})

/** Makes every open purchase due, as 30 seconds of waiting would, then runs one reconciler pass. */
const reconcilePass = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE purchases SET updated_at = now() - interval '1 minute', next_attempt_at = now()`
  yield* Purchases.use((s) => s.reconcileNow)
})
const stepIs = (want: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    for (let i = 0; i < 200; i++) {
      if ((yield* sql<{ step: string }>`SELECT step FROM purchases`)[0]?.step === want) return
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die(`never reached ${want}`)
  })

test("the reconciler coming by a purchase that is still running never starts a second run", async () => {
  const w = world({ real: true, guest: true, credit: 100_000_000, deliveryDelay: 400 })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    const buying = yield* Effect.forkChild(w.buy())
    yield* stepIs("delivery")
    yield* reconcilePass
    yield* reconcilePass
    const p = yield* Fiber.join(buying)
    return yield* settled(p.id)
  }))
  assert.equal(r, "settled")
  assert.equal(w.calls.filter((c) => c.startsWith("delivery:")).length, 1, "one run asked Bitrefill for the card")
  assert.equal(w.calls.filter((c) => c === "confirm_delivery").length, 1)
})

test("two reconciler passes during a slow Base payment never pay the invoice twice", async () => {
  const w = world({ real: true, guest: true, credit: 100_000_000, payDelay: 400 })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    const buying = yield* Effect.forkChild(w.buy())
    yield* stepIs("pay")
    yield* reconcilePass
    yield* reconcilePass
    const p = yield* Fiber.join(buying)
    return yield* settled(p.id)
  }))
  assert.equal(r, "settled")
  assert.equal(w.paid.length, 1, "paid once")
})

test("a Base payment is never saved over one another run already saved: the saved one is sent instead", async () => {
  const w = world({ real: true, guest: true, credit: 100_000_000, payDelay: 300 })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    const sql = yield* SqlClient.SqlClient
    const buying = yield* Effect.forkChild(w.buy())
    yield* stepIs("pay")
    // Another run's payment lands in the row while this one is still signing its own.
    const other = { to: "0x1306efa7dc204B6e995AeD34ADBC24C9889c7f4F", amount: "10000000", nonce: 9, maxFeePerGas: "1", maxPriorityFeePerGas: "1", raw: "0x02", hash: "0xother" }
    yield* sql`UPDATE purchases SET pay_tx = ${JSON.stringify(other)}::jsonb`
    const p = yield* Fiber.join(buying)
    const during = { status: p.status, paid: w.paid.length, hash: (yield* sql<{ hash: string }>`SELECT pay_tx->>'hash' AS hash FROM purchases`)[0]!.hash }
    yield* reconcilePass
    return { during, after: yield* settled(p.id) }
  }))
  assert.deepEqual(r.during, { status: "pending", paid: 0, hash: "0xother" }, "its own payment was neither saved nor sent")
  assert.equal(r.after, "settled")
  assert.deepEqual(w.paid.map((x) => x.resent), [true], "the saved payment was sent, once")
})

test("a signed Base payment is never sent again once its invoice nears expiry: Base is only asked where it is", async () => {
  const w = world({ real: true, guest: true, credit: 100_000_000, payments: ["pending"], statuses: ["pending", "success"] })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    const sql = yield* SqlClient.SqlClient
    const p = yield* w.buy()
    // Signed and sent, not mined; then 51 minutes pass since the invoice.
    yield* sql`UPDATE purchases SET invoice_at = now() - interval '51 minutes'`
    yield* reconcilePass
    const waiting = (yield* sql<{ step: string; error: string | null }>`SELECT step, error FROM purchases`)[0]!
    yield* reconcilePass
    return { first: p.status, waiting, after: yield* settled(p.id) }
  }))
  assert.equal(r.first, "pending")
  assert.equal(r.waiting.step, "pay")
  assert.match(r.waiting.error ?? "", /isn't sent again/)
  assert.equal(r.after, "settled", "mined after all: the card is fetched")
  assert.equal(w.paid.length, 1, "sent once, when it was signed, and never again")
  assert.equal(w.asked.length, 2)
})

test("a charged purchase that can't be paid for in time is refunded in full, with no new invoice", async () => {
  const w = world({ real: true, guest: true, credit: 100_000_000, payDown: true })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    const sql = yield* SqlClient.SqlClient
    const p = yield* w.buy()
    const before = (yield* rowOf(p.id)).step
    // Never signed: its invoice goes stale, and the purchase is now 23.5 hours old (Reclaim opens at 24).
    yield* sql`UPDATE purchases SET invoice_at = now() - interval '41 minutes', created_at = now() - interval '1410 minutes'`
    yield* reconcilePass
    return { before, after: yield* settled(p.id) }
  }))
  assert.equal(r.before, "pay")
  assert.equal(r.after, "failed")
  assert.deepEqual(w.paid, [], "nothing was ever paid")
  assert.equal(w.calls.filter((c) => c.startsWith("order:")).length, 1, "no second invoice")
  assert.ok(w.calls.includes("fail_purchase"))
  assert.match(w.alerts.join(" "), /in time/)
})

test("a Lucky Buy is checked against what the contract will debit before anything is signed", async () => {
  // The Lucky price is $11.20 (the world's quote); the balance covers the card but not that.
  const poor = world({ mode: { lucky: 0 }, account: { ...account, balance: "10600000" } })
  const short = await poor.run(poor.buy().pipe(Effect.flip))
  assert.match(short.message, /Insufficient balance/)
  assert.deepEqual(poor.calls, [], "nothing signed")
  // A maximum under the Lucky price: the contract would refuse it, after the operator paid to ask.
  const w = world({ mode: { lucky: 0 } })
  const low = await w.run(Purchases.use((p) =>
    p.create("alice.test", new NewPurchase({ voucherId: "test-card", value: "10", mode: { lucky: 0 }, maxPrice: 10_000_000, luckyAmount: 6_000_000, idempotencyKey: crypto.randomUUID() }))
  ).pipe(Effect.flip))
  assert.match(low.message, /Price changed/)
  assert.deepEqual(w.calls, [], "nothing signed")
  // The quote the customer saw, as the contract gives it now, goes through.
  const ok = world({ mode: { lucky: 0 } })
  assert.equal((await ok.run(ok.buy())).status, "delivered")
})

test("after three admissions the contract refused, the account waits before the operator signs another", async () => {
  const w = world({ admitRefused: "Price changed since you confirmed; please confirm again" })
  const e = await w.run(Effect.gen(function*() {
    for (let i = 0; i < 3; i++) assert.equal((yield* w.buy()).status, "rejected")
    return yield* w.buy().pipe(Effect.flip)
  }))
  assert.match(e.message, /just refused/)
  assert.equal(w.calls.filter((c) => c === "purchase").length, 3, "the fourth was never signed")
})

test("an account with no money, or one that keeps asking for cards we can't find, stops spending price lookups", async () => {
  const empty = world({ account: null })
  await empty.run(empty.buy().pipe(Effect.flip))
  assert.equal(empty.lookups(), 0, "no balance: refused before the lookup")
  const w = world({ noCard: true })
  const e = await w.run(Effect.gen(function*() {
    for (let i = 0; i < 3; i++) yield* w.buy().pipe(Effect.flip)
    return yield* w.buy().pipe(Effect.flip)
  }))
  assert.match(e.message, /couldn't find several cards/)
  assert.equal(w.lookups(), 3, "the fourth asked Bitrefill nothing")
})
