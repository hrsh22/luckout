import { Effect } from "effect"
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
import { TopUp } from "./TopUp.ts"

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
const layer = TopUp.layer.pipe(Layer.provide([OneClick.layer, Layer.succeed(Near, fakeNear()), noRelay, DbMemory]))
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
  }).pipe(Effect.provide(TopUp.layer.pipe(Layer.provideMerge(Layer.mergeAll(pending, Layer.succeed(Near, near), noRelay, DbMemory))))))
  assert.match(results.wrongAmount, /doesn't move this Top-Up/)
  assert.deepEqual([results.first, results.same, results.second, results.third], ["ok", "ok", "ok", "ok"])
  assert.match(results.again, /already handled/, "a second signed move-in for the same Top-Up is refused")
  assert.match(results.fourth, /other Top-Ups first/)
})
