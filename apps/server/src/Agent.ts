import type { Mode } from "@luckout/api"
import { Effect } from "effect"
import OpenAI from "openai"
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions"
import type { Bitrefill } from "./Bitrefill.ts"
import type { Near } from "./Near.ts"
import type { Purchases } from "./Purchases.ts"

// The Agent (ADR-0001, ADR-0006): a plain tool-calling loop on NEAR AI Cloud's
// OpenAI-compatible API. Safety is structural, not prompt-based:
// - the model can only *prepare* a purchase; a human taps Confirm before anything is bought,
//   and the contract's Spending Limits still bound every purchase;
// - Redemption Data never enters the model's context (the bot sends codes itself).

export interface Pending {
  readonly voucherId: string
  readonly voucherName: string
  readonly value: string
  /** Always resolved (the Default Mode when the customer named none), so the button shows the real maximum. */
  readonly mode: Mode
  readonly maxPrice: number
  readonly referencePrice: number
}

const MODES: Record<string, Mode> = { normal: "normal", classic: { lucky: 0 }, bold: { lucky: 1 }, jackpot: { lucky: 2 } }
const usd = (micro: number) => `$${(micro / 1e6).toFixed(2)}`

const tool = (name: string, description: string, properties: Record<string, object> = {}, required: Array<string> = []): ChatCompletionTool => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } }
})
const mode = { type: "string", enum: ["normal", "classic", "bold", "jackpot"], description: "Omit to use the customer's Default Mode" }

const TOOLS = [
  tool("search_vouchers", "Search gift cards, top-ups and eSIMs by brand.", { query: { type: "string" } }, ["query"]),
  tool("get_voucher", "Amounts and current prices (USD) for one voucher.", { voucher_id: { type: "string" } }, ["voucher_id"]),
  tool("get_balance", "The customer's Luckout balance, Spending Limits, Default Mode and Running Total."),
  tool("quote", "The exact quote for one amount in one mode: price and the most they could pay.", {
    voucher_id: { type: "string" },
    value: { type: "string", description: "The amount exactly as get_voucher lists it" },
    mode
  }, ["voucher_id", "value"]),
  tool("prepare_purchase", "Show the customer a Confirm button for this purchase. Nothing is bought until they tap it.", {
    voucher_id: { type: "string" },
    value: { type: "string" },
    mode
  }, ["voucher_id", "value"]),
  tool("recent_purchases", "The customer's last purchases and what they paid (codes are not included).")
]

const system = (testnet: boolean) => `You are Luckout's shopping assistant in Telegram. Luckout sells gift cards, mobile top-ups and eSIMs from Bitrefill, paid from the customer's USDC balance on NEAR.
Modes: Normal pays exactly the price, no draw. Lucky modes pay up to a premium on top (Classic +10%, Bold +25%, Jackpot +50%), and a fair onchain draw can bring the price down, sometimes to half or free; every lucky mode averages 6% above the price. The customer always gets the voucher.
Rules:
- Use tools for every price, balance and quote; never guess numbers.
- To buy, call prepare_purchase; the customer confirms with a button. Never say something was bought before they confirm.
- Only call a result a discount or a win when the Final Price was below the price.
- Voucher codes are delivered by the bot directly; never ask for or repeat them.
- Keep replies short and plain.${testnet ? "\n- This is the testnet demo: only Bitrefill test vouchers (ids starting with test-) can be bought, with test USDC." : ""}`

export const makeAgent = (deps: {
  bitrefill: Bitrefill["Service"]
  purchases: Purchases["Service"]
  near: Near["Service"]
  testnet: boolean
  apiKey: string
  baseURL: string
  model: string
}) => {
  const client = new OpenAI({ apiKey: deps.apiKey, baseURL: deps.baseURL })

  const run = <A>(e: Effect.Effect<A, { message: string }>) =>
    Effect.runPromise(Effect.match(e, { onFailure: (err) => ({ error: err.message }), onSuccess: (a) => a }))

  // The quote must use the mode the contract will apply, so an omitted mode means the Default Mode.
  const resolveMode = (accountId: string, mode: string | undefined) =>
    mode && MODES[mode]
      ? Effect.succeed(MODES[mode]!)
      : deps.near.view<{ default_mode: Mode } | null>("get_account", { account_id: accountId }).pipe(
        Effect.map((a) => a?.default_mode ?? ("normal" as Mode))
      )
  const game = (m: Mode) => (m === "normal" ? undefined : m.lucky)

  const tools = (accountId: string, prepare: (p: Pending) => void) => ({
    search_vouchers: ({ query }: { query: string }) =>
      run(deps.bitrefill.search(query).pipe(Effect.map((vs) => vs.slice(0, 8).map((v) => ({ id: v.id, name: v.name, country: v.countryCode }))))),
    get_voucher: ({ voucher_id }: { voucher_id: string }) =>
      run(deps.bitrefill.voucher(voucher_id).pipe(Effect.map((v) => ({
        name: v.name,
        currency: v.currency,
        amounts: v.packages.map((p) => ({ value: p.value, price: usd(p.priceMicroUsdc) }))
      })))),
    get_balance: () =>
      run(deps.near.view<Record<string, string> | null>("get_account", { account_id: accountId }).pipe(Effect.map((a) =>
        a
          ? {
            balance: usd(Number(a.balance)),
            per_purchase_limit: usd(Number(a.per_purchase_limit)),
            daily_limit: usd(Number(a.daily_limit)),
            spent_today: usd(Number(a.spent_today)),
            default_mode: a.default_mode,
            running_total: usd(Number(a.refunds_received) - Number(a.premiums_paid))
          }
          : { balance: "$0.00", note: "No deposit yet; they can top up in the web app." }
      ))),
    quote: ({ voucher_id, value, mode }: { voucher_id: string; value: string; mode?: string }) =>
      run(resolveMode(accountId, mode).pipe(
        Effect.flatMap((m) => deps.purchases.quote(voucher_id, value, game(m))),
        Effect.map((q) => ({ mode: q.mode, price: usd(q.referencePrice), most_you_pay: usd(q.maxPrice), lucky_part: usd(q.luckyAmount) }))
      )),
    prepare_purchase: ({ voucher_id, value, mode }: { voucher_id: string; value: string; mode?: string }) =>
      run(Effect.gen(function*() {
        const m = yield* resolveMode(accountId, mode)
        const [voucher, q] = yield* Effect.all([deps.bitrefill.voucher(voucher_id), deps.purchases.quote(voucher_id, value, game(m))])
        prepare({ voucherId: voucher.id, voucherName: voucher.name, value, mode: m, maxPrice: q.maxPrice, referencePrice: q.referencePrice })
        return { shown: "A Confirm button is now under your reply." }
      })),
    recent_purchases: () =>
      run(deps.purchases.list(accountId).pipe(Effect.map((ps) => ps.slice(0, 5).map((p) => ({
        voucher: `${p.voucherName} ${p.value}`,
        status: p.status,
        price: usd(p.referencePrice),
        paid: p.draw ? usd(p.draw.finalPrice) : p.status === "delivered" ? usd(p.referencePrice) : null,
        when: p.createdAt
      })))))
  })

  /** One customer turn: runs the tool loop and returns the reply plus any purchase to confirm. */
  return async (accountId: string, history: Array<ChatCompletionMessageParam>, text: string) => {
    let pending: Pending | undefined
    const handlers: Record<string, (args: never) => Promise<unknown>> = tools(accountId, (p) => (pending = p))
    const messages: Array<ChatCompletionMessageParam> = [{ role: "system", content: system(deps.testnet) }, ...history, { role: "user", content: text }]
    for (let step = 0; step < 6; step++) {
      const res = await client.chat.completions.create({ model: deps.model, messages, tools: TOOLS })
      const msg = res.choices[0]?.message
      if (!msg) break
      messages.push(msg)
      const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function")
      if (calls.length === 0) {
        return { reply: msg.content ?? "", pending, history: messages.slice(1).filter((m) => m.role === "user" || (m.role === "assistant" && !m.tool_calls?.length)) }
      }
      for (const c of calls) {
        const handler = handlers[c.function.name]
        const args = JSON.parse(c.function.arguments || "{}")
        const result = handler ? await handler(args as never) : { error: `Unknown tool ${c.function.name}` }
        messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(result) })
      }
    }
    return { reply: "Sorry, I couldn't finish that. Try asking again in a simpler way.", pending, history: history }
  }
}
