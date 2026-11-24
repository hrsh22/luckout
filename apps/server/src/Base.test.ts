import { Clock, ConfigProvider, Deferred, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { baseEncode } from "near-api-js"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { decodeFunctionData, erc20Abi, type Hex, parseTransaction, recoverTransactionAddress } from "viem"
import { privateKeyToAccount, sign } from "viem/accounts"
import { Alerts } from "./Alerts.ts"
import { Base, BASE_USDC, GAS_RESERVE, type SignedPayment } from "./Base.ts"
import { Near, type Outcome } from "./Near.ts"
import { fakeNear } from "./testing.ts"

// The Base Wallet (Base.ts) against a Base node faked over JSON-RPC, with NEAR's MPC network played by a
// throwaway key. Nothing here touches a real chain.

/** Stands in for the key NEAR's MPC network holds for the treasury. Not a real key. */
const MPC_KEY: Hex = `0x${"11".repeat(32)}`
const wallet = privateKeyToAccount(MPC_KEY)
const BITREFILL: Hex = "0x1306efa7dc204B6e995AeD34ADBC24C9889c7f4F"

const receipt = (hash: string, ok = true) => ({
  transactionHash: hash,
  status: ok ? "0x1" : "0x0",
  blockHash: `0x${"ab".repeat(32)}`,
  blockNumber: "0x10",
  transactionIndex: "0x0",
  from: wallet.address,
  to: BASE_USDC.mainnet,
  contractAddress: null,
  cumulativeGasUsed: "0xea60",
  gasUsed: "0xea60",
  effectiveGasPrice: "0x1",
  logs: [],
  logsBloom: `0x${"00".repeat(256)}`,
  type: "0x2"
})

/** What the faked node answers; a test changes it as its story goes. */
interface Chain {
  /** The wallet's next nonce counting transactions still waiting, and counting only mined ones. */
  pending: number
  latest: number
  /** The node's answer to a send: an error message, or nothing to accept it. */
  sendError?: string
  /** The receipt for a hash, on the nth time it's asked for (from 1); undefined is "no such receipt". */
  receipt: (hash: string, asked: number) => ReturnType<typeof receipt> | undefined
  /** Any request is answered with this HTTP status instead. */
  http?: number
  /** The latest block's base fee (wei): 1 gwei unless a test says otherwise. */
  baseFee?: bigint
  /** Whether the node knows a transaction by its hash (waiting, or mined); unknown when left out. */
  known?: (hash: string) => boolean
}

const world = async <A>(
  chain: Chain,
  body: (w: { sent: Array<Hex>; signed: () => number; log: Array<string>; alerts: Array<string> }) => Effect.Effect<A, unknown, Base>,
  /** How delivering an admin alert behaves before it's recorded (Telegram can be slow); at once when left out. */
  deliver: Effect.Effect<void> = Effect.void
) => {
  const sent: Array<Hex> = []
  const log: Array<string> = []
  const alerts: Array<string> = []
  const asked = new Map<string, number>()
  let signed = 0
  const answer = (method: string, params: Array<unknown>): unknown => {
    switch (method) {
      case "eth_chainId":
        return "0x2105"
      case "eth_getTransactionCount":
        return `0x${(params[1] === "pending" ? chain.pending : chain.latest).toString(16)}`
      case "eth_getBlockByNumber":
        return { number: "0x10", hash: `0x${"ab".repeat(32)}`, baseFeePerGas: `0x${(chain.baseFee ?? 1_000_000_000n).toString(16)}`, timestamp: "0x1", gasLimit: "0x1", gasUsed: "0x0", transactions: [] }
      case "eth_maxPriorityFeePerGas":
        return "0x1"
      case "eth_sendRawTransaction": {
        log.push("send")
        sent.push(params[0] as Hex)
        if (chain.sendError) throw new Error(chain.sendError)
        return `0x${"00".repeat(32)}`
      }
      case "eth_getTransactionReceipt": {
        const hash = params[0] as string
        asked.set(hash, (asked.get(hash) ?? 0) + 1)
        return chain.receipt(hash, asked.get(hash)!) ?? null
      }
      case "eth_getTransactionByHash": {
        const hash = params[0] as string
        return chain.known?.(hash)
          ? { hash, nonce: "0x7", from: wallet.address, to: BASE_USDC.mainnet, input: "0x", value: "0x0", gas: "0x186a0", type: "0x2", blockHash: null, blockNumber: null }
          : null
      }
      default:
        throw new Error(`the faked Base node wasn't expecting ${method}`)
    }
  }
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      if (chain.http) return void res.writeHead(chain.http, { "content-type": "text/plain" }).end("Not Found")
      const { id, method, params } = JSON.parse(raw)
      res.writeHead(200, { "content-type": "application/json" })
      try {
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: answer(method, params) }))
      } catch (e) {
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: (e as Error).message } }))
      }
    })
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const near = fakeNear({
    treasuryId: "treasury.test",
    // "secp256k1:<base58 of the 64-byte uncompressed key>", as v1.signer's derived_public_key answers.
    view: <A>() => Effect.succeed(`secp256k1:${baseEncode(Buffer.from(wallet.publicKey.slice(4), "hex"))}` as A),
    // v1.signer's sign: the digest comes in the function call's arguments, the signature goes back as the value.
    treasurySend: (_receiver, actions) =>
      Effect.promise(async (): Promise<Outcome> => {
        signed++
        const args = JSON.parse(Buffer.from(actions[0]!.functionCall!.args).toString())
        const s = await sign({ hash: `0x${args.request.payload_v2.Ecdsa}`, privateKey: MPC_KEY })
        return { hash: "near-tx", value: { big_r: { affine_point: `02${s.r.slice(2)}` }, s: { scalar: s.s.slice(2) }, recovery_id: s.yParity }, events: [], failures: [] }
      })
  })
  const layer = Base.layer.pipe(
    Layer.provide(Layer.succeed(Near, near)),
    Layer.provide(Layer.succeed(Alerts, Alerts.of({ admin: (t) => Effect.andThen(deliver, Effect.sync(() => void alerts.push(t))), customer: () => Effect.succeed(true) }))),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({
      env: { NEAR_NETWORK: "mainnet", BASE_RPC_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
    })))
  )
  try {
    return await Effect.runPromise(body({ sent, signed: () => signed, log, alerts }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())))
  } finally {
    server.close()
    server.closeAllConnections()
  }
}

/** Runs `e` while moving the test clock on, 2 seconds at a time, until it finishes: its waits cost no real time. */
const overTime = <A, E, R>(e: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(e)
    for (let i = 0; i < 200 && fiber.pollUnsafe() === undefined; i++) {
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 10)))
      yield* TestClock.adjust("2 seconds")
    }
    return yield* Fiber.join(fiber)
  })

/** For payments whose invoice isn't near expiry. */
const NO_DEADLINE = Number.POSITIVE_INFINITY

/** A payment signed earlier with `nonce`, as a purchase would have saved it. */
const savedPayment = (nonce: number) =>
  Base.use((b) => Effect.flatMap(b.sign({ to: BITREFILL, amount: "10000000", nonce, maxFeePerGas: "2000000000", maxPriorityFeePerGas: "1" }), (p) => Effect.succeed(p as SignedPayment)))

test("a new payment is the wallet's own USDC transfer, saved before it is sent, and reported once mined", async () => {
  const r = await world({ pending: 7, latest: 7, receipt: (hash) => receipt(hash) }, (w) =>
    Effect.gen(function*() {
      const saved: Array<SignedPayment> = []
      const status = yield* overTime(Base.use((b) => b.pay(BITREFILL, 10_000_000, null, (p) => Effect.sync(() => void (w.log.push("save"), saved.push(p))), NO_DEADLINE)))
      return { status, saved, sent: w.sent, log: w.log }
    }))
  assert.equal(r.status, "success")
  assert.deepEqual(r.log, ["save", "send"], "saved before anything reaches the chain")
  assert.equal(r.sent[0], r.saved[0]!.raw, "what was saved is what was sent")
  const tx = parseTransaction(r.sent[0]!)
  assert.equal(tx.nonce, 7)
  assert.equal(tx.to?.toLowerCase(), BASE_USDC.mainnet.toLowerCase(), "a call to USDC, not a transfer of ETH")
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: tx.data! }).args, [BITREFILL, 10_000_000n])
  assert.equal(await recoverTransactionAddress({ serializedTransaction: r.sent[0] as `0x02${string}` }), wallet.address, "signed by the wallet")
})

test("a payment may pay far more per gas than today's fee, so a fee spike can't leave it unmined; one signed mid-spike keeps twice the estimate", async () => {
  const fees = (baseFee: bigint) =>
    world({ pending: 7, latest: 7, baseFee, receipt: (hash) => receipt(hash) }, (w) =>
      Effect.map(overTime(Base.use((b) => b.pay(BITREFILL, 10_000_000, null, () => Effect.void, NO_DEADLINE))), () => parseTransaction(w.sent[0]!)))
  // Base's minimum base fee, 0.005 gwei: the ceiling is 0.5 gwei, at no cost (only the base fee and the tip are paid).
  const quiet = await fees(5_000_000n)
  assert.equal(quiet.maxFeePerGas, 500_000_000n)
  assert.equal(quiet.maxPriorityFeePerGas, 1n, "the tip is today's")
  // Already at 1 gwei: twice viem's estimate (1.2 × the base fee, plus the tip), above the ceiling.
  assert.equal((await fees(1_000_000_000n)).maxFeePerGas, 2_400_000_002n)
  // The node takes a payment only from a wallet holding its gas limit at that ceiling: 0.00005 ETH.
  assert.equal(GAS_RESERVE, 50_000_000_000_000n)
})

test("a saved payment is sent again as the same bytes and never signed again while its nonce is still its own", async () => {
  // The node already has it ("already known"); its receipt shows up on the third look.
  const chain: Chain = { pending: 8, latest: 7, sendError: "already known", receipt: (hash, asked) => (asked >= 3 ? receipt(hash) : undefined) }
  const r = await world(chain, (w) =>
    Effect.gen(function*() {
      const saved = yield* savedPayment(7)
      const before = w.signed()
      const status = yield* overTime(Base.use((b) => b.pay(BITREFILL, 10_000_000, saved, () => Effect.die("a saved payment must not be saved over"), NO_DEADLINE)))
      return { status, resigned: w.signed() - before, sent: w.sent, raw: saved.raw }
    }))
  assert.equal(r.status, "success")
  assert.equal(r.resigned, 0)
  assert.deepEqual(r.sent, [r.raw])
})

test("a payment mined but reverted is reported as reverted, not as paid", async () => {
  const r = await world({ pending: 8, latest: 8, sendError: "nonce too low", receipt: (hash) => receipt(hash, false) }, () =>
    Effect.gen(function*() {
      const saved = yield* savedPayment(7)
      return yield* overTime(Base.use((b) => b.pay(BITREFILL, 10_000_000, saved, () => Effect.die("not expected"), NO_DEADLINE)))
    }))
  assert.equal(r, "reverted")
})

test("only the node saying there is no receipt means not mined; a failing node says nothing about the payment", async () => {
  const hash: Hex = `0x${"cd".repeat(32)}`
  const absent = await world({ pending: 0, latest: 0, receipt: () => undefined }, () => Base.use((b) => b.status(hash)))
  assert.equal(absent, "pending")
  // The provider answers 404 Not Found: that is an outage, not "this transaction was not found".
  const down = await world({ pending: 0, latest: 0, receipt: () => undefined, http: 404 }, () => Base.use((b) => b.status(hash)).pipe(Effect.flip))
  assert.equal((down as { _tag?: string })._tag, "BaseUnavailable")
})

test("a saved payment is replaced only when its nonce was taken, its receipt stays absent for half a minute, and the node doesn't know it", async () => {
  // Another transaction of the wallet's took nonce 7 (latest is 8), and the saved payment never gets a receipt.
  const lost: Chain = { pending: 8, latest: 8, sendError: "nonce too low", receipt: (_hash, _asked) => undefined, known: () => false }
  const r = await world(lost, (w) =>
    Effect.gen(function*() {
      const saved = yield* savedPayment(7)
      // The replacement is mined at once.
      lost.receipt = (hash) => (hash === saved.hash ? undefined : receipt(hash))
      const replaced: Array<SignedPayment> = []
      const status = yield* overTime(Base.use((b) => b.pay(BITREFILL, 10_000_000, saved, (p) => Effect.sync(() => void replaced.push(p)), NO_DEADLINE)))
      return { status, replaced, sent: w.sent, old: saved, alerts: w.alerts }
    }))
  assert.equal(r.status, "success")
  assert.equal(r.replaced.length, 1, "one new payment was signed and saved")
  assert.equal(r.replaced[0]!.nonce, 8, "on a fresh nonce")
  assert.notEqual(r.replaced[0]!.hash, r.old.hash)
  assert.deepEqual(r.sent, [r.old.raw, r.replaced[0]!.raw])
  assert.equal(r.alerts.length, 1, "an admin hears of every payment signed again")
  assert.ok(r.alerts[0]!.includes(r.old.hash) && r.alerts[0]!.includes(r.replaced[0]!.hash), r.alerts[0])

  // The same, but the node still knows the saved payment by its hash (mined, its receipt not indexed yet): it
  // isn't lost, and paying again would pay the invoice twice.
  const indexing: Chain = { pending: 8, latest: 8, sendError: "nonce too low", receipt: () => undefined, known: () => false }
  const k = await world(indexing, (w) =>
    Effect.gen(function*() {
      const saved = yield* savedPayment(7)
      indexing.known = (hash) => hash === saved.hash
      const before = w.signed()
      const status = yield* overTime(Base.use((b) => b.pay(BITREFILL, 10_000_000, saved, () => Effect.die("must not sign a second payment"), NO_DEADLINE)))
      return { status, resigned: w.signed() - before, sent: w.sent.length, alerts: w.alerts }
    }))
  assert.deepEqual(k, { status: "pending", resigned: 0, sent: 1, alerts: [] })

  // The same, but the node is only slow to show the receipt (it appears on the sixth look, about 10 seconds
  // in): the payment was ours all along, and paying again would pay the invoice twice.
  const slow: Chain = { pending: 8, latest: 8, sendError: "nonce too low", receipt: (hash, asked) => (asked >= 6 ? receipt(hash) : undefined) }
  const s = await world(slow, (w) =>
    Effect.gen(function*() {
      const saved = yield* savedPayment(7)
      const before = w.signed()
      const status = yield* overTime(Base.use((b) => b.pay(BITREFILL, 10_000_000, saved, () => Effect.die("must not sign a second payment"), NO_DEADLINE)))
      return { status, resigned: w.signed() - before, sent: w.sent.length }
    }))
  assert.equal(s.status, "success")
  assert.equal(s.resigned, 0)
  assert.equal(s.sent, 1)
})

test("a slow alert about a payment signed again never holds the wallet: the next payment goes out meanwhile", async () => {
  // Telegram doesn't answer until the test lets it.
  const telegram = Deferred.makeUnsafe<void>()
  let alerting = false
  const lost: Chain = { pending: 8, latest: 8, sendError: "nonce too low", receipt: () => undefined, known: () => false }
  const r = await world(lost, (w) =>
    Effect.gen(function*() {
      const saved = yield* savedPayment(7)
      lost.receipt = (hash) => (hash === saved.hash ? undefined : receipt(hash))
      const again = yield* Effect.forkChild(Base.use((b) => b.pay(BITREFILL, 10_000_000, saved, () => Effect.void, NO_DEADLINE)))
      // The saved payment is watched for half a minute before it's signed again and the admin told.
      for (let i = 0; i < 200 && !alerting; i++) {
        yield* Effect.promise(() => new Promise((done) => setTimeout(done, 10)))
        yield* TestClock.adjust("2 seconds")
      }
      // Another purchase pays while that alert is still on its way.
      const next = yield* Effect.forkChild(Base.use((b) => b.pay(BITREFILL, 5_000_000, null, () => Effect.void, NO_DEADLINE)))
      for (let i = 0; i < 100 && next.pollUnsafe() === undefined; i++) yield* Effect.promise(() => new Promise((done) => setTimeout(done, 10)))
      const nextDone = next.pollUnsafe() !== undefined
      yield* Deferred.succeed(telegram, undefined)
      return { nextDone, next: yield* Fiber.join(next), again: yield* Fiber.join(again), sent: w.sent.length, alerts: w.alerts }
    }), Effect.andThen(Effect.sync(() => void (alerting = true)), Deferred.await(telegram)))
  assert.ok(r.nextDone, "the next payment didn't wait for Telegram")
  assert.deepEqual([r.next, r.again, r.sent, r.alerts.length], ["success", "success", 3, 1], "sent: the old payment, its replacement, the next one")
})

test("a saved payment whose nonce is still its own is never signed again, even when no receipt shows up", async () => {
  const r = await world({ pending: 8, latest: 7, sendError: "already known", receipt: () => undefined }, (w) =>
    Effect.gen(function*() {
      const saved = yield* savedPayment(7)
      const before = w.signed()
      const status = yield* overTime(Base.use((b) => b.pay(BITREFILL, 10_000_000, saved, () => Effect.die("must not sign a second payment"), NO_DEADLINE)))
      return { status, resigned: w.signed() - before, sent: w.sent.length }
    }))
  assert.deepEqual(r, { status: "pending", resigned: 0, sent: 1 })
})

test("a saved payment that waits on the wallet's lock past its deadline is never sent again: its receipt is only looked up", async () => {
  // The first payment holds the lock for half a minute, watching for a receipt that doesn't show up.
  const r = await world({ pending: 9, latest: 7, sendError: "already known", receipt: () => undefined }, (w) =>
    Effect.gen(function*() {
      const first = yield* savedPayment(7)
      const second = yield* savedPayment(8)
      const now = yield* Clock.currentTimeMillis
      const holding = yield* Effect.forkChild(Base.use((b) => b.pay(BITREFILL, 10_000_000, first, () => Effect.die("not expected"), now + 3_600_000)))
      yield* Effect.promise(() => new Promise((done) => setTimeout(done, 100)))
      // The second one's invoice nears expiry ten seconds in, while it's still waiting for the lock.
      const status = yield* overTime(Base.use((b) => b.pay(BITREFILL, 10_000_000, second, () => Effect.die("must not sign a new payment"), now + 10_000)))
      yield* Fiber.join(holding)
      return { status, sent: w.sent, first: first.raw }
    }))
  assert.equal(r.status, "pending")
  assert.deepEqual(r.sent, [r.first], "only the first payment reached the node")
})
