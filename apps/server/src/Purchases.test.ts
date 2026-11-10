import { NewPurchase, Voucher } from "@luckout/api"
import { Effect, Layer } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Alerts } from "./Alerts.ts"
import { Bitrefill } from "./Bitrefill.ts"
import { DbMemory } from "./Db.ts"
import { ContractRejected, Near, type Outcome } from "./Near.ts"
import { Purchases } from "./Purchases.ts"

// The purchase workflow end to end on an in-memory database, with NEAR and Bitrefill faked.
process.env.NEAR_NETWORK = "testnet"
process.env.REDEMPTION_KEY = "11".repeat(32)

const account = { balance: "100000000", per_purchase_limit: "50000000", daily_limit: "100000000", day: 0, spent_today: "0" }

const world = (opts: { account?: typeof account | null; confirm?: "ok" | "refused"; onchain?: string } = {}) => {
  const calls: Array<string> = []
  const alerts: Array<string> = []
  const outcome = (value: unknown, events: Outcome["events"] = []): Outcome => ({ hash: "h", value, events, failures: [] })
  const near = Near.of({
    contractId: "app.test",
    operatorId: "server.test",
    view: <A>(method: string) =>
      Effect.succeed(
        (method === "get_account" ? (opts.account === undefined ? account : opts.account) : { status: opts.onchain ?? "Pending" }) as A
      ),
    call: (method, _args, persist) =>
      Effect.gen(function*() {
        calls.push(method)
        yield* persist({ hash: `${method}-tx`, bytes: "" })
        if (method === "purchase") {
          return outcome(7, [{ event: "purchase", data: [{ purchase: { mode: "normal", max_price: "10000000", lucky_amount: "0" } }] }])
        }
        if (opts.confirm === "refused") return yield* new ContractRejected({ message: "Purchase is already closed" })
        return outcome(null)
      }),
    resume: () => Effect.die("not used"),
    relayerId: undefined,
    relay: () => Effect.die("not used"),
    accessKey: () => Effect.die("not used"),
    height: Effect.die("not used"),
    account: () => Effect.die("not used"),
    verifySignIn: () => Effect.succeed(false)
  })
  const bitrefill = Bitrefill.of({
    search: () => Effect.succeed([]),
    voucher: () =>
      Effect.succeed(new Voucher({ id: "test-card", name: "Test Card", countryCode: "US", currency: "USD", packages: [{ value: "10", priceMicroUsdc: 10_000_000 }] })),
    order: () => Effect.sync(() => (calls.push("order"), { _tag: "Ordered" as const, invoiceId: "inv-1" })),
    delivery: () => Effect.succeed({ _tag: "Delivered" as const, invoiceId: "inv-1", orderId: "o-1", redemption: { code: "ABC-123" } }),
    usdBalance: Effect.succeed("0.00")
  })
  const layer = Purchases.layer.pipe(
    Layer.provide(Layer.mergeAll(
      Layer.succeed(Near, near),
      Layer.succeed(Bitrefill, bitrefill),
      Layer.succeed(Alerts, Alerts.of({ admin: (t) => Effect.sync(() => void alerts.push(t)), customer: () => Effect.void }))
    )),
    Layer.provideMerge(DbMemory)
  )
  const buy = (key: string = crypto.randomUUID()) =>
    Purchases.use((p) => p.create("alice.test", new NewPurchase({ voucherId: "test-card", value: "10", mode: "normal", maxPrice: 10_000_000, idempotencyKey: key })))
  return { calls, alerts, layer, buy }
}

test("a purchase walks every step and shows the code only once delivered", async () => {
  const w = world()
  const p = await Effect.runPromise(w.buy().pipe(Effect.provide(w.layer)))
  assert.equal(p.status, "delivered")
  assert.equal(p.redemption?.code, "ABC-123")
  assert.deepEqual(w.calls, ["purchase", "order", "confirm_delivery"])
})

test("the same idempotency key never buys twice", async () => {
  const w = world()
  const [a, b] = await Effect.runPromise(Effect.all([w.buy("same-key-1"), w.buy("same-key-1")]).pipe(Effect.provide(w.layer)))
  assert.equal(a.id, b.id)
  assert.deepEqual(w.calls, ["purchase", "order", "confirm_delivery"])
})

test("an account with no balance is refused before anything is signed", async () => {
  const w = world({ account: null })
  const e = await Effect.runPromise(w.buy().pipe(Effect.flip, Effect.provide(w.layer)))
  assert.match(e.message, /No balance/)
  assert.deepEqual(w.calls, [])
})

test("over the per-purchase limit is refused before anything is signed", async () => {
  const w = world({ account: { ...account, per_purchase_limit: "5000000" } })
  const e = await Effect.runPromise(w.buy().pipe(Effect.flip, Effect.provide(w.layer)))
  assert.match(e.message, /per-purchase spending limit/)
  assert.deepEqual(w.calls, [])
})

test("a refused confirmation reads the chain: reclaimed means refunded, and a human is told", async () => {
  const w = world({ confirm: "refused", onchain: "Reclaimed" })
  const p = await Effect.runPromise(w.buy().pipe(Effect.provide(w.layer)))
  assert.equal(p.status, "failed")
  assert.match(p.error ?? "", /reclaimed/)
  assert.equal(p.redemption, undefined)
  assert.equal(w.alerts.length, 1)
})

test("a refused confirmation that is still open onchain stays pending for the reconciler", async () => {
  const w = world({ confirm: "refused", onchain: "Drawing" })
  const p = await Effect.runPromise(w.buy().pipe(Effect.provide(w.layer)))
  assert.equal(p.status, "pending")
  assert.equal(p.settleTx, undefined, "the next attempt signs a fresh transaction")
})
