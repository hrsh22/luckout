import { Purchase, Quote, Voucher } from "@luckout/api"
import { Effect } from "effect"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { makeAgent } from "./Agent.ts"

// A fake OpenAI-compatible endpoint that plays back scripted model turns and records what it was sent.
const fakeModel = async (turns: Array<object>) => {
  const seen: Array<{ messages: Array<{ role: string; content?: string }> }> = []
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push(JSON.parse(body))
      const message = turns[seen.length - 1] ?? { role: "assistant", content: "done" }
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "fake", choices: [{ index: 0, finish_reason: "stop", message }] }))
    })
  })
  await new Promise<void>((r) => server.listen(0, r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, close: () => server.close() }
}

const call = (name: string, args: object) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: `c-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }]
})

let bought = 0
const deps = {
  bitrefill: {
    voucher: () => Effect.succeed(new Voucher({ id: "test-gift-card-code", name: "Test Gift Card Code", countryCode: "KN", currency: "USD", packages: [{ value: "10", priceMicroUsdc: 10_000_000 }] }))
  },
  purchases: {
    quote: () => Effect.succeed(new Quote({ mode: { lucky: 2 }, referencePrice: 10_000_000, luckyAmount: 10_000_000, maxPrice: 15_000_000 })),
    create: () => Effect.sync(() => void bought++),
    list: () =>
      Effect.succeed([
        new Purchase({
          id: "p1", voucherId: "test-gift-card-code", voucherName: "Test Gift Card Code", value: "10", status: "delivered",
          referencePrice: 10_000_000, redemption: { code: "SECRET-CODE-123" }, createdAt: new Date(0).toISOString()
        })
      ])
  },
  near: { view: () => Effect.succeed(null) }
} as never

test("prepare_purchase returns a confirmation and buys nothing", async () => {
  const model = await fakeModel([call("prepare_purchase", { voucher_id: "test-gift-card-code", value: "10", mode: "jackpot" }), { role: "assistant", content: "Tap Buy to confirm." }])
  const agent = makeAgent({ ...(deps as object), testnet: true, apiKey: "test", baseURL: model.url, model: "fake" } as never)
  const turn = await agent("alice.testnet", [], "buy me a 10 dollar test card on jackpot")
  model.close()
  assert.equal(bought, 0, "the model can't buy; only the customer's tap can")
  assert.deepEqual(turn.pending, {
    voucherId: "test-gift-card-code", voucherName: "Test Gift Card Code", value: "10", mode: { lucky: 2 }, maxPrice: 15_000_000, referencePrice: 10_000_000
  })
  assert.equal(turn.reply, "Tap Buy to confirm.")
})

test("voucher codes never reach the model", async () => {
  const model = await fakeModel([call("recent_purchases", {}), { role: "assistant", content: "Here they are." }])
  const agent = makeAgent({ ...(deps as object), testnet: true, apiKey: "test", baseURL: model.url, model: "fake" } as never)
  await agent("alice.testnet", [], "what did I buy?")
  model.close()
  assert.ok(!JSON.stringify(model.seen).includes("SECRET-CODE-123"))
  assert.ok(JSON.stringify(model.seen).includes("Test Gift Card Code"), "the tool result itself did reach the model")
})
