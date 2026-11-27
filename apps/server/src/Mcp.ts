import { finalPrice, verifyCard } from "@luckout/api/draw"
import { Config, Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { MODES, modeName, usd, usdUp, worksIn } from "./Agent.ts"
import { Bitrefill } from "./Bitrefill.ts"
import { type DrawEvent, maxCashback } from "./Program.ts"
import { Purchases } from "./Purchases.ts"
import { Solana } from "./Solana.ts"
import { Telegram } from "./Telegram.ts"

// Luckout as a tool for other AI agents: a read-only MCP server (Streamable HTTP at POST /mcp,
// JSON replies, no sessions). An agent can search gift cards, price one in every mode with its
// exact odds, read the fairness numbers, and recompute any Draw from the chain (Solana, ADR-0015). Nothing here can
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
          "Luckout sells gift cards for USDC on Solana, at the normal price or with a provably fair chance at cashback. These tools only read: search cards, quote every mode with exact odds, check fairness, verify a Draw. To buy, give your human the buy_url; they sign in and confirm themselves."
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

/** A Solana transaction signature: 64 bytes in base58. */
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex")

const text = (args: Record<string, unknown>, key: string, max = 100) => {
  const v = args[key]
  if (typeof v !== "string" || v.trim() === "" || v.length > max) throw new ToolError(`${key} must be a non-empty string of at most ${max} characters`)
  return v.trim()
}

export const McpRoute = Layer.unwrap(Effect.gen(function*() {
  const bitrefill = yield* Bitrefill
  const purchases = yield* Purchases
  const solana = yield* Solana
  const telegram = yield* Telegram
  const web = yield* Config.String("WEB_ORIGIN").pipe(Config.withDefault("http://localhost:3000"))

  // Same wording as the public catalog endpoints: upstream details (an RPC URL holds its key) stay in our logs.
  const run = async <A>(e: Effect.Effect<A, { message: string }>) => {
    const r = await Effect.runPromise(Effect.match(e, {
      onFailure: (err) => ({ failed: "_tag" in err && err._tag === "SolanaUnavailable" ? "Solana isn't answering right now. Try again in a moment." : err.message }),
      onSuccess: (ok) => ({ ok })
    }))
    if (!("failed" in r)) return r.ok
    if (r.failed.startsWith("Bitrefill request failed")) throw new ToolError("Bitrefill isn't answering right now. Try again in a moment.")
    throw new ToolError(r.failed)
  }
  const buyUrl = (id: string) => `${web}/shop/${encodeURIComponent(id)}`

  const tools: Array<Tool> = [
    {
      name: "search_gift_cards",
      description: "Search Luckout's gift cards (sourced from Bitrefill's catalog: Amazon, Steam, Swiggy and thousands more) by brand or keyword.",
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
        "Price one amount of a card in every mode (or one): Normal pays the price; Lite, Classic and Jackpot pay more up front for a chance at cashback. Gives each outcome's exact chance and final price, read from the program's Game Versions. Every lucky mode averages 105.6% of the price.",
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
        const { versions } = await run(solana.config)
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
        "Luckout's live fairness numbers, read from the program: what lucky buyers have paid on average (promised 105.6%), the Cashback Reserve, the most one purchase can win, and the latest TEE attestation check of the shopping agent's model.",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        const config = await run(solana.config)
        const attested = await Effect.runPromise(telegram.attestation.pipe(Effect.orElseSucceed(() => undefined)))
        const total = Number(config.lucky_amount_total)
        return {
          contract: solana.program.id.toBase58(),
          network: solana.cluster,
          promised_average: "105.6% of the price, in every lucky mode",
          live_average: total > 0 ? `${(Number(config.lucky_paid_total) / total * 100).toFixed(2)}% over ${config.lucky_settled} Draws` : "no Draws yet",
          cashback_reserve_free: usd(Number(config.free_reserve)),
          max_cashback_per_purchase: usd(Number(maxCashback(config))),
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
        "Recompute a Luckout Draw from its Solana transaction: random value = sha256(ORAO's randomness ‖ card), then the roll, the outcome and the Cashback, each compared with what the program recorded.",
      inputSchema: {
        type: "object",
        properties: {
          tx_hash: { type: "string", description: "The Solana transaction that finished the Draw" },
          card: { type: "integer", description: "Which card, when the transaction drew several of a Checkout's cards (its link's ?card=)" }
        },
        required: ["tx_hash"]
      },
      run: async (args) => {
        const tx = text(args, "tx_hash", 88)
        if (!SIGNATURE.test(tx)) throw new ToolError("tx_hash must be a Solana transaction signature")
        // Only our program's own records count: a failed transaction has none, and a Draw only another program logged
        // isn't one (Program.decodeEvents).
        const out = await run(solana.transaction(tx))
        if (!out) throw new ToolError("Solana has no record of that transaction, or it failed.")
        const card = Number.isSafeInteger(args.card) ? Number(args.card) : undefined
        const draw = out.events.filter((e) => e.name === "Draw").map((e) => e.data as unknown as DrawEvent).find((d) => card === undefined || d.card === card)
        if (!draw) throw new ToolError("That transaction has no Luckout Draw.")
        const version = (await run(solana.config)).versions[draw.game_version]
        if (!version) throw new ToolError(`Unknown Game Version ${draw.game_version}`)
        const checks = await verifyCard({
          card: draw.card,
          game_version: draw.game_version,
          reference_price: String(draw.reference_price),
          lucky_amount: String(draw.lucky_amount),
          max_price: String(draw.max_price),
          randomness: hex(draw.randomness),
          random: hex(draw.random),
          roll: draw.roll,
          final_bps: draw.final_bps,
          final_price: String(draw.final_price),
          cashback: String(draw.cashback)
        }, version)
        return {
          card: draw.card,
          checkout: draw.checkout.toBase58(),
          mode: version.name,
          all_match: checks.every((c) => c.ok),
          checks: checks.map(({ label, expected, recomputed, ok }) => ({ label, logged: expected, recomputed, ok })),
          proof_page: `${web}/draw/${tx}?card=${draw.card}`
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
