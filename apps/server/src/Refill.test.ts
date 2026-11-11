import { CreditSettings } from "@luckout/api"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import type { Action } from "near-api-js"
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Hex } from "viem"
import { Alerts } from "./Alerts.ts"
import { Base, BaseUnavailable, type PaymentStatus } from "./Base.ts"
import { Bitrefill, type DepositState } from "./Bitrefill.ts"
import { Credit, CREDIT_DEFAULTS, levels } from "./Credit.ts"
import { DbMemory } from "./Db.ts"
import { Near, NearUnavailable, type Outcome } from "./Near.ts"
import { OneClick, type QuoteRequest, type QuoteResponse } from "./OneClick.ts"
import { BASE_USDC_ASSET, floatTopUp, quoteProblem, Refill } from "./Refill.ts"
import { fakeBase, fakeBitrefill, fakeNear } from "./testing.ts"
import { NEAR_USDC_ASSET } from "./TopUp.ts"

// The refill pipeline on an in-memory database, with NEAR, our Base wallet, Bitrefill and 1Click faked.
// Refills only run on mainnet. Every test checks where the money went: which transactions the treasury
// signed, and what the Base wallet paid.
process.env.NEAR_NETWORK = "mainnet"

const TREASURY = "treasury.test"
const BITREFILL_ADDRESS = "0x" + "ab".repeat(20)
const WALLET = "0x" + "b5".repeat(20)
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
  /** The network is down when the transfer is about to be signed: nothing is signed or sent. */
  sendDownOnce?: boolean
  /** USDC (base units) and ETH (wei) already in our Base wallet. */
  walletUsdc?: number
  walletEth?: bigint
  /** What Base says about the wallet's payment, each time it's asked. */
  pay?: Array<PaymentStatus>
  /** Base's RPC fails once: when fixing the payment (before anything is signed), or when sending it (after). */
  prepareDownOnce?: boolean
  payDownOnce?: boolean
  /** The contract takes the pull, but its USDC transfer fails (the treasury isn't registered): the proceeds go back. */
  sweepFails?: boolean
  /** False: 1Click reports SUCCESS, but the USDC doesn't show in our wallet. */
  swapLands?: boolean
} = {}) => {
  const s = { usdc: o.treasuryUsdc ?? 0, proceeds: o.proceeds ?? 236_000_000, swept: 0 }
  const made = { invoices: 0, quotes: 0, signs: 0 }
  const wallet = { usdc: o.walletUsdc ?? 0, eth: o.walletEth ?? 10n ** 16n }
  /** What happened, in order: when the invoice is asked for matters. */
  const events: Array<string> = []
  const payments: Array<{ to: string; amount: string }> = []
  const quotes: Array<QuoteRequest> = []
  const payStatus = [...(o.pay ?? ["success"])]
  let swapOut = 0
  let prepareDown = o.prepareDownOnce ?? false
  let payDown = o.payDownOnce ?? false
  /** Times the Base payment was handed to the node, whether or not it answered. */
  let sends = 0
  let down = o.sendDownOnce ?? false
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
        if (down && tx.calls.some((c) => c.method === "ft_transfer")) {
          down = false
          return yield* new NearUnavailable({ message: "access key: RPC unreachable" })
        }
        const hash = `tx-${txs.length + 1}`
        txs.push(tx)
        yield* persist({ hash, bytes: JSON.stringify(tx, (_, v) => (typeof v === "bigint" ? String(v) : v)) })
        if (lost && tx.calls.some((c) => c.method === "ft_transfer")) {
          lost = false
          apply(tx)
          return yield* new NearUnavailable({ message: "send: timed out" })
        }
        if (o.sweepFails && tx.calls.some((c) => c.method === "sweep_proceeds")) {
          return { ...outcome(hash), failures: [`The account ${TREASURY} is not registered`] }
        }
        apply(tx)
        return outcome(hash)
      }),
    resume: (signed) => Effect.sync(() => (resumed.push(signed.hash), outcome(signed.hash))),
    account: () => Effect.succeed({ amount: 10n ** 24n, storageUsage: 0 })
  })
  /** Our Bitrefill credit; a test may lower it to make a refill due. */
  const bitrefillCredit = { balance: o.credit ?? 450_000_000 }
  const bitrefill = fakeBitrefill({
    credit: Effect.sync(() => ({ balance: bitrefillCredit.balance, room: 1_500_000_000 })),
    deposit: (amount) => Effect.sync(() => (made.invoices++, events.push("invoice"), { invoiceId: `inv-${made.invoices}`, address: BITREFILL_ADDRESS, price: amount })),
    depositState: () => Effect.succeed({ state: deposit.shift() ?? "credited", status: "x" })
  })
  const honest = (r: QuoteRequest): QuoteResponse => ({
    correlationId: `quote-${made.quotes}`,
    quote: {
      depositAddress: DEPOSIT_ADDRESS,
      amountIn: String(Math.ceil(Number(r.amount) * 1.005)),
      amountInFormatted: "",
      minAmountIn: String(Math.ceil(Number(r.amount) * 1.0004)),
      amountOut: r.amount,
      minAmountOut: r.amount,
      timeEstimate: 22,
      // Like the real 1Click: the deposit address lives for days; refunds start at the requested deadline.
      deadline: new Date(Date.parse(r.deadline) + 3 * 86_400_000).toISOString()
    },
    quoteRequest: {
      originAsset: r.originAsset,
      destinationAsset: r.destinationAsset,
      recipient: r.recipient,
      swapType: r.swapType,
      amount: r.amount,
      refundTo: r.refundTo,
      // The client always asks for these; 1Click echoes them.
      depositType: "ORIGIN_CHAIN",
      recipientType: "DESTINATION_CHAIN",
      refundType: r.refundType
    }
  })
  const oneClick = OneClick.of({
    tokens: Effect.succeed([]),
    quote: (r) => Effect.sync(() => (made.quotes++, quotes.push(r), swapOut = Number(r.amount), events.push("quote"), (o.quote ?? honest)(r))),
    status: () =>
      Effect.sync(() => {
        const st = swap.shift() ?? "SUCCESS"
        // A finished swap lands in our wallet, once.
        if (st === "SUCCESS" && swapOut && o.swapLands !== false) (wallet.usdc += swapOut, swapOut = 0, events.push("swapped"))
        return st
      }),
    details: () => Effect.die("refills only read the status"),
    submitDeposit: () => Effect.void
  })
  const settled = new Set<string>()
  const statusOf = (hash: string, amount: string, to: string) =>
    Effect.sync(() => {
      const st = payStatus.length > 1 ? payStatus.shift()! : payStatus[0]!
      // A mined payment moves the USDC, once.
      if (st === "success" && !settled.has(hash)) (settled.add(hash), wallet.usdc -= Number(amount), payments.push({ to, amount }), events.push("paid"))
      return st
    })
  const base = fakeBase({
    address: Effect.succeed(WALLET as Hex),
    balances: Effect.sync(() => ({ usdc: wallet.usdc, eth: wallet.eth })),
    prepare: (to, amount) =>
      Effect.suspend(() => {
        if (!prepareDown) return Effect.succeed({ to, amount: String(amount), nonce: 7, maxFeePerGas: "2", maxPriorityFeePerGas: "1" })
        prepareDown = false
        return Effect.fail(new BaseUnavailable({ message: "Base nonce: fetch failed" }))
      }),
    sign: (p) => Effect.sync(() => (made.signs++, { ...p, raw: `0xraw${made.signs}` as Hex, hash: `0xhash${made.signs}` as Hex })),
    send: (p) =>
      Effect.suspend(() => {
        sends++
        if (!payDown) return statusOf(p.hash, p.amount, p.to)
        payDown = false
        return Effect.fail(new BaseUnavailable({ message: "Base send: fetch failed" }))
      }),
    status: () => Effect.sync(() => payStatus[0] ?? "pending")
  })
  const layer = Refill.layer.pipe(
    Layer.provideMerge(Credit.layer),
    Layer.provide(Layer.mergeAll(
      Layer.succeed(Near, near),
      Layer.succeed(Base, base),
      Layer.succeed(Bitrefill, bitrefill),
      Layer.succeed(OneClick, oneClick),
      Layer.succeed(Alerts, Alerts.of({ admin: (t) => Effect.sync(() => void alerts.push(t)), customer: () => Effect.void }))
    )),
    Layer.provideMerge(DbMemory)
  )
  // These tests size refills in tens of dollars: give them testnet-sized limits (mainnet starts at $30).
  const run = <A, E>(e: Effect.Effect<A, E, Refill | Credit | SqlClient.SqlClient>) =>
    Effect.runPromise(Effect.scoped(Effect.andThen(Effect.flatMap(Credit, (c) => c.configure(CREDIT_DEFAULTS.testnet, "test")), e)).pipe(Effect.provide(layer)))
  return { s, made, wallet, events, payments, quotes, txs, resumed, alerts, run, sends: () => sends, bitrefillCredit }
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
    for (let i = 0; i < 8 && ["swapping", "crediting", "quote", "invoice", "pay"].includes(r.step); i++) {
      yield* due
      yield* refill.process
      r = yield* settle(id)
    }
    return r
  })
const methods = (txs: ReadonlyArray<Tx>) => txs.map((t) => t.calls.map((c) => c.method).join("+"))

test("a refill funds the swap first, swaps into our Base wallet, and only then invoices and pays Bitrefill", async () => {
  const w = world({ cap: 100_000_000, treasuryUsdc: 0 })
  const r = await w.run(Effect.gen(function*() {
    const v = yield* Effect.flatMap(Refill, (r) => r.request(30_000_000, "boss.testnet"))
    return yield* drive(v.id)
  }))
  assert.equal(r.step, "done", r.error ?? "")
  assert.deepEqual(methods(w.txs), ["sweep_proceeds", "storage_deposit+ft_transfer"])
  assert.equal(w.txs[0]!.calls[0]!.args.amount, "30300000", "the most a $30 swap may cost (1% over), before any quote")
  const send = w.txs[1]!
  assert.equal(send.receiver, "usdc.test")
  assert.deepEqual(send.calls[1]!.args.receiver_id, DEPOSIT_ADDRESS)
  assert.equal(send.calls[1]!.args.amount, "30150000", "exactly what the quote asked")
  assert.equal(send.calls[1]!.deposit, 1n)
  assert.equal(w.quotes[0]!.recipient, WALLET, "1Click delivers to our wallet, not to Bitrefill")
  assert.deepEqual(w.events, ["quote", "swapped", "invoice", "paid"], "Bitrefill is asked for an invoice only once the USDC is ours")
  assert.deepEqual(w.payments, [{ to: BITREFILL_ADDRESS, amount: "30000000" }], "exactly the invoice, from our wallet")
  assert.equal(w.wallet.usdc, 0)
  assert.equal(w.s.usdc, 150_000, "the treasury keeps only the unused part of the 1%, for the next refill")
  assert.ok(w.alerts.some((a) => a.includes("refilled: +$30.00")))
})

test("a treasury with enough USDC pays without pulling proceeds, under our own refund deadline", async () => {
  const w = world({ treasuryUsdc: 50_000_000 })
  const r = await w.run(Effect.gen(function*() {
    const v = yield* Effect.flatMap(Refill, (r) => r.request(30_000_000, "boss.testnet"))
    const row = yield* drive(v.id)
    const [s] = yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ deadline: string; quote: string }>`SELECT swap->>'deadline' AS deadline, swap->>'correlationId' AS quote FROM refills WHERE id = ${v.id}`)
    return { row, ...s! }
  }))
  assert.equal(r.row.step, "done")
  assert.deepEqual(methods(w.txs), ["storage_deposit+ft_transfer"])
  assert.ok(Date.parse(r.deadline) - Date.now() <= 15 * 60_000, "1Click refunds from our deadline, not the address's three days")
  assert.equal(r.quote, "quote-1", "the quote id is kept for support")
})

test("USDC already in the Base wallet pays Bitrefill straight away, with no swap", async () => {
  const w = world({ walletUsdc: 45_000_000 })
  const r = await w.run(Effect.flatMap(Effect.flatMap(Refill, (r) => r.request(30_000_000, "boss.testnet")), (v) => drive(v.id)))
  assert.equal(r.step, "done", r.error ?? "")
  assert.equal(w.made.quotes, 0)
  assert.deepEqual(w.txs, [], "the treasury signed nothing")
  assert.deepEqual(w.payments, [{ to: BITREFILL_ADDRESS, amount: "30000000" }])
  assert.equal(w.wallet.usdc, 15_000_000)
})

test("a wallet holding part of it swaps only the rest, at least $2", async () => {
  const w = world({ treasuryUsdc: 50_000_000, walletUsdc: 29_500_000 })
  const r = await w.run(Effect.flatMap(Effect.flatMap(Refill, (r) => r.request(30_000_000, "boss.testnet")), (v) => drive(v.id)))
  assert.equal(r.step, "done", r.error ?? "")
  assert.equal(w.quotes[0]!.amount, "2000000", "a $0.50 shortfall is topped up with the $2 minimum")
  assert.deepEqual(w.payments, [{ to: BITREFILL_ADDRESS, amount: "30000000" }])
  assert.equal(w.wallet.usdc, 1_500_000, "the extra waits in the wallet for the next refill")
})

test("a Base wallet out of gas holds the refill before anything is quoted", async () => {
  const w = world({ treasuryUsdc: 50_000_000, walletEth: 0n })
  const r = await w.run(Effect.flatMap(Effect.flatMap(Refill, (r) => r.request(30_000_000, "boss.testnet")), (v) => settle(v.id)))
  assert.equal(r.step, "fund")
  assert.match(r.error ?? "", /ETH for gas/)
  assert.ok(w.alerts.some((a) => a.includes(`The Base wallet ${WALLET} is out of ETH`)))
  assert.deepEqual([w.made.quotes, w.made.invoices, w.txs.length], [0, 0, 0])
})

test("in manual mode the refill waits for the owner, says how much to move, and makes no invoice or quote meanwhile", async () => {
  const w = world({ cap: 0 })
  const r = await w.run(Effect.gen(function*() {
    const refill = yield* Refill
    const v = yield* refill.request(30_000_000, "boss.testnet")
    return { row: yield* settle(v.id), needs: (yield* refill.status).needs }
  }))
  assert.equal(r.row.step, "fund")
  assert.equal(r.needs, 30_300_000)
  assert.deepEqual(w.txs, [], "nothing signed")
  assert.deepEqual(w.made, { invoices: 0, quotes: 0, signs: 0 }, "nothing to go stale while it waits")
})

test("money comes first: once the owner funds the treasury, a fresh quote is paid at once", async () => {
  const w = world({ cap: 0 })
  const r = await w.run(Effect.gen(function*() {
    const refill = yield* Refill
    const v = yield* refill.request(30_000_000, "boss.testnet")
    yield* settle(v.id)
    w.s.usdc = 30_300_000
    yield* due
    yield* refill.process
    return yield* drive(v.id)
  }))
  assert.equal(r.step, "done", r.error ?? "")
  assert.deepEqual(w.made, { invoices: 1, quotes: 1, signs: 1 })
  assert.deepEqual(methods(w.txs), ["storage_deposit+ft_transfer"])
})

test("a quote older than two minutes is thrown away, never paid", async () => {
  const w = world({ treasuryUsdc: 50_000_000, sendDownOnce: true })
  const r = await w.run(Effect.gen(function*() {
    const refill = yield* Refill
    const v = yield* refill.request(30_000_000, "boss.testnet")
    const stalled = yield* settle(v.id)
    // The network stayed down for a while: by the next attempt, the quote has aged.
    yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE refills SET swap = jsonb_set(swap, '{quotedAt}', to_jsonb((now() - interval '3 minutes')::text)) WHERE id = ${v.id}`)
    yield* due
    yield* refill.process
    return { stalled, last: yield* drive(v.id) }
  }))
  assert.equal(r.stalled.step, "send", "nothing was signed while the network was down")
  assert.equal(r.last.step, "done", r.last.error ?? "")
  assert.equal(w.made.quotes, 2, "the stale quote was replaced")
  assert.deepEqual(methods(w.txs), ["storage_deposit+ft_transfer"], "and only the fresh one was paid")
})

test("the Base payment is signed once, and resent as the same bytes when sending fails", async () => {
  const w = world({ walletUsdc: 30_000_000, payDownOnce: true })
  const r = await w.run(Effect.gen(function*() {
    const refill = yield* Refill
    const v = yield* refill.request(30_000_000, "boss.testnet")
    const stalled = yield* settle(v.id)
    yield* due
    yield* refill.process
    return { stalled, last: yield* drive(v.id) }
  }))
  assert.equal(r.stalled.step, "pay")
  assert.equal(r.last.step, "done", r.last.error ?? "")
  assert.equal(w.made.signs, 1, "never signed twice")
  assert.deepEqual(w.payments, [{ to: BITREFILL_ADDRESS, amount: "30000000" }], "and paid once")
})

test("an invoice that got old before anything was signed is replaced, never paid", async () => {
  const w = world({ walletUsdc: 30_000_000, prepareDownOnce: true })
  const r = await w.run(Effect.gen(function*() {
    const refill = yield* Refill
    const v = yield* refill.request(30_000_000, "boss.testnet")
    yield* settle(v.id)
    yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE refills SET invoice_at = now() - interval '45 minutes' WHERE id = ${v.id}`)
    yield* due
    yield* refill.process
    const [row] = yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ invoice_id: string }>`SELECT invoice_id FROM refills WHERE id = ${v.id}`)
    return { last: yield* drive(v.id), invoice: row!.invoice_id }
  }))
  assert.equal(r.last.step, "done", r.last.error ?? "")
  assert.equal(w.made.invoices, 2, "a fresh invoice")
  assert.equal(w.made.signs, 1)
  assert.deepEqual(w.payments, [{ to: BITREFILL_ADDRESS, amount: "30000000" }])
})

test("a payment not confirmed before its invoice nearly expires is never sent again, and may have gone out", async () => {
  const w = world({ walletUsdc: 30_000_000, payDownOnce: true, pay: ["pending"] })
  const r = await w.run(Effect.gen(function*() {
    const refill = yield* Refill
    const sql = yield* SqlClient.SqlClient
    const v = yield* refill.request(30_000_000, "boss.testnet")
    yield* settle(v.id)
    // The node may have taken that first send before the connection dropped: it counts as sent.
    const [first] = yield* sql<{ paid: boolean }>`SELECT paid_at IS NOT NULL AS paid FROM refills WHERE id = ${v.id}`
    // Base stayed unreachable until the invoice was 55 minutes old.
    yield* sql`UPDATE refills SET invoice_at = now() - interval '55 minutes' WHERE id = ${v.id}`
    yield* due
    yield* refill.process
    return { paid: first!.paid, last: yield* settle(v.id) }
  }))
  assert.equal(r.paid, true, "the first send was saved before it went out")
  assert.equal(r.last.step, "stuck")
  assert.match(r.last.error ?? "", /may have been sent: check 0xhash1 on basescan/)
  assert.equal(w.sends(), 1, "the signed bytes weren't sent again")
  assert.deepEqual(w.payments, [])
  assert.equal(w.wallet.usdc, 30_000_000)
})

test("a reverted Base payment fails the refill and leaves the USDC in the wallet", async () => {
  const w = world({ walletUsdc: 30_000_000, pay: ["reverted"] })
  const r = await w.run(Effect.flatMap(Effect.flatMap(Refill, (r) => r.request(30_000_000, "boss.testnet")), (v) => drive(v.id)))
  assert.equal(r.step, "failed")
  assert.match(r.error ?? "", /still in the Base wallet/)
  assert.equal(w.wallet.usdc, 30_000_000)
  assert.deepEqual(w.payments, [])
})

/** A refill whose swap 1Click leaves hanging past our deadline, so it's stuck. */
const stuckRefill = Effect.gen(function*() {
  const refill = yield* Refill
  const sql = yield* SqlClient.SqlClient
  const v = yield* refill.request(30_000_000, "boss.testnet")
  yield* settle(v.id)
  yield* sql`UPDATE refills SET swap = jsonb_set(swap, '{deadline}', '"2020-01-01T00:00:00.000Z"') WHERE id = ${v.id}`
  yield* due
  yield* refill.process
  return { id: v.id, stuck: yield* settle(v.id) }
})
/** Lets the stuck-refill check run once more, then reads where the refill is. */
const checkAgain = (id: string) =>
  Effect.gen(function*() {
    const refill = yield* Refill
    yield* due
    yield* refill.process
    const [row] = yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ step: string; swap_status: string | null }>`SELECT step, swap_status FROM refills WHERE id = ${id}`)
    return { ...row!, paused: (yield* refill.status).paused }
  })

test("a stuck swap says what to ask support for, and closes itself when 1Click refunds it later", async () => {
  const w = world({ treasuryUsdc: 50_000_000, swap: ["PROCESSING", "PROCESSING", "REFUNDED"] })
  const r = await w.run(Effect.gen(function*() {
    const s = yield* stuckRefill
    return { stuck: s.stuck, after: yield* checkAgain(s.id) }
  }))
  assert.equal(r.stuck.step, "stuck")
  const alert = w.alerts.find((a) => a.includes("needs a look")) ?? ""
  assert.match(alert, new RegExp(`explorer\\.near-intents\\.org/transactions/${DEPOSIT_ADDRESS}`))
  assert.match(alert, /deposit tx tx-1, quote quote-1/)
  assert.match(alert, /finish it or refund it to treasury\.test: either is safe/)
  assert.equal(r.after.step, "refunded")
  assert.ok(w.alerts.some((a) => a.includes("has refunded the swap")))
  assert.ok(!r.after.paused?.includes("stuck"), "refills are no longer held up by it")
})

test("a stuck swap that 1Click finishes late lands in our wallet, and the refill carries on to Bitrefill", async () => {
  const w = world({ treasuryUsdc: 50_000_000, swap: ["PROCESSING", "PROCESSING", "SUCCESS"] })
  const r = await w.run(Effect.gen(function*() {
    const s = yield* stuckRefill
    const after = yield* checkAgain(s.id)
    return { after, last: yield* drive(s.id) }
  }))
  assert.equal(r.after.step, "invoice", "it carries on by itself")
  assert.ok(w.alerts.some((a) => a.includes("finished the swap late, into our Base wallet")))
  assert.equal(r.last.step, "done", r.last.error ?? "")
  assert.deepEqual(w.events, ["quote", "swapped", "invoice", "paid"], "the invoice still comes only after the USDC")
})

test("a quote that pays anyone but our Base wallet is refused, and nothing is sent", async () => {
  const w = world({
    treasuryUsdc: 50_000_000,
    quote: (r) => {
      const q = { quote: { depositAddress: DEPOSIT_ADDRESS, amountIn: r.amount, amountInFormatted: "", amountOut: r.amount, timeEstimate: 1, deadline: r.deadline } }
      return { ...q, quoteRequest: { originAsset: r.originAsset, destinationAsset: r.destinationAsset, recipient: "0x" + "ee".repeat(20), swapType: r.swapType, amount: r.amount, refundTo: r.refundTo, depositType: "ORIGIN_CHAIN", recipientType: "DESTINATION_CHAIN", refundType: "ORIGIN_CHAIN" } }
    }
  })
  const r = await w.run(Effect.flatMap(Effect.flatMap(Refill, (r) => r.request(30_000_000, "boss.testnet")), (v) => settle(v.id)))
  assert.equal(r.step, "failed")
  assert.match(r.error ?? "", /not our Base wallet/)
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
  assert.equal(refunded.made.invoices, 0, "Bitrefill was never involved")

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

test("a contract pointing at another treasury is never funded, and nothing is invoiced or quoted", async () => {
  const w = world({ contractTreasury: "someone-else.test" })
  const r = await w.run(Effect.flatMap(Effect.flatMap(Refill, (r) => r.request(30_000_000, "boss.testnet")), (v) => settle(v.id)))
  assert.equal(r.step, "fund")
  assert.match(r.error ?? "", /someone-else\.test/)
  assert.deepEqual(w.txs, [])
  assert.deepEqual(w.made, { invoices: 0, quotes: 0, signs: 0 })
})

test("the daily cap and the proceeds bound what the treasury pulls", async () => {
  const w = world({ cap: 20_000_000 })
  const r = await w.run(Effect.flatMap(Effect.flatMap(Refill, (r) => r.request(30_000_000, "boss.testnet")), (v) => settle(v.id)))
  assert.equal(r.step, "fund")
  assert.match(r.error ?? "", /Today's cap allows \$20\.00 more \(\$0\.00 of \$20\.00 used\)/)
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
      depositType: "ORIGIN_CHAIN",
      recipientType: "DESTINATION_CHAIN",
      refundType: "ORIGIN_CHAIN",
      ...echo
    }
  })
  assert.equal(quoteProblem(base(), want), undefined)
  assert.match(quoteProblem(base({ minAmountOut: "29900000" }), want) ?? "", /not exactly/)
  assert.match(quoteProblem(base({ amountIn: "30400000" }), want) ?? "", /over the 1% limit/)
  assert.match(quoteProblem(base({}, { refundTo: "attacker.near" }), want) ?? "", /refunds to/)
  assert.match(quoteProblem(base({}, { destinationAsset: "nep141:eth-usdc" }), want) ?? "", /wrong assets/)
  assert.match(quoteProblem(base({}, { recipientType: "INTENTS" }), want) ?? "", /doesn't deliver on Base/)
  assert.match(quoteProblem(base({}, { refundType: "INTENTS" }), want) ?? "", /inside NEAR Intents/)
  assert.match(quoteProblem(base({}, { depositType: undefined }), want) ?? "", /inside NEAR Intents/)
  assert.match(quoteProblem(base({ depositAddress: "Not A NEAR Account!" }), want) ?? "", /deposit address/)
  assert.match(quoteProblem(base({ deadline: new Date(Date.now() + 60_000).toISOString() }), want) ?? "", /deadline/)
  assert.match(quoteProblem({ quote: base().quote }, want) ?? "", /didn't echo/)
})

test("mainnet keeps idle credit between $10 and $30, refills up to $300 a day, and lets a purchase wait up to a day", () => {
  const m = CREDIT_DEFAULTS.mainnet
  assert.deepEqual([m.floor, m.ceiling, m.dailyRefill, m.waitMinutes], [10_000_000, 30_000_000, 300_000_000, 1440])
})

test("the refill line never sits below the biggest card bought lately, so cards of the usual size buy at once", () => {
  const s = { floor: 10_000_000, ceiling: 30_000_000 }
  assert.deepEqual(levels(s, 0, 0), { target: 10_000_000, refillBelow: 5_000_000 }, "no sales yet: the floor")
  assert.deepEqual(levels(s, 0, 15_000_000), { target: 25_000_000, refillBelow: 15_000_000 }, "a $15 card: kept between $15 and $25")
  assert.deepEqual(levels(s, 0, 50_000_000), { target: 30_000_000, refillBelow: 20_000_000 }, "a $50 card: idle credit still stops at the ceiling")
  assert.deepEqual(levels(s, 20_000_000, 5_000_000), { target: 30_000_000, refillBelow: 15_000_000 }, "busy days: two days of sales, up to the ceiling")
})

test("a refill for purchases already waiting may go past the ceiling: that credit is spent within minutes", async () => {
  const w = world({ credit: 450_000_000, treasuryUsdc: 1_000_000_000 })
  const v = await w.run(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO purchases (account_id, idempotency_key, voucher_id, voucher_name, package_value, reference_price, max_debit, step)
               VALUES ('big.test', 'k1', 'amazon-us', 'Amazon', '600', 600000000, 600000000, 'waiting')`
    yield* Effect.flatMap(Credit, (c) => c.refresh)
    return yield* Effect.flatMap(Refill, (r) => r.request(undefined, "boss.testnet"))
  }))
  // Target $100 + the waiting $600 − $450 free; before, the $500 ceiling allowed only $50.
  assert.equal(v.amount, 250_000_000)
})

test("pulls nearing the daily cap say so, with a cap to raise it to", async () => {
  const w = world({ cap: 35_000_000, treasuryUsdc: 0 })
  const r = await w.run(Effect.flatMap(Effect.flatMap(Refill, (r) => r.request(30_000_000, "boss.testnet")), (v) => drive(v.id)))
  assert.equal(r.step, "done", r.error ?? "")
  assert.ok(w.alerts.some((a) => /reached \$30\.30 of the \$35\.00 daily cap.*say to \$100\.00/.test(a)), w.alerts.join("\n"))
})


// ---------- audit fixes ----------

test("a pull whose transfer fails stops for an admin: nothing is quoted, and it isn't pulled again", async () => {
  const w = world({ cap: 100_000_000, treasuryUsdc: 0, sweepFails: true })
  const r = await w.run(Effect.gen(function*() {
    const refill = yield* Refill
    const v = yield* refill.request(30_000_000, "boss.testnet")
    const row = yield* settle(v.id)
    yield* due
    yield* refill.process
    return { row, again: yield* settle(v.id), paused: (yield* refill.status).paused }
  }))
  assert.equal(r.row.step, "stuck")
  assert.match(r.row.error ?? "", /didn't arrive and the contract put the proceeds back \(The account treasury\.test is not registered\)\. Is the treasury registered on USDC\?/)
  assert.equal(r.again.step, "stuck")
  assert.deepEqual(methods(w.txs), ["sweep_proceeds"], "pulled once, not again and again")
  assert.ok(r.paused, "automatic refills pause until an admin resolves it")
  assert.ok(!w.alerts.some((a) => a.includes("Treasury pulled")), "never announced as pulled")
  assert.equal(w.alerts.filter((a) => a.includes("registered on USDC")).length, 1)
  assert.deepEqual(w.made, { invoices: 0, quotes: 0, signs: 0 })
})

test("a refill stuck because the wallet came up short at the invoice stays stuck for an admin, without flapping", async () => {
  const w = world({ treasuryUsdc: 50_000_000, swapLands: false })
  const r = await w.run(Effect.gen(function*() {
    const refill = yield* Refill
    const sql = yield* SqlClient.SqlClient
    const v = yield* refill.request(30_000_000, "boss.testnet")
    yield* settle(v.id)
    yield* due
    yield* refill.process
    const atInvoice = yield* settle(v.id)
    // 1Click said SUCCESS ten minutes ago, and the wallet still doesn't show it.
    yield* sql`UPDATE refills SET updated_at = now() - interval '11 minutes' WHERE id = ${v.id}`
    yield* due
    yield* refill.process
    const stuck = yield* settle(v.id)
    const after = [yield* checkAgain(v.id)]
    // Even once the USDC shows up, a refill stuck at the invoice waits for an admin.
    w.wallet.usdc = 30_000_000
    after.push(yield* checkAgain(v.id))
    const [row] = yield* sql<{ error: string; stuck_at: string }>`SELECT error, stuck_at FROM refills WHERE id = ${v.id}`
    yield* refill.resolve(v.id, "Topped up on bitrefill.com by hand", "boss.testnet")
    return { atInvoice, stuck, after, row: row!, paused: (yield* refill.status).paused }
  }))
  assert.equal(r.atInvoice.step, "invoice")
  assert.equal(r.stuck.step, "stuck")
  assert.equal(r.row.stuck_at, "invoice")
  assert.deepEqual(r.after.map((a) => a.step), ["stuck", "stuck"], "not sent back to the invoice by 1Click's SUCCESS")
  assert.equal(r.row.error, r.stuck.error, "and nothing appended on each pass")
  assert.ok(!r.paused?.includes("stuck"), "an admin could resolve it")
  assert.equal(w.made.invoices, 0)
})

test("a stuck swap 1Click reports finished carries on only once the USDC is in our wallet", async () => {
  const w = world({ treasuryUsdc: 50_000_000, swap: ["PROCESSING", "PROCESSING", "SUCCESS", "SUCCESS"], swapLands: false })
  const r = await w.run(Effect.gen(function*() {
    const s = yield* stuckRefill
    const notYet = yield* checkAgain(s.id)
    w.wallet.usdc = 30_000_000
    const landed = yield* checkAgain(s.id)
    return { notYet, landed, last: yield* drive(s.id) }
  }))
  assert.equal(r.notYet.step, "stuck", "1Click says done, but the wallet doesn't show it yet")
  assert.equal(r.landed.step, "invoice")
  assert.equal(r.last.step, "done", r.last.error ?? "")
  assert.deepEqual(w.payments, [{ to: BITREFILL_ADDRESS, amount: "30000000" }])
})

test("a shutdown waits for the refill step in progress", async () => {
  const w = world({ treasuryUsdc: 50_000_000 })
  // The scope closes as soon as the request returns, while the refill it started is still running.
  await w.run(Effect.flatMap(Refill, (r) => r.request(30_000_000, "boss.testnet")))
  assert.deepEqual(methods(w.txs), ["storage_deposit+ft_transfer"], "it ran on to the swap and saved it, rather than being cut off")
})

test("with a Base float, a refill pays Bitrefill from it at once, and the float is topped back up in the background", async () => {
  // Credit above the refill line, so only the refill asked for and the float's own top-up run.
  const w = world({ walletUsdc: 40_000_000, treasuryUsdc: 50_000_000 })
  const r = await w.run(Effect.gen(function*() {
    const credit = yield* Credit
    const refill = yield* Refill
    const sql = yield* SqlClient.SqlClient
    yield* credit.configure(new CreditSettings({ ...(yield* credit.settings), baseFloat: 40_000_000 }), "boss.testnet")
    const paid = yield* drive((yield* refill.request(30_000_000, "boss.testnet")).id)
    const quotesBefore = w.made.quotes
    // The next plan sees the wallet under half the float, with no refill due: it tops the float up.
    yield* refill.kick
    yield* Effect.sleep("100 millis")
    const [top] = yield* sql<{ id: string; amount: string }>`SELECT id, amount::text FROM refills WHERE reason = 'float'`
    const topped = yield* drive(top!.id)
    const [others] = yield* sql<{ n: number }>`SELECT count(*)::int AS n FROM refills WHERE reason <> 'float'`
    return { paid, quotesBefore, top: top!, topped, refills: others!.n }
  }))
  assert.equal(r.paid.step, "done", r.paid.error ?? "")
  assert.equal(r.quotesBefore, 0, "Bitrefill was paid from the float, with no swap to wait for")
  assert.equal(r.top.amount, "30000000", "exactly what brings the wallet back to the float")
  assert.equal(r.topped.step, "done", r.topped.error ?? "")
  assert.equal(w.quotes[0]!.recipient, WALLET)
  assert.equal(w.quotes[0]!.amount, "30000000")
  assert.deepEqual(w.payments, [{ to: BITREFILL_ADDRESS, amount: "30000000" }], "the top-up never pays Bitrefill")
  assert.equal(w.wallet.usdc, 40_000_000, "the float is whole again")
  assert.equal(r.refills, 1)
  assert.ok(w.alerts.some((a) => a.includes("The Base float was topped up by $30.00")))
})

test("a float top-up waiting for money waits quietly, and gives way the moment a real refill is due", async () => {
  // No proceeds and an empty treasury: the top-up can only wait.
  const w = world({ walletUsdc: 0, treasuryUsdc: 0, proceeds: 0 })
  const r = await w.run(Effect.gen(function*() {
    const credit = yield* Credit
    const refill = yield* Refill
    const sql = yield* SqlClient.SqlClient
    yield* credit.configure(new CreditSettings({ ...(yield* credit.settings), baseFloat: 40_000_000 }), "boss.testnet")
    yield* refill.kick
    yield* Effect.sleep("100 millis")
    const [waiting] = yield* sql<{ id: string; step: string }>`SELECT id, step FROM refills WHERE reason = 'float'`
    const quiet = [...w.alerts]
    // Bitrefill credit drops under the refill line: a real refill is due.
    w.bitrefillCredit.balance = 0
    yield* refill.kick
    yield* Effect.sleep("100 millis")
    const rows = yield* sql<{ reason: string; step: string; error: string | null }>`SELECT reason, step, error FROM refills ORDER BY created_at`
    return { waiting: waiting!, rows, quiet }
  }))
  assert.equal(r.waiting.step, "fund", "it waits for money")
  assert.ok(!r.quiet.some((a) => a.includes("more in the treasury")), "quietly: a float is never urgent")
  assert.equal(r.rows[0]!.reason, "float")
  assert.equal(r.rows[0]!.step, "cancelled")
  assert.match(r.rows[0]!.error ?? "", /Gave way to a Bitrefill refill/)
  assert.equal(r.rows[1]!.reason, "target", "the real refill took its place")
  assert.equal(w.txs.length, 0, "nothing was signed for the top-up")
})

test("the float is topped up only once the wallet holds under half of it, and with a float the credit target is one day of sales", () => {
  assert.equal(floatTopUp(0, 0), 0, "no float, no top-up")
  assert.equal(floatTopUp(50_000_000, 30_000_000), 0, "over half: nothing yet")
  assert.equal(floatTopUp(50_000_000, 20_000_000), 30_000_000)
  assert.equal(floatTopUp(50_000_000, 49_000_000), 0)
  const s = { floor: 10_000_000, ceiling: 300_000_000 }
  assert.equal(levels(s, 40_000_000, 0).target, 80_000_000, "two days without a float")
  assert.equal(levels({ ...s, baseFloat: 50_000_000 }, 40_000_000, 0).target, 40_000_000, "one day with one")
  assert.equal(CREDIT_DEFAULTS.mainnet.baseFloat, 50_000_000)
  assert.equal(CREDIT_DEFAULTS.testnet.baseFloat, 0, "refills, and so the float, don't run on testnet")
})
