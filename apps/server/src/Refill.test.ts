import { CreditSettings } from "@luckout/api"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import type { Action } from "near-api-js"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Alerts } from "./Alerts.ts"
import { Bitrefill, type DepositState } from "./Bitrefill.ts"
import { Credit, CREDIT_DEFAULTS } from "./Credit.ts"
import { DbMemory } from "./Db.ts"
import { Near, NearUnavailable, type Outcome } from "./Near.ts"
import { OneClick, type QuoteRequest, type QuoteResponse } from "./OneClick.ts"
import { BASE_USDC_ASSET, quoteProblem, Refill } from "./Refill.ts"
import { fakeBitrefill, fakeNear } from "./testing.ts"
import { NEAR_USDC_ASSET } from "./TopUp.ts"

// The refill pipeline on an in-memory database, with NEAR, Bitrefill and 1Click faked. Refills only
// run on mainnet. Every test checks where the money went: which transactions the treasury signed.
process.env.NEAR_NETWORK = "mainnet"

const TREASURY = "treasury.test"
const BITREFILL_ADDRESS = "0x" + "ab".repeat(20)
const DEPOSIT_ADDRESS = "cd".repeat(32)

interface Tx {
  readonly receiver: string
  readonly calls: ReadonlyArray<{ method: string; args: Record<string, unknown>; deposit: bigint }>
}

const world = (o: {
  cap?: number
  treasuryUsdc?: number
  proceeds?: number
  contractTreasury?: string | null
  /** Our Bitrefill credit: above the refill line, so nothing refills by itself. */
  credit?: number
  quote?: (r: QuoteRequest) => QuoteResponse
  swap?: Array<string>
  deposit?: Array<DepositState>
  /** The treasury's transfer is saved, then the network goes quiet: outcome unknown. */
  sendLost?: boolean
} = {}) => {
  const s = { usdc: o.treasuryUsdc ?? 0, proceeds: o.proceeds ?? 236_000_000, swept: 0 }
  const txs: Array<Tx> = []
  const resumed: Array<string> = []
  const alerts: Array<string> = []
  const swap = [...(o.swap ?? ["PROCESSING", "SUCCESS"])]
  const deposit = [...(o.deposit ?? ["pending", "credited"])]
  let lost = o.sendLost ?? false
  const outcome = (hash: string): Outcome => ({ hash, value: null, events: [], failures: [] })
  const decode = (a: Action) => {
    const f = a.functionCall!
    return { method: f.methodName, args: JSON.parse(new TextDecoder().decode(f.args)), deposit: BigInt(f.deposit) }
  }
  // What each transaction does to the balances, as the chain would.
  const apply = (tx: Tx) => {
    for (const c of tx.calls) {
      if (c.method === "sweep_proceeds") {
        const amount = Number(c.args.amount)
        s.usdc += amount
        s.proceeds -= amount
        s.swept += amount
      }
      if (c.method === "ft_transfer") s.usdc -= Number(c.args.amount)
    }
  }
  const near = fakeNear({
    treasuryId: TREASURY,
    view: <A>(method: string) =>
      Effect.succeed(({
        get_config: {
          treasury: o.contractTreasury === undefined ? TREASURY : o.contractTreasury,
          sweep_daily_cap: String(o.cap ?? 100_000_000),
          swept_today: String(s.swept)
        },
        get_reserve: { proceeds: String(s.proceeds) },
        ft_balance_of: String(s.usdc)
      } as Record<string, unknown>)[method] as A),
    treasurySend: (receiver, actions, persist) =>
      Effect.gen(function*() {
        const tx = { receiver, calls: actions.map(decode) }
        const hash = `tx-${txs.length + 1}`
        txs.push(tx)
        yield* persist({ hash, bytes: JSON.stringify(tx, (_, v) => (typeof v === "bigint" ? String(v) : v)) })
        if (lost && tx.calls.some((c) => c.method === "ft_transfer")) {
          lost = false
          apply(tx)
          return yield* new NearUnavailable({ message: "send: timed out" })
        }
        apply(tx)
        return outcome(hash)
      }),
    resume: (signed) => Effect.sync(() => (resumed.push(signed.hash), outcome(signed.hash))),
    account: () => Effect.succeed({ amount: 10n ** 24n, storageUsage: 0 })
  })
  const bitrefill = fakeBitrefill({
    credit: Effect.succeed({ balance: o.credit ?? 450_000_000, room: 1_500_000_000 }),
    deposit: (amount) => Effect.succeed({ invoiceId: "inv-1", address: BITREFILL_ADDRESS, price: amount }),
    depositState: () => Effect.succeed({ state: deposit.shift() ?? "credited", status: "x" })
  })
  const honest = (r: QuoteRequest): QuoteResponse => ({
    quote: {
      depositAddress: DEPOSIT_ADDRESS,
      amountIn: String(Math.ceil(Number(r.amount) * 1.005)),
      amountInFormatted: "",
      minAmountIn: String(Math.ceil(Number(r.amount) * 1.0004)),
      amountOut: r.amount,
      minAmountOut: r.amount,
      timeEstimate: 22,
      deadline: r.deadline
    },
    quoteRequest: {
      originAsset: r.originAsset,
      destinationAsset: r.destinationAsset,
      recipient: r.recipient,
      swapType: r.swapType,
      amount: r.amount,
      refundTo: r.refundTo
    }
  })
  const oneClick = OneClick.of({
    tokens: Effect.succeed([]),
    quote: (r) => Effect.succeed((o.quote ?? honest)(r)),
    status: () => Effect.succeed(swap.shift() ?? "SUCCESS"),
    submitDeposit: () => Effect.void
  })
  const layer = Refill.layer.pipe(
    Layer.provideMerge(Credit.layer),
    Layer.provide(Layer.mergeAll(
      Layer.succeed(Near, near),
      Layer.succeed(Bitrefill, bitrefill),
      Layer.succeed(OneClick, oneClick),
      Layer.succeed(Alerts, Alerts.of({ admin: (t) => Effect.sync(() => void alerts.push(t)), customer: () => Effect.void }))
    )),
    Layer.provideMerge(DbMemory)
  )
  // These tests size refills in tens of dollars: give them testnet-sized limits (mainnet starts at $30).
  const run = <A, E>(e: Effect.Effect<A, E, Refill | Credit | SqlClient.SqlClient>) =>
    Effect.runPromise(Effect.scoped(Effect.andThen(Effect.flatMap(Credit, (c) => c.configure(CREDIT_DEFAULTS.testnet, "test")), e)).pipe(Effect.provide(layer)))
  return { s, txs, resumed, alerts, run }
}

/** Waits until the refill's step stops changing (the pipeline runs in its own fiber). */
const settle = (id: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    let last = ""
    for (let i = 0; i < 40; i++) {
      yield* Effect.sleep("50 millis")
      const [r] = yield* sql<{ step: string; error: string | null }>`SELECT step, error FROM refills WHERE id = ${id}`
      const now = `${r?.step}|${r?.error}`
      if (now === last) return r!
      last = now
    }
    return yield* Effect.die("refill never settled")
  })
const due = Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE refills SET next_attempt_at = now() - interval '1 second'`)
/** Settles, then makes every waiting step due again, until the refill finishes (or stops moving). */
const drive = (id: string) =>
  Effect.gen(function*() {
    const refill = yield* Refill
    let r = yield* settle(id)
    for (let i = 0; i < 6 && ["swapping", "crediting", "quote", "invoice"].includes(r.step); i++) {
      yield* due
      yield* refill.process
      r = yield* settle(id)
    }
    return r
  })
const methods = (txs: ReadonlyArray<Tx>) => txs.map((t) => t.calls.map((c) => c.method).join("+"))

test("a refill pulls exactly its shortfall, pays exactly the invoice through 1Click, and waits for Bitrefill's credit", async () => {
  const w = world({ cap: 100_000_000, treasuryUsdc: 0 })
  const r = await w.run(Effect.gen(function*() {
    const v = yield* Effect.flatMap(Refill, (r) => r.request(30_000_000, "boss.testnet"))
    return yield* drive(v.id)
  }))
  assert.equal(r.step, "done", r.error ?? "")
  assert.deepEqual(methods(w.txs), ["sweep_proceeds", "storage_deposit+ft_transfer"])
  const pull = w.txs[0]!
  assert.equal(pull.calls[0]!.args.amount, "30150000", "the shortfall, rounded up to the cent")
  const pay = w.txs[1]!
  assert.equal(pay.receiver, "usdc.test")
  assert.deepEqual(pay.calls[1]!.args.receiver_id, DEPOSIT_ADDRESS)
  assert.equal(pay.calls[1]!.args.amount, "30150000")
  assert.equal(pay.calls[1]!.deposit, 1n)
  assert.equal(w.s.usdc, 0, "the treasury keeps nothing back")
  assert.ok(w.alerts.some((a) => a.includes("refilled: +$30.00")))
})

test("a treasury with enough USDC pays without pulling proceeds", async () => {
  const w = world({ treasuryUsdc: 50_000_000 })
  const r = await w.run(Effect.flatMap(Effect.flatMap(Refill, (r) => r.request(30_000_000, "boss.testnet")), (v) => drive(v.id)))
  assert.equal(r.step, "done")
  assert.deepEqual(methods(w.txs), ["storage_deposit+ft_transfer"])
})

test("in manual mode the refill waits for the owner, and says how much to move", async () => {
  const w = world({ cap: 0 })
  const r = await w.run(Effect.gen(function*() {
    const refill = yield* Refill
    const v = yield* refill.request(30_000_000, "boss.testnet")
    const row = yield* settle(v.id)
    return { row, needs: (yield* refill.status).needs }
  }))
  assert.equal(r.row.step, "fund")
  assert.equal(r.needs, 30_150_000)
  assert.deepEqual(w.txs, [], "nothing signed")
})

test("a quote that pays anyone but Bitrefill is refused, and nothing is sent", async () => {
  const w = world({
    quote: (r) => {
      const q = { quote: { depositAddress: DEPOSIT_ADDRESS, amountIn: r.amount, amountInFormatted: "", amountOut: r.amount, timeEstimate: 1, deadline: r.deadline } }
      return { ...q, quoteRequest: { originAsset: r.originAsset, destinationAsset: r.destinationAsset, recipient: "0x" + "ee".repeat(20), swapType: r.swapType, amount: r.amount, refundTo: r.refundTo } }
    }
  })
  const r = await w.run(Effect.flatMap(Effect.flatMap(Refill, (r) => r.request(30_000_000, "boss.testnet")), (v) => settle(v.id)))
  assert.equal(r.step, "failed")
  assert.match(r.error ?? "", /not Bitrefill's/)
  assert.deepEqual(w.txs, [])
})

test("a lost transfer is resumed with the same signed bytes, never paid twice", async () => {
  const w = world({ treasuryUsdc: 50_000_000, sendLost: true })
  const r = await w.run(Effect.gen(function*() {
    const refill = yield* Refill
    const v = yield* refill.request(30_000_000, "boss.testnet")
    const first = yield* settle(v.id)
    yield* due
    yield* refill.process
    return { first, last: yield* drive(v.id) }
  }))
  assert.equal(r.first.step, "send", "unknown outcome: it stays at send")
  assert.equal(r.last.step, "done")
  assert.deepEqual(methods(w.txs), ["storage_deposit+ft_transfer"], "one transfer signed")
  assert.deepEqual(w.resumed, ["tx-1"], "then resumed, not re-signed")
})

test("a refunded swap ends with the money back; a failed one stops refills until resolved", async () => {
  const refunded = world({ treasuryUsdc: 50_000_000, swap: ["REFUNDED"] })
  const a = await refunded.run(Effect.flatMap(Effect.flatMap(Refill, (r) => r.request(30_000_000, "boss.testnet")), (v) => drive(v.id)))
  assert.equal(a.step, "refunded")

  const failed = world({ treasuryUsdc: 50_000_000, swap: ["FAILED"] })
  const b = await failed.run(Effect.gen(function*() {
    const refill = yield* Refill
    const v = yield* refill.request(30_000_000, "boss.testnet")
    const stuck = yield* settle(v.id)
    const blocked = yield* refill.request(30_000_000, "boss.testnet").pipe(Effect.flip)
    yield* refill.resolve(v.id, "Checked 1Click and Bitrefill: credited by hand", "boss.testnet")
    return { stuck: stuck.step, blocked: blocked.message, paused: (yield* refill.status).paused }
  }))
  assert.equal(b.stuck, "stuck")
  assert.match(b.blocked, /stuck; resolve it/)
  assert.ok(!b.paused?.includes("stuck"), "resolving lets refills run again")
  assert.ok(failed.alerts.some((m) => m.includes("needs a look")))
})

test("a contract pointing at another treasury is never funded", async () => {
  const w = world({ contractTreasury: "someone-else.test" })
  const r = await w.run(Effect.flatMap(Effect.flatMap(Refill, (r) => r.request(30_000_000, "boss.testnet")), (v) => settle(v.id)))
  assert.equal(r.step, "fund")
  assert.match(r.error ?? "", /someone-else\.test/)
  assert.deepEqual(w.txs, [])
})

test("the daily cap and the proceeds bound what the treasury pulls", async () => {
  const w = world({ cap: 20_000_000 })
  const r = await w.run(Effect.flatMap(Effect.flatMap(Refill, (r) => r.request(30_000_000, "boss.testnet")), (v) => settle(v.id)))
  assert.equal(r.step, "fund")
  assert.match(r.error ?? "", /allow \$20\.00/)
  assert.deepEqual(w.txs, [])
})

test("a refill never takes the credit above the ceiling", async () => {
  const w = world({ credit: 450_000_000, treasuryUsdc: 100_000_000 })
  const v = await w.run(Effect.gen(function*() {
    yield* Effect.flatMap(Credit, (c) => c.refresh)
    return yield* Effect.flatMap(Refill, (r) => r.request(200_000_000, "boss.testnet"))
  }))
  assert.equal(v.amount, CREDIT_DEFAULTS.testnet.ceiling - 450_000_000)
})

test("refills stop by themselves when switched off, and only on mainnet with a treasury", async () => {
  const w = world({ credit: 0 })
  const paused = await w.run(Effect.gen(function*() {
    const credit = yield* Credit
    yield* credit.configure(new CreditSettings({ ...(yield* credit.settings), autoRefill: false }), "boss.testnet")
    return (yield* Effect.flatMap(Refill, (r) => r.status)).paused
  }))
  assert.match(paused ?? "", /switched off/)
})

test("quotes are checked against exactly what we asked for", () => {
  const want = { amount: 30_000_000, recipient: BITREFILL_ADDRESS, refundTo: TREASURY }
  const base = (over: Partial<QuoteResponse["quote"]> = {}, echo: Partial<NonNullable<QuoteResponse["quoteRequest"]>> = {}): QuoteResponse => ({
    quote: {
      depositAddress: DEPOSIT_ADDRESS,
      amountIn: "30150000",
      amountInFormatted: "",
      amountOut: "30000000",
      minAmountOut: "30000000",
      timeEstimate: 22,
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
      ...over
    },
    quoteRequest: {
      originAsset: NEAR_USDC_ASSET,
      destinationAsset: BASE_USDC_ASSET,
      recipient: BITREFILL_ADDRESS,
      swapType: "EXACT_OUTPUT",
      amount: "30000000",
      refundTo: TREASURY,
      ...echo
    }
  })
  assert.equal(quoteProblem(base(), want), undefined)
  assert.match(quoteProblem(base({ minAmountOut: "29900000" }), want) ?? "", /not exactly/)
  assert.match(quoteProblem(base({ amountIn: "30400000" }), want) ?? "", /over the 1% limit/)
  assert.match(quoteProblem(base({}, { refundTo: "attacker.near" }), want) ?? "", /refunds to/)
  assert.match(quoteProblem(base({}, { destinationAsset: "nep141:eth-usdc" }), want) ?? "", /wrong assets/)
  assert.match(quoteProblem(base({ depositAddress: "Not A NEAR Account!" }), want) ?? "", /deposit address/)
  assert.match(quoteProblem(base({ deadline: new Date(Date.now() + 60_000).toISOString() }), want) ?? "", /deadline/)
  assert.match(quoteProblem({ quote: base().quote }, want) ?? "", /didn't echo/)
})

test("mainnet starts small: a $30 ceiling, $15 largest order, $40 of refills a day", () => {
  const m = CREDIT_DEFAULTS.mainnet
  assert.deepEqual([m.floor, m.ceiling, m.maxOrder, m.dailyRefill], [10_000_000, 30_000_000, 15_000_000, 40_000_000])
})

