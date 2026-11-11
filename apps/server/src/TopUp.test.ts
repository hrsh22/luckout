import { ConfigProvider, Effect } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Layer } from "effect"
import { DbMemory } from "./Db.ts"
import { Near } from "./Near.ts"
import { OneClick } from "./OneClick.ts"
import { Relay } from "./Relay.ts"
import { fakeNear } from "./testing.ts"
import { intentPayload, intentSignature, moveInIntent } from "@luckout/api"
import { SqlClient } from "effect/sql"
import { randomBytes } from "node:crypto"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { Alerts } from "./Alerts.ts"
import { isLate, noticeFor, phaseOf, type SwapRow, TopUp } from "./TopUp.ts"
import type { SwapDetails } from "./OneClick.ts"

// Live dry-run quotes against 1Click mainnet (no funds move, no key needed).
const run = <A, E>(f: (t: TopUp["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(TopUp.use(f).pipe(Effect.provide(layer)))
const noRelay = Layer.succeed(Relay, Relay.of({
  available: () => Effect.succeed(false),
  send: () => Effect.die("relay.send was not expected"),
  sendIntent: () => Effect.die("relay.sendIntent was not expected"),
  settings: Effect.die("relay.settings was not expected"),
  configure: () => Effect.die("relay.configure was not expected")
}))
const noAlerts = Layer.succeed(Alerts, Alerts.of({ admin: () => Effect.void, customer: () => Effect.void }))
const layer = TopUp.layer.pipe(Layer.provide([OneClick.layer, Layer.succeed(Near, fakeNear()), noRelay, noAlerts, DbMemory]))
const live = { skip: process.env.CI ? "no network calls to 1Click in CI" : false }

test("lists supported origin tokens, never USDC on NEAR itself", live, async () => {
  const assets = await run((t) => t.assets)
  assert.ok(assets.some((a) => a.symbol === "USDC" && a.chain === "base"))
  assert.ok(!assets.some((a) => a.chain === "near" && a.symbol === "USDC"))
})

test("quotes exactly the USDC asked for, delivered to the customer's NEAR account", live, async () => {
  const q = await run((t) => t.quote("root.near", "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", 10_000_000, true))
  assert.equal(q.usdcOut, 10_000_000)
  assert.ok(Number(q.amountInFormatted) >= 10 && Number(q.amountInFormatted) < 10.5, q.amountInFormatted)
})

test("refuses amounts outside 1–2,000 USDC", async () => {
  const r = await Effect.runPromise(TopUp.use((t) => t.quote("root.near", "x", 500_000, true)).pipe(Effect.provide(layer), Effect.flip))
  assert.match(r.message, /between 1 and 2,000/)
})

test("an EVM wallet's Top-Up lands in its own NEAR Intents account", live, async () => {
  const evm = "0x53a19a03679e8d5e9253a998dcde6c71dbb002a2"
  const q = await run((t) => t.quote(evm, "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", 2_000_000, true))
  assert.equal(q.usdcOut, 2_000_000)
})

test("a Top-Up's move-in is armed once, for exactly what its swap delivers, and a few at a time per account", async () => {
  const wallet = privateKeyToAccount(generatePrivateKey())
  const me = wallet.address.toLowerCase()
  const near = fakeNear({ contractId: "app.test", usdcId: "usdc.test", intentsId: "intents.test" })
  const pending = Layer.succeed(OneClick, OneClick.of({
    tokens: Effect.succeed([]),
    quote: () => Effect.die("quote was not expected"),
    status: () => Effect.succeed("PENDING_DEPOSIT"),
    details: () => Effect.succeed({ status: "PENDING_DEPOSIT" }),
    submitDeposit: () => Effect.void
  }))
  const sign = async (amount: string) => {
    const payload = intentPayload({
      signer: me,
      intentsId: "intents.test",
      deadline: new Date(Date.now() + 3_600_000),
      nonce: randomBytes(32).toString("base64"),
      intents: [moveInIntent({ usdcId: "usdc.test", contractId: "app.test", account: me, amount })]
    })
    return { standard: "erc191" as const, payload, signature: intentSignature(await wallet.signMessage({ message: payload })) }
  }
  const [a, a2, wrong] = await Promise.all([sign("2000000"), sign("2000000"), sign("3000000")])
  const results = await Effect.runPromise(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const t = yield* TopUp
    for (const d of ["d1", "d2", "d3", "d4"]) {
      yield* sql`INSERT INTO intents_swaps (deposit_address, account_id, direction, usdc) VALUES (${d}, ${me}, 'in', 2000000)`
    }
    const tag = <E>(e: Effect.Effect<void, E>) => e.pipe(Effect.match({ onFailure: (err) => String((err as { message: string }).message), onSuccess: () => "ok" }))
    return {
      wrongAmount: yield* tag(t.move(me, "d1", wrong)),
      first: yield* tag(t.move(me, "d1", a)),
      same: yield* tag(t.move(me, "d1", a)),
      again: yield* tag(t.move(me, "d1", a2)),
      second: yield* tag(t.move(me, "d2", yield* Effect.promise(() => sign("2000000")))),
      third: yield* tag(t.move(me, "d3", yield* Effect.promise(() => sign("2000000")))),
      fourth: yield* tag(t.move(me, "d4", yield* Effect.promise(() => sign("2000000"))))
    }
  }).pipe(Effect.provide(TopUp.layer.pipe(Layer.provideMerge(Layer.mergeAll(pending, Layer.succeed(Near, near), noRelay, noAlerts, DbMemory))))))
  assert.match(results.wrongAmount, /doesn't move this Top-Up/)
  assert.deepEqual([results.first, results.same, results.second, results.third], ["ok", "ok", "ok", "ok"])
  assert.match(results.again, /already handled/, "a second signed move-in for the same Top-Up is refused")
  assert.match(results.fourth, /other Top-Ups first/)
})

// ---------- money in transit stays in sight ----------

test("a quote tells the customer, and records, when refunds begin (30 min), not when 1Click's address closes (days later)", async () => {
  const threeDays = new Date(Date.now() + 3 * 86_400_000).toISOString()
  const oneClick = Layer.succeed(OneClick, OneClick.of({
    tokens: Effect.succeed([{ assetId: "nep141:base-usdc", blockchain: "base", symbol: "USDC", contractAddress: "0xusdc", decimals: 6 }]),
    quote: (r) => Effect.succeed({
      quote: { depositAddress: `dq-${r.swapType}`, amountIn: "1010224", amountInFormatted: "1.010224", amountOut: "1000000", amountOutFormatted: "0.99", timeEstimate: 35, deadline: threeDays },
      quoteRequest: { originAsset: r.originAsset, destinationAsset: r.destinationAsset, recipient: r.recipient, swapType: r.swapType, recipientType: r.recipientType, depositType: r.depositType ?? "ORIGIN_CHAIN" }
    } as never),
    status: () => Effect.succeed("PENDING_DEPOSIT"),
    details: () => Effect.succeed({ status: "PENDING_DEPOSIT" }),
    submitDeposit: () => Effect.void
  }))
  const r = await Effect.runPromise(Effect.gen(function*() {
    const t = yield* TopUp
    const sql = yield* SqlClient.SqlClient
    const q = yield* t.quote(EVM, "nep141:base-usdc", 1_000_000)
    yield* t.exit(EVM, "nep141:base-usdc", 1_000_000)
    const rows = yield* sql<{ deadline: Date }>`SELECT deadline FROM intents_swaps ORDER BY direction`
    return { shown: Date.parse(q.deadline), stored: rows.map((x) => new Date(x.deadline).getTime()) }
  }).pipe(Effect.provide(TopUp.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(oneClick, Layer.succeed(Near, fakeNear()), noRelay, noAlerts, DbMemory)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { NEAR_NETWORK: "mainnet" } })))
  ))))
  const inHalfAnHour = (ms: number) => Math.abs(ms - (Date.now() + 30 * 60_000)) < 60_000
  assert.ok(inHalfAnHour(r.shown), "the quote says to send within 30 minutes")
  assert.equal(r.stored.length, 2)
  assert.ok(r.stored.every(inHalfAnHour), "both the Top-Up and the withdrawal are recorded with when refunds begin")
})

const EVM = "0x" + "a".repeat(40)
const NEAR = "alice.near"
const row = (o: Partial<SwapRow>): SwapRow => ({
  deposit_address: "d",
  deposit_memo: null,
  account_id: EVM,
  direction: "in",
  usdc: "2500000",
  symbol: "USDC",
  chain: "base",
  amount_in: "2.525765",
  amount_out: null,
  deadline: null,
  time_estimate: 60,
  status: null,
  deposit_seen_at: null,
  status_at: null,
  delivered_tx: null,
  refunded: null,
  refund_reason: null,
  move: null,
  move_detail: null,
  move_in: null,
  told: [],
  created_at: new Date(),
  ...o
})

test("every swap says where the money is, in the customer's words", () => {
  const cases: Array<[Partial<SwapRow>, string]> = [
    [{ status: null }, "awaiting-transfer"],
    [{ status: "PENDING_DEPOSIT" }, "awaiting-transfer"],
    [{ status: "KNOWN_DEPOSIT_TX" }, "swapping"],
    [{ status: "PROCESSING" }, "swapping"],
    [{ status: "INCOMPLETE_DEPOSIT" }, "swapping"],
    [{ status: "SUCCESS", move: "waiting" }, "moving"],
    [{ status: "SUCCESS", move: "moved" }, "done"],
    [{ status: "SUCCESS", move: "failed" }, "in-intents"],
    [{ status: "SUCCESS", move: null }, "in-intents"],
    [{ status: "SUCCESS", account_id: NEAR }, "in-wallet"],
    [{ status: "REFUNDED" }, "refunded"],
    [{ status: "FAILED" }, "refunded"],
    [{ direction: "out", status: "PENDING_DEPOSIT" }, "swapping"],
    [{ direction: "out", status: "PROCESSING" }, "swapping"],
    [{ direction: "out", status: "SUCCESS" }, "done"],
    [{ direction: "out", status: "REFUNDED" }, "refunded"]
  ]
  for (const [o, phase] of cases) assert.equal(phaseOf(row(o)), phase, JSON.stringify(o))
})

test("a swap is late once 1Click has had the money well past its usual time, never before or after", () => {
  const now = Date.now()
  const seen = (minutes: number) => new Date(now - minutes * 60_000)
  assert.equal(isLate(row({ status: "PROCESSING", deposit_seen_at: seen(5) }), now), false, "under 10 minutes")
  assert.equal(isLate(row({ status: "PROCESSING", deposit_seen_at: seen(11) }), now), true)
  assert.equal(isLate(row({ status: "PROCESSING", deposit_seen_at: seen(11), time_estimate: 600 }), now), false, "3× a 10-minute estimate")
  assert.equal(isLate(row({ status: "PENDING_DEPOSIT", deposit_seen_at: null }), now), false, "we're waiting for the customer, not 1Click")
  assert.equal(isLate(row({ status: "SUCCESS", deposit_seen_at: seen(90) }), now), false, "done is never late")
})

test("each notice says what happened and what to do, keyed so it's sent once", () => {
  const web = "https://luckout.example"
  const now = Date.now()
  const n = (o: Partial<SwapRow>) => noticeFor(row(o), now, web)
  assert.deepEqual(n({ status: "SUCCESS", move: "moved" }), { key: "landed", text: "Your $2.50 Top-Up is in your Luckout balance." })
  assert.match(n({ status: "SUCCESS", account_id: NEAR })!.text, /landed in your NEAR wallet\. Deposit it into Luckout at https:\/\/luckout\.example\/wallet/)
  assert.match(n({ status: "SUCCESS", move: "failed", move_detail: "That approval expired" })!.text, /NEAR Intents account but didn't move into Luckout \(That approval expired\)\. Move it in/)
  const refund = n({ status: "REFUNDED", refunded: "2.5", refund_reason: "Deposit came in after the deadline" })!
  assert.equal(refund.key, "refunded")
  assert.match(refund.text, /2\.525765 USDC on Base\) didn't go through: Deposit came in after the deadline\. 1Click sent 2\.5 USDC back to your NEAR Intents account/)
  assert.deepEqual(n({ direction: "out", status: "SUCCESS", amount_out: "1.419", chain: "base" }), { key: "arrived", text: "Your $2.50 withdrawal arrived: 1.419 USDC on Base." })
  assert.match(n({ direction: "out", status: "REFUNDED" })!.text, /withdrawal to Base was refunded to your NEAR Intents account/)
  const late = n({ status: "PROCESSING", deposit_seen_at: new Date(now - 30 * 60_000), deposit_address: "abc" })!
  assert.equal(late.key, "late")
  assert.match(late.text, /taking longer than usual\. It's safe.*explorer\.near-intents\.org\/transactions\/abc/)
  assert.equal(n({ status: "PROCESSING", deposit_seen_at: new Date(now - 60_000) }), undefined, "nothing to say yet")
  assert.equal(n({ status: "PENDING_DEPOSIT" }), undefined)
})

test("tracking follows every swap, moves EVM Top-Ups in, tells each customer once, and lists what's in transit", async () => {
  const told: Array<[string, string]> = []
  const sent: Array<string> = []
  const checked: Array<string> = []
  const scripted: Record<string, SwapDetails> = {
    evmIn: { status: "SUCCESS", deliveredTx: "nearTxHash" },
    nearIn: { status: "SUCCESS" },
    out: { status: "SUCCESS", amountOut: "1.419", deliveredTx: "0xbeef" },
    refunded: { status: "REFUNDED", refunded: "2.5", refundReason: "Deposit came in after the deadline" },
    late: { status: "PROCESSING" },
    awaiting: { status: "PENDING_DEPOSIT" },
    abandoned: { status: "PENDING_DEPOSIT" },
    unsigned: { status: "PENDING_DEPOSIT" }
  }
  const oneClick = Layer.succeed(OneClick, OneClick.of({
    tokens: Effect.succeed([]),
    quote: () => Effect.die("quote was not expected"),
    status: (a) => Effect.succeed(scripted[a]!.status),
    details: (a) => Effect.sync(() => (checked.push(a), scripted[a]!)),
    submitDeposit: () => Effect.void
  }))
  const relay = Layer.succeed(Relay, Relay.of({
    available: () => Effect.succeed(true),
    send: () => Effect.die("relay.send was not expected"),
    sendIntent: (account) => Effect.sync(() => (sent.push(account), { hash: "tx" })),
    settings: Effect.die("relay.settings was not expected"),
    configure: () => Effect.die("relay.configure was not expected")
  }))
  const alerts = Layer.succeed(Alerts, Alerts.of({ admin: () => Effect.void, customer: (a, t) => Effect.sync(() => void told.push([a, t])) }))
  const moveIn = {
    standard: "erc191",
    payload: intentPayload({
      signer: EVM,
      intentsId: "intents.test",
      deadline: new Date(Date.now() + 3_600_000),
      nonce: randomBytes(32).toString("base64"),
      intents: [moveInIntent({ usdcId: "usdc.test", contractId: "app.test", account: EVM, amount: "2500000" })]
    }),
    signature: "x"
  }
  const result = await Effect.runPromise(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const t = yield* TopUp
    const add = (address: string, o: Record<string, unknown>) =>
      sql`INSERT INTO intents_swaps ${sql.insert({ deposit_address: address, account_id: EVM, direction: "in", usdc: 2_500_000, symbol: "USDC", chain: "base", amount_in: "2.525765", time_estimate: 60, ...o })}`
    yield* add("evmIn", { move: "waiting" })
    yield* sql`UPDATE intents_swaps SET move_in = ${JSON.stringify(moveIn)}::jsonb WHERE deposit_address = 'evmIn'`
    yield* add("nearIn", { account_id: NEAR })
    yield* add("out", { direction: "out", usdc: 1_422_000, amount_in: null })
    yield* add("refunded", {})
    yield* add("late", { status: "PROCESSING", deposit_seen_at: new Date(Date.now() - 30 * 60_000) })
    yield* add("awaiting", { deadline: new Date(Date.now() + 20 * 60_000) })
    yield* add("abandoned", { deadline: new Date(Date.now() - 3 * 3_600_000), created_at: new Date(Date.now() - 4 * 3_600_000) })
    yield* add("unsigned", { direction: "out", deadline: new Date(Date.now() + 25 * 60_000), created_at: new Date(Date.now() - 5 * 60_000) })
    yield* t.trackNow
    yield* t.trackNow
    const mine = yield* t.transfers(EVM)
    const near = yield* t.transfers(NEAR)
    return { mine, near }
  }).pipe(Effect.provide(TopUp.layer.pipe(Layer.provideMerge(Layer.mergeAll(oneClick, Layer.succeed(Near, fakeNear()), relay, alerts, DbMemory))))))

  assert.deepEqual(sent, [EVM], "the EVM Top-Up's move-in is sent once, when its swap landed")
  assert.ok(!checked.includes("abandoned"), "a quote nobody paid into, long past its deadline, isn't checked")
  const texts = told.map(([a, t]) => `${a === NEAR ? "near" : "evm"}: ${t}`)
  assert.equal(told.length, 5, texts.join("\n"))
  assert.ok(texts.some((t) => t.startsWith("evm: Your $2.50 Top-Up is in your Luckout balance")))
  assert.ok(texts.some((t) => t.startsWith("near: Your $2.50 Top-Up landed in your NEAR wallet")))
  assert.ok(texts.some((t) => t.startsWith("evm: Your $1.42 withdrawal arrived: 1.419 USDC on Base")))
  assert.ok(texts.some((t) => /evm: Your Top-Up .* didn't go through: Deposit came in after the deadline/.test(t)))
  assert.ok(texts.some((t) => /evm: Your \$2\.50 Top-Up is taking longer than usual/.test(t)))

  const byAddress = Object.fromEntries(result.mine.map((x) => [x.depositAddress, x]))
  assert.deepEqual(Object.keys(byAddress).sort(), ["awaiting", "evmIn", "late", "out", "refunded"], "neither the abandoned quote nor the withdrawal never sent is listed")
  assert.equal(byAddress.evmIn!.phase, "done")
  assert.equal(byAddress.evmIn!.deliveredTx, undefined, "a Top-Up's delivery is a NEAR transaction, not a link on Base")
  assert.equal(byAddress.awaiting!.phase, "awaiting-transfer")
  assert.equal(byAddress.late!.phase, "swapping")
  assert.equal(byAddress.late!.late, true)
  assert.deepEqual([byAddress.out!.phase, byAddress.out!.amountOut, byAddress.out!.deliveredTx], ["done", "1.419", "0xbeef"])
  assert.deepEqual([byAddress.refunded!.phase, byAddress.refunded!.refunded, byAddress.refunded!.detail], ["refunded", "2.5", "Deposit came in after the deadline"])
  assert.match(byAddress.refunded!.explorer, /explorer\.near-intents\.org\/transactions\/refunded$/)
  assert.deepEqual(result.near.map((x) => x.phase), ["in-wallet"])
})
