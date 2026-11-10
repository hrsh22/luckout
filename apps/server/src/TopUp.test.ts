import { Effect } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Layer } from "effect"
import { OneClick } from "./OneClick.ts"
import { TopUp } from "./TopUp.ts"

// Live dry-run quotes against 1Click mainnet (no funds move, no key needed).
const run = <A, E>(f: (t: TopUp["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(TopUp.use(f).pipe(Effect.provide(layer)))
const layer = TopUp.layer.pipe(Layer.provide(OneClick.layer))
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
