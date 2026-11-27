import { PublicKey } from "@solana/web3.js"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { Bitrefill } from "./Bitrefill.ts"
import { McpRoute, respond, type Tool, ToolError } from "./Mcp.ts"
import type { Config, GameVersion } from "./Program.ts"
import { Purchases } from "./Purchases.ts"
import { type Outcome, Solana, SolanaUnavailable } from "./Solana.ts"
import { Telegram } from "./Telegram.ts"
import { fakeBitrefill } from "./testing.ts"

const tools: Array<Tool> = [
  { name: "echo", description: "", inputSchema: { type: "object" }, run: async (args) => args },
  { name: "refuse", description: "", inputSchema: { type: "object" }, run: () => Promise.reject(new ToolError("No such card")) },
  { name: "crash", description: "", inputSchema: { type: "object" }, run: () => Promise.reject(new Error("db password is hunter2")) }
]
const call = (method: string, params?: object, id: unknown = 1) => respond({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }, tools)

test("initialize agrees on a protocol version it supports", async () => {
  const known = await call("initialize", { protocolVersion: "2025-03-26" }) as { result: { protocolVersion: string; capabilities: object } }
  assert.equal(known.result.protocolVersion, "2025-03-26")
  assert.deepEqual(known.result.capabilities, { tools: {} })
  const future = await call("initialize", { protocolVersion: "2099-01-01" }) as { result: { protocolVersion: string } }
  assert.equal(future.result.protocolVersion, "2025-06-18")
})

test("notifications get no reply; bad and unknown messages get JSON-RPC errors", async () => {
  assert.equal(await respond({ jsonrpc: "2.0", method: "notifications/initialized" }, tools), undefined)
  assert.equal((await respond([{ jsonrpc: "2.0", id: 1, method: "ping" }], tools) as { error: { code: number } }).error.code, -32600)
  assert.equal((await call("resources/list") as { error: { code: number } }).error.code, -32601)
  assert.equal((await call("tools/call", { name: "nope" }) as { error: { code: number } }).error.code, -32602)
  assert.deepEqual(await call("ping"), { jsonrpc: "2.0", id: 1, result: {} })
})

test("every tool is listed as read-only", async () => {
  const r = await call("tools/list") as { result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> } }
  assert.deepEqual(r.result.tools.map((t) => t.name), ["echo", "refuse", "crash"])
  assert.ok(r.result.tools.every((t) => t.annotations.readOnlyHint))
})

test("a call returns JSON text; a refusal says why; a crash leaks nothing", async () => {
  const ok = await call("tools/call", { name: "echo", arguments: { q: "amazon" } }) as { result: { content: Array<{ text: string }>; isError: boolean } }
  assert.deepEqual(JSON.parse(ok.result.content[0]!.text), { q: "amazon" })
  assert.equal(ok.result.isError, false)
  const refused = await call("tools/call", { name: "refuse" }) as { result: { content: Array<{ text: string }>; isError: boolean } }
  assert.deepEqual([refused.result.isError, refused.result.content[0]!.text], [true, "No such card"])
  const crashed = await call("tools/call", { name: "crash" }) as { result: { content: Array<{ text: string }>; isError: boolean } }
  assert.equal(crashed.result.isError, true)
  assert.doesNotMatch(crashed.result.content[0]!.text, /hunter2/)
})

// verify_draw on a faked chain: the Draw below is worked out here, independently of draw.ts, as the program's game.rs does it.

/** Classic's table, as the program's default_game_versions makes it. */
const CLASSIC: GameVersion = {
  name: "Classic",
  premium_bps: 2_000,
  outcomes: [
    { final_bps: 0, chance_bps: 200 },
    { final_bps: 6_000, chance_bps: 300 },
    { final_bps: 7_200, chance_bps: 400 },
    { final_bps: 8_400, chance_bps: 700 },
    { final_bps: 9_600, chance_bps: 2_400 },
    { final_bps: 12_000, chance_bps: 6_000 }
  ]
}
const RANDOMNESS = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256))

/** Card `card`'s Draw from RANDOMNESS on a $10 Classic card, as the program would record it. */
const drawn = (card: number) => {
  const random = createHash("sha256").update(Buffer.concat([RANDOMNESS, Uint8Array.of(card)])).digest()
  const roll = Number(random.readBigUInt64LE(0) % 10_000n)
  let cumulative = 0
  const final_bps = CLASSIC.outcomes.find((o) => roll < (cumulative += o.chance_bps))!.final_bps
  const [reference, lucky, max] = [10_000_000n, 10_000_000n, 12_000_000n]
  const paid = reference - lucky + (lucky * BigInt(final_bps) + 9_999n) / 10_000n
  const final_price = paid < max ? paid : max
  return {
    checkout: PublicKey.default, card, round: 0, randomness: RANDOMNESS, random, roll, game_version: 1,
    reference_price: reference, lucky_amount: lucky, max_price: max, final_bps, final_price, cashback: max - final_price
  }
}

const SIG = "5".repeat(87)

test("verify_draw recomputes each card's Draw from the program's record, and says when there's none or Solana isn't answering", async () => {
  // What the chain holds: undefined for no such (or a failed) transaction.
  let landed: () => Effect.Effect<Outcome | undefined, SolanaUnavailable> = () => Effect.succeed(undefined)
  const solana = Solana.of({
    transaction: () => landed(),
    config: Effect.succeed({ versions: [CLASSIC, CLASSIC, CLASSIC] } as unknown as Config)
  } as unknown as Solana["Service"])
  const { handler, dispose } = HttpRouter.toWebHandler(
    McpRoute.pipe(Layer.provide([
      Layer.succeed(Bitrefill, fakeBitrefill()),
      Layer.succeed(Solana, solana),
      Layer.succeed(Purchases, {} as Purchases["Service"]),
      Layer.succeed(Telegram, {} as Telegram["Service"])
    ])),
    { disableLogger: true }
  )
  const verify = async (args: object) => {
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "verify_draw", arguments: args } }
    const res = await handler(new Request("http://luckout.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(call) }))
    const text = (await res.json() as { result: { content: Array<{ text: string }> } }).result.content[0]!.text
    try {
      return JSON.parse(text) as { card: number; all_match: boolean; checks: Array<{ label: string; ok: boolean }>; proof_page: string }
    } catch {
      return text
    }
  }
  const outcome = (events: Array<Record<string, unknown>>): Outcome => ({ signature: SIG, events: events.map((data) => ({ name: "Draw", data })), returnData: undefined, units: 0 })
  try {
    assert.match(String(await verify({ tx_hash: "not-a-signature" })), /must be a Solana transaction signature/)
    assert.equal(await verify({ tx_hash: SIG }), "Solana has no record of that transaction, or it failed.")
    landed = () => Effect.fail(new SolanaUnavailable({ message: "transaction: https://rpc.example/?api-key=secret timed out" }))
    assert.equal(await verify({ tx_hash: SIG }), "Solana isn't answering right now. Try again in a moment.", "never the RPC's URL or key")
    landed = () => Effect.succeed(outcome([]))
    assert.equal(await verify({ tx_hash: SIG }), "That transaction has no Luckout Draw.")

    // Two cards drawn together; the second's record has its Cashback changed by one base unit.
    const forged = { ...drawn(3), cashback: drawn(3).cashback + 1n }
    landed = () => Effect.succeed(outcome([drawn(0), forged]))
    const first = await verify({ tx_hash: SIG })
    assert.ok(typeof first === "object" && first.card === 0 && first.all_match, JSON.stringify(first))
    assert.equal(typeof first === "object" && first.proof_page, `http://localhost:3000/draw/${SIG}?card=0`)
    const second = await verify({ tx_hash: SIG, card: 3 })
    assert.ok(typeof second === "object" && !second.all_match)
    assert.deepEqual(typeof second === "object" && second.checks.filter((c) => !c.ok).map((c) => c.label), ["Cashback"])
  } finally {
    await dispose()
  }
})
