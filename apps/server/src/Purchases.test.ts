import { BitrefillUnavailable, CreditSettings, type Mode, NewPurchase, ShopStatus, Voucher } from "@luckout/api"
import { ConfigProvider, Effect, Exit, Fiber, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Alerts } from "./Alerts.ts"
import { Base, BaseUnavailable, type PaymentStatus, type SignedPayment } from "./Base.ts"
import { Bitrefill, type CardDelivery, matchOrders, type Order } from "./Bitrefill.ts"
import { Connect } from "./Connect.ts"
import { Credit, CREDIT_DEFAULTS } from "./Credit.ts"
import { DbMemory } from "./Db.ts"
import { ContractRejected, Near, NearUnavailable, type Outcome, TxExpired } from "./Near.ts"
import { GAVE_UP_AT, guestLimitRefusal, Purchases, retryPurchase } from "./Purchases.ts"
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
  /** Bitrefill's lookups are used up for this minute: every price lookup is turned away. */
  pricesBusy?: boolean
  /** Signing a Base payment takes this long (ms): the wait for the wallet and for Chain Signatures. */
  payDelay?: number
  /** Base can't be reached when a payment is about to be signed: nothing is signed or saved. */
  payDown?: boolean
  /** What Base says when it is only asked where a saved payment is; "pending" unless set. */
  statuses?: Array<PaymentStatus>
  /** No Free Reserve left: a cart's Lucky cards are quoted Normal. */
  reserveFull?: boolean
  /** The most of a card's price the reserve lets a Lucky Buy play ($6 unless set). */
  luckyCap?: number
  /** For each delivery poll, the order in which Bitrefill lists the invoice's orders (cart order unless set). */
  listed?: Array<ReadonlyArray<number>>
  /**
   * Where each order of the invoice is at each delivery poll, one list per poll, in cart order; delivered unless set.
   * "NoCode": delivered with Redemption Data that holds neither a code nor a link.
   */
  deliveries?: Array<Array<"Delivered" | "Failed" | "Pending" | "NoCode">>
  /** Bitrefill can't be reached (or is rate limiting us) for this call: its outcome is unknown. */
  bitrefillDown?: "order" | "delivery"
  /** Telegram doesn't take this many customer notices first (it's worth sending them again). */
  telegramDown?: number
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
  /** The contract's next purchase id. */
  let nextPurchase = 7
  /** Each `settle`: the purchase ids it confirmed and failed. */
  const settled: Array<{ delivered: Array<number>; failed: Array<number> }> = []
  /** How many cards each Bitrefill order held. */
  const ordered: Array<number> = []
  const deliveries = [...(opts.deliveries ?? [])]
  const listed = [...(opts.listed ?? [])]
  /** How many cards each invoice holds, as ordered. */
  const invoiceCards = new Map<string, number>()
  let confirm = opts.confirm
  let telegramDown = opts.telegramDown ?? 0
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
    view: <A>(method: string, args?: unknown) =>
      Effect.succeed(
        (method === "get_account"
          ? (opts.account === undefined ? account : opts.account)
          : method === "quote"
          // The reserve covers $6 of a Lucky Buy right now.
          ? { mode, reference_price: String(price), lucky_amount: "6000000", max_price: String(price + 1_200_000) }
          : method === "quote_many"
          // Each card as the contract prices it: a Lucky one plays as much of its price as the reserve allows, at a 20%
          // premium rounded up; with no reserve left, it comes back Normal.
          ? (args as { items: Array<{ reference_price: string; mode: Mode }> }).items.map((i) => {
            const r = Number(i.reference_price)
            const lucky = Math.min(r, opts.luckyCap ?? 6_000_000)
            return typeof i.mode === "object" && !opts.reserveFull
              ? { mode: i.mode, reference_price: i.reference_price, lucky_amount: String(lucky), max_price: String(r + Math.ceil(lucky * 2_000 / 10_000)) }
              : { mode: "normal", reference_price: i.reference_price, lucky_amount: "0", max_price: i.reference_price }
          })
          : method === "get_game_versions"
          ? [0, 1].map((v) => ({ name: `v${v}`, premium_bps: 2_000, outcomes: [] }))
          : { status: opts.onchain ?? "Pending", ...opts.onchainPurchase }) as A
      ),
    // A cart's admission and settlement are logged card by card, under the single-card methods' names.
    call: (method, args, persist) =>
      Effect.gen(function*() {
        if (method === "purchase_many") {
          const { customer, items } = args as { customer: string; items: Array<Record<string, unknown>> }
          for (const item of items) {
            calls.push("purchase")
            admits.push({ customer, ...item })
          }
          yield* persist({ hash: `${method}-tx`, bytes: "" })
          if (opts.admitRefused) return yield* new ContractRejected({ message: opts.admitRefused })
          const ids = items.map(() => nextPurchase++)
          return outcome(ids, ids.map((id) => ({ event: "purchase", data: [{ purchase_id: id, purchase: { mode: "normal", max_price: String(price), lucky_amount: "0" } }] })))
        }
        const { delivered, failed } = args as { delivered: Array<number>; failed: Array<number> }
        for (const _ of delivered) calls.push("confirm_delivery")
        for (const _ of failed) calls.push("fail_purchase")
        settled.push({ delivered, failed })
        yield* persist({ hash: `${method}-tx`, bytes: "" })
        if (confirm === "refused") return yield* new ContractRejected({ message: "Purchase is already closed" })
        if (confirm === "down" && delivered.length > 0) return yield* new NearUnavailable({ message: "send: timed out" })
        return outcome(null)
      }),
    // A saved transaction the chain never saw (NEAR timed out before taking it): it's signed afresh.
    resume: (signed) => Effect.fail(new TxExpired({ hash: signed.hash }))
  })
  const bitrefill = fakeBitrefill({
    guest: opts.guest ?? false,
    voucher: () =>
      Effect.suspend(() => {
        lookups++
        if (opts.pricesBusy) return Effect.fail(new BitrefillUnavailable({ message: "Prices are busy right now; try again in a minute" }))
        return opts.noCard
          ? Effect.fail(new BitrefillUnavailable({ message: "No such voucher" }))
          : Effect.succeed(new Voucher({ id: voucherId, name: "Card", countryCode: "US", currency: "USD", packages: [{ value: "10", priceMicroUsdc: price }] }))
      }),
    order: (cart, buyer) =>
      Effect.suspend(() => (opts.bitrefillDown === "order" ? Effect.fail(new BitrefillUnavailable({ message: "Bitrefill is rate limiting us" })) : Effect.void)).pipe(Effect.andThen(Effect.sync((): Order => {
        calls.push(!opts.guest ? "order" : buyer && "token" in buyer ? `order:token:${buyer.token}` : `order:${buyer?.email}`)
        ordered.push(cart.length)
        const tag = orders.shift() ?? (opts.guest ? "Invoiced" : "Ordered")
        // A token Bitrefill no longer takes: the tool never ran.
        if (tag === "Refused") return { _tag: "Refused", reason: opts.refusal ?? "HTTP 401 invalid_token" }
        const invoiceId = `inv-${calls.length}`
        invoiceCards.set(invoiceId, cart.length)
        if (tag === "Invoiced") return { _tag: "Invoiced", invoiceId, accessToken: "secret-token", payTo: "0x1306efa7dc204B6e995AeD34ADBC24C9889c7f4F", amount: opts.invoiceAmount ?? price * cart.length }
        if (tag === "NoCredit") return { _tag: "NoCredit", reason: "Balance too low (INVALID_INPUT)" }
        // Ordering spends the credit, as Bitrefill would.
        creditBalance -= price * cart.length
        return { _tag: "Ordered", invoiceId }
      }))),
    // The invoice's orders as Bitrefill lists them, in cart order, each matched to the cards asked about the way
    // Bitrefill.ts matches them: by product and amount, not by place in the list asked about.
    delivery: (invoiceId, token, cart) =>
      opts.bitrefillDown === "delivery"
        ? Effect.fail(new BitrefillUnavailable({ message: `invoice ${invoiceId} is still pending` }))
        : Effect.suspend(() => {
          if (token) calls.push(`delivery:${token}`)
          const poll = deliveries.shift() ?? []
          const order = listed.shift()
          const inCartOrder = Array.from({ length: invoiceCards.get(invoiceId) ?? cart.length }, (_, j) => {
            const state = poll[j] ?? "Delivered"
            const redemption_info: Record<string, unknown> | undefined = state === "Delivered"
              ? { code: `ABC-12${j + 3}`, expirationTime: "2027-03-30T00:00:00.000Z" }
              : state === "NoCode"
              ? { other: "Show this at the till: S3CRET-TEXT" }
              : undefined
            return { order_id: `o-${j}`, status: state, product: { id: voucherId, value: "10" }, redemption_info }
          })
          const invoice = order ? order.map((j) => inCartOrder[j]!) : inCartOrder
          const found = matchOrders(cart, invoice).map((o): CardDelivery =>
            o?.redemption_info
              ? { _tag: "Delivered", orderId: o.order_id, redemption: o.redemption_info }
              : o?.status === "Failed"
              ? { _tag: "Failed", reason: `order ${o.order_id} failed` }
              : { _tag: "Pending" }
          )
          return found.every((d) => d._tag === "Pending")
            ? Effect.fail(new BitrefillUnavailable({ message: `invoice ${invoiceId} is still pending` }))
            : Effect.succeed(found)
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
      Layer.succeed(Alerts, Alerts.of({ admin: (t) => Effect.sync(() => void alerts.push(t)), customer: (_, t) => Effect.sync(() => (notices.push(t), telegramDown-- <= 0)) }))
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
  /** A Cart of `keys.length` of the card, all in one request. */
  const cart = (keys: ReadonlyArray<string>, who = "alice.test") =>
    Purchases.use((p) =>
      p.createCart(who, keys.map((k) => new NewPurchase({ voucherId, value: "10", mode, maxPrice: price + (mode === "normal" ? 0 : 1_200_000), idempotencyKey: k })))
    )
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
    cart,
    run,
    settled,
    ordered,
    kicks: () => kicks,
    lookups: () => lookups,
    setCredit: (micro: number) => void (creditBalance = micro),
    setCreditDelay: (ms: number) => void (creditDelay = ms),
    setShop: (s: ShopStatus) => void (shop = s),
    setConfirm: (c: typeof opts.confirm) => void (confirm = c)
  }
}

/** A purchase's row as saved. */
const rowOf = (id: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ step: string; attempts: number; due: boolean; quoted_lucky_amount: string | null }>`
      SELECT p.step, c.attempts, c.next_attempt_at <= now() AS due, p.quoted_lucky_amount::text
      FROM purchases p JOIN checkouts c ON c.id = p.checkout_id WHERE p.id = ${id}`).pipe(Effect.map((r) => r[0]!))

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
      WITH co AS (INSERT INTO checkouts (account_id, step, created_at) VALUES ('alice.test', 'restock', now() - make_interval(mins => ${Math.round(createdHoursAgo * 60)}))
                  RETURNING id)
      INSERT INTO purchases (checkout_id, account_id, idempotency_key, voucher_id, voucher_name, package_value, requested_mode, reference_price, max_debit,
                             step, contract_purchase_id, admitted, created_at)
      VALUES ((SELECT id FROM co), 'alice.test', ${crypto.randomUUID()}, 'amazon-us', 'Card', '10', '"normal"', 10000000, 10000000, 'restock', 7,
              ${JSON.stringify({ mode: "normal", max_price: "10000000", lucky_amount: "0", created_at: (Date.now() - admittedHoursAgo * 3_600_000) * 1e6 })},
              now() - make_interval(mins => ${Math.round(createdHoursAgo * 60)}))
      RETURNING id`).pipe(Effect.map((r) => r[0]!.id))

test("a purchase walks every step and shows the code only once delivered", async () => {
  const w = world()
  const p = await w.run(w.buy())
  assert.equal(p.status, "delivered")
  assert.equal(p.redemption?.code, "ABC-123")
  assert.equal(p.currency, "USD", "the card's own currency, for showing its value")
  assert.deepEqual(w.calls, ["purchase", "order", "confirm_delivery"])
})

test("a delivered card's use-by date is kept outside its sealed code, so the card's page can show it before buying", async () => {
  const w = world()
  const r = await w.run(Effect.gen(function*() {
    yield* w.buy()
    const purchases = yield* Purchases
    const fresh = yield* purchases.useBy("test-card")
    const other = yield* purchases.useBy("amazon-us")
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE purchases SET created_at = now() - interval '61 days'`
    return { fresh, other, stale: yield* purchases.useBy("test-card") }
  }))
  assert.deepEqual(r, { fresh: "2027-03-30T00:00:00.000Z", other: undefined, stale: undefined }, "only this card's, and only from the last 60 days")
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
    yield* sql`UPDATE checkouts SET created_at = now() - make_interval(mins => ${CREDIT_DEFAULTS.mainnet.waitMinutes + 1}) WHERE id = (SELECT checkout_id FROM purchases WHERE id = ${p.id})`
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
    yield* sql`UPDATE checkouts SET created_at = now() - make_interval(mins => ${CREDIT_DEFAULTS.mainnet.waitMinutes + 1}) WHERE id = (SELECT checkout_id FROM purchases WHERE id = ${p.id})`
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
    yield* sql`UPDATE checkouts SET attempts = 11, next_attempt_at = now() + interval '1 hour' WHERE id = (SELECT checkout_id FROM purchases WHERE id = ${p.id})`
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
      WITH co AS (INSERT INTO checkouts (account_id, step, created_at) VALUES ('alice.test', 'waiting', now() - interval '20 minutes') RETURNING id)
      INSERT INTO purchases (checkout_id, account_id, idempotency_key, voucher_id, voucher_name, package_value, reference_price, max_debit, step, created_at)
      VALUES ((SELECT id FROM co), 'alice.test', 'waited-key-1', 'test-card', 'Card', '10', 9000000, 11000000, 'waiting', now() - interval '20 minutes')
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
  assert.deepEqual(r.seen.used, { orders: 1, day: 10_000_000, month: 10_000_000 }, "what the email has used of a guest's limits")
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
      yield* sql`WITH co AS (INSERT INTO checkouts (account_id, step) VALUES ('test', 'done') RETURNING id) INSERT INTO purchases (checkout_id, account_id, idempotency_key, voucher_id, voucher_name, package_value, reference_price, step, email_key, invoice_id)
                 VALUES ((SELECT id FROM co), 'bob.test', ${`k${i}`}, 'amazon-us', 'Card', '1', 1000000, 'settled', ${email_key}, ${`inv${i}`})`
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
      yield* sql`WITH co AS (INSERT INTO checkouts (account_id, step) VALUES ('test', 'done') RETURNING id) INSERT INTO purchases (checkout_id, account_id, idempotency_key, voucher_id, voucher_name, package_value, reference_price, step, email_key, invoice_id)
                 VALUES ((SELECT id FROM co), 'alice.test', ${`k${i}`}, 'amazon-us', 'Card', '1', 1000000, 'settled', ${email_key}, ${`inv${i}`})`
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
  yield* sql`UPDATE checkouts SET updated_at = now() - interval '1 minute', next_attempt_at = now()`
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
    yield* sql`UPDATE checkouts SET pay_tx = ${JSON.stringify(other)}::jsonb`
    const p = yield* Fiber.join(buying)
    const during = { status: p.status, paid: w.paid.length, hash: (yield* sql<{ hash: string }>`SELECT pay_tx->>'hash' AS hash FROM checkouts`)[0]!.hash }
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
    yield* sql`UPDATE checkouts SET invoice_at = now() - interval '51 minutes'`
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
    yield* sql`UPDATE checkouts SET invoice_at = now() - interval '41 minutes', created_at = now() - interval '1410 minutes'`
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

test("a guest order Bitrefill never took is refunded in full once the retries run out; a paid one still stops for a human", async () => {
  const w = world({ real: true, guest: true, credit: 100_000_000, bitrefillDown: "order" })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    const sql = yield* SqlClient.SqlClient
    const p = yield* w.buy()
    const before = (yield* rowOf(p.id)).step
    // Twelve tries later Bitrefill still hasn't taken the order.
    yield* sql`UPDATE checkouts SET attempts = 12`
    yield* reconcilePass
    return { before, after: yield* settled(p.id) }
  }))
  assert.equal(r.before, "ordering")
  assert.equal(r.after, "failed")
  assert.deepEqual(w.paid, [], "nothing was ever paid")
  assert.ok(w.calls.includes("fail_purchase"), "refunded through the contract")
  assert.match(w.alerts.join(" "), /couldn't be ordered from Bitrefill in 12 attempts/)
  assert.match(w.notices.join(" "), /full amount is back/)

  // Paid, and the card never arrives: that outcome isn't ours to guess.
  const paid = world({ real: true, guest: true, credit: 100_000_000, bitrefillDown: "delivery" })
  const after = await paid.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    const sql = yield* SqlClient.SqlClient
    const p = yield* paid.buy()
    yield* sql`UPDATE checkouts SET attempts = 12`
    yield* reconcilePass
    return yield* settled(p.id)
  }))
  assert.equal(after, "stuck")
  assert.equal(paid.paid.length, 1)
  assert.ok(!paid.calls.includes("fail_purchase"), "never refunded while Bitrefill may still deliver")
  assert.match(paid.alerts.join(" "), /stuck after 12 attempts at delivery/)
})

test("a float read while a payment is on its way, or before we've seen it land, raises no alarm; a real drop still does", async () => {
  const w = world({ real: true, guest: true, credit: 100_000_000, payments: ["pending", "success", "pending"] })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    const credit = yield* Credit
    // First card: signed and sent, not mined yet when the float is read; then it lands and we see it.
    const first = yield* w.buy()
    yield* credit.refresh
    // (The fakes answer instantly; a real float read and a payment seen mined are never in the same millisecond.)
    yield* Effect.sleep("2 millis")
    w.setCredit(90_000_000)
    yield* reconcilePass
    const a = yield* settled(first.id)
    yield* credit.refresh
    // Second card: it lands, and the float is read before we've looked at the payment.
    const second = yield* w.buy()
    w.setCredit(80_000_000)
    yield* credit.refresh
    yield* Effect.sleep("2 millis")
    yield* reconcilePass
    const b = yield* settled(second.id)
    yield* credit.refresh
    const explained = [...w.alerts]
    // $5 leaves the wallet that no payment of ours explains.
    w.setCredit(75_000_000)
    yield* credit.refresh
    return { sent: [first.status, second.status], ended: [a, b], explained }
  }))
  assert.deepEqual(r.sent, ["pending", "pending"])
  assert.deepEqual(r.ended, ["settled", "settled"])
  assert.ok(!r.explained.some((a) => /dropped/.test(a)), r.explained.join(" | "))
  assert.match(w.alerts.join(" | "), /The Base Float dropped \$5\.00 more than our payments explain/)
})

test("a Base payment signed after its invoice neared expiry is neither saved nor sent: a fresh invoice is paid once", async () => {
  const w = world({ real: true, guest: true, credit: 100_000_000, payDelay: 300 })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    const sql = yield* SqlClient.SqlClient
    const buying = yield* Effect.forkChild(w.buy())
    yield* stepIs("pay")
    // The invoice passes 50 minutes while the payment is still being signed (the wallet's lock, Chain Signatures).
    yield* sql`UPDATE checkouts SET invoice_at = now() - interval '51 minutes'`
    const p = yield* Fiber.join(buying)
    const [row] = yield* sql<{ step: string; saved: boolean }>`SELECT p.step, c.pay_tx IS NOT NULL AS saved FROM purchases p JOIN checkouts c ON c.id = p.checkout_id`
    const during = { status: p.status, paid: w.paid.length, ...row! }
    yield* reconcilePass
    return { during, after: yield* settled(p.id) }
  }))
  assert.deepEqual(r.during, { status: "pending", paid: 0, step: "pay", saved: false }, "the late payment was neither saved nor sent")
  assert.equal(r.after, "settled")
  assert.equal(w.calls.filter((c) => c.startsWith("order:")).length, 2, "a fresh invoice was asked for")
  assert.deepEqual(w.paid.map((x) => x.resent), [false], "and paid once")
})

test("a busy minute at Bitrefill isn't counted against the account as cards it couldn't find", async () => {
  const w = world({ pricesBusy: true })
  const e = await w.run(Effect.gen(function*() {
    for (let i = 0; i < 3; i++) yield* w.buy().pipe(Effect.flip)
    return yield* w.buy().pipe(Effect.flip)
  }))
  assert.match(e.message, /Prices are busy/)
})

test("the purchase list pages newest first, every purchase exactly once, and only the caller's own", async () => {
  const w = world()
  await w.run(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // Saved straight to the table, at whole minutes, so two can share one instant.
    const add = (who: string, minutesAgo: number) =>
      sql<{ id: string }>`
        WITH co AS (INSERT INTO checkouts (account_id, step) VALUES ('test', 'done') RETURNING id) INSERT INTO purchases (checkout_id, account_id, idempotency_key, voucher_id, voucher_name, package_value, requested_mode, reference_price, max_debit, step, created_at)
        VALUES ((SELECT id FROM co), ${who}, ${crypto.randomUUID()}, 'amazon-us', 'Card', '10', '"normal"', 10000000, 10000000, 'failed',
                date_trunc('minute', now()) - make_interval(mins => ${minutesAgo}))
        RETURNING id`.pipe(Effect.map((r) => r[0]!.id))
    const mine = [yield* add("alice.test", 1), yield* add("alice.test", 2), yield* add("alice.test", 2), yield* add("alice.test", 3), yield* add("alice.test", 4)]
    const bobs = yield* add("bob.test", 0)
    const p = yield* Purchases
    const seen: Array<string> = []
    let before: string | undefined
    for (let i = 0; i < 5; i++) {
      const page = yield* p.list("alice.test", { limit: 2, before })
      assert.ok(page.items.length <= 2)
      seen.push(...page.items.map((x) => x.id))
      before = page.next
      if (!before) break
    }
    assert.equal(seen.length, 5, "three pages of two, two and one")
    assert.deepEqual([...seen].sort(), [...mine].sort(), "each of alice's once, none of bob's")
    assert.equal(seen[0], mine[0], "newest first")
    assert.equal(seen[4], mine[4], "oldest last")
    // Someone else's purchase is no cursor into alice's list.
    assert.deepEqual((yield* p.list("alice.test", { before: bobs })).items, [])
    // Without a limit, a page holds up to 100 and says nothing follows.
    const all = yield* p.list("alice.test")
    assert.equal(all.items.length, 5)
    assert.equal(all.next, undefined)
  }))
})

const keys = (n: number) => Array.from({ length: n }, () => crypto.randomUUID())

test("a cart buys every card as its own purchase, each admitted, delivered and drawn on its own", async () => {
  const w = world()
  const r = await w.run(Effect.gen(function*() {
    const asked = keys(3)
    const placed = yield* w.cart(asked)
    const steps = yield* Effect.forEach(placed, (p) => settled(p.id))
    const again = yield* w.cart(asked)
    return { placed, steps, again }
  }))
  assert.equal(r.placed.length, 3)
  assert.deepEqual(r.steps, ["settled", "settled", "settled"])
  assert.deepEqual(w.calls.filter((c) => c === "purchase").length, 3)
  assert.deepEqual(w.calls.filter((c) => c === "confirm_delivery").length, 3)
  assert.deepEqual(r.again.map((p) => p.id), r.placed.map((p) => p.id), "a retry with the same keys returns the same purchases, in order")
  assert.equal(w.calls.filter((c) => c === "purchase").length, 3, "and buys nothing again")
})

test("a cart is checked as a whole before anything is signed: all its cards or none", async () => {
  const poor = world({ account: { ...account, balance: "25000000" } })
  const e = await poor.run(poor.cart(keys(3)).pipe(Effect.flip))
  assert.match(e.message, /Insufficient balance/)
  const capped = world({ account: { ...account, daily_limit: "25000000" } })
  const d = await capped.run(capped.cart(keys(3)).pipe(Effect.flip))
  assert.match(d.message, /daily spending limit/)
  const perCard = world({ account: { ...account, per_purchase_limit: "5000000" } })
  const c = await perCard.run(perCard.cart(keys(2)).pipe(Effect.flip))
  assert.match(c.message, /^Card 10: Over the per-purchase spending limit/, "a cart says which card")
  const dup = world()
  const k = crypto.randomUUID()
  const twice = await dup.run(dup.cart([k, k]).pipe(Effect.flip))
  assert.match(twice.message, /its own key/)
  for (const x of [poor, capped, perCard, dup]) assert.deepEqual(x.calls, [], "nothing signed")
  const rows = await poor.run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ n: number }>`SELECT count(*)::int AS n FROM purchases`))
  assert.equal(rows[0]!.n, 0, "nothing recorded")
})

test("a guest cart counts all its cards against the email's 15 a day", async () => {
  const w = world({ real: true, guest: true, credit: 1_000_000_000 })
  const e = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    const sql = yield* SqlClient.SqlClient
    const [{ email_key }] = (yield* sql<{ email_key: string }>`SELECT email_key FROM checkout_emails WHERE account_id = 'alice.test'`) as [{ email_key: string }]
    for (let i = 0; i < 12; i++) {
      yield* sql`WITH co AS (INSERT INTO checkouts (account_id, step) VALUES ('test', 'done') RETURNING id) INSERT INTO purchases (checkout_id, account_id, idempotency_key, voucher_id, voucher_name, package_value, reference_price, step, email_key, invoice_id)
                 VALUES ((SELECT id FROM co), 'alice.test', ${`k${i}`}, 'amazon-us', 'Card', '1', 1000000, 'settled', ${email_key}, ${`inv${i}`})`
    }
    return yield* w.cart(keys(4)).pipe(Effect.flip)
  }))
  assert.match(e.message, /15 cards a day per email, and yours has had 12 in the last 24 hours\. This cart can have at most 3\./)
  assert.deepEqual(w.calls, [])
})

test("a cart the float can't cover waits whole, uncharged, for a refill sized for it, then goes as one order", async () => {
  const w = world({ real: true, price: 10_000_000, credit: 25_000_000 })
  const r = await w.run(Effect.gen(function*() {
    const placed = yield* w.cart(keys(3))
    w.setCredit(100_000_000)
    yield* Effect.flatMap(Credit, (c) => c.refresh)
    yield* Effect.flatMap(Purchases, (s) => s.promoteWaiting)
    return { placed, steps: yield* Effect.forEach(placed, (p) => settled(p.id)) }
  }))
  assert.deepEqual(r.placed.map((p) => p.status), ["waiting", "waiting", "waiting"])
  assert.equal(w.kicks(), 1)
  assert.deepEqual(r.steps, ["settled", "settled", "settled"])
  assert.deepEqual(w.ordered, [3], "one Bitrefill order for the whole cart")
})

test("a cart of 15 Lucky cards is admitted, ordered, paid and settled as one, each card with its own purchase", async () => {
  const w = world({ mode: { lucky: 1 }, real: true, guest: true, credit: 1_000_000_000 })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    const placed = yield* w.cart(keys(15))
    return { placed, steps: yield* Effect.forEach(placed, (p) => settled(p.id)) }
  }))
  assert.ok(r.steps.every((s) => s === "settled"), JSON.stringify(r.steps))
  assert.equal(w.calls.filter((c) => c === "purchase").length, 15, "admitted together")
  assert.deepEqual(w.ordered, [15], "one invoice")
  assert.equal(w.paid.length, 1, "one Base payment")
  assert.equal(w.paid[0]!.amount, 150_000_000)
  assert.equal(w.settled.length, 1, "one settlement")
  assert.equal(w.settled[0]!.delivered.length, 15)
  assert.equal(new Set(r.placed.map((p) => p.checkoutId)).size, 1, "one checkout")
})

test("a Lucky card the reserve no longer covers is refused before anything is signed, so the customer confirms again", async () => {
  const w = world({ mode: { lucky: 1 }, reserveFull: true })
  const e = await w.run(w.cart(keys(2)).pipe(Effect.flip))
  assert.match(e.message, /^Card 10: That quote is out of date/)
  assert.deepEqual(w.calls, [])
})

test("each card of a cart gets its own code, and a card Bitrefill fails is refunded without holding the others", async () => {
  const w = world({ real: true, guest: true, credit: 100_000_000, deliveries: [["Delivered", "Failed", "Delivered"]] })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    const placed = yield* w.cart(keys(3))
    yield* Effect.forEach(placed, (p) => settled(p.id))
    return yield* Effect.forEach(placed, (p) => Purchases.use((s) => s.get("alice.test", p.id)))
  }))
  assert.deepEqual(r.map((p) => p.status), ["delivered", "failed", "delivered"])
  assert.deepEqual(r.map((p) => p.redemption?.code), ["ABC-123", undefined, "ABC-125"], "each card its own order's code")
  assert.deepEqual(w.settled, [{ delivered: [7, 9], failed: [8] }])
  assert.ok(w.alerts.some((a) => /didn't deliver purchase .* on paid invoice/.test(a)), "we paid for it: ask Bitrefill for the money back")
})

test("a card still on its way doesn't hold the others: they're settled now, it is later", async () => {
  // Still pending when it's asked about again: the run pauses there, the others settled.
  const w = world({ real: true, guest: true, credit: 100_000_000, deliveries: [["Delivered", "Pending", "Delivered"], ["Delivered", "Pending", "Delivered"]] })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    const placed = yield* w.cart(keys(3))
    const first = yield* Effect.forEach(placed, (p) => settled(p.id))
    // The reconciler comes by again; this time the slow card is there.
    yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE checkouts SET updated_at = now() - interval '1 minute', next_attempt_at = now()`)
    yield* Effect.flatMap(Purchases, (s) => s.reconcileNow)
    return { first, then: yield* Effect.forEach(placed, (p) => settled(p.id)) }
  }))
  assert.deepEqual(r.first, ["settled", "delivery", "settled"])
  assert.deepEqual(r.then, ["settled", "settled", "settled"])
  assert.deepEqual(w.settled, [{ delivered: [7, 9], failed: [] }, { delivered: [8], failed: [] }])
})

test("identical cards delivered in different rounds each get their own order's code", async () => {
  // Bitrefill lists an order for each copy of the same card; the first copy arrives at once, the second a round later.
  const w = world({ real: true, guest: true, credit: 100_000_000, deliveries: [["Delivered", "Pending"], ["Delivered", "Pending"]] })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    const placed = yield* w.cart(keys(2))
    const first = yield* Effect.forEach(placed, (p) => settled(p.id))
    yield* reconcilePass
    yield* Effect.forEach(placed, (p) => settled(p.id))
    return { first, cards: yield* Effect.forEach(placed, (p) => Purchases.use((s) => s.get("alice.test", p.id))) }
  }))
  assert.deepEqual(r.first, ["settled", "delivery"], "the second copy is still on its way after the first round")
  assert.deepEqual(r.cards.map((p) => p.redemption?.code), ["ABC-123", "ABC-124"], "the second copy gets the second order's code, never the first's again")
  assert.deepEqual(w.settled, [{ delivered: [7], failed: [] }, { delivered: [8], failed: [] }])
})

test("two carts at once can't both pass an email's guest limits or an account's open cards", async () => {
  // Two accounts with the same Checkout Email: 10 cards each would make 20 for the email today.
  const guest = world({ real: true, guest: true, credit: 1_000_000_000 })
  const g = await guest.run(Effect.gen(function*() {
    yield* withEmail("shared@example.com", "bob.test")
    yield* withEmail("shared@example.com")
    return yield* Effect.all([Effect.exit(guest.cart(keys(10))), Effect.exit(guest.cart(keys(10), "bob.test"))], { concurrency: "unbounded" })
  }))
  assert.equal(g.filter(Exit.isSuccess).length, 1, "only one cart goes through")
  assert.match(JSON.stringify(g.find(Exit.isFailure)), /15 cards a day per email/)
  assert.equal(guest.calls.filter((c) => c === "purchase").length, 10, "the other is refused before anything is signed")

  // One account, two carts of 10 at once: 20 unfinished cards, more than a full cart.
  const one = world({ deliveryDelay: 300 })
  const o = await one.run(Effect.all([Effect.exit(one.cart(keys(10))), Effect.exit(one.cart(keys(10)))], { concurrency: "unbounded" }))
  assert.equal(o.filter(Exit.isSuccess).length, 1)
  assert.match(JSON.stringify(o.find(Exit.isFailure)), /still in progress/)
})

test("a card counts against its email's day from when it was ordered, not when it was placed", async () => {
  // Fifteen cards placed 25 hours ago that waited for the float and were ordered an hour ago: Bitrefill counts them today.
  const w = world({ real: true, guest: true, credit: 100_000_000 })
  const e = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    const sql = yield* SqlClient.SqlClient
    const [{ email_key }] = (yield* sql<{ email_key: string }>`SELECT email_key FROM checkout_emails WHERE account_id = 'alice.test'`) as [{ email_key: string }]
    for (let i = 0; i < 15; i++) {
      yield* sql`WITH co AS (INSERT INTO checkouts (account_id, step) VALUES ('test', 'done') RETURNING id)
                 INSERT INTO purchases (checkout_id, account_id, idempotency_key, voucher_id, voucher_name, package_value, reference_price, step, email_key, invoice_id, created_at, ordered_at)
                 VALUES ((SELECT id FROM co), 'alice.test', ${`k${i}`}, 'amazon-us', 'Card', '1', 1000000, 'settled', ${email_key}, ${`inv${i}`},
                         now() - interval '25 hours', now() - interval '1 hour')`
    }
    return yield* w.buy().pipe(Effect.flip)
  }))
  assert.match(e.message, /15 cards a day per email, and yours has had 15/)
  assert.deepEqual(w.calls, [])
})

test("a checkout whose cards were partly bought already is refused, and nothing more is bought", async () => {
  const w = world()
  const k = crypto.randomUUID()
  const e = await w.run(Effect.gen(function*() {
    yield* w.cart([k])
    return yield* w.cart([k, crypto.randomUUID()]).pipe(Effect.flip)
  }))
  assert.match(e.message, /already sent in an earlier checkout/)
  assert.equal(w.calls.filter((c) => c === "purchase").length, 1)
})

test("a notice Telegram didn't take is sent again on the next pass, and only once", async () => {
  const w = world({ real: true, guest: true, credit: 100_000_000, deliveryDelay: 400, requestWait: 50, telegramDown: 1 })
  await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    yield* w.buy()
    yield* Effect.sleep("1 second")
    yield* reconcilePass
    yield* reconcilePass
  }))
  assert.equal(w.notices.length, 2, "tried once, then sent once more")
  assert.match(w.notices[1]!, /is ready/)
})

test("a checkout is ordered with the Checkout Email it was placed under, even if that changed while it waited", async () => {
  const w = world({ real: true, guest: true, price: 12_000_000, credit: 5_000_000 })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    const p = yield* w.buy()
    yield* withEmail("later@example.com")
    const sql = yield* SqlClient.SqlClient
    const [stored] = yield* sql<{ email: string | null }>`SELECT email FROM checkouts`
    w.setCredit(100_000_000)
    yield* Effect.flatMap(Credit, (c) => c.refresh)
    yield* Effect.flatMap(Purchases, (s) => s.promoteWaiting)
    return { first: p.status, stored: stored!.email, after: yield* settled(p.id) }
  }))
  assert.equal(r.first, "waiting")
  assert.equal(r.after, "settled")
  assert.deepEqual(w.calls.filter((c) => c.startsWith("order:")), ["order:alice@example.com"], "the email the customer confirmed")
  assert.ok(r.stored && !r.stored.includes("alice"), "kept on the checkout, sealed")
})

test("a card delivered with neither a code nor a link tells an admin, naming the purchase and none of its data", async () => {
  const w = world({ real: true, guest: true, credit: 100_000_000, deliveries: [["NoCode"]] })
  const p = await w.run(Effect.andThen(withEmail("alice@example.com"), w.buy()))
  assert.equal(p.status, "delivered")
  assert.equal(w.alerts.filter((a) => a.includes(p.id)).length, 1)
  assert.ok(!w.alerts.join(" ").includes("S3CRET"), "never the Redemption Data")
})

test("a checkout that gave up at settle goes back on Retry now, each card to where it was, and finishes", async () => {
  // NEAR doesn't take the settlement for six hours of retries: one card has its code, the other failed at Bitrefill.
  const w = world({ real: true, guest: true, credit: 100_000_000, confirm: "down", deliveries: [["Delivered", "Failed"]] })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    const placed = yield* w.cart(keys(2))
    yield* Effect.forEach(placed, (p) => settled(p.id))
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE checkouts SET attempts = 12`
    yield* reconcilePass
    const stuck = yield* sql<{ step: string; error: string }>`SELECT step, error FROM purchases ORDER BY position`
    const [checkout] = yield* sql<{ step: string }>`SELECT step FROM checkouts`
    // NEAR is back; the admin presses Retry now on either card.
    w.setConfirm("ok")
    const at = yield* retryPurchase(placed[1]!.id)
    yield* reconcilePass
    const after = yield* Effect.forEach(placed, (p) => settled(p.id))
    return { stuck, checkout: checkout!.step, at, after, cards: yield* Effect.forEach(placed, (p) => Purchases.use((s) => s.get("alice.test", p.id))) }
  }))
  assert.equal(r.checkout, "stuck")
  assert.deepEqual(r.stuck.map((c) => [c.step, GAVE_UP_AT.exec(c.error)?.[1]]), [["stuck", "confirm"], ["stuck", "fail"]], "each card says where it gave up")
  assert.equal(r.at, "fail")
  assert.deepEqual(r.after, ["settled", "failed"])
  assert.equal(r.cards[0]!.redemption?.code, "ABC-123", "the code it already had")
  assert.deepEqual(w.settled.at(-1), { delivered: [7], failed: [8] }, "settled once more, as it was")
  assert.equal(w.calls.filter((c) => c.startsWith("order:")).length, 1, "never ordered again")
  assert.equal(w.paid.length, 1, "never paid again")
})

test("a checkout that gave up at delivery goes back to asking Bitrefill; one that gave up at pay needs a human", async () => {
  const slow = world({ real: true, guest: true, credit: 100_000_000, bitrefillDown: "delivery" })
  const d = await slow.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    const p = yield* slow.buy()
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE checkouts SET attempts = 12`
    yield* reconcilePass
    const stuck = (yield* rowOf(p.id)).step
    const at = yield* retryPurchase(p.id)
    return { stuck, at, row: yield* rowOf(p.id), checkout: (yield* sql<{ step: string; error: string | null }>`SELECT step, error FROM checkouts`)[0]! }
  }))
  assert.equal(d.stuck, "stuck")
  assert.equal(d.at, "delivery")
  assert.deepEqual([d.row.step, d.row.attempts, d.row.due], ["delivery", 0, true], "due on the reconciler's next pass")
  assert.deepEqual(d.checkout, { step: "delivery", error: null })
  assert.equal(slow.paid.length, 1)

  const unpaid = world({ real: true, guest: true, credit: 100_000_000, payDown: true })
  const p = await unpaid.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    const p = yield* unpaid.buy()
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE checkouts SET attempts = 12`
    yield* reconcilePass
    return { step: (yield* rowOf(p.id)).step, refused: yield* retryPurchase(p.id).pipe(Effect.flip) }
  }))
  assert.equal(p.step, "stuck")
  assert.match(p.refused.message, /needs a manual check/)
})

test("the same cart sent twice at once is one checkout, returned to both", async () => {
  const w = world()
  const asked = keys(10)
  const [a, b] = await w.run(Effect.all([w.cart(asked), w.cart(asked)], { concurrency: "unbounded" }))
  assert.deepEqual(a.map((p) => p.id), b.map((p) => p.id))
  assert.equal(new Set(a.map((p) => p.checkoutId)).size, 1)
  assert.equal(w.calls.filter((c) => c === "purchase").length, 10, "admitted once")
})

test("a card is never given an order another card of its checkout already has, however Bitrefill lists them", async () => {
  // Two copies of one card. In the second round Bitrefill lists the orders the other way round, so the copy still on
  // its way is matched to the order the first copy got.
  const w = world({
    real: true,
    guest: true,
    credit: 100_000_000,
    deliveries: [["Delivered", "Pending"], ["Delivered", "Pending"], ["Delivered", "Delivered"]],
    listed: [[0, 1], [1, 0], [0, 1]]
  })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com")
    const placed = yield* w.cart(keys(2))
    const first = yield* Effect.forEach(placed, (p) => settled(p.id))
    yield* reconcilePass
    yield* Effect.forEach(placed, (p) => settled(p.id))
    return { placed, first, cards: yield* Effect.forEach(placed, (p) => Purchases.use((s) => s.get("alice.test", p.id))) }
  }))
  assert.deepEqual(r.first, ["settled", "delivery"], "left waiting rather than given the first copy's code")
  assert.deepEqual(r.cards.map((p) => p.redemption?.code), ["ABC-123", "ABC-124"])
  assert.equal(w.alerts.filter((a) => a.includes(`purchase ${r.placed[1]!.id}`) && /already has/.test(a)).length, 1)
  assert.deepEqual(w.settled, [{ delivered: [7], failed: [] }, { delivered: [8], failed: [] }])
})

test("a card whose price rose since it was confirmed is refused before anything is signed; a drop buys at the lower price", async () => {
  // The card is $10 now. Lucky Buys here play their whole price at a 20% premium.
  const w = world({ price: 10_000_000, luckyCap: 100_000_000 })
  const lucky = { lucky: 1 }
  const buy = (cards: ReadonlyArray<{ mode: Mode; maxPrice: number; luckyAmount?: number }>) => {
    const items = cards.map((c) => new NewPurchase({ voucherId: "test-card", value: "10", ...c, idempotencyKey: crypto.randomUUID() }))
    return items.length === 1
      ? Effect.map(Purchases.use((p) => p.create("alice.test", items[0]!)), (p) => [p])
      : Purchases.use((p) => p.createCart("alice.test", items))
  }
  // Confirmed at $8: $8 in Normal, $9.60 for a Lucky Buy on the whole $8.
  const normalUp = { mode: "normal" as const, maxPrice: 8_000_000 }
  const luckyUp = { mode: lucky, luckyAmount: 8_000_000, maxPrice: 9_600_000 }
  // Confirmed at $12: $12 in Normal, $14.40 for a Lucky Buy on the whole $12.
  const normalDown = { mode: "normal" as const, maxPrice: 12_000_000 }
  const luckyDown = { mode: lucky, luckyAmount: 12_000_000, maxPrice: 14_400_000 }
  // Price unchanged, and the reserve has grown since a Lucky Buy on $5 of it was confirmed at $11: still exactly $11.
  const luckyGrown = { mode: lucky, luckyAmount: 5_000_000, maxPrice: 11_000_000 }
  const r = await w.run(Effect.gen(function*() {
    const refused: Array<string> = []
    for (const cards of [[normalUp], [luckyUp], [normalDown, luckyUp], [luckyDown, normalUp]]) refused.push((yield* Effect.flip(buy(cards))).message)
    const signed = [...w.calls]
    const bought = [...(yield* buy([normalDown])), ...(yield* buy([luckyDown])), ...(yield* buy([normalDown, luckyDown])), ...(yield* buy([luckyGrown]))]
    return { refused, signed, bought: yield* Effect.forEach(bought, (p) => settled(p.id)) }
  }))
  assert.deepEqual(r.refused.map((m) => /Price changed since you confirmed; please confirm again/.test(m)), [true, true, true, true])
  assert.deepEqual(r.signed, [], "nothing signed, so none of it counts as a refusal against the customer")
  assert.deepEqual(r.bought, ["settled", "settled", "settled", "settled", "settled"], "four refusals later the customer still buys")
  assert.deepEqual(w.admits.map((a) => [a.reference_price, a.lucky_amount ?? null]), [
    ["10000000", null],
    ["10000000", "10000000"],
    ["10000000", null],
    ["10000000", "10000000"],
    ["10000000", "5000000"]
  ], "at today's lower price, a whole-price Lucky Buy on the whole of it")
})

test("Bitrefill's guest limits, as one rule the shop and the bot share", () => {
  assert.equal(guestLimitRefusal({ orders: 11, day: 0, month: 0 }, 4_000_000, 4), undefined)
  assert.match(guestLimitRefusal({ orders: 12, day: 0, month: 0 }, 4_000_000, 4) ?? "", /yours has had 12 in the last 24 hours\. This cart can have at most 3\./)
  assert.match(guestLimitRefusal({ orders: 0, day: 450_000_000, month: 450_000_000 }, 60_000_000, 1) ?? "", /a day per email; this one would go over it/)
  assert.match(guestLimitRefusal({ orders: 0, day: 0, month: 950_000_000 }, 60_000_000, 2) ?? "", /a month per email; this cart would go over it/)
})
