import { type Mode, noLimit } from "@luckout/api"
import { Effect } from "effect"
import type { ChatCompletion, ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions"
import type { Bitrefill } from "./Bitrefill.ts"
import type { Near } from "./Near.ts"
import type { Purchases } from "./Purchases.ts"

// The Agent (ADR-0001, ADR-0006): a plain tool-calling loop on NEAR AI Cloud's
// OpenAI-compatible API. Safety is structural, not prompt-based:
// - the model can only *prepare* a purchase; a human taps Confirm before anything is bought,
//   and the contract's Spending Limits still bound every purchase;
// - a purchase the customer can't pay for (balance, limits) is never offered as a button;
// - on testnet the catalog itself only holds test cards (Bitrefill.ts), so the model can't offer others;
// - Redemption Data never enters the model's context (the bot sends codes itself);
// - every completion must be signed inside NEAR AI's attested TEE (Attestation.ts), or the turn's
//   reply and button are withheld.

export interface Pending {
  readonly voucherId: string
  readonly voucherName: string
  readonly value: string
  /** The card's own currency, so "500" reads as "500 INR". */
  readonly currency: string
  /** Where the card works: a country code, or "XI" for worldwide. */
  readonly country: string
  /** Always resolved (the Default Mode when the customer named none), so the button shows the real maximum. */
  readonly mode: Mode
  readonly maxPrice: number
  readonly referencePrice: number
  /** The quote's Lucky Amount (0 for Normal): the purchase plays exactly that, or is refused. */
  readonly luckyAmount: number
}

const regions = new Intl.DisplayNames(["en"], { type: "region" })
/** Where a card can be used, in words: "India only", or "anywhere" for a worldwide ("XI") card. */
export const worksIn = (code: string, name?: string) => (code === "XI" ? "anywhere" : `${name ?? regions.of(code) ?? code} only`)

const MODES: Record<string, Mode> = { normal: "normal", lite: { lucky: 0 }, classic: { lucky: 1 }, jackpot: { lucky: 2 } }
export const modeName = (m: Mode) => (m === "normal" ? "Normal" : ["Lite", "Classic", "Jackpot"][m.lucky] ?? "Lucky")

/** Money as people read it. */
export const usd = (micro: number) => `$${(micro / 1e6).toFixed(2)}`
/** What the customer pays, rounded up to the cent: never show less than what leaves their balance. */
export const usdUp = (micro: number) => `$${(Math.ceil(micro / 10_000) / 100).toFixed(2)}`
/** Time until daily limits reset at 00:00 UTC: Telegram doesn't tell us the customer's time zone. */
const untilReset = (now: number) => {
  const minutes = Math.ceil((86_400_000 - (now % 86_400_000)) / 60_000)
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

const tool = (name: string, description: string, properties: Record<string, object> = {}, required: Array<string> = []): ChatCompletionTool => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } }
})
const mode = { type: "string", enum: ["normal", "lite", "classic", "jackpot"], description: "Omit to use the customer's Default Mode" }

const TOOLS = [
  tool("search_vouchers", "Find gift cards by brand. Each result says where it works.", { query: { type: "string" } }, ["query"]),
  tool("get_voucher", "The amounts on sale for one voucher, with today's USD price for each.", { voucher_id: { type: "string" } }, ["voucher_id"]),
  tool("get_balance", "The customer's balance, Spending Limits, Default Mode and Running Total."),
  tool("quote", "The exact quote for one amount in one mode, and whether their balance covers it.", {
    voucher_id: { type: "string" },
    value: { type: "string", description: "The amount exactly as get_voucher lists it" },
    mode
  }, ["voucher_id", "value"]),
  tool("prepare_purchase", "Put a Confirm button under your reply. Nothing is bought until they tap it. Refused if their balance or limits don't cover it.", {
    voucher_id: { type: "string" },
    value: { type: "string" },
    mode
  }, ["voucher_id", "value"]),
  tool("recent_purchases", "The customer's last purchases and what they paid (codes are not included).")
]

const system = (testnet: boolean, web: string) => `You're Luckout's shopping assistant on Telegram. People buy gift cards (from Bitrefill) with the USDC balance they keep in Luckout.

What you know:
- Normal pays exactly the price.
- Lucky modes cost more up front, then a fair draw on NEAR may pay cashback: Lite +10% (23% get cashback, 1% get 100% off), Classic +20% (40%, 2% get 100% off; the one we recommend), Jackpot +50% (56%, 10% get 100% off). Call the top outcome "100% off", never "free". Cashback comes in fixed slabs and any cashback means they paid less than the price. Each lucky mode averages 5.6% above the price over many buys. They always get the card.
- One purchase's cashback is capped (the lower of a fixed amount and a share of the reserve), so on big buys only part of the price plays (the quote's lucky_part). Purchases start at $0.50, so smaller amounts aren't sold.
- Add funds or change limits: ${web}/wallet. Browse: ${web}/shop.

How you talk:
- Like a sharp, friendly person texting. Usually one to three short sentences.
- Answer what they asked. Bring up odds, caps, averages or rules only when they change the answer or they ask.
- If they ask for options, give the few that fit best, not the whole catalog.
- When comparing modes, one line each, same shape: "Classic: $1.33 now, 40% chance of cashback, 2% chance of 100% off".
- "Lucky" with no mode: quote Classic and mention Lite and Jackpot exist.
- Say amounts the way they did (₹500, $10). Tools give USD.
- Plain text only: no headers, bold, markdown or em dashes.

Rules:
- Every price, balance and quote comes from a tool. Never guess a number.
- A card only works in its own country (its works_in). Before preparing one, make sure it's for the country they'll use it in; if they haven't said, ask. Never offer another country's card as a substitute.
- Only offer a purchase they can pay for. If a tool says they're short or over a limit, say by how much and give the link.
- To buy, call prepare_purchase; they confirm with a button. Never say it's bought before they confirm.
- No cashback means they paid the up-front amount; never call that a win.
- The bot sends voucher codes itself; never ask for or repeat them.${testnet
  ? `\n- This is the testnet demo: only Bitrefill's test cards can be bought, with free test USDC. If they ask for a real brand, say so in one line and offer the $10 test gift card.`
  : ""}`

/**
 * Old turns are dropped in one big cut, at a customer message, rather than one by one: the model
 * provider caches by exact prefix, so a history that only grows keeps hitting the cache, while a
 * sliding window shifts every token after the system prompt on every turn.
 */
export const trimHistory = (h: Array<ChatCompletionMessageParam>, max = 60, keep = 24) => {
  if (h.length <= max) return h
  const start = h.findIndex((m, i) => i >= h.length - keep && m.role === "user")
  return start === -1 ? [] : h.slice(start)
}

interface Account {
  balance: string
  per_purchase_limit: string
  daily_limit: string
  day: number
  spent_today: string
  default_mode: Mode
  premiums_paid: string
  cashback_received: string
}

/** A Spending Limit for the model: dollars, or "No limit" when they turned it off (u128::MAX). */
const limit = (micro: string) => (noLimit(micro) ? "No limit" : usd(Number(micro)))

/** Why the customer can't buy this right now, in words the model can pass on; undefined if they can. */
export const blocker = (a: Account | null, maxPrice: number, web: string, now = Date.now()) => {
  const balance = Number(a?.balance ?? 0)
  if (balance < maxPrice) {
    return `Not enough balance: they have ${usd(balance)} and this needs ${usdUp(maxPrice)}, so they're ${usdUp(maxPrice - balance)} short. Add funds at ${web}/wallet`
  }
  if (maxPrice > Number(a!.per_purchase_limit)) {
    return `Over their per-purchase limit of ${usd(Number(a!.per_purchase_limit))}. They can raise it in one tap when they buy on the web, or at ${web}/wallet#limits`
  }
  const spent = a!.day === Math.floor(now / 86_400_000) ? Number(a!.spent_today) : 0
  if (spent + maxPrice > Number(a!.daily_limit)) {
    return `Over their daily limit: ${usd(spent)} of ${usd(Number(a!.daily_limit))} used today. It resets in ${untilReset(now)} (00:00 UTC), or they can raise it in one tap when they buy on the web, or at ${web}/wallet#limits`
  }
  return undefined
}

export const makeAgent = (deps: {
  bitrefill: Bitrefill["Service"]
  purchases: Purchases["Service"]
  near: Near["Service"]
  /** Why new purchases can't start right now (sales stopped, contract paused, Bitrefill's order limit), or undefined. */
  shopClosed: Effect.Effect<string | undefined>
  testnet: boolean
  web: string
  apiKey: string
  baseURL: string
  model: string
  /** Whether NEAR AI signed exactly this request and response inside its attested TEE. */
  verify: (request: string, response: string, chatId: string) => Promise<boolean>
}) => {
  /** One completion. We send and keep the exact bytes, because the TEE signs their hashes. */
  const complete = async (messages: Array<ChatCompletionMessageParam>) => {
    const request = JSON.stringify({ model: deps.model, messages, tools: TOOLS })
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${deps.baseURL}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${deps.apiKey}`, "content-type": "application/json" },
        body: request,
        signal: AbortSignal.timeout(45_000)
      }).catch((e: unknown) => {
        if (attempt === 2) throw e
        return undefined
      })
      if (res?.ok) {
        const response = await res.text()
        return { request, response, completion: JSON.parse(response) as ChatCompletion }
      }
      // One retry for a dropped connection or a busy server, like the OpenAI SDK's default.
      if (res && (attempt === 2 || (res.status !== 429 && res.status < 500))) {
        throw Object.assign(new Error(`NEAR AI answered ${res.status}`), { status: res.status })
      }
    }
  }

  const run = <A>(e: Effect.Effect<A, { message: string }>) =>
    Effect.runPromise(Effect.match(e, { onFailure: (err) => ({ error: err.message }), onSuccess: (a) => a }))

  const account = (accountId: string) => deps.near.view<Account | null>("get_account", { account_id: accountId })
  // The quote must use the mode the contract will apply, so an omitted mode means the Default Mode.
  const resolveMode = (a: Account | null, name: string | undefined) => (name && MODES[name]) || a?.default_mode || ("normal" as Mode)
  const game = (m: Mode) => (m === "normal" ? undefined : m.lucky)

  const tools = (accountId: string, prepare: (p: Pending) => void) => ({
    search_vouchers: ({ query }: { query: string }) =>
      run(deps.bitrefill.search(query).pipe(Effect.map((vs) => {
        const results = vs.slice(0, 6).map((v) => ({ id: v.id, name: v.name, works_in: worksIn(v.countryCode, v.countryName) }))
        return deps.testnet && results.length === 0
          ? { results, note: "Testnet demo: only Bitrefill's test cards are sold. Try search_vouchers('test')." }
          : { results }
      }))),
    get_voucher: ({ voucher_id }: { voucher_id: string }) =>
      run(deps.bitrefill.voucher(voucher_id).pipe(Effect.map((v) => ({
        name: v.name,
        works_in: worksIn(v.countryCode, v.countryName),
        currency: v.currency,
        amounts: v.packages.map((p) => ({ value: p.value, price: usd(p.priceMicroUsdc) })),
        ...(v.tooSmall?.length
          ? { not_sold_under_50_cent_minimum: v.tooSmall.map((p) => ({ value: p.value, price: usd(p.priceMicroUsdc) })) }
          : {})
      })))),
    get_balance: () =>
      run(account(accountId).pipe(Effect.map((a) =>
        a
          ? {
            balance: usd(Number(a.balance)),
            per_purchase_limit: limit(a.per_purchase_limit),
            daily_limit: limit(a.daily_limit),
            default_mode: modeName(a.default_mode),
            running_total: usd(Number(a.cashback_received) - Number(a.premiums_paid))
          }
          : { balance: "$0.00", note: `No deposit yet. Add funds at ${deps.web}/wallet` }
      ))),
    quote: ({ voucher_id, value, mode }: { voucher_id: string; value: string; mode?: string }) =>
      run(Effect.gen(function*() {
        const a = yield* account(accountId)
        const m = resolveMode(a, mode)
        const q = yield* deps.purchases.quote(voucher_id, value, game(m))
        const why = blocker(a, q.maxPrice, deps.web)
        return {
          mode: modeName(m),
          price: usd(q.referencePrice),
          pay_now: usdUp(q.maxPrice),
          ...(q.luckyAmount > 0 && q.luckyAmount < q.referencePrice ? { lucky_part: usd(q.luckyAmount) } : {}),
          ...(why ? { cannot_buy_yet: why } : {})
        }
      })),
    prepare_purchase: ({ voucher_id, value, mode }: { voucher_id: string; value: string; mode?: string }) =>
      run(Effect.gen(function*() {
        const a = yield* account(accountId)
        const m = resolveMode(a, mode)
        const [voucher, q] = yield* Effect.all([deps.bitrefill.voucher(voucher_id), deps.purchases.quote(voucher_id, value, game(m))])
        // A button that would fail on tap is worse than no button: say what's in the way instead.
        const closed = yield* deps.shopClosed
        if (closed) return { error: closed }
        const why = blocker(a, q.maxPrice, deps.web)
        if (why) return { error: why }
        prepare({ voucherId: voucher.id, voucherName: voucher.name, value, currency: voucher.currency, country: voucher.countryCode, mode: m, maxPrice: q.maxPrice, referencePrice: q.referencePrice, luckyAmount: q.luckyAmount })
        return {
          shown: "Under your reply the customer sees the exact card, mode and price, and a Buy button. So reply with one short line and no prices, like: Here it is, tap Buy when you're ready."
        }
      })),
    recent_purchases: () =>
      run(deps.purchases.list(accountId).pipe(Effect.map((ps) => ps.slice(0, 5).map((p) => ({
        voucher: `${p.voucherName} ${p.value}`,
        status: p.status,
        price: usd(p.referencePrice),
        paid: p.draw ? usdUp(p.draw.finalPrice) : p.status === "delivered" ? usd(p.referencePrice) : null,
        when: p.createdAt
      })))))
  })

  /** One customer turn: runs the tool loop and returns the reply plus any purchase to confirm. */
  return async (accountId: string, history: Array<ChatCompletionMessageParam>, text: string) => {
    let pending: Pending | undefined
    const handlers: Record<string, (args: never) => Promise<unknown>> = tools(accountId, (p) => (pending = p))
    const messages: Array<ChatCompletionMessageParam> = [{ role: "system", content: system(deps.testnet, deps.web) }, ...history, { role: "user", content: text }]
    // Signatures are checked alongside the tool loop and all awaited before anything reaches the customer.
    const signed: Array<Promise<boolean>> = []
    for (let step = 0; step < 6; step++) {
      const { request, response, completion: res } = await complete(messages)
      signed.push(deps.verify(request, response, res.id))
      const u = res.usage
      if (u) console.log(`agent tokens: prompt ${u.prompt_tokens}, cached ${u.prompt_tokens_details?.cached_tokens ?? 0}, completion ${u.completion_tokens}`)
      const msg = res.choices[0]?.message
      if (!msg) break
      messages.push(msg)
      const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function")
      if (calls.length === 0) {
        if (!(await Promise.all(signed)).every(Boolean)) {
          return { reply: "I couldn't prove that answer came from the secure enclave, so I didn't send it. Try again in a moment.", pending: undefined, history }
        }
        // The whole transcript, tool calls included: the next turn's prompt then starts with exactly
        // this turn's tokens, which the provider has cached (cache reads cost 2% of fresh input).
        return { reply: msg.content ?? "", pending, history: messages.slice(1) }
      }
      for (const c of calls) {
        const handler = handlers[c.function.name]
        const args = JSON.parse(c.function.arguments || "{}")
        const result = handler ? await handler(args as never) : { error: `Unknown tool ${c.function.name}` }
        messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(result) })
      }
    }
    // A button prepared along the way still needs every step behind it verified.
    const verified = (await Promise.all(signed)).every(Boolean)
    return { reply: "Sorry, I couldn't finish that. Try asking again in a simpler way.", pending: verified ? pending : undefined, history: history }
  }
}
