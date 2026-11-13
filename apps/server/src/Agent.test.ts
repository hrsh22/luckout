import { Purchase, Quote, Voucher } from "@luckout/api"
import { Effect } from "effect"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { NO_LIMIT } from "@luckout/api"
import { blocker, makeAgent, trimHistory, usdUp } from "./Agent.ts"

// A fake OpenAI-compatible endpoint that plays back scripted model turns and records what it was sent.
const fakeModel = async (turns: Array<object>) => {
  const seen: Array<{ messages: Array<{ role: string; content?: string }> }> = []
  /** The exact bytes of each exchange, which the TEE signature covers. */
  const wire: Array<{ id: string; request: string; response: string }> = []
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push(JSON.parse(body))
      const message = turns[seen.length - 1] ?? { role: "assistant", content: "done" }
      const id = `chat-${seen.length}`
      const response = JSON.stringify({ id, object: "chat.completion", created: 0, model: "fake", choices: [{ index: 0, finish_reason: "stop", message }] })
      wire.push({ id, request: body, response })
      res.setHeader("content-type", "application/json")
      res.end(response)
    })
  })
  await new Promise<void>((r) => server.listen(0, r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, wire, close: () => server.close() }
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
  near: { view: () => Effect.succeed(rich) },
  web: "https://luckout.test",
  shopOpen: Effect.succeed(true),
  verify: async () => true
} as never

// An account that can afford the $15 test purchase, within its limits.
const rich = { balance: "100000000", per_purchase_limit: "50000000", daily_limit: "100000000", day: 0, spent_today: "0", default_mode: "normal" }

test("prepare_purchase returns a confirmation and buys nothing", async () => {
  const model = await fakeModel([call("prepare_purchase", { voucher_id: "test-gift-card-code", value: "10", mode: "jackpot" }), { role: "assistant", content: "Tap Buy to confirm." }])
  const agent = makeAgent({ ...(deps as object), testnet: true, apiKey: "test", baseURL: model.url, model: "fake" } as never)
  const turn = await agent("alice.testnet", [], "buy me a 10 dollar test card on jackpot")
  model.close()
  assert.equal(bought, 0, "the model can't buy; only the customer's tap can")
  assert.deepEqual(turn.pending, {
    voucherId: "test-gift-card-code", voucherName: "Test Gift Card Code", value: "10", currency: "USD", mode: { lucky: 2 }, maxPrice: 15_000_000, referencePrice: 10_000_000, luckyAmount: 10_000_000, country: "KN"
  })
  assert.equal(turn.reply, "Tap Buy to confirm.")
})

test("every completion's exact bytes are checked, and an unverified turn shows nothing", async () => {
  const model = await fakeModel([call("prepare_purchase", { voucher_id: "test-gift-card-code", value: "10", mode: "jackpot" }), { role: "assistant", content: "Tap Buy to confirm." }])
  const checked: Array<{ id: string; request: string; response: string }> = []
  // The tool step verifies; the final reply doesn't.
  const verify = async (request: string, response: string, id: string) => (checked.push({ id, request, response }), id === "chat-1")
  const agent = makeAgent({ ...(deps as object), verify, testnet: true, apiKey: "test", baseURL: model.url, model: "fake" } as never)
  const turn = await agent("alice.testnet", [], "buy me a 10 dollar test card on jackpot")
  model.close()
  assert.deepEqual(checked, model.wire, "the signature check sees exactly what went over the wire")
  assert.equal(turn.pending, undefined, "no Buy button")
  assert.match(turn.reply, /couldn't prove/)
  assert.deepEqual(turn.history, [], "the unverified turn isn't kept")
})

test("voucher codes never reach the model", async () => {
  const model = await fakeModel([call("recent_purchases", {}), { role: "assistant", content: "Here they are." }])
  const agent = makeAgent({ ...(deps as object), testnet: true, apiKey: "test", baseURL: model.url, model: "fake" } as never)
  await agent("alice.testnet", [], "what did I buy?")
  model.close()
  assert.ok(!JSON.stringify(model.seen).includes("SECRET-CODE-123"))
  assert.ok(JSON.stringify(model.seen).includes("Test Gift Card Code"), "the tool result itself did reach the model")
})

test("each turn's prompt starts with the previous turn's exact messages, so it hits the cache", async () => {
  const model = await fakeModel([
    call("search_vouchers", { query: "steam" }),
    { role: "assistant", content: "Found Steam." },
    { role: "assistant", content: "Sure." }
  ])
  const agent = makeAgent({ ...(deps as object), bitrefill: { ...(deps as { bitrefill: object }).bitrefill, search: () => Effect.succeed([]) }, testnet: true, apiKey: "test", baseURL: model.url, model: "fake" } as never)
  const first = await agent("alice.testnet", [], "steam card?")
  await agent("alice.testnet", first.history, "thanks")
  model.close()
  const lastOfFirstTurn = model.seen[1]!.messages
  const secondTurn = model.seen[2]!.messages
  assert.deepEqual(secondTurn.slice(0, lastOfFirstTurn.length), lastOfFirstTurn, "same prefix, tool calls included")
})

test("history is trimmed in one cut, at a customer message", () => {
  const turn = (i: number) => [{ role: "user", content: `q${i}` }, { role: "assistant", content: `a${i}` }] as const
  const h = Array.from({ length: 31 }, (_, i) => turn(i)).flat() as Array<never>
  assert.equal(trimHistory(h.slice(0, 60)).length, 60, "untouched until it grows past the limit")
  const cut = trimHistory(h) as Array<{ role: string }>
  assert.ok(cut.length <= 24 && cut[0]!.role === "user")
})

test("no Confirm button for a purchase the customer can't pay for", async () => {
  const model = await fakeModel([call("prepare_purchase", { voucher_id: "test-gift-card-code", value: "10", mode: "jackpot" }), { role: "assistant", content: "You're short." }])
  const broke = { ...rich, balance: "500000" }
  const agent = makeAgent({ ...(deps as object), near: { view: () => Effect.succeed(broke) }, testnet: true, apiKey: "test", baseURL: model.url, model: "fake" } as never)
  const turn = await agent("alice.testnet", [], "buy it")
  model.close()
  assert.equal(turn.pending, undefined)
  const toolResult = JSON.stringify(model.seen[1]!.messages.at(-1))
  assert.match(toolResult, /\$14\.50 short/)
  assert.match(toolResult, /luckout\.test\/wallet/)
})

test("blocker: balance first, then the per-purchase and daily limits", () => {
  const now = 5 * 86_400_000
  assert.match(blocker(null, 1_000_000, "w")!, /\$0\.00 and this needs \$1\.00/)
  assert.match(blocker({ ...rich, per_purchase_limit: "10000000" } as never, 15_000_000, "w")!, /per-purchase limit of \$10\.00/)
  assert.match(blocker({ ...rich, day: 5, spent_today: "90000000" } as never, 15_000_000, "w", now)!, /daily limit/)
  assert.equal(blocker({ ...rich, day: 4, spent_today: "90000000" } as never, 15_000_000, "w", now), undefined, "yesterday's spending doesn't count")
  const unlimited = { ...rich, balance: "9000000000000", per_purchase_limit: NO_LIMIT, daily_limit: NO_LIMIT, day: 5, spent_today: "8000000000000" }
  assert.equal(blocker(unlimited as never, 900_000_000_000, "w", now), undefined, "No limit: only the balance counts")
})

test("amounts the customer pays round up to the cent, never down", () => {
  assert.equal(usdUp(1_221_000), "$1.23")
  assert.equal(usdUp(1_330_000), "$1.33")
  assert.equal(usdUp(0), "$0.00")
})
