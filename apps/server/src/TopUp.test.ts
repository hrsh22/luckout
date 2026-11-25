import { NodeHttpServer } from "@effect/platform-node"
import { ConfigProvider, Effect, Fiber } from "effect"
import { HttpRouter } from "effect/http"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mock, test } from "node:test"
import { Keypair } from "@solana/web3.js"
import { Layer } from "effect"
import { DbMemory } from "./Db.ts"
import { Near } from "./Near.ts"
import { echoProblem, OneClick, type QuoteRequest } from "./OneClick.ts"
import { Relay } from "./Relay.ts"
import { fakeNear } from "./testing.ts"
import { intentPayload, intentSignature, moveInIntent, RelayFailed, solanaAddress } from "@luckout/api"
import { SqlClient } from "effect/sql"
import { randomBytes } from "node:crypto"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { Alerts } from "./Alerts.ts"
import { SOL_USDC_ASSET, Swap, swapAssetId, SWAP_TOKENS, SwapUnavailable } from "./Swap.ts"
import { isLate, noticeFor, phaseOf, refundsToWallet, SolanaPayRoute, type SwapRow, TopUp } from "./TopUp.ts"
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
const noAlerts = Layer.succeed(Alerts, Alerts.of({ admin: () => Effect.void, customer: () => Effect.succeed(true) }))
// No Jupiter key: no swap-paid tokens (Swap.test.ts covers those).
const noSwaps = Layer.succeed(Swap, Swap.of({
  tokens: Effect.succeed([]),
  size: () => Effect.die("swap.size was not expected"),
  transaction: () => Effect.die("swap.transaction was not expected"),
  paidBy: () => Effect.succeed(undefined)
}))
const layer = TopUp.layer.pipe(Layer.provide([OneClick.layer, Layer.succeed(Near, fakeNear()), noRelay, noAlerts, DbMemory, noSwaps]))
// Live calls to 1Click, only when asked for (pnpm --filter @luckout/server test:live).
const live = { skip: !process.env.LIVE_TESTS && "set LIVE_TESTS=1 to call 1Click" }

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
    for (const d of ["d1", "d2", "d3", "d4", "d5"]) {
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
      fourth: yield* tag(t.move(me, "d4", yield* Effect.promise(() => sign("2000000")))),
      // d1 left unpaid past its deadline: it can't land, so it stops counting.
      afterDeadline: yield* sql`UPDATE intents_swaps SET deadline = now() - interval '1 minute' WHERE deposit_address = 'd1'`.pipe(
        Effect.andThen(tag(t.move(me, "d5", yield* Effect.promise(() => sign("2000000")))))
      ),
      // A dismissed transfer's address is out, so it may still land: it keeps its place.
      dismissed: yield* sql`UPDATE intents_swaps SET dismissed_at = now() WHERE deposit_address = 'd2'`.pipe(
        Effect.andThen(tag(t.move(me, "d4", yield* Effect.promise(() => sign("2000000")))))
      ),
      // A cancelled swap-paid one gets no new transaction: it stops counting, as if past its deadline.
      cancelled: yield* sql`UPDATE intents_swaps SET paid_mint = 'mint' WHERE deposit_address = 'd2'`.pipe(
        Effect.andThen(tag(t.move(me, "d4", yield* Effect.promise(() => sign("2000000")))))
      )
    }
  }).pipe(Effect.provide(TopUp.layer.pipe(Layer.provideMerge(Layer.mergeAll(pending, Layer.succeed(Near, near), noRelay, noAlerts, DbMemory, noSwaps))))))
  assert.match(results.wrongAmount, /doesn't move this Top-Up/)
  assert.deepEqual([results.first, results.same, results.second, results.third], ["ok", "ok", "ok", "ok"])
  assert.match(results.again, /already handled/, "a second signed move-in for the same Top-Up is refused")
  assert.match(results.fourth, /other Top-Ups first/)
  assert.equal(results.afterDeadline, "ok", "an unpaid quote past its deadline doesn't hold up a new Top-Up")
  assert.match(results.dismissed, /other Top-Ups first/, "a dismissed transfer may still land")
  assert.equal(results.cancelled, "ok", "a cancelled swap-paid Top-Up doesn't hold up a new one")
})

// ---------- money in transit stays in sight ----------

test("a quote tells the customer, and records, when refunds begin (30 min), not when 1Click's address closes (days later)", async () => {
  const threeDays = new Date(Date.now() + 3 * 86_400_000).toISOString()
  const oneClick = Layer.succeed(OneClick, OneClick.of({
    tokens: Effect.succeed([{ assetId: "nep141:base-usdc", blockchain: "base", symbol: "USDC", contractAddress: "0xusdc", decimals: 6 }]),
    quote: (r) => Effect.succeed({
      quote: { depositAddress: `dq-${r.swapType}`, amountIn: "1010224", amountInFormatted: "1.010224", amountOut: "1000000", amountOutFormatted: "0.99", timeEstimate: 35, deadline: threeDays },
      quoteRequest: { originAsset: r.originAsset, destinationAsset: r.destinationAsset, recipient: r.recipient, refundTo: r.refundTo, swapType: r.swapType, amount: r.amount, recipientType: r.recipientType, depositType: r.depositType ?? "ORIGIN_CHAIN", refundType: r.refundType }
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
    Layer.provideMerge(Layer.mergeAll(oneClick, Layer.succeed(Near, fakeNear()), noRelay, noAlerts, DbMemory, noSwaps)),
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
  deposited: null,
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
  origin_asset: null,
  origin_amount: null,
  deposit_tx: null,
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
    [{ status: "INCOMPLETE_DEPOSIT" }, "incomplete"],
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
    [{ direction: "out", status: "REFUNDED" }, "refunded"],
    [{ direction: "back", status: null }, "swapping"],
    [{ direction: "back", status: "PROCESSING" }, "swapping"],
    [{ direction: "back", status: "SUCCESS", account_id: NEAR }, "done"],
    [{ direction: "back", status: "REFUNDED" }, "refunded"]
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
  assert.equal(isLate(row({ status: "INCOMPLETE_DEPOSIT", deposit_seen_at: seen(90) }), now), false, "a short payment waits on the customer, who is told so")
  assert.equal(isLate(row({ status: "SUCCESS", move: "waiting", status_at: seen(2) }), now), false, "landed, move-in still has time")
  assert.equal(isLate(row({ status: "SUCCESS", move: "waiting", status_at: seen(6) }), now), true, "landed, move-in stuck")
  assert.equal(isLate(row({ status: "SUCCESS", move: "moved", status_at: seen(60) }), now), false, "moved is never late")
  const stuck = noticeFor(row({ status: "SUCCESS", move: "waiting", status_at: seen(6) }), now, "https://luckout.example")
  assert.equal(stuck?.key, "late")
  assert.match(stuck!.text, /landed, but moving it into your Luckout balance is taking longer/, "says where it is, not that 1Click may refund it")
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
  assert.match(refund.text, /2\.53 USDC on Base\) didn't go through: Deposit came in after the deadline\. 1Click sent 2\.50 USDC back to your wallet on Base\./)
  assert.match(n({ status: "REFUNDED", refunded: "2.5", account_id: NEAR })!.text, /1Click sent 2\.50 USDC back to your NEAR Intents account\./, "a NEAR wallet's address on Base is unknown")
  assert.match(n({ status: "REFUNDED", refunded: "0.1", symbol: "SOL", chain: "sol" })!.text, /1Click sent 0\.1 SOL back to your NEAR Intents account\./, "an EVM address isn't one on Solana")
  assert.match(n({ status: "REFUNDED", refunded: "0.15", refund_reason: "QUOTE_EXPIRED" })!.text, /didn't go through: the full amount didn't arrive before the deadline\. 1Click sent 0\.15 USDC back/)
  assert.deepEqual(n({ direction: "out", status: "SUCCESS", amount_out: "1.419", chain: "base" }), { key: "arrived", text: "Your $2.50 withdrawal arrived: 1.419 USDC on Base." })
  assert.match(n({ direction: "out", status: "REFUNDED" })!.text, /withdrawal to Base was refunded to your NEAR Intents account/)
  const late = n({ status: "PROCESSING", deposit_seen_at: new Date(now - 30 * 60_000), deposit_address: "abc" })!
  assert.equal(late.key, "late")
  assert.match(late.text, /taking longer than usual\. It's safe.*explorer\.near-intents\.org\/transactions\/abc/)
  assert.equal(n({ status: "PROCESSING", deposit_seen_at: new Date(now - 60_000) }), undefined, "nothing to say yet")
  assert.equal(n({ status: "PENDING_DEPOSIT" }), undefined)
  const short = n({ status: "INCOMPLETE_DEPOSIT", deposited: "0.15", deadline: new Date(now + 20.5 * 60_000) })!
  assert.equal(short.key, "incomplete")
  assert.match(short.text, /^1Click got 0\.15 of the 2\.53 USDC on Base your \$2\.50 Top-Up needs\. Send the rest to the same address within 20 min, or what arrived goes back to your wallet on Base\./)
  assert.match(n({ status: "INCOMPLETE_DEPOSIT", deposited: "0.15", deadline: new Date(now - 60_000), account_id: NEAR })!.text, /0\.15 of the .* needs\. What arrived goes back to your NEAR Intents account/)
  const paid = { status: "PENDING_DEPOSIT", deposit_tx: "0x" + "ab".repeat(32), deposit_address: "dq" }
  const unseen = n({ ...paid, deadline: new Date(now - 6 * 60_000) })!
  assert.equal(unseen.key, "unseen")
  assert.match(unseen.text, /^1Click hasn't confirmed your \$2\.50 Top-Up transfer \(2\.53 USDC on Base\) yet\. It's at 1Click's deposit address: it either goes through or comes back to your wallet on Base\. Luckout is looking into it\./)
  assert.equal(n({ ...paid, deadline: new Date(now - 60_000) }), undefined, "1Click gets a few minutes past the deadline")
  assert.equal(n({ ...paid, deposit_tx: null, deadline: new Date(now - 6 * 60_000) }), undefined, "nobody said they paid")
  const back = (o: Partial<SwapRow>) => n({ direction: "back", usdc: "0", amount_in: "0.120132", amount_out: "0.117732", ...o })!
  assert.deepEqual(back({ status: "SUCCESS" }), { key: "arrived", text: "0.117732 USDC is in your wallet on Base." })
  assert.deepEqual(back({ status: "SUCCESS", account_id: NEAR, chain: "near" }), { key: "arrived", text: "0.117732 USDC is in your NEAR wallet." })
  assert.match(back({ status: "REFUNDED" }).text, /^Sending it to your wallet on Base didn't go through\. It's still in your NEAR Intents account/)
  assert.match(back({ status: "PROCESSING", deposit_seen_at: new Date(now - 30 * 60_000) }).text, /^Sending to your wallet on Base is taking longer than usual/)
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
    short: { status: "INCOMPLETE_DEPOSIT", deposited: "0.15" },
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
  const alerts = Layer.succeed(Alerts, Alerts.of({ admin: () => Effect.void, customer: (a, t) => Effect.sync(() => (told.push([a, t]), true)) }))
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
    yield* add("short", { account_id: NEAR, deadline: new Date(Date.now() + 20 * 60_000) })
    yield* add("abandoned", { deadline: new Date(Date.now() - 3 * 3_600_000), created_at: new Date(Date.now() - 4 * 3_600_000) })
    yield* add("unsigned", { direction: "out", deadline: new Date(Date.now() + 25 * 60_000), created_at: new Date(Date.now() - 5 * 60_000) })
    yield* t.trackNow
    yield* t.trackNow
    const mine = yield* t.transfers(EVM)
    const near = yield* t.transfers(NEAR)
    return { mine, near }
  }).pipe(Effect.provide(TopUp.layer.pipe(Layer.provideMerge(Layer.mergeAll(oneClick, Layer.succeed(Near, fakeNear()), relay, alerts, DbMemory, noSwaps))))))

  assert.deepEqual(sent, [EVM], "the EVM Top-Up's move-in is sent once, when its swap landed")
  assert.ok(!checked.includes("abandoned"), "a quote nobody paid into, long past its deadline, isn't checked")
  const texts = told.map(([a, t]) => `${a === NEAR ? "near" : "evm"}: ${t}`)
  assert.equal(told.length, 6, texts.join("\n"))
  assert.ok(texts.some((t) => t.startsWith("near: 1Click got 0.15 of the 2.53 USDC on Base your $2.50 Top-Up needs. Send the rest")))
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
  assert.deepEqual(result.near.map((x) => [x.depositAddress, x.phase, x.deposited]), [["short", "incomplete", "0.15"], ["nearIn", "in-wallet", undefined]])
})

test("a landed Top-Up's move-in that NEAR didn't answer for waits and goes on a later pass, whether or not it was sent", async () => {
  const tries: Array<string> = []
  const answers = ["NEAR didn't answer, so nothing was sent. Try again in a minute.", "NEAR didn't answer in time. It may still go through, so check your balance before trying again."]
  const oneClick = Layer.succeed(OneClick, OneClick.of({
    tokens: Effect.succeed([]),
    quote: () => Effect.die("quote was not expected"),
    status: () => Effect.succeed("SUCCESS"),
    details: () => Effect.succeed({ status: "SUCCESS" }),
    submitDeposit: () => Effect.void
  }))
  const relay = Layer.succeed(Relay, Relay.of({
    available: () => Effect.succeed(true),
    send: () => Effect.die("relay.send was not expected"),
    sendIntent: () => Effect.suspend(() => {
      const message = answers[tries.length]
      tries.push(message ?? "sent")
      return message ? Effect.fail(new RelayFailed({ message })) : Effect.succeed({ hash: "tx" })
    }),
    settings: Effect.die("relay.settings was not expected"),
    configure: () => Effect.die("relay.configure was not expected")
  }))
  const signed = {
    standard: "erc191",
    payload: intentPayload({
      signer: EVM, intentsId: "intents.test", deadline: new Date(Date.now() + 3_600_000), nonce: randomBytes(32).toString("base64"),
      intents: [moveInIntent({ usdcId: "usdc.test", contractId: "app.test", account: EVM, amount: "2500000" })]
    }),
    signature: "x"
  }
  const moves = await Effect.runPromise(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const t = yield* TopUp
    yield* Effect.sleep("100 millis") // the start-up pass is done
    yield* sql`INSERT INTO intents_swaps ${sql.insert({ deposit_address: "landed", account_id: EVM, direction: "in", usdc: 2_500_000, move: "waiting" })}`
    yield* sql`UPDATE intents_swaps SET move_in = ${JSON.stringify(signed)}::jsonb`
    const moves: Array<string | null> = []
    for (let i = 0; i < 3; i++) {
      yield* t.trackNow
      moves.push((yield* sql<{ move: string | null }>`SELECT move FROM intents_swaps`)[0]!.move)
    }
    return moves
  }).pipe(Effect.provide(TopUp.layer.pipe(Layer.provideMerge(Layer.mergeAll(oneClick, Layer.succeed(Near, fakeNear()), relay, noAlerts, DbMemory, noSwaps))))))
  assert.deepEqual(moves, ["waiting", "waiting", "moved"])
  assert.equal(tries.length, 3)
})

test("what 1Click sent back in the token paid with is listed, so no change or refund is out of sight", async () => {
  const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"
  const owned: Record<string, Array<string>> = {
    [EVM]: [BASE_USDC, "nep141:usdc.test", "nep141:unknown.near"],
    [NEAR]: [BASE_USDC, "nep141:usdc.test", "nep141:wrap.near"]
  }
  const balance: Record<string, string> = { [BASE_USDC]: "120132", "nep141:usdc.test": "2500000", "nep141:unknown.near": "5", "nep141:wrap.near": "0" }
  const near = fakeNear({
    view: ((method: string, args: { account_id: string; token_ids?: Array<string> }, contract?: string) => {
      assert.equal(contract, "intents.test")
      return Effect.succeed(method === "mt_tokens_for_owner" ? owned[args.account_id]!.map((token_id) => ({ token_id })) : args.token_ids!.map((id) => balance[id]))
    }) as never
  })
  const oneClick = Layer.succeed(OneClick, OneClick.of({
    tokens: Effect.succeed([
      { assetId: BASE_USDC, blockchain: "base", symbol: "USDC", decimals: 6 },
      { assetId: "nep141:wrap.near", blockchain: "near", symbol: "wNEAR", decimals: 24 }
    ]),
    quote: () => Effect.die("quote was not expected"),
    status: () => Effect.die("status was not expected"),
    details: () => Effect.die("details was not expected"),
    submitDeposit: () => Effect.void
  }))
  const r = await Effect.runPromise(Effect.gen(function*() {
    const t = yield* TopUp
    return { evm: yield* t.held(EVM), near: yield* t.held(NEAR) }
  }).pipe(Effect.provide(TopUp.layer.pipe(Layer.provideMerge(Layer.mergeAll(oneClick, Layer.succeed(Near, near), noRelay, noAlerts, DbMemory, noSwaps))))))
  const show = (xs: ReadonlyArray<{ amount: string; symbol: string; chain: string }>) => xs.map((x) => `${x.amount} ${x.symbol} on ${x.chain}`)
  assert.deepEqual(show(r.evm), ["0.120132 USDC on base"], "an EVM wallet's NEAR USDC is its Luckout wallet already; an unknown token is skipped")
  assert.deepEqual(show(r.near), ["0.120132 USDC on base", "2.5 USDC on near"], "a NEAR wallet sees its NEAR USDC there too; nothing at zero")
})

// ---------- what 1Click sends back reaches the customer's own wallet ----------

const BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"
const tokens = [
  { assetId: BASE, blockchain: "base", symbol: "USDC", contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 },
  { assetId: "nep141:sol.omft.near", blockchain: "sol", symbol: "SOL", decimals: 9 },
  { assetId: "nep141:eth.omft.near", blockchain: "eth", symbol: "ETH", decimals: 18 },
  { assetId: "nep141:wrap.near", blockchain: "near", symbol: "wNEAR", decimals: 24 },
  { assetId: SOL_USDC_ASSET, blockchain: "sol", symbol: "USDC", contractAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 }
]
/** A mainnet TopUp whose 1Click records each quote request; NEAR Intents holds `holdings` for everyone. */
const mainnetTopUp = (
  holdings: Record<string, string> = {},
  /** `echo`: what 1Click says it will do, given what was asked (default: exactly that); undefined for no echo at all. */
  o: { deliver?: () => boolean; status?: string; echo?: (asked: QuoteRequest) => object | undefined; swaps?: Layer.Layer<Swap> } = {}
) => {
  const deliver = o.deliver ?? (() => true)
  const asked: Array<Parameters<OneClick["Service"]["quote"]>[0]> = []
  const submitted: Array<{ txHash: string; depositAddress: string }> = []
  const told: Array<string> = []
  /** The deposit addresses whose status 1Click was asked for, in order. */
  const checked: Array<string> = []
  const oneClick = Layer.succeed(OneClick, OneClick.of({
    tokens: Effect.succeed(tokens),
    quote: (r) => {
      asked.push(r)
      return Effect.succeed({
        quote: { depositAddress: `dq-${asked.length}`, amountIn: r.amount, amountInFormatted: "0.120132", amountOut: "117732", amountOutFormatted: "0.117732", timeEstimate: 12 },
        quoteRequest: (o.echo ?? ((x: QuoteRequest) => x))({ ...r, depositType: r.depositType ?? "ORIGIN_CHAIN" })
      } as never)
    },
    status: () => Effect.succeed("PENDING_DEPOSIT"),
    details: (address) => Effect.sync(() => (checked.push(address), { status: o.status ?? "PENDING_DEPOSIT" })),
    submitDeposit: (i) => Effect.sync(() => void submitted.push(i))
  }))
  const alerts = Layer.succeed(Alerts, Alerts.of({
    admin: (text) => Effect.sync(() => void told.push(`admin: ${text}`)),
    customer: (account, text) => Effect.sync(() => (told.push(`${account}: ${text}`), deliver()))
  }))
  const near = fakeNear({
    view: ((method: string, args: { token_ids?: Array<string> }) =>
      Effect.succeed(
        method === "mt_tokens_for_owner"
          ? Object.keys(holdings).map((token_id) => ({ token_id }))
          : args.token_ids!.map((id) => holdings[id])
      )) as never
  })
  const run = <A, E>(f: (t: TopUp["Service"], sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.gen(function*() {
      return yield* f(yield* TopUp, yield* SqlClient.SqlClient)
    }).pipe(Effect.provide(TopUp.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(oneClick, Layer.succeed(Near, near), noRelay, alerts, DbMemory, o.swaps ?? noSwaps)),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { NEAR_NETWORK: "mainnet" } })))
    ))))
  return { asked, submitted, told, checked, run }
}

test("a Top-Up's refund, and the extra it asks for, go back to an EVM wallet on its own chain; anything else to NEAR Intents", async () => {
  const w = mainnetTopUp()
  await w.run((t) =>
    Effect.all([t.quote(EVM, BASE, 1_000_000), t.quote(EVM, "nep141:sol.omft.near", 1_000_000), t.quote(EVM, "nep141:eth.omft.near", 1_000_000), t.quote(NEAR, BASE, 1_000_000)])
  )
  assert.deepEqual(w.asked.map((r) => [r.refundTo, r.refundType]), [[EVM, "ORIGIN_CHAIN"], [EVM, "INTENTS"], [EVM, "INTENTS"], [NEAR, "INTENTS"]], "Ethereum's gas could eat the change")
})

test("a Solana wallet's money lands in its NEAR Intents account and goes back to its Solana address; a NEAR implicit account of the same name is untouched", async () => {
  const SOL_ID = "ad1e2d1d642de1e151c749df291187b0f92b4aad725f7fac726709a85f87e5cf"
  const SOL_ADDRESS = solanaAddress(SOL_ID)
  const SOL = "nep141:sol.omft.near"
  const w = mainnetTopUp({ [SOL]: "5", [BASE]: "7" })
  const r = await w.run((t, sql) =>
    Effect.gen(function*() {
      yield* t.quote(SOL_ID, SOL, 1_000_000, false, "solana") // dq-1
      yield* t.quote(SOL_ID, BASE, 1_000_000, false, "solana") // dq-2: paid from Base, so refunds wait in NEAR Intents
      yield* t.quote(SOL_ID, SOL, 1_000_000, false, "near") // dq-3: the same name, signed in with a NEAR wallet
      yield* t.exit(SOL_ID, SOL, 1_000_000, "solana") // dq-4
      const refused = yield* Effect.all([t.exit(SOL_ID, BASE, 1_000_000, "solana"), t.exit(SOL_ID, SOL, 1_000_000, "near")].map(Effect.flip))
      const held = yield* t.held(SOL_ID, "solana")
      yield* t.sendBack(SOL_ID, SOL, "solana") // dq-5
      yield* sql`UPDATE intents_swaps SET status = 'SUCCESS'`
      const rows = yield* sql<SwapRow>`SELECT * FROM intents_swaps ORDER BY deposit_address`
      return { refused, held, rows }
    })
  )
  assert.deepEqual(w.asked.map((a) => [a.recipient, a.recipientType, a.refundTo, a.refundType]), [
    [SOL_ID, "INTENTS", SOL_ADDRESS, "ORIGIN_CHAIN"],
    [SOL_ID, "INTENTS", SOL_ID, "INTENTS"],
    [SOL_ID, "DESTINATION_CHAIN", SOL_ID, "INTENTS"],
    [SOL_ADDRESS, "DESTINATION_CHAIN", SOL_ID, "INTENTS"],
    [SOL_ADDRESS, "DESTINATION_CHAIN", SOL_ID, "INTENTS"]
  ])
  assert.deepEqual(r.refused.map((e) => e.message), ["That token can't be withdrawn to your wallet", "Withdrawals to other chains are for EVM and Solana wallets"])
  assert.deepEqual(r.held.map((h) => [h.symbol, h.chain, h.sendable]), [["SOL", "sol", true], ["USDC", "base", false]], "a Solana wallet has no address on Base")
  assert.deepEqual(r.rows.map((x) => [x.deposit_address, x.wallet, phaseOf(x), refundsToWallet(x)]), [
    ["dq-1", "solana", "in-intents", true],
    ["dq-2", "solana", "in-intents", false],
    ["dq-3", "near", "in-wallet", false],
    ["dq-4", "solana", "done", false],
    ["dq-5", "solana", "done", false]
  ])
})

test("a held token goes to the customer's own wallet: an EVM wallet's as it is on its chain, a NEAR wallet's as USDC", async () => {
  const held = { [BASE]: "120132", "nep141:wrap.near": "10", "nep141:usdc.test": "5" }
  const w = mainnetTopUp(held)
  const r = await w.run((t, sql) =>
    Effect.gen(function*() {
      const evm = yield* t.held(EVM)
      const near = yield* t.held(NEAR)
      const q = yield* t.sendBack(EVM, BASE)
      const n = yield* t.sendBack(NEAR, BASE)
      const refused = yield* Effect.all([t.sendBack(EVM, "nep141:wrap.near"), t.sendBack(NEAR, "nep141:usdc.test"), t.sendBack(EVM, "nep141:none")].map(Effect.flip))
      const rows = yield* sql<{ deposit_address: string; direction: string; symbol: string; chain: string; origin_asset: string; origin_amount: string }>`
        SELECT deposit_address, direction, symbol, chain, origin_asset, origin_amount FROM intents_swaps ORDER BY deposit_address`
      const listed = yield* t.transfers(EVM)
      return { evm, near, q, n, refused, rows, listed }
    })
  )
  assert.deepEqual(r.evm.map((h) => [h.symbol, h.chain, h.sendable]), [["USDC", "base", true], ["wNEAR", "near", false]], "an EVM wallet has no address on NEAR")
  assert.deepEqual(r.near.map((h) => [h.symbol, h.chain, h.sendable]), [["USDC", "base", true], ["wNEAR", "near", true], ["USDC", "near", false]])
  assert.deepEqual(w.asked.map((a) => [a.originAsset, a.destinationAsset, a.amount, a.depositType, a.recipient, a.recipientType, a.refundType]), [
    [BASE, BASE, "120132", "INTENTS", EVM, "DESTINATION_CHAIN", "INTENTS"],
    [BASE, "nep141:usdc.test", "120132", "INTENTS", NEAR, "DESTINATION_CHAIN", "INTENTS"]
  ])
  assert.deepEqual([r.q.depositAddress, r.q.assetId, r.q.amount, r.q.symbol, r.q.chain], ["dq-1", BASE, "120132", "USDC", "base"])
  assert.deepEqual([r.n.symbol, r.n.chain], ["USDC", "near"])
  assert.equal(r.refused.length, 3)
  assert.deepEqual(r.rows.map((x) => [x.deposit_address, x.direction, x.symbol, x.chain, x.origin_asset, x.origin_amount]), [
    ["dq-1", "back", "USDC", "base", BASE, "120132"],
    ["dq-2", "back", "USDC", "near", BASE, "120132"]
  ])
  assert.deepEqual(r.listed.map((x) => [x.direction, x.phase, x.amountOut]), [["back", "swapping", "0.117732"]], "on its way, in sight")
})

test("a Top-Up the app paid stays in sight past its deadline until 1Click settles it, and an unseen one is chased", async () => {
  const w = mainnetTopUp()
  const tx = "0x" + "cd".repeat(32)
  const r = await w.run((t, sql) =>
    Effect.gen(function*() {
      yield* t.quote(EVM, BASE, 1_000_000) // dq-1: paid
      yield* t.quote(EVM, BASE, 1_000_000) // dq-2: never paid
      const bad = yield* Effect.flip(t.sent(EVM, "dq-1", "0x1234"))
      yield* t.sent(NEAR, "dq-1", tx) // not theirs: nothing happens
      yield* t.sent(EVM, "dq-1", tx)
      yield* sql`UPDATE intents_swaps SET deadline = now() - interval '10 minutes'`
      const listed = yield* t.transfers(EVM)
      yield* t.trackNow
      yield* t.trackNow
      return { bad: bad.message, listed }
    })
  )
  assert.equal(r.bad, "That isn't a transaction hash")
  assert.deepEqual(w.submitted, [{ txHash: tx, depositAddress: "dq-1" }], "passed on to 1Click once, for the customer's own quote")
  assert.deepEqual(r.listed.map((x) => [x.depositAddress, x.phase, x.depositTx]), [["dq-1", "awaiting-transfer", tx]], "the unpaid quote is gone; the paid one isn't")
  assert.equal(w.told.length, 2, "told once, not on every pass")
  assert.ok(w.told[0]!.startsWith(`${EVM}: 1Click hasn't confirmed your $0.12 Top-Up transfer (0.13 USDC on Base) yet.`), w.told[0])
  assert.match(w.told[1]!, new RegExp(`^admin: 1Click hasn't seen a paid Top-Up: deposit dq-1, tx ${tx} on Base`))
})

test("a notice Telegram didn't take is sent again on a later pass, even once the swap is done, and only until it's taken", async () => {
  const answers = [false, true]
  const w = mainnetTopUp({}, { status: "SUCCESS", deliver: () => answers.shift() ?? true })
  const r = await w.run((t, sql) =>
    Effect.gen(function*() {
      yield* t.quote(NEAR, BASE, 1_000_000)
      for (let i = 0; i < 3; i++) yield* t.trackNow
      return (yield* sql<{ told: Array<string>; retell: boolean }>`SELECT told, retell FROM intents_swaps`)[0]!
    })
  )
  assert.equal(w.told.length, 2, "failed once, delivered on the next pass, then left alone")
  assert.ok(w.told.every((x) => x.includes("landed in your NEAR wallet")))
  assert.deepEqual([[...r.told], r.retell], [["landed"], false])
})

// ---------- a customer's quote is checked as strictly as our own refills' ----------

test("a quote is used only when 1Click's echo matches what was asked: recipient, refund address, tokens, amount, and how each moves", () => {
  const asked: QuoteRequest = {
    dry: false,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: BASE,
    destinationAsset: "nep141:usdc.near",
    amount: "1000000",
    recipient: NEAR,
    recipientType: "DESTINATION_CHAIN",
    refundTo: NEAR,
    refundType: "INTENTS",
    deadline: "2026-11-16T00:00:00.000Z"
  }
  const honest = { originAsset: BASE, destinationAsset: "nep141:usdc.near", recipient: NEAR, swapType: "EXACT_OUTPUT", amount: "1000000", refundTo: NEAR, depositType: "ORIGIN_CHAIN", recipientType: "DESTINATION_CHAIN", refundType: "INTENTS" }
  assert.equal(echoProblem(honest, asked), undefined)
  assert.equal(echoProblem({ ...honest, recipient: "0xAbC", refundTo: "0xAbC" }, { ...asked, recipient: "0xabc", refundTo: "0xabc" }), undefined, "an address may come back in another case")
  assert.match(echoProblem(undefined, asked) ?? "", /didn't confirm/)
  const bad: Array<[string, object, RegExp]> = [
    ["someone else is paid", { recipient: "mallory.near" }, /different recipient/],
    ["paid inside NEAR Intents instead of to the account", { recipientType: "INTENTS" }, /different recipient/],
    ["someone else is refunded", { refundTo: "mallory.near" }, /different refund address/],
    ["refunded on the origin chain to a NEAR account name", { refundType: "ORIGIN_CHAIN" }, /different refund address/],
    ["another token in", { originAsset: "nep141:other" }, /different tokens/],
    ["another token out", { destinationAsset: "nep141:other" }, /different tokens/],
    ["paid from inside NEAR Intents", { depositType: "INTENTS" }, /different way to pay/],
    ["an exact-input swap", { swapType: "EXACT_INPUT" }, /different amount/],
    ["another amount", { amount: "999999" }, /different amount/],
    ["a field left out", { refundType: undefined }, /different refund address/]
  ]
  for (const [name, change, why] of bad) assert.match(echoProblem({ ...honest, ...change } as never, asked) ?? "", why, name)
})

test("a Top-Up, a withdrawal or a send-back whose quote 1Click doesn't confirm, or confirms differently, is refused and never recorded", async () => {
  const said = <A>(e: Effect.Effect<A, { message: string }>) => e.pipe(Effect.match({ onFailure: (err) => err.message, onSuccess: () => "ok" }))
  const attempt = (echo: (asked: QuoteRequest) => object | undefined) => {
    const w = mainnetTopUp({ [BASE]: "120132" }, { echo })
    return w.run((t, sql) =>
      Effect.gen(function*() {
        const said3 = [yield* said(t.quote(NEAR, BASE, 1_000_000)), yield* said(t.exit(EVM, BASE, 1_000_000)), yield* said(t.sendBack(EVM, BASE))]
        const [rows] = yield* sql<{ n: number }>`SELECT count(*)::int AS n FROM intents_swaps`
        return { said3, recorded: rows!.n }
      })
    )
  }
  assert.deepEqual(await attempt((x) => x), { said3: ["ok", "ok", "ok"], recorded: 3 }, "an honest echo goes through")

  const none = await attempt(() => undefined)
  assert.equal(none.recorded, 0)
  for (const m of none.said3) assert.match(m, /1Click didn't confirm what it quoted\. Try again\./)

  // For a NEAR wallet's Top-Up only the refund address used to be compared: another recipient went through.
  const stranger = await attempt((x) => ({ ...x, recipient: "mallory.near" }))
  assert.equal(stranger.recorded, 0)
  for (const m of stranger.said3) assert.match(m, /1Click quoted a different recipient\. Try again\./)

  const refund = await attempt((x) => ({ ...x, refundTo: "mallory.near" }))
  assert.equal(refund.recorded, 0)
  for (const m of refund.said3) assert.match(m, /different refund address/)
})

test("a price check is still shown when 1Click doesn't echo it, since nothing is paid into it", async () => {
  const w = mainnetTopUp({}, { echo: () => undefined })
  const q = await w.run((t) => t.quote(NEAR, BASE, 1_000_000, true))
  assert.equal(q.depositAddress, "dq-1")
})

// ---------- signing in is free: what one account can make the server follow is capped ----------

test("an account's unpaid quotes are capped: the eleventh is refused before 1Click is asked, until one is paid or lapses", async () => {
  const w = mainnetTopUp({ [BASE]: "120132" })
  const said = <A>(e: Effect.Effect<A, { message: string }>) => e.pipe(Effect.match({ onFailure: (err) => err.message, onSuccess: () => "ok" }))
  const r = await w.run((t, sql) =>
    Effect.gen(function*() {
      for (let i = 0; i < 10; i++) yield* t.quote(EVM, BASE, 1_000_000) // dq-1 … dq-10
      const refused = [yield* said(t.quote(EVM, BASE, 1_000_000)), yield* said(t.exit(EVM, BASE, 1_000_000)), yield* said(t.sendBack(EVM, BASE))]
      const askedSoFar = w.asked.length
      // A price check creates nothing, and another customer has their own ten.
      const others = [yield* said(t.quote(EVM, BASE, 1_000_000, true)), yield* said(t.quote(NEAR, BASE, 1_000_000))]
      // 1Click sees one paid into, and another lapses: unpaid, and past the two hours it's still watched after its deadline.
      yield* sql`UPDATE intents_swaps SET status = 'PROCESSING' WHERE deposit_address = 'dq-1'`
      yield* sql`UPDATE intents_swaps SET deadline = now() - interval '3 hours' WHERE deposit_address = 'dq-2'`
      const room = [yield* said(t.quote(EVM, BASE, 1_000_000)), yield* said(t.exit(EVM, BASE, 1_000_000)), yield* said(t.quote(EVM, BASE, 1_000_000))]
      // Naming a transaction for a quote doesn't free its place: only 1Click seeing the money does.
      yield* t.sent(EVM, "dq-3", "0x" + "cd".repeat(32))
      const claimed = yield* said(t.quote(EVM, BASE, 1_000_000))
      return { refused, askedSoFar, others, room, claimed }
    })
  )
  assert.equal(r.refused.length, 3)
  for (const m of r.refused) assert.match(m, /several quotes open already/, "a Top-Up, a withdrawal and a send-back all count")
  assert.equal(r.askedSoFar, 10, "a refused quote never reaches 1Click")
  assert.deepEqual(r.others, ["ok", "ok"])
  assert.equal(r.room[0], "ok")
  assert.equal(r.room[1], "ok")
  assert.match(r.room[2]!, /several quotes open already/, "two places came free, no more")
  assert.match(r.claimed, /several quotes open already/)
})

test("two real quotes for one account at the same moment: one goes ahead, so the cap can't be raced", async () => {
  const w = mainnetTopUp()
  const said = <A>(e: Effect.Effect<A, { message: string }>) => e.pipe(Effect.match({ onFailure: (err) => err.message, onSuccess: () => "ok" }))
  const r = await w.run((t) =>
    Effect.gen(function*() {
      const both = yield* Effect.all([said(t.quote(EVM, BASE, 1_000_000)), said(t.quote(EVM, BASE, 1_000_000))], { concurrency: 2 })
      return { both, after: yield* said(t.quote(EVM, BASE, 1_000_000)) }
    })
  )
  assert.deepEqual([...r.both].sort(), ["One quote at a time. Try again in a moment.", "ok"])
  assert.equal(r.after, "ok", "the guard is given back")
})

test("a swap 1Click has seen money in is checked every pass, however many unpaid quotes are waiting; unpaid ones still get part of each pass", async () => {
  const quotes = (sql: SqlClient.SqlClient, n: number, prefix: string, status: string | null, checkedAt: Date) =>
    sql`INSERT INTO intents_swaps (deposit_address, account_id, direction, usdc, status, checked_at, deadline)
        SELECT ${prefix} || i, 'someone.near', 'in', 1000000, ${status}, ${checkedAt}, now() + interval '30 minutes' FROM generate_series(1, ${n}) i`
  const anHourAgo = new Date(Date.now() - 3_600_000)
  // 200 quotes nobody paid into, none checked for an hour; one swap in flight, checked a moment ago.
  const flood = mainnetTopUp()
  await flood.run((t, sql) =>
    Effect.gen(function*() {
      // The pass that runs at start-up finishes first, so it can't race the rows below.
      yield* Effect.sleep("100 millis")
      yield* quotes(sql, 200, "unpaid-", null, anHourAgo)
      yield* quotes(sql, 1, "paid-", "PROCESSING", new Date())
      yield* t.trackNow
    })
  )
  assert.equal(flood.checked.length, 40)
  assert.ok(flood.checked.includes("paid-1"), "the swap with money in it isn't behind 200 unpaid quotes")

  // 50 swaps in flight and 20 unpaid quotes: the swaps don't take the whole pass.
  const busy = mainnetTopUp()
  await busy.run((t, sql) =>
    Effect.gen(function*() {
      yield* Effect.sleep("100 millis")
      yield* quotes(sql, 50, "paid-", "PROCESSING", anHourAgo)
      yield* quotes(sql, 20, "unpaid-", null, new Date())
      yield* t.trackNow
    })
  )
  assert.equal(busy.checked.filter((a) => a.startsWith("paid-")).length, 30)
  assert.equal(busy.checked.filter((a) => a.startsWith("unpaid-")).length, 10, "a payment just made is still noticed")
})

test("a quote 1Click calls KNOWN_DEPOSIT_TX (a hash it was told about) still holds its place in the cap and waits with the unpaid ones", async () => {
  const said = <A>(e: Effect.Effect<A, { message: string }>) => e.pipe(Effect.match({ onFailure: (err) => err.message, onSuccess: () => "ok" }))
  const w = mainnetTopUp({ [BASE]: "120132" })
  const r = await w.run((t, sql) =>
    Effect.gen(function*() {
      for (let i = 0; i < 10; i++) yield* t.quote(EVM, BASE, 1_000_000)
      // A hash named for each, which 1Click now knows of.
      yield* sql`UPDATE intents_swaps SET status = 'KNOWN_DEPOSIT_TX', deposit_tx = '0x' || repeat('cd', 32)`
      return yield* said(t.quote(EVM, BASE, 1_000_000))
    })
  )
  assert.match(r, /several quotes open already/)

  // 200 of them checked an hour ago, and one swap 1Click is processing, checked a moment ago: it isn't pushed out.
  const flood = mainnetTopUp()
  await flood.run((t, sql) =>
    Effect.gen(function*() {
      yield* Effect.sleep("100 millis")
      yield* sql`INSERT INTO intents_swaps (deposit_address, account_id, direction, usdc, status, deposit_tx, checked_at, deadline)
                 SELECT 'named-' || i, 'someone.near', 'in', 1000000, 'KNOWN_DEPOSIT_TX', 'tx-' || i, now() - interval '1 hour', now() + interval '30 minutes'
                 FROM generate_series(1, 200) i`
      yield* sql`INSERT INTO intents_swaps (deposit_address, account_id, direction, usdc, status, checked_at, deadline)
                 VALUES ('paid-1', 'someone.near', 'in', 1000000, 'PROCESSING', now(), now() + interval '30 minutes')`
      yield* t.trackNow
    })
  )
  assert.ok(flood.checked.includes("paid-1"), "the swap with money in it isn't behind 200 named hashes")
})

test("paid Top-Ups 1Click hasn't seen reach the admin one by one only up to a handful; past that, one line says so", async () => {
  const w = mainnetTopUp()
  await w.run((t, sql) =>
    Effect.gen(function*() {
      // The pass that runs at start-up finishes first, so it can't race the rows below.
      yield* Effect.sleep("100 millis")
      // Twelve Top-Ups of several accounts, each with a transaction named for it, ten minutes past their deadline.
      yield* sql`INSERT INTO intents_swaps (deposit_address, account_id, direction, usdc, symbol, chain, amount_in, deposit_tx, deadline)
                 SELECT 'named-' || i, 'someone' || i || '.near', 'in', 1000000, 'USDC', 'base', '1.01', 'tx-' || i, now() - interval '10 minutes' FROM generate_series(1, 12) i`
      yield* t.trackNow
    })
  )
  const admin = w.told.filter((x) => x.startsWith("admin: "))
  const oneByOne = admin.filter((x) => x.includes("1Click hasn't seen a paid Top-Up: deposit named-"))
  const summary = admin.filter((x) => x.includes("More than 5 paid Top-Ups in the last two hours are unseen by 1Click"))
  assert.ok(oneByOne.length <= 5, `${oneByOne.length} one by one`)
  assert.ok(summary.length >= 7 && new Set(summary).size === 1, "the rest share one text, which goes out at most hourly")
  assert.equal(oneByOne.length + summary.length, 12, "every one of them was accounted for")
  assert.equal(w.told.filter((x) => !x.startsWith("admin: ")).length, 12, "each customer is still told about their own")
})

// ---------- a token 1Click doesn't take, paid through a swap (ADR-0014) ----------

test("an ORE Top-Up: 1Click is quoted for USDC on Solana, the wallet signs our swap for exactly the ORE shown, and only a payment found on chain counts", async () => {
  const SOL_ID = "ad1e2d1d642de1e151c749df291187b0f92b4aad725f7fac726709a85f87e5cf"
  const OTHER = "b".repeat(64)
  const PAYER = Keypair.generate().publicKey.toBase58()
  const ORE = SWAP_TOKENS[0]!
  const built: Array<{ payer: string; depositAddress: string; need: bigint; spend: bigint }> = []
  const looked: Array<[string, bigint]> = []
  let paid: string | undefined
  const swaps = Layer.succeed(Swap, Swap.of({
    tokens: Effect.succeed([{ ...ORE, price: 71.5 }]),
    size: (_t, need) => Effect.succeed(need * 1_400n),
    transaction: (o) => Effect.sync(() => (built.push(o), { transaction: `tx-${built.length}`, lastValidBlockHeight: 7 })),
    paidBy: (address, need) => Effect.sync(() => (looked.push([address, need]), paid))
  }))
  const w = mainnetTopUp({}, { swaps })
  const r = await w.run((t, sql) =>
    Effect.gen(function*() {
      const assets = yield* t.assets
      const q = yield* t.quote(SOL_ID, swapAssetId(ORE), 5_000_000, false, "solana") // dq-1
      const q2 = yield* t.quote(SOL_ID, swapAssetId(ORE), 5_000_000, false, "solana") // dq-2
      const refused = yield* Effect.all([t.swapTx(SOL_ID, q.depositAddress, "near"), t.swapTx(OTHER, q.depositAddress, "solana")].map(Effect.flip))
      const tx = yield* t.swapTx(SOL_ID, q.depositAddress, "solana")
      const again = yield* t.swapTx(SOL_ID, q.depositAddress, "solana")
      const busy = yield* Effect.flip(t.solanaPay(q.depositAddress, PAYER))
      const pay = yield* t.solanaPay(q2.depositAddress, PAYER)
      // The app's word that it sent the swap isn't a payment: the swap may still fail, and another may be sent.
      yield* t.sent(SOL_ID, q.depositAddress, "5".repeat(87))
      const [{ deposit_tx: told = null } = {}] = yield* sql<{ deposit_tx: string | null }>`SELECT deposit_tx FROM intents_swaps WHERE deposit_address = 'dq-1'`
      paid = "5sig"
      yield* t.trackNow
      const after = yield* Effect.flip(t.solanaPay(q.depositAddress, PAYER))
      const rows = yield* sql<SwapRow>`SELECT * FROM intents_swaps ORDER BY deposit_address`
      const listed = yield* t.transfers(SOL_ID)
      return { assets, q, refused, tx, again, busy, pay, told, after, rows, listed }
    })
  )
  const ore = r.assets.find((a) => a.symbol === "ORE")!
  assert.deepEqual([ore.assetId, ore.chain, ore.contract, ore.decimals, ore.swap], [swapAssetId(ORE), "sol", ORE.mint, 11, true])
  assert.deepEqual(w.asked.map((a) => [a.originAsset, a.swapType, a.amount, a.refundTo, a.refundType])[0], [SOL_USDC_ASSET, "EXACT_OUTPUT", "5000000", solanaAddress(SOL_ID), "ORIGIN_CHAIN"],
    "1Click's side is USDC on Solana; its change goes back to the Solana wallet")
  // 1Click's fake asks for exactly the 5 USDC it quotes; the swap is sized for that.
  assert.deepEqual([r.q.symbol, r.q.chain, r.q.swap, r.q.amountIn, r.q.amountInFormatted, r.q.usdcOut], ["ORE", "sol", true, "7000000000", "0.07", 117732])
  assert.deepEqual(r.refused.map((e) => e.message), ["Pay from a Solana wallet: scan the code with Phantom, Solflare or Backpack.", "No Top-Up is paid that way"])
  assert.equal(r.tx.transaction, "tx-1")
  assert.equal(r.again.transaction, "tx-2", "the app asks only to send: sending again after a failed swap needs a fresh route")
  assert.match(r.busy.message, /Another wallet is paying/, "no second wallet's transaction while the first may land")
  assert.equal(r.pay.transaction, "tx-3")
  assert.match(r.pay.message, /\$0\.12 Top-Up for 0\.07 ORE/)
  const own = { token: ORE, payer: solanaAddress(SOL_ID), depositAddress: "dq-1", need: 5_000_000n, spend: 7_000_000_000n, retryBusy: true }
  assert.deepEqual(built, [own, own, { token: ORE, payer: PAYER, depositAddress: "dq-2", need: 5_000_000n, spend: 7_000_000_000n, retryBusy: false }],
    "the wallet signed in, or whichever wallet scanned the code: the same swap (Jupiter asked again when busy only for the one signed in)")
  assert.equal(r.told, null, "a swap the app says it sent isn't recorded as paid")
  assert.deepEqual(looked.slice(0, 2), [["dq-1", 5_000_000n], ["dq-2", 5_000_000n]], "the chain is asked for a payment of the USDC 1Click needs")
  assert.deepEqual(r.rows.map((x) => [x.symbol, x.chain, x.paid_symbol, x.paid_raw, x.amount_in_raw, x.deposit_tx]), [
    ["USDC", "sol", "ORE", "7000000000", "5000000", "5sig"],
    ["USDC", "sol", "ORE", "7000000000", "5000000", "5sig"]
  ])
  assert.deepEqual(w.submitted.map((x) => x.txHash), ["5sig", "5sig"], "only a payment found on chain is passed to 1Click")
  assert.match(r.after.message, /already paid/, "no transaction once it's paid")
  assert.deepEqual(r.listed.map((x) => [x.symbol, x.chain, x.paidWith, x.depositTx]), [["USDC", "sol", "0.07 ORE", "5sig"], ["USDC", "sol", "0.07 ORE", "5sig"]])
})

/**
 * A fake Swap for ORE whose transactions wait on `gate` (open by default) and count each build in `built`; `refuse`
 * answers for a payer instead. `asked` counts every request.
 */
const oreSwaps = (refuse: (payer: string) => SwapUnavailable | undefined = () => undefined) => {
  const ORE = SWAP_TOKENS[0]!
  const built: Array<{ payer: string; depositAddress: string; retryBusy: boolean }> = []
  /** `paid`: the payment found on chain, by deposit address. */
  const s = { gate: Promise.resolve(), asked: 0, paid: {} as Record<string, string> }
  const layer = Layer.succeed(Swap, Swap.of({
    tokens: Effect.succeed([{ ...ORE, price: 71.5 }]),
    size: (_t, need) => Effect.succeed(need * 1_400n),
    transaction: (o) => {
      s.asked++
      const refused = refuse(o.payer)
      return refused
        ? Effect.fail(refused)
        : Effect.promise(async () => {
          built.push({ payer: o.payer, depositAddress: o.depositAddress, retryBusy: o.retryBusy })
          const n = built.length
          await s.gate
          return { transaction: `tx-${n}`, lastValidBlockHeight: 7 }
        })
    },
    paidBy: (address) => Effect.succeed(s.paid[address])
  }))
  return { ORE, built, layer, s }
}
const wallet = () => Keypair.generate().publicKey.toBase58()

test("a swap-paid quote's transaction is built one at a time, at most eight times, and handed again to a wallet scanning its code while it can still land", async () => {
  const SOL_ID = "ad1e2d1d642de1e151c749df291187b0f92b4aad725f7fac726709a85f87e5cf"
  const [PAYER, OTHER, EMPTY] = [wallet(), wallet(), wallet()]
  const f = oreSwaps((payer) => (payer === EMPTY ? new SwapUnavailable({ message: "This wallet doesn't hold the ORE this Top-Up swaps.", early: true }) : undefined))
  const w = mainnetTopUp({}, { swaps: f.layer })
  const said = <A>(e: Effect.Effect<A, { message: string }>) => e.pipe(Effect.match({ onFailure: (err) => err.message, onSuccess: () => "ok" }))
  const real = Date.now()
  let later = 0
  const clock = mock.method(Date, "now", () => real + later)
  try {
    const r = await w.run((t) =>
      Effect.gen(function*() {
        const q = yield* t.quote(SOL_ID, swapAssetId(f.ORE), 5_000_000, false, "solana") // dq-1
        // Refused before Jupiter is asked, however often: no build is used up. Not a wallet at all: Swap isn't asked.
        for (let i = 0; i < 10; i++) yield* said(t.solanaPay(q.depositAddress, EMPTY))
        const notAWallet = yield* said(t.solanaPay(q.depositAddress, "not-a-wallet"))
        const asked = f.s.asked
        // Two requests at once (a wallet asking twice): one builds, the other is told to wait.
        let open = () => {}
        f.s.gate = new Promise<void>((ok) => (open = ok))
        const first = yield* Effect.forkChild(t.solanaPay(q.depositAddress, PAYER))
        for (let i = 0; i < 400 && f.built.length === 0; i++) yield* Effect.sleep("5 millis")
        yield* Effect.forkChild(Effect.sleep("200 millis").pipe(Effect.andThen(Effect.sync(() => open()))))
        const meanwhile = yield* said(t.solanaPay(q.depositAddress, PAYER))
        const tx = (yield* Fiber.join(first)).transaction
        // The same wallet within 30 seconds: the same transaction, nothing built.
        later += 29_000
        const again = (yield* t.solanaPay(q.depositAddress, PAYER)).transaction
        // Past that, a fresh one; another wallet, none while that one may land.
        later += 2_000
        const fresh = (yield* t.solanaPay(q.depositAddress, PAYER)).transaction
        const other = yield* said(t.solanaPay(q.depositAddress, OTHER))
        // Six more builds over the next minutes, then no more for this quote.
        for (let i = 0; i < 6; i++) {
          later += 31_000
          yield* t.solanaPay(q.depositAddress, PAYER)
        }
        later += 31_000
        const spent = yield* said(t.solanaPay(q.depositAddress, PAYER))
        // Another quote has its own eight. The signed-in wallet sending again (its swap failed) gets a new
        // transaction at once, and its requests ask a busy Jupiter again.
        const q2 = yield* t.quote(SOL_ID, swapAssetId(f.ORE), 5_000_000, false, "solana") // dq-2
        const own = [(yield* t.swapTx(SOL_ID, q2.depositAddress, "solana")).transaction, (yield* t.swapTx(SOL_ID, q2.depositAddress, "solana")).transaction]
        return { notAWallet, asked, meanwhile, tx, again, fresh, other, spent, own }
      })
    )
    assert.match(r.notAWallet, /isn't a Solana wallet/)
    assert.equal(r.asked, 10)
    assert.match(r.meanwhile, /on its way/)
    assert.deepEqual([r.tx, r.again, r.fresh], ["tx-1", "tx-1", "tx-2"])
    assert.match(r.other, /Another wallet is paying/)
    assert.match(r.spent, /fetched too many times/)
    assert.deepEqual(r.own, ["tx-9", "tx-10"])
    assert.deepEqual(f.built.map((b) => [b.depositAddress, b.retryBusy]), [...Array(8).fill(["dq-1", false]), ["dq-2", true], ["dq-2", true]],
      "eight builds for the first quote, none asking a busy Jupiter again for a request anyone can make")
  } finally {
    clock.mock.restore()
  }
})

test("Solana Pay: a wallet gets the label, its transaction, or a plain reason, never a server error", async () => {
  const SOL_ID = "ad1e2d1d642de1e151c749df291187b0f92b4aad725f7fac726709a85f87e5cf"
  const [PAYER, BUSY] = [wallet(), wallet()]
  const f = oreSwaps((payer) => (payer === BUSY ? new SwapUnavailable({ message: "Jupiter is busy. Nothing was sent: try again in a few seconds.", busy: true }) : undefined))
  const w = mainnetTopUp({}, { swaps: f.layer })
  const r = await w.run((t) =>
    Effect.gen(function*() {
      const q = yield* t.quote(SOL_ID, swapAssetId(f.ORE), 5_000_000, false, "solana") // dq-1
      const node = createServer()
      return yield* Effect.promise(async () => {
        const url = `http://127.0.0.1:${(node.address() as AddressInfo).port}/solana-pay`
        const post = (path: string, body: string) => fetch(`${url}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body })
        const answer = async (res: Response) => [res.status, await res.json()] as const
        return {
          label: await answer(await fetch(`${url}/${q.depositAddress}`)),
          garbled: await answer(await post(q.depositAddress, "not json")),
          unknown: await answer(await post("nothing-here", JSON.stringify({ account: PAYER }))),
          busy: await answer(await post(q.depositAddress, JSON.stringify({ account: BUSY }))),
          paid: await answer(await post(q.depositAddress, JSON.stringify({ account: PAYER })))
        }
      }).pipe(Effect.provide(HttpRouter.serve(SolanaPayRoute, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provide(NodeHttpServer.layer(() => node, { port: 0, host: "127.0.0.1" })),
        Layer.provide(Layer.succeed(TopUp, t))
      )))
    })
  )
  assert.deepEqual(r.label, [200, { label: "Luckout", icon: "http://localhost:3000/logo.png" }])
  assert.deepEqual([r.garbled[0], r.garbled[1].message], [400, "Send the wallet's account as JSON: {\"account\": \"…\"}."])
  assert.deepEqual(r.unknown, [400, { message: "No Top-Up is paid that way" }])
  assert.deepEqual(r.busy, [400, { message: "Jupiter is busy. Nothing was sent: try again in a few seconds." }])
  assert.equal(r.paid[0], 200)
  assert.equal(r.paid[1].transaction, "tx-1")
  assert.match(r.paid[1].message, /^Luckout: a \$0\.12 Top-Up for 0\.07 ORE$/)
})

test("an unpaid swap-paid quote stops holding a place in the cap ten minutes past its deadline, and is still watched for an hour: a wallet may give its transaction a fresh blockhash and pay late", async () => {
  const SOL_ID = "ad1e2d1d642de1e151c749df291187b0f92b4aad725f7fac726709a85f87e5cf"
  const f = oreSwaps()
  const w = mainnetTopUp({ [BASE]: "120132" }, { swaps: f.layer })
  const said = <A>(e: Effect.Effect<A, { message: string }>) => e.pipe(Effect.match({ onFailure: (err) => err.message, onSuccess: () => "ok" }))
  const watched = (t: TopUp["Service"]) => Effect.gen(function*() {
    w.checked.length = 0
    yield* t.trackNow
    return [...w.checked].sort()
  })
  const r = await w.run((t, sql) =>
    Effect.gen(function*() {
      yield* Effect.sleep("100 millis") // the start-up pass is done
      for (let i = 0; i < 10; i++) yield* t.quote(SOL_ID, swapAssetId(f.ORE), 1_000_000, false, "solana") // dq-1 … dq-10: the price moved on each
      const full = yield* said(t.exit(SOL_ID, BASE, 1_000_000, "solana"))
      yield* sql`UPDATE intents_swaps SET deadline = now() - interval '9 minutes'`
      const stillFull = yield* said(t.quote(SOL_ID, swapAssetId(f.ORE), 1_000_000, false, "solana"))
      yield* sql`UPDATE intents_swaps SET deadline = now() - interval '11 minutes', checked_at = NULL`
      const room = yield* said(t.quote(SOL_ID, swapAssetId(f.ORE), 1_000_000, false, "solana")) // dq-11
      const after11 = yield* watched(t)
      yield* sql`UPDATE intents_swaps SET deadline = now() - interval '61 minutes', checked_at = NULL WHERE deposit_address NOT IN ('dq-1', 'dq-11')`
      const after61 = yield* watched(t)
      // Any other unpaid quote keeps its place for the two hours a late transfer may still arrive in.
      for (let i = 0; i < 10; i++) yield* t.quote(EVM, BASE, 1_000_000)
      yield* sql`UPDATE intents_swaps SET deadline = now() - interval '11 minutes' WHERE account_id = ${EVM}`
      const evm = yield* said(t.quote(EVM, BASE, 1_000_000))
      return { full, stillFull, room, after11, after61, evm }
    })
  )
  assert.match(r.full, /several quotes open already/, "ten unpaid ORE quotes hold every place, a withdrawal's too")
  assert.match(r.stillFull, /several quotes open already/)
  assert.equal(r.room, "ok", "eleven minutes past their deadline, they hold no place")
  assert.equal(r.after11.length, 11, "but are all still checked for a payment")
  assert.deepEqual(r.after61, ["dq-1", "dq-11"], "until an hour past their deadline")
  assert.match(r.evm, /several quotes open already/)
})

test("an EVM wallet's change on Solana from a swap-paid Top-Up goes back to it as USDC on Base", async () => {
  const w = mainnetTopUp({ [SOL_USDC_ASSET]: "251000" })
  const r = await w.run((t) => Effect.all([t.held(EVM), t.sendBack(EVM, SOL_USDC_ASSET)]))
  assert.deepEqual(r[0].map((h) => [h.symbol, h.chain, h.sendable]), [["USDC", "sol", true]])
  assert.deepEqual([r[1].symbol, r[1].chain], ["USDC", "base"])
  assert.deepEqual(w.asked.map((a) => [a.originAsset, a.destinationAsset, a.recipient]), [[SOL_USDC_ASSET, BASE, EVM]])
})

test("a customer dismisses an unpaid Top-Up of theirs: it leaves the list but is still watched, and comes back once money arrives; anyone else's, or a paid one, is refused", async () => {
  const o = { status: "PENDING_DEPOSIT" }
  const w = mainnetTopUp({}, o)
  const said = <A>(e: Effect.Effect<A, { message: string }>) => e.pipe(Effect.match({ onFailure: (err) => err.message, onSuccess: () => "ok" }))
  const r = await w.run((t, sql) =>
    Effect.gen(function*() {
      yield* Effect.sleep("100 millis") // the start-up pass is done
      for (let i = 0; i < 3; i++) yield* t.quote(EVM, BASE, 1_000_000) // dq-1 … dq-3
      yield* t.sent(EVM, "dq-2", "0x" + "cd".repeat(32))
      yield* sql`UPDATE intents_swaps SET status = 'PROCESSING' WHERE deposit_address = 'dq-3'`
      const refused = {
        others: yield* said(t.dismiss(NEAR, "dq-1")),
        sent: yield* said(t.dismiss(EVM, "dq-2")),
        seen: yield* said(t.dismiss(EVM, "dq-3")),
        unknown: yield* said(t.dismiss(EVM, "nothing-here"))
      }
      const twice = [yield* said(t.dismiss(EVM, "dq-1")), yield* said(t.dismiss(EVM, "dq-1"))]
      const listed = (yield* t.transfers(EVM)).map((x) => x.depositAddress).sort()
      w.checked.length = 0
      yield* t.trackNow
      const watched = [...w.checked].sort()
      // Its address was out, so a transfer can still come: 1Click sees it.
      o.status = "PROCESSING"
      yield* t.trackNow
      const back = (yield* t.transfers(EVM)).find((x) => x.depositAddress === "dq-1")
      return { refused, twice, listed, watched, back }
    })
  )
  for (const m of Object.values(r.refused)) assert.match(m, /Only an unpaid Top-Up of yours/)
  assert.deepEqual(r.twice, ["ok", "ok"], "dismissing twice is fine")
  assert.deepEqual(r.listed, ["dq-2", "dq-3"], "a dismissed quote leaves the list")
  assert.ok(r.watched.includes("dq-1"), "but tracking still follows it")
  assert.equal(r.back?.phase, "swapping", "and money sent anyway shows again")
})

test("a dismissed swap-paid Top-Up is cancelled: no transaction is built for it again and it keeps its place in the cap, but one built before still pays it", async () => {
  const SOL_ID = "ad1e2d1d642de1e151c749df291187b0f92b4aad725f7fac726709a85f87e5cf"
  const PAYER = wallet()
  const f = oreSwaps()
  const w = mainnetTopUp({}, { swaps: f.layer })
  const said = <A>(e: Effect.Effect<A, { message: string }>) => e.pipe(Effect.match({ onFailure: (err) => err.message, onSuccess: () => "ok" }))
  const r = await w.run((t, sql) =>
    Effect.gen(function*() {
      const ore = () => said(t.quote(SOL_ID, swapAssetId(f.ORE), 1_000_000, false, "solana"))
      yield* Effect.sleep("100 millis") // the start-up pass is done
      for (let i = 0; i < 10; i++) yield* ore() // dq-1 … dq-10
      // The customer's wallet has dq-1's transaction, not yet approved.
      const before = (yield* t.swapTx(SOL_ID, "dq-1", "solana")).transaction
      const full = yield* ore()
      yield* t.dismiss(SOL_ID, "dq-1")
      const stillFull = yield* ore()
      const refused = [yield* said(t.swapTx(SOL_ID, "dq-1", "solana")), yield* said(t.solanaPay("dq-1", PAYER))]
      const listed = (yield* t.transfers(SOL_ID)).map((x) => x.depositAddress)
      // It's approved after all, and lands.
      f.s.paid["dq-1"] = "5sig"
      yield* sql`UPDATE intents_swaps SET paid_amount = '0.26565993349', checked_at = NULL WHERE deposit_address = 'dq-1'`
      yield* t.trackNow
      const back = (yield* t.transfers(SOL_ID)).find((x) => x.depositAddress === "dq-1")
      const paid = yield* said(t.dismiss(SOL_ID, "dq-1"))
      return { before, full, stillFull, refused, listed, back, paid }
    })
  )
  assert.equal(r.before, "tx-1")
  assert.match(r.full, /several quotes open already/)
  assert.match(r.stillFull, /several quotes open already/, "cancelled, it keeps its place until its deadline is past: each quote costs a Jupiter call")
  for (const m of r.refused) assert.match(m, /cancelled/)
  assert.equal(f.built.length, 1, "nothing is built for it after")
  assert.ok(!r.listed.includes("dq-1"))
  assert.deepEqual(w.submitted, [{ txHash: "5sig", depositAddress: "dq-1" }], "the transaction built before is found on chain and passed to 1Click like any payment")
  assert.deepEqual([r.back?.phase, r.back?.depositTx, r.back?.paidWith], ["awaiting-transfer", "5sig", "0.26566 ORE"], "and it's listed again, its amount readable")
  assert.match(r.paid, /Only an unpaid Top-Up of yours/)
})

test("a dismissed Top-Up whose move-in was armed still moves into the Balance once paid; one 1Click has seen money in can't be dismissed", async () => {
  const sent: Array<string> = []
  const status: Record<string, SwapDetails> = { a: { status: "PENDING_DEPOSIT" }, b: { status: "PENDING_DEPOSIT" } }
  const oneClick = Layer.succeed(OneClick, OneClick.of({
    tokens: Effect.succeed([]),
    quote: () => Effect.die("quote was not expected"),
    status: (a) => Effect.succeed(status[a]!.status),
    details: (a) => Effect.sync(() => status[a]!),
    submitDeposit: () => Effect.void
  }))
  const relay = Layer.succeed(Relay, Relay.of({
    available: () => Effect.succeed(true),
    send: () => Effect.die("relay.send was not expected"),
    sendIntent: (account) => Effect.sync(() => (sent.push(account), { hash: "tx" })),
    settings: Effect.die("relay.settings was not expected"),
    configure: () => Effect.die("relay.configure was not expected")
  }))
  const alerts = Layer.succeed(Alerts, Alerts.of({ admin: () => Effect.void, customer: () => Effect.succeed(true) }))
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
  const r = await Effect.runPromise(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const t = yield* TopUp
    for (const d of ["a", "b"]) {
      yield* sql`INSERT INTO intents_swaps ${
        sql.insert({ deposit_address: d, account_id: EVM, direction: "in", usdc: 2_500_000, symbol: "USDC", chain: "base", amount_in: "2.52", deadline: new Date(Date.now() + 20 * 60_000), move: "waiting" })
      }`
      yield* sql`UPDATE intents_swaps SET move_in = ${JSON.stringify(moveIn)}::jsonb WHERE deposit_address = ${d}`
    }
    yield* Effect.sleep("100 millis") // the start-up pass is done
    yield* t.dismiss(EVM, "a")
    const hidden = (yield* t.transfers(EVM)).map((x) => x.depositAddress)
    // Sent anyway: 1Click delivers a; it has seen money in b.
    status.a = { status: "SUCCESS" }
    status.b = { status: "PROCESSING" }
    yield* sql`UPDATE intents_swaps SET checked_at = NULL`
    yield* t.trackNow
    const late = yield* t.dismiss(EVM, "b").pipe(Effect.flip, Effect.map((e) => e.message))
    const [a] = yield* sql<{ move: string }>`SELECT move FROM intents_swaps WHERE deposit_address = 'a'`
    const listed = (yield* t.transfers(EVM)).map((x) => [x.depositAddress, x.phase])
    return { hidden, move: a?.move, listed, late }
  }).pipe(Effect.provide(TopUp.layer.pipe(Layer.provideMerge(Layer.mergeAll(oneClick, Layer.succeed(Near, fakeNear()), relay, alerts, DbMemory, noSwaps))))))
  assert.deepEqual(r.hidden, ["b"], "dismissed, it leaves the list")
  assert.deepEqual(sent, [EVM], "its armed move-in is sent once its money landed")
  assert.equal(r.move, "moved")
  assert.ok(r.listed.some(([d, p]) => d === "a" && p === "done"), "and it's listed again, done")
  assert.match(r.late, /Only an unpaid Top-Up of yours/)
})
