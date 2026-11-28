import { Keypair } from "@solana/web3.js"
import { ConfigProvider, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Alerts } from "./Alerts.ts"
import { DbMemory } from "./Db.ts"
import { Deposits } from "./Deposits.ts"
import { echoProblem, OneClick, type QuoteRequest, type SwapDetails } from "./OneClick.ts"
import { SOL_USDC_ASSET, Swap, swapAssetId, SWAP_TOKENS, SwapUnavailable } from "./Swap.ts"
import { isLate, noticeFor, phaseOf, refundProblem, type SwapRow, TopUp } from "./TopUp.ts"

const ME = Keypair.generate().publicKey.toBase58()
const OTHER = Keypair.generate().publicKey.toBase58()
const EVM = "0x" + "a".repeat(40)
const BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"
const tokens = [
  { assetId: BASE, blockchain: "base", symbol: "USDC", contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 },
  { assetId: "nep141:sol.omft.near", blockchain: "sol", symbol: "SOL", decimals: 9 },
  { assetId: "nep141:eth.omft.near", blockchain: "eth", symbol: "ETH", decimals: 18 },
  { assetId: "nep141:wrap.near", blockchain: "near", symbol: "wNEAR", decimals: 24 },
  { assetId: "nep141:btc.omft.near", blockchain: "btc", symbol: "BTC", decimals: 8 },
  { assetId: "nep141:tron-usdt.omft.near", blockchain: "tron", symbol: "USDT", decimals: 6 },
  { assetId: SOL_USDC_ASSET, blockchain: "sol", symbol: "USDC", contractAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  { assetId: "nep141:sol-usdt.omft.near", blockchain: "sol", symbol: "USDT", decimals: 6 }
]
const noSwaps = Layer.succeed(Swap, Swap.of({ tokens: Effect.succeed([]), transaction: () => Effect.die("swap.transaction was not expected"), held: () => Effect.succeed([]) }))
const said = <A>(e: Effect.Effect<A, { message: string }>) => e.pipe(Effect.match({ onFailure: (err) => err.message, onSuccess: () => "ok" }))

/**
 * A TopUp whose 1Click records each quote request: an EXACT_OUTPUT price asks 1% more in, and a FLEX_INPUT quote takes
 * what it's given with 1% of room under it. `echo`: what 1Click says it will do, given what was asked (default:
 * exactly that; undefined for no echo at all).
 */
const world = (o: {
  status?: string | ((address: string) => SwapDetails)
  echo?: (asked: QuoteRequest) => object | undefined
  deliver?: () => boolean
  swaps?: Layer.Layer<Swap>
  cluster?: string
} = {}) => {
  const asked: Array<QuoteRequest> = []
  const submitted: Array<{ txHash: string; depositAddress: string }> = []
  const told: Array<string> = []
  /** The deposit addresses whose status 1Click was asked for, in order. */
  const checked: Array<string> = []
  const s = { nudged: 0 }
  let paidInto = 0
  const oneClick = Layer.succeed(OneClick, OneClick.of({
    tokens: Effect.succeed(tokens),
    quote: (r) => {
      asked.push(r)
      const exact = r.swapType === "EXACT_OUTPUT"
      const amountIn = exact ? String((BigInt(r.amount) * 101n) / 100n) : r.amount
      return Effect.succeed({
        quote: {
          ...(r.dry ? {} : { depositAddress: `dq-${++paidInto}` }),
          amountIn,
          amountInFormatted: String(Number(amountIn) / 1e6),
          ...(exact ? {} : { minAmountIn: String((BigInt(r.amount) * 99n) / 100n) }),
          amountOut: exact ? r.amount : String((BigInt(r.amount) * 100n) / 101n),
          timeEstimate: 12
        },
        quoteRequest: (o.echo ?? ((x: QuoteRequest) => x))({ ...r })
      } as never)
    },
    status: () => Effect.succeed("PENDING_DEPOSIT"),
    details: (address) =>
      Effect.sync(() => {
        checked.push(address)
        return typeof o.status === "function" ? o.status(address) : { status: o.status ?? "PENDING_DEPOSIT" }
      }),
    submitDeposit: (i) => Effect.sync(() => void submitted.push(i))
  }))
  const alerts = Layer.succeed(Alerts, Alerts.of({
    admin: (text) => Effect.sync(() => void told.push(`admin: ${text}`)),
    customer: (account, text) => Effect.sync(() => (told.push(`${account}: ${text}`), (o.deliver ?? (() => true))()))
  }))
  const unused = () => Effect.die("not expected")
  const deposits = Layer.succeed(Deposits, Deposits.of({
    approval: unused, status: unused, account: unused, sweep: Effect.void, withdrawal: unused, limits: unused, defaultMode: unused, reclaim: unused,
    nudge: Effect.sync(() => void s.nudged++)
  }))
  const run = <A, E>(f: (t: TopUp["Service"], sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.gen(function*() {
      return yield* f(yield* TopUp, yield* SqlClient.SqlClient)
    }).pipe(Effect.provide(TopUp.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(oneClick, alerts, DbMemory, o.swaps ?? noSwaps, deposits)),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ SOLANA_CLUSTER: o.cluster ?? "mainnet" })))
    ))))
  return { asked, submitted, told, checked, s, run }
}

// ---------- a Top-Up delivers USDC on Solana to the Deposit Address ----------

test("a Top-Up is a FLEX_INPUT quote that delivers USDC on Solana to the customer's Deposit Address, refunding to the address they give on the source chain", async () => {
  const w = world()
  const r = await w.run((t, sql) =>
    Effect.gen(function*() {
      const q = yield* t.quote(ME, BASE, 2_500_000, EVM)
      const rows = yield* sql<SwapRow>`SELECT * FROM intents_swaps`
      return { q, rows }
    })
  )
  const [price, flex] = w.asked
  assert.deepEqual([price!.swapType, price!.dry, price!.amount], ["EXACT_OUTPUT", true, "2500000"], "first, what to send for the USDC asked for: a price, which creates nothing")
  assert.deepEqual(flex, {
    ...price,
    dry: false,
    swapType: "FLEX_INPUT",
    amount: "2525000"
  }, "then the quote paid into: that much in, whatever arrives above its minimum swapped")
  assert.deepEqual(
    [flex!.originAsset, flex!.destinationAsset, flex!.recipient, flex!.recipientType, flex!.depositType, flex!.refundTo, flex!.refundType],
    [BASE, SOL_USDC_ASSET, ME, "DESTINATION_CHAIN", "ORIGIN_CHAIN", EVM, "ORIGIN_CHAIN"]
  )
  assert.deepEqual([r.q.depositAddress, r.q.amountIn, r.q.minAmountIn, r.q.usdcOut, r.q.symbol, r.q.chain, r.q.refundTo], ["dq-1", "2525000", "2499750", 2_500_000, "USDC", "base", EVM])
  assert.deepEqual(r.rows.map((x) => [x.deposit_address, x.account_id, Number(x.usdc), x.amount_in, x.refund_to]), [["dq-1", ME, 2_500_000, "2.525", EVM]])
})

test("a price check asks 1Click once, creates nothing, and is shown even when 1Click doesn't echo it", async () => {
  const w = world({ echo: () => undefined })
  const r = await w.run((t, sql) => Effect.all([t.quote(ME, BASE, 2_500_000, EVM, true), sql<{ n: number }>`SELECT count(*)::int AS n FROM intents_swaps`]))
  assert.deepEqual([r[0].depositAddress, r[0].amountIn, r[0].usdcOut], ["", "2525000", 2_500_000])
  assert.equal(w.asked.length, 1)
  assert.equal(r[1][0]!.n, 0)
})

test("a refund address is required, and checked lightly for its chain before 1Click is asked", () => {
  const ok: Array<[string, string]> = [
    ["base", EVM], ["eth", "0x53a19a03679E8d5e9253a998dcde6c71dbb002a2"], ["sol", ME], ["near", "alice.near"], ["near", "a".repeat(64)],
    ["btc", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"], ["btc", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"], ["tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"]
  ]
  for (const [chain, address] of ok) assert.equal(refundProblem(chain, address), undefined, `${address} on ${chain}`)
  const wrong: Array<[string, string]> = [
    ["base", ""], ["base", "0x123"], ["base", ME], ["sol", EVM], ["sol", "not-a-key"], ["near", "Alice.near"], ["btc", EVM],
    ["tron", EVM], ["tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6"], ["dogecoin", EVM]
  ]
  for (const [chain, address] of wrong) assert.match(refundProblem(chain, address) ?? "", /isn't an address on/, `${address} on ${chain}`)
})

test("a Top-Up is refused before 1Click is asked: an unknown or Solana USDC token, an amount outside 1–2,000 USDC, a refund address on another chain, off mainnet", async () => {
  const w = world()
  const r = await w.run((t) =>
    Effect.all([
      said(t.quote(ME, "nep141:unknown", 2_500_000, EVM)),
      said(t.quote(ME, SOL_USDC_ASSET, 2_500_000, ME)),
      said(t.quote(ME, BASE, 500_000, EVM)),
      said(t.quote(ME, BASE, 2_000_000_001, EVM)),
      said(t.quote(ME, BASE, 2_500_000, ME)),
      said(t.quote(EVM, BASE, 2_500_000, EVM))
    ])
  )
  assert.match(r[0], /isn't supported/)
  assert.match(r[1], /isn't supported/, "USDC on Solana goes straight to the Deposit Address")
  assert.match(r[2], /between 1 and 2,000/)
  assert.match(r[3], /between 1 and 2,000/)
  assert.match(r[4], /isn't an address on Base/)
  assert.match(r[5], /sign in again/, "only a Solana wallet has a Deposit Address")
  assert.equal(w.asked.length, 0)
  const devnet = world({ cluster: "devnet" })
  assert.match(await devnet.run((t) => said(t.quote(ME, BASE, 2_500_000, EVM))), /mainnet only/)
  assert.equal(await devnet.run((t) => said(t.quote(ME, BASE, 2_500_000, EVM, true))), "ok", "a price check is fine anywhere")
})

test("the tokens offered: 1Click's from other chains (Tron's too, not USDC or USDT on Solana), and those swapped from the wallet", async () => {
  const ORE = SWAP_TOKENS.find((x) => x.symbol === "ORE")!
  const swaps = Layer.succeed(Swap, Swap.of({ tokens: Effect.succeed([{ ...ORE, price: 71.5 }]), transaction: () => Effect.die("not expected"), held: () => Effect.succeed([]) }))
  const assets = await world({ swaps }).run((t) => t.assets)
  assert.deepEqual(assets.map((a) => `${a.symbol} on ${a.chain}${a.swap ? " (swap)" : ""}`), [
    "USDC on base", "SOL on sol", "ETH on eth", "wNEAR on near", "BTC on btc", "USDT on tron", "ORE on sol (swap)"
  ])
})

test("a quote tells the customer, and records, when refunds begin (30 min), not when 1Click's address closes (days later)", async () => {
  const w = world()
  const r = await w.run((t, sql) =>
    Effect.gen(function*() {
      const q = yield* t.quote(ME, BASE, 1_000_000, EVM)
      const [row] = yield* sql<{ deadline: Date }>`SELECT deadline FROM intents_swaps`
      return { shown: Date.parse(q.deadline), stored: new Date(row!.deadline).getTime(), asked: Date.parse(w.asked[1]!.deadline) }
    })
  )
  const inHalfAnHour = (ms: number) => Math.abs(ms - (Date.now() + 30 * 60_000)) < 60_000
  assert.ok(inHalfAnHour(r.shown) && inHalfAnHour(r.stored) && inHalfAnHour(r.asked))
})

// ---------- a customer's quote is checked as strictly as our own refills' ----------

test("a quote is used only when 1Click's echo matches what was asked: recipient, refund address, tokens, amount, and how each moves", () => {
  const asked: QuoteRequest = {
    dry: false,
    swapType: "FLEX_INPUT",
    slippageTolerance: 100,
    originAsset: BASE,
    destinationAsset: SOL_USDC_ASSET,
    amount: "1010000",
    recipient: ME,
    recipientType: "DESTINATION_CHAIN",
    refundTo: EVM,
    refundType: "ORIGIN_CHAIN",
    depositType: "ORIGIN_CHAIN",
    deadline: "2026-11-28T00:00:00.000Z"
  }
  const honest = { originAsset: BASE, destinationAsset: SOL_USDC_ASSET, recipient: ME, swapType: "FLEX_INPUT", amount: "1010000", refundTo: EVM, depositType: "ORIGIN_CHAIN", recipientType: "DESTINATION_CHAIN", refundType: "ORIGIN_CHAIN" }
  assert.equal(echoProblem(honest, asked), undefined)
  assert.equal(echoProblem({ ...honest, refundTo: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, asked), undefined, "an EVM address may come back checksummed")
  assert.match(echoProblem(undefined, asked) ?? "", /didn't confirm/)
  const bad: Array<[string, object, RegExp]> = [
    ["someone else is paid", { recipient: OTHER }, /different recipient/],
    ["a Solana address in another case is another address", { recipient: ME.toLowerCase() }, /different recipient/],
    ["paid inside NEAR Intents instead of to the wallet", { recipientType: "INTENTS" }, /different recipient/],
    ["someone else is refunded", { refundTo: "0x" + "b".repeat(40) }, /different refund address/],
    ["refunded inside NEAR Intents", { refundType: "INTENTS" }, /different refund address/],
    ["another token in", { originAsset: "nep141:other" }, /different tokens/],
    ["another token out", { destinationAsset: "nep141:other" }, /different tokens/],
    ["paid from inside NEAR Intents", { depositType: "INTENTS" }, /different way to pay/],
    ["an exact-input swap", { swapType: "EXACT_INPUT" }, /different amount/],
    ["another amount", { amount: "999999" }, /different amount/],
    ["a field left out", { refundType: undefined }, /different refund address/]
  ]
  for (const [name, change, why] of bad) assert.match(echoProblem({ ...honest, ...change } as never, asked) ?? "", why, name)
})

test("a Top-Up whose quote 1Click doesn't confirm, or confirms differently, is refused and never recorded", async () => {
  const attempt = (echo: (asked: QuoteRequest) => object | undefined) =>
    world({ echo }).run((t, sql) =>
      Effect.gen(function*() {
        const message = yield* said(t.quote(ME, BASE, 1_000_000, EVM))
        const [rows] = yield* sql<{ n: number }>`SELECT count(*)::int AS n FROM intents_swaps`
        return { message, recorded: rows!.n }
      })
    )
  assert.deepEqual(await attempt((x) => x), { message: "ok", recorded: 1 }, "an honest echo goes through")
  assert.deepEqual(await attempt(() => undefined), { message: "1Click didn't confirm what it quoted. Try again.", recorded: 0 })
  assert.deepEqual(await attempt((x) => ({ ...x, recipient: OTHER })), { message: "1Click quoted a different recipient. Try again.", recorded: 0 })
  assert.deepEqual(await attempt((x) => ({ ...x, refundTo: "0x" + "b".repeat(40) })), { message: "1Click quoted a different refund address. Try again.", recorded: 0 })
  assert.deepEqual(await attempt((x) => ({ ...x, swapType: "EXACT_INPUT" })), { message: "1Click quoted a different amount. Try again.", recorded: 0 })
})

// ---------- money in transit stays in sight ----------

const row = (o: Partial<SwapRow>): SwapRow => ({
  deposit_address: "d",
  deposit_memo: null,
  account_id: ME,
  usdc: "2500000",
  symbol: "USDC",
  chain: "base",
  amount_in: "2.525765",
  deposited: null,
  deadline: null,
  time_estimate: 60,
  status: null,
  deposit_seen_at: null,
  status_at: null,
  delivered_tx: null,
  refunded: null,
  refund_reason: null,
  refund_to: EVM,
  deposit_tx: null,
  told: [],
  created_at: new Date(),
  ...o
})

test("every Top-Up says where the money is, in the customer's words", () => {
  const cases: Array<[string | null, string]> = [
    [null, "awaiting-transfer"],
    ["PENDING_DEPOSIT", "awaiting-transfer"],
    ["KNOWN_DEPOSIT_TX", "swapping"],
    ["PROCESSING", "swapping"],
    ["INCOMPLETE_DEPOSIT", "incomplete"],
    ["SUCCESS", "done"],
    ["REFUNDED", "refunded"],
    ["FAILED", "refunded"]
  ]
  for (const [status, phase] of cases) assert.equal(phaseOf(row({ status })), phase, String(status))
})

test("a Top-Up is late once 1Click has had the money well past its usual time, never before or after", () => {
  const now = Date.now()
  const seen = (minutes: number) => new Date(now - minutes * 60_000)
  assert.equal(isLate(row({ status: "PROCESSING", deposit_seen_at: seen(5) }), now), false, "under 10 minutes")
  assert.equal(isLate(row({ status: "PROCESSING", deposit_seen_at: seen(11) }), now), true)
  assert.equal(isLate(row({ status: "PROCESSING", deposit_seen_at: seen(11), time_estimate: 600 }), now), false, "3× a 10-minute estimate")
  assert.equal(isLate(row({ status: "PENDING_DEPOSIT", deposit_seen_at: null }), now), false, "we're waiting for the customer, not 1Click")
  assert.equal(isLate(row({ status: "SUCCESS", deposit_seen_at: seen(90) }), now), false, "done is never late")
  assert.equal(isLate(row({ status: "INCOMPLETE_DEPOSIT", deposit_seen_at: seen(90) }), now), false, "a short payment waits on the customer, who is told so")
})

test("each notice says what happened and what to do, and where a refund goes; keyed so it's sent once", () => {
  const web = "https://luckout.example"
  const now = Date.now()
  const n = (o: Partial<SwapRow>) => noticeFor(row(o), now, web)
  assert.equal(n({ status: "SUCCESS" }), undefined, "the deposit sweep tells the customer when it reaches their Balance")
  const refund = n({ status: "REFUNDED", refunded: "2.5", refund_reason: "Deposit came in after the deadline" })!
  assert.equal(refund.key, "refunded")
  assert.match(refund.text, new RegExp(`2\\.53 USDC on Base\\) didn't go through: Deposit came in after the deadline\\. 1Click sent 2\\.50 USDC back to ${EVM} on Base\\.`))
  assert.match(n({ status: "REFUNDED", refunded: "0.15", refund_reason: "QUOTE_EXPIRED" })!.text, /didn't go through: the full amount didn't arrive before the deadline\. 1Click sent 0\.15 USDC back/)
  const late = n({ status: "PROCESSING", deposit_seen_at: new Date(now - 30 * 60_000), deposit_address: "abc" })!
  assert.equal(late.key, "late")
  assert.match(late.text, /taking longer than usual\. It's safe.*explorer\.near-intents\.org\/transactions\/abc/)
  assert.equal(n({ status: "PROCESSING", deposit_seen_at: new Date(now - 60_000) }), undefined, "nothing to say yet")
  assert.equal(n({ status: "PENDING_DEPOSIT" }), undefined)
  const short = n({ status: "INCOMPLETE_DEPOSIT", deposited: "0.15", deadline: new Date(now + 20.5 * 60_000) })!
  assert.equal(short.key, "incomplete")
  assert.match(short.text, new RegExp(`^1Click got 0\\.15 of the 2\\.53 USDC on Base your \\$2\\.50 Top-Up needs\\. Send the rest to the same address within 20 min, or what arrived goes back to ${EVM} on Base\\.`))
  assert.match(n({ status: "INCOMPLETE_DEPOSIT", deposited: "0.15", deadline: new Date(now - 60_000) })!.text, /needs\. What arrived goes back to/)
  const paid = { status: "PENDING_DEPOSIT", deposit_tx: "0x" + "ab".repeat(32), deposit_address: "dq" }
  const unseen = n({ ...paid, deadline: new Date(now - 6 * 60_000) })!
  assert.equal(unseen.key, "unseen")
  assert.match(unseen.text, new RegExp(`^1Click hasn't confirmed your \\$2\\.50 Top-Up transfer \\(2\\.53 USDC on Base\\) yet\\. It's at 1Click's deposit address: it either goes through or comes back to ${EVM} on Base\\.`))
  assert.equal(n({ ...paid, deadline: new Date(now - 60_000) }), undefined, "1Click gets a few minutes past the deadline")
  assert.equal(n({ ...paid, deposit_tx: null, deadline: new Date(now - 6 * 60_000) }), undefined, "nobody said they paid")
})

test("tracking follows every Top-Up, sweeps the Deposit Address once one is delivered, tells each customer once, and lists what's in transit", async () => {
  const scripted: Record<string, SwapDetails> = {
    delivered: { status: "SUCCESS", deliveredTx: "5solanaTx" },
    refunded: { status: "REFUNDED", refunded: "2.5", refundReason: "Deposit came in after the deadline" },
    late: { status: "PROCESSING" },
    short: { status: "INCOMPLETE_DEPOSIT", deposited: "0.15" },
    awaiting: { status: "PENDING_DEPOSIT" },
    abandoned: { status: "PENDING_DEPOSIT" }
  }
  const w = world({ status: (a) => scripted[a]! })
  const r = await w.run((t, sql) =>
    Effect.gen(function*() {
      yield* Effect.sleep("100 millis") // the start-up pass is done
      const add = (address: string, o: Record<string, unknown>) =>
        sql`INSERT INTO intents_swaps ${sql.insert({ deposit_address: address, account_id: ME, direction: "in", usdc: 2_500_000, symbol: "USDC", chain: "base", amount_in: "2.525765", time_estimate: 60, refund_to: EVM, ...o })}`
      yield* add("delivered", {})
      yield* add("refunded", {})
      yield* add("late", { status: "PROCESSING", deposit_seen_at: new Date(Date.now() - 30 * 60_000) })
      yield* add("awaiting", { deadline: new Date(Date.now() + 20 * 60_000) })
      yield* add("short", { account_id: OTHER, deadline: new Date(Date.now() + 20 * 60_000) })
      yield* add("abandoned", { deadline: new Date(Date.now() - 3 * 3_600_000), created_at: new Date(Date.now() - 4 * 3_600_000) })
      yield* t.trackNow
      yield* t.trackNow
      return { mine: yield* t.transfers(ME), other: yield* t.transfers(OTHER) }
    })
  )
  assert.equal(w.s.nudged, 1, "one sweep, when its USDC was delivered, not on every pass")
  assert.ok(!w.checked.includes("abandoned"), "a quote nobody paid into, long past its deadline, isn't checked")
  assert.equal(w.told.length, 3, w.told.join("\n"))
  assert.ok(w.told.some((x) => x.startsWith(`${OTHER}: 1Click got 0.15 of the 2.53 USDC on Base your $2.50 Top-Up needs. Send the rest`)))
  assert.ok(w.told.some((x) => x.startsWith(`${ME}: Your Top-Up (2.53 USDC on Base) didn't go through: Deposit came in after the deadline`)))
  assert.ok(w.told.some((x) => x.startsWith(`${ME}: Your $2.50 Top-Up is taking longer than usual`)))
  const byAddress = Object.fromEntries(r.mine.map((x) => [x.depositAddress, x]))
  assert.deepEqual(Object.keys(byAddress).sort(), ["awaiting", "delivered", "late", "refunded"], "the abandoned quote isn't listed")
  assert.deepEqual([byAddress.delivered!.phase, byAddress.delivered!.deliveredTx], ["done", "5solanaTx"])
  assert.equal(byAddress.awaiting!.phase, "awaiting-transfer")
  assert.deepEqual([byAddress.late!.phase, byAddress.late!.late], ["swapping", true])
  assert.deepEqual([byAddress.refunded!.phase, byAddress.refunded!.refunded, byAddress.refunded!.refundTo, byAddress.refunded!.detail], ["refunded", "2.5", EVM, "Deposit came in after the deadline"])
  assert.match(byAddress.refunded!.explorer, /explorer\.near-intents\.org\/transactions\/refunded$/)
  assert.deepEqual(r.other.map((x) => [x.depositAddress, x.phase, x.deposited]), [["short", "incomplete", "0.15"]])
})

test("a Top-Up's status is 1Click's, for the customer's own Top-Ups only", async () => {
  const r = await world().run((t, sql) =>
    Effect.gen(function*() {
      yield* sql`INSERT INTO intents_swaps (deposit_address, account_id, direction, usdc) VALUES ('mine', ${ME}, 'in', 1000000)`
      return [(yield* t.status(ME, "mine")).status, yield* said(t.status(OTHER, "mine"))]
    })
  )
  assert.deepEqual(r, ["PENDING_DEPOSIT", "No Top-Up of yours has that deposit address"])
})

test("a Top-Up the app paid stays in sight past its deadline until 1Click settles it, and an unseen one is chased", async () => {
  const w = world()
  const tx = "0x" + "cd".repeat(32)
  const r = await w.run((t, sql) =>
    Effect.gen(function*() {
      yield* Effect.sleep("100 millis") // the start-up pass is done
      yield* t.quote(ME, BASE, 1_000_000, EVM) // dq-1: paid
      yield* t.quote(ME, BASE, 1_000_000, EVM) // dq-2: never paid
      const bad = yield* said(t.sent(ME, "dq-1", "0x1234"))
      yield* t.sent(OTHER, "dq-1", tx) // not theirs: nothing happens
      yield* t.sent(ME, "dq-1", tx)
      yield* sql`UPDATE intents_swaps SET deadline = now() - interval '10 minutes'`
      const listed = yield* t.transfers(ME)
      yield* t.trackNow
      yield* t.trackNow
      return { bad, listed }
    })
  )
  assert.equal(r.bad, "That isn't a transaction hash")
  assert.deepEqual(w.submitted, [{ txHash: tx, depositAddress: "dq-1" }], "passed on to 1Click once, for the customer's own quote")
  assert.deepEqual(r.listed.map((x) => [x.depositAddress, x.phase, x.depositTx]), [["dq-1", "awaiting-transfer", tx]], "the unpaid quote is gone; the paid one isn't")
  assert.equal(w.told.length, 2, "told once, not on every pass")
  assert.ok(w.told[0]!.startsWith(`${ME}: 1Click hasn't confirmed your $1.00 Top-Up transfer (1.01 USDC on Base) yet.`), w.told[0])
  assert.match(w.told[1]!, new RegExp(`^admin: 1Click hasn't seen a paid Top-Up: deposit dq-1, tx ${tx} on Base`))
})

test("a notice Telegram didn't take is sent again on a later pass, even once the Top-Up is settled, and only until it's taken", async () => {
  const answers = [false, true]
  const w = world({ status: "REFUNDED", deliver: () => answers.shift() ?? true })
  const r = await w.run((t, sql) =>
    Effect.gen(function*() {
      yield* Effect.sleep("100 millis") // the start-up pass is done
      yield* t.quote(ME, BASE, 1_000_000, EVM)
      for (let i = 0; i < 3; i++) yield* t.trackNow
      return (yield* sql<{ told: Array<string>; retell: boolean }>`SELECT told, retell FROM intents_swaps`)[0]!
    })
  )
  assert.equal(w.told.length, 2, "failed once, delivered on the next pass, then left alone")
  assert.ok(w.told.every((x) => x.includes("didn't go through")))
  assert.deepEqual([[...r.told], r.retell], [["refunded"], false])
})

test("paid Top-Ups 1Click hasn't seen reach the admin one by one only up to a handful; past that, one line says so", async () => {
  const w = world()
  await w.run((t, sql) =>
    Effect.gen(function*() {
      yield* Effect.sleep("100 millis") // the start-up pass is done
      // Twelve Top-Ups of several accounts, each with a transaction named for it, ten minutes past their deadline.
      yield* sql`INSERT INTO intents_swaps (deposit_address, account_id, direction, usdc, symbol, chain, amount_in, deposit_tx, deadline)
                 SELECT 'named-' || i, 'someone' || i, 'in', 1000000, 'USDC', 'base', '1.01', 'tx-' || i, now() - interval '10 minutes' FROM generate_series(1, 12) i`
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

// ---------- signing in is free: what one account can make the server follow is capped ----------

test("an account's unpaid quotes are capped: the eleventh is refused before 1Click is asked, until one is paid or lapses", async () => {
  const w = world()
  const r = await w.run((t, sql) =>
    Effect.gen(function*() {
      for (let i = 0; i < 10; i++) yield* t.quote(ME, BASE, 1_000_000, EVM) // dq-1 … dq-10
      const refused = yield* said(t.quote(ME, BASE, 1_000_000, EVM))
      const askedSoFar = w.asked.length
      // A price check creates nothing, and another customer has their own ten.
      const others = [yield* said(t.quote(ME, BASE, 1_000_000, EVM, true)), yield* said(t.quote(OTHER, BASE, 1_000_000, EVM))]
      // 1Click sees one paid into, and another lapses: unpaid, and past the two hours it's still watched after its deadline.
      yield* sql`UPDATE intents_swaps SET status = 'PROCESSING' WHERE deposit_address = 'dq-1'`
      yield* sql`UPDATE intents_swaps SET deadline = now() - interval '3 hours' WHERE deposit_address = 'dq-2'`
      const room = [yield* said(t.quote(ME, BASE, 1_000_000, EVM)), yield* said(t.quote(ME, BASE, 1_000_000, EVM)), yield* said(t.quote(ME, BASE, 1_000_000, EVM))]
      // Naming a transaction for a quote doesn't free its place: only 1Click seeing the money does.
      yield* sql`UPDATE intents_swaps SET status = 'PROCESSING' WHERE deposit_address = 'dq-3'`
      yield* t.sent(ME, "dq-4", "0x" + "cd".repeat(32))
      const claimed = yield* said(t.quote(ME, BASE, 1_000_000, EVM))
      return { refused, askedSoFar, others, room, claimed }
    })
  )
  assert.match(r.refused, /several quotes open already/)
  assert.equal(r.askedSoFar, 20, "a refused quote never reaches 1Click")
  assert.deepEqual(r.others, ["ok", "ok"])
  assert.deepEqual(r.room.slice(0, 2), ["ok", "ok"])
  assert.match(r.room[2]!, /several quotes open already/, "two places came free, no more")
  assert.equal(r.claimed, "ok", "dq-3 was seen; dq-4's named hash frees nothing")
})

test("two real quotes for one account at the same moment: one goes ahead, so the cap can't be raced", async () => {
  const r = await world().run((t) =>
    Effect.gen(function*() {
      const both = yield* Effect.all([said(t.quote(ME, BASE, 1_000_000, EVM)), said(t.quote(ME, BASE, 1_000_000, EVM))], { concurrency: 2 })
      return { both, after: yield* said(t.quote(ME, BASE, 1_000_000, EVM)) }
    })
  )
  assert.deepEqual([...r.both].sort(), ["One quote at a time. Try again in a moment.", "ok"])
  assert.equal(r.after, "ok", "the guard is given back")
})

test("a Top-Up 1Click has seen money in is checked every pass, however many unpaid quotes are waiting; unpaid ones still get part of each pass", async () => {
  const quotes = (sql: SqlClient.SqlClient, n: number, prefix: string, status: string | null, checkedAt: Date, deposit_tx: string | null = null) =>
    sql`INSERT INTO intents_swaps (deposit_address, account_id, direction, usdc, status, checked_at, deadline, deposit_tx)
        SELECT ${prefix} || i, 'someone', 'in', 1000000, ${status}, ${checkedAt}, now() + interval '30 minutes', ${deposit_tx} FROM generate_series(1, ${n}) i`
  const anHourAgo = new Date(Date.now() - 3_600_000)
  // 200 quotes nobody paid into (or only named a hash for, which 1Click now knows of), none checked for an hour; one
  // in flight, checked a moment ago.
  for (const [status, tx] of [[null, null], ["KNOWN_DEPOSIT_TX", "tx"]] as const) {
    const flood = world()
    await flood.run((t, sql) =>
      Effect.gen(function*() {
        yield* Effect.sleep("100 millis")
        yield* quotes(sql, 200, "unpaid-", status, anHourAgo, tx)
        yield* quotes(sql, 1, "paid-", "PROCESSING", new Date())
        yield* t.trackNow
      })
    )
    assert.equal(flood.checked.length, 40)
    assert.ok(flood.checked.includes("paid-1"), "the Top-Up with money in it isn't behind 200 unpaid quotes")
  }
  // 50 in flight and 20 unpaid quotes: the ones in flight don't take the whole pass.
  const busy = world()
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

test("a customer dismisses an unpaid Top-Up of theirs: it leaves the list but is still watched, and comes back once money arrives; anyone else's, or a paid one, is refused", async () => {
  const o = { status: "PENDING_DEPOSIT" }
  const w = world({ status: () => ({ status: o.status }) })
  const r = await w.run((t, sql) =>
    Effect.gen(function*() {
      yield* Effect.sleep("100 millis") // the start-up pass is done
      for (let i = 0; i < 3; i++) yield* t.quote(ME, BASE, 1_000_000, EVM) // dq-1 … dq-3
      yield* t.sent(ME, "dq-2", "0x" + "cd".repeat(32))
      yield* sql`UPDATE intents_swaps SET status = 'PROCESSING' WHERE deposit_address = 'dq-3'`
      const refused = [said(t.dismiss(OTHER, "dq-1")), said(t.dismiss(ME, "dq-2")), said(t.dismiss(ME, "dq-3")), said(t.dismiss(ME, "nothing-here"))]
      const messages = yield* Effect.all(refused)
      const twice = [yield* said(t.dismiss(ME, "dq-1")), yield* said(t.dismiss(ME, "dq-1"))]
      const listed = (yield* t.transfers(ME)).map((x) => x.depositAddress).sort()
      w.checked.length = 0
      yield* t.trackNow
      const watched = [...w.checked].sort()
      // Its address was out, so a transfer can still come: 1Click sees it.
      o.status = "PROCESSING"
      yield* t.trackNow
      const back = (yield* t.transfers(ME)).find((x) => x.depositAddress === "dq-1")
      return { messages, twice, listed, watched, back }
    })
  )
  for (const m of r.messages) assert.match(m, /Only an unpaid Top-Up of yours/)
  assert.deepEqual(r.twice, ["ok", "ok"], "dismissing twice is fine")
  assert.deepEqual(r.listed, ["dq-2", "dq-3"], "a dismissed quote leaves the list")
  assert.ok(r.watched.includes("dq-1"), "but tracking still follows it")
  assert.equal(r.back?.phase, "swapping", "and money sent anyway shows again")
})

// ---------- USDT and ORE in the wallet: a swap the customer signs (Swap.ts) ----------

test("a swap from the wallet: the token named and the amount asked for, or all of it; what it gives comes back with the transaction to sign", async () => {
  const USDT = SWAP_TOKENS.find((x) => x.symbol === "USDT")!
  const asked: Array<{ symbol: string; wallet: string; spend: bigint | undefined }> = []
  const swaps = Layer.succeed(Swap, Swap.of({
    tokens: Effect.succeed([]),
    transaction: (o) =>
      o.spend === 1n
        ? Effect.fail(new SwapUnavailable({ message: "That's less than 1 USDC of USDT. Swap at least 1 USDC's worth." }))
        : Effect.sync(() => (asked.push({ symbol: o.token.symbol, wallet: o.wallet, spend: o.spend }),
          { transaction: "tx", token: "bound", spend: o.spend ?? 12_340_000n, usdcOut: 12_300_000n, minUsdcOut: 12_238_500n })),
    held: () => Effect.succeed([])
  }))
  const r = await world({ swaps }).run((t) =>
    Effect.gen(function*() {
      return {
        all: yield* t.swap(ME, swapAssetId(USDT)),
        some: yield* t.swap(ME, swapAssetId(USDT), "5000000"),
        small: yield* said(t.swap(ME, swapAssetId(USDT), "1")),
        unknown: yield* said(t.swap(ME, BASE))
      }
    })
  )
  assert.deepEqual(asked, [{ symbol: "USDT", wallet: ME, spend: undefined }, { symbol: "USDT", wallet: ME, spend: 5_000_000n }])
  assert.deepEqual([r.all.transaction, r.all.token, r.all.spend, r.all.usdcOut, r.all.minUsdcOut], ["tx", "bound", "12340000", 12_300_000, 12_238_500])
  assert.equal(r.some.spend, "5000000")
  assert.match(r.small, /at least 1 USDC's worth/)
  assert.match(r.unknown, /isn't swapped here/)
})

// Live calls to 1Click, only when asked for (pnpm --filter @luckout/server test:live).
const live = { skip: !process.env.LIVE_TESTS && "set LIVE_TESTS=1 to call 1Click" }

test("1Click prices USDC on Base into USDC on Solana at the Deposit Address", live, async () => {
  const q = await Effect.runPromise(TopUp.use((t) => t.quote(ME, BASE, 10_000_000, EVM, true)).pipe(Effect.provide(TopUp.layer.pipe(
    Layer.provide([OneClick.layer, DbMemory, noSwaps, Layer.succeed(Alerts, Alerts.of({ admin: () => Effect.void, customer: () => Effect.succeed(true) }))]),
    Layer.provide(Layer.succeed(Deposits, Deposits.of({} as never)))
  ))))
  assert.equal(q.usdcOut, 10_000_000)
  assert.ok(Number(q.amountInFormatted) >= 10 && Number(q.amountInFormatted) < 10.5, q.amountInFormatted)
})
