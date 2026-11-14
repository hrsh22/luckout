import assert from "node:assert/strict"
import { test } from "node:test"
import { drawEvent, respond, type Tool, ToolError } from "./Mcp.ts"

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
