import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Bitrefill } from "./Bitrefill.ts"
import { drawEvent, McpRoute, respond, type Tool, ToolError } from "./Mcp.ts"
import { Near } from "./Near.ts"
import { Purchases } from "./Purchases.ts"
import { Telegram } from "./Telegram.ts"
import { fakeBitrefill, fakeNear } from "./testing.ts"

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

test("only our contract's successful receipts can carry a Draw", () => {
  const log = (who: string) => `EVENT_JSON:${JSON.stringify({ standard: "luckout", version: "1.0.0", event: "draw", data: [{ purchase_id: who === "app.luckout.near" ? 10 : 99 }] })}`
  const receipt = (executor_id: string, status: Record<string, unknown> = { SuccessValue: "" }) => ({ outcome: { executor_id, status, logs: [log(executor_id)] } })
  assert.equal(drawEvent([receipt("evil.near"), receipt("app.luckout.near")], "app.luckout.near")?.purchase_id, 10)
  assert.equal(drawEvent([receipt("evil.near")], "app.luckout.near"), undefined)
  assert.equal(drawEvent([receipt("app.luckout.near", { Failure: {} })], "app.luckout.near"), undefined)
})

test("verify_draw tells a transaction NEAR has no record of from NEAR not answering", async () => {
  const realFetch = globalThis.fetch
  // The archival node, faked: whatever `archival` answers.
  let archival = () => new Response("")
  globalThis.fetch = (async () => archival()) as typeof fetch
  const { handler, dispose } = HttpRouter.toWebHandler(
    McpRoute.pipe(Layer.provide([
      Layer.succeed(Bitrefill, fakeBitrefill()),
      Layer.succeed(Near, fakeNear({ view: <A>() => Effect.succeed({ operator: "server.test" } as A) })),
      Layer.succeed(Purchases, {} as Purchases["Service"]),
      Layer.succeed(Telegram, {} as Telegram["Service"])
    ])),
    { disableLogger: true }
  )
  const verify = async () => {
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "verify_draw", arguments: { tx_hash: "4HWu4u4VAKfZZgezdYYLBYctgTdTuWbFEJ5wW6xPoSV2" } } }
    const res = await handler(new Request("http://luckout.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(call) }))
    return (await res.json() as { result: { content: Array<{ text: string }> } }).result.content[0]!.text
  }
  const rpcError = (cause: string, status = 200) => () => Response.json({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: cause } } }, { status })
  try {
    archival = rpcError("UNKNOWN_TRANSACTION")
    assert.equal(await verify(), "NEAR has no record of that transaction.")
    // A hash that can't be one.
    archival = rpcError("PARSE_ERROR", 400)
    assert.equal(await verify(), "NEAR has no record of that transaction.")
    archival = () => new Response("Bad Gateway", { status: 502 })
    assert.match(await verify(), /isn't answering/)
    archival = rpcError("TIMEOUT_ERROR")
    assert.match(await verify(), /isn't answering/)
  } finally {
    globalThis.fetch = realFetch
    await dispose()
  }
})
