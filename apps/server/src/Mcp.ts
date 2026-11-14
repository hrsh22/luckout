import { type DrawEvent, finalPrice, type GameVersion, verify } from "@luckout/api/draw"
import { Config, Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { MODES, modeName, usd, usdUp, worksIn } from "./Agent.ts"
import { Bitrefill } from "./Bitrefill.ts"
import { Near, Network } from "./Near.ts"
import { Purchases } from "./Purchases.ts"
import { Telegram } from "./Telegram.ts"

// Luckout as a tool for other AI agents: a read-only MCP server (Streamable HTTP at POST /mcp,
// JSON replies, no sessions). An agent can search gift cards, price one in every mode with its
// exact odds, read the fairness numbers, and recompute any Draw from the chain. Nothing here can
// spend or sign: buying needs the customer's own sign-in and Confirm, so an agent hands its human
// the checkout link instead.

export interface Tool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  run(args: Record<string, unknown>): Promise<unknown>
}

/** A refusal meant for the calling agent; any other error stays in our logs. */
export class ToolError extends Error {}

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]

const reply = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result })
const failure = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } })

/** One JSON-RPC message in, its reply out; undefined for a notification, which gets none. */
export const respond = async (message: unknown, tools: ReadonlyArray<Tool>) => {
  if (!message || typeof message !== "object" || Array.isArray(message)) return failure(null, -32600, "Invalid request")
  const m = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> }
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return failure(m.id ?? null, -32600, "Invalid request")
  if (m.id === undefined) return undefined
  switch (m.method) {
    case "initialize": {
      const asked = m.params?.protocolVersion
      return reply(m.id, {
        protocolVersion: typeof asked === "string" && VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "luckout", version: "1.0.0" },
        instructions:
          "Luckout sells gift cards for USDC on NEAR, at the normal price or with a provably fair chance at cashback. These tools only read: search cards, quote every mode with exact odds, check fairness, verify a Draw. To buy, give your human the buy_url; they sign in and confirm themselves."
      })
    }
    case "ping":
      return reply(m.id, {})
    case "tools/list":
      return reply(m.id, {
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: true } }))
      })
    case "tools/call": {
      const tool = tools.find((t) => t.name === m.params?.name)
      if (!tool) return failure(m.id, -32602, `Unknown tool: ${String(m.params?.name)}`)
      const args = m.params?.arguments
      try {
        const result = await tool.run(args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {})
        return reply(m.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false })
      } catch (e) {
        if (!(e instanceof ToolError)) console.error(`mcp ${tool.name} failed:`, e)
        const text = e instanceof ToolError ? e.message : "Something went wrong on our side. Try again in a moment."
        return reply(m.id, { content: [{ type: "text", text }], isError: true })
      }
    }
    default:
      return failure(m.id, -32601, `Method not found: ${m.method}`)
  }
}

interface Receipt {
  readonly outcome: { readonly logs: ReadonlyArray<string>; readonly executor_id: string; readonly status: Record<string, unknown> }
}

/** The Draw a transaction logged, counting only receipts our contract ran successfully (no look-alikes). */
export const drawEvent = (receipts: ReadonlyArray<Receipt>, contractId: string) =>
  receipts
    .filter((r) => r.outcome.executor_id === contractId && !("Failure" in r.outcome.status))
    .flatMap((r) => r.outcome.logs)
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice(11)) as { standard: string; event: string; data: Array<unknown> })
    .find((e) => e.standard === "luckout" && e.event === "draw")?.data[0] as DrawEvent | undefined

const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/
const ARCHIVAL = { mainnet: "https://archival-rpc.mainnet.fastnear.com", testnet: "https://archival-rpc.testnet.fastnear.com" } as const

const text = (args: Record<string, unknown>, key: string, max = 100) => {
  const v = args[key]
  if (typeof v !== "string" || v.trim() === "" || v.length > max) throw new ToolError(`${key} must be a non-empty string of at most ${max} characters`)
  return v.trim()
}

interface Stats {
  readonly lucky_settled: number
  readonly lucky_amount_total: string
  readonly lucky_paid_total: string
}
interface Reserve {
  readonly free: string
  readonly max_cashback: string
}

export const McpRoute = Layer.unwrap(Effect.gen(function*() {
  const bitrefill = yield* Bitrefill
  const purchases = yield* Purchases
  const near = yield* Near
  const telegram = yield* Telegram
  const network = yield* Network
  const web = yield* Config.String("WEB_ORIGIN").pipe(Config.withDefault("http://localhost:3000"))

  // Same wording as the public catalog endpoints: upstream details stay in our logs.
  const run = async <A>(e: Effect.Effect<A, { message: string }>) => {
    const r = await Effect.runPromise(Effect.match(e, { onFailure: (err) => ({ failed: err.message }), onSuccess: (ok) => ({ ok }) }))
    if (!("failed" in r)) return r.ok
    if (r.failed.startsWith("Bitrefill request failed")) throw new ToolError("Bitrefill isn't answering right now. Try again in a moment.")
    throw new ToolError(r.failed)
  }
  const buyUrl = (id: string) => `${web}/shop/${encodeURIComponent(id)}`

  const tools: Array<Tool> = [
    {
      name: "search_gift_cards",
      description: "Search Luckout's gift cards (Bitrefill's catalog: Amazon, Steam, Swiggy and thousands more) by brand or keyword.",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "Brand or keyword, e.g. 'amazon india'" } }, required: ["query"] },
      run: async (args) => {
        const found = await run(bitrefill.search(text(args, "query")))
        return found.slice(0, 10).map((v) => ({ id: v.id, name: v.name, works_in: worksIn(v.countryCode, v.countryName), currency: v.currency }))
      }
    },
    {
      name: "get_gift_card",
      description: "One gift card's amounts and their USD prices (paid in USDC), plus the page where a human can buy it.",
      inputSchema: { type: "object", properties: { id: { type: "string", description: "Card id from search_gift_cards" } }, required: ["id"] },
      run: async (args) => {
        const v = await run(bitrefill.voucher(text(args, "id")))
        return {
          id: v.id,
          name: v.name,
          works_in: worksIn(v.countryCode, v.countryName),
          currency: v.currency,
          amounts: v.packages.map((p) => ({ value: p.value, price: usd(p.priceMicroUsdc) })),
          buy_url: buyUrl(v.id)
        }
      }
    },
    {
      name: "quote",
      description:
        "Price one amount of a card in every mode (or one): Normal pays the price; Lite, Classic and Jackpot pay more up front for a chance at cashback. Gives each outcome's exact chance and final price, read from the contract's Game Versions. Every lucky mode averages 105.6% of the price.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Card id" },
          value: { type: "string", description: "An amount from get_gift_card, e.g. '500'" },
          mode: { type: "string", enum: ["normal", "lite", "classic", "jackpot"], description: "Omit for all four" }
        },
        required: ["id", "value"]
      },
      run: async (args) => {
        const id = text(args, "id")
        const value = text(args, "value")
        const asked = args.mode === undefined ? undefined : text(args, "mode", 10).toLowerCase()
        if (asked !== undefined && !MODES[asked]) throw new ToolError("mode must be normal, lite, classic or jackpot")
        const modes = asked === undefined ? Object.values(MODES) : [MODES[asked]!]
        const versions = await run(near.view<Array<GameVersion>>("get_game_versions"))
        const quotes = await Promise.all(modes.map(async (m) => {
          const q = await run(purchases.quote(id, value, m === "normal" ? undefined : m.lucky))
          const version = m === "normal" ? undefined : versions[m.lucky]
          const outcomes = version
            ? version.outcomes.map((o) => {
              const price = Number(finalPrice(BigInt(q.referencePrice), BigInt(q.luckyAmount), BigInt(q.maxPrice), o.final_bps))
              return { chance: `${o.chance_bps / 100}%`, final_price: usd(price), cashback: usd(q.maxPrice - price) }
            })
            : [{ chance: "100%", final_price: usd(q.referencePrice), cashback: usd(0) }]
          return { price: usd(q.referencePrice), mode: modeName(m), pay_up_front: usdUp(q.maxPrice), outcomes }
        }))
        return { card_price: quotes[0]?.price, quotes: quotes.map(({ price: _, ...q }) => q), buy_url: buyUrl(id) }
      }
    },
    {
      name: "fairness",
      description:
        "Luckout's live fairness numbers, read from the contract: what lucky buyers have paid on average (promised 105.6%), the Cashback Reserve, the most one purchase can win, and the latest TEE attestation check of the shopping agent's model.",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        const [stats, reserve] = await Promise.all([run(near.view<Stats>("get_stats")), run(near.view<Reserve>("get_reserve"))])
        const attested = await Effect.runPromise(telegram.attestation.pipe(Effect.orElseSucceed(() => undefined)))
        const total = Number(stats.lucky_amount_total)
        return {
          contract: near.contractId,
          network,
          promised_average: "105.6% of the price, in every lucky mode",
          live_average: total > 0 ? `${(Number(stats.lucky_paid_total) / total * 100).toFixed(2)}% over ${stats.lucky_settled} Draws` : "no Draws yet",
          cashback_reserve_free: usd(Number(reserve.free)),
          max_cashback_per_purchase: usd(Number(reserve.max_cashback)),
          agent_model_attestation: attested
            ? {
              ok: attested.ok,
              model: attested.model,
              checked_at: new Date(attested.checkedAt).toISOString(),
              checks_passed: `${attested.checks.filter((c) => c.ok).length}/${attested.checks.length}`
            }
            : "not available",
          page: `${web}/fair`
        }
      }
    },
    {
      name: "verify_draw",
      description:
        "Recompute a Luckout Draw from its NEAR transaction: random value = sha256(block random seed ‖ purchase id), then the roll, the outcome and the Cashback, each compared with what the contract logged.",
      inputSchema: { type: "object", properties: { tx_hash: { type: "string", description: "The NEAR transaction that ran the Draw" } }, required: ["tx_hash"] },
      run: async (args) => {
        const tx = text(args, "tx_hash", 44)
        if (!TX_HASH.test(tx)) throw new ToolError("tx_hash must be a NEAR transaction hash")
        const config = await run(near.view<{ operator: string }>("get_config"))
        // RPC uses the sender only to find the shard; Draws are mostly confirmed by the operator.
        const res = await fetch(ARCHIVAL[network], {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tx", params: { tx_hash: tx, sender_account_id: config.operator, wait_until: "NONE" } }),
          signal: AbortSignal.timeout(15_000)
        }).then((r) => r.json() as Promise<{ result?: { receipts_outcome: Array<Receipt> } }>).catch(() => undefined)
        if (!res?.result) throw new ToolError("NEAR RPC couldn't find that transaction.")
        const draw = drawEvent(res.result.receipts_outcome, near.contractId)
        if (!draw) throw new ToolError("That transaction has no Luckout Draw.")
        const version = (await run(near.view<Array<GameVersion>>("get_game_versions")))[draw.game_version]
        if (!version) throw new ToolError(`Unknown Game Version ${draw.game_version}`)
        const checks = await verify(draw, version)
        return {
          purchase_id: draw.purchase_id,
          mode: version.name,
          all_match: checks.every((c) => c.ok),
          checks: checks.map(({ label, expected, recomputed, ok }) => ({ label, logged: expected, recomputed, ok })),
          proof_page: `${web}/draw/${tx}`
        }
      }
    }
  ]

  return Layer.mergeAll(
    HttpRouter.add("POST", "/mcp", (request) =>
      Effect.gen(function*() {
        const body = yield* request.json.pipe(Effect.map((json) => ({ json })), Effect.orElseSucceed(() => undefined))
        if (!body) return HttpServerResponse.jsonUnsafe(failure(null, -32700, "Parse error"), { status: 400 })
        const out = yield* Effect.promise(() => respond(body.json, tools))
        return out ? HttpServerResponse.jsonUnsafe(out) : HttpServerResponse.empty({ status: 202 })
      })),
    // No server-sent events: every reply comes back on its POST.
    HttpRouter.add("GET", "/mcp", HttpServerResponse.text("Luckout's MCP server: POST JSON-RPC messages here.", { status: 405 }))
  )
}))
