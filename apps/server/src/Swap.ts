import {
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token"
import {
  ComputeBudgetProgram,
  Connection,
  PACKET_DATA_SIZE,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js"
import { Cache, Config, Context, Data, Effect, Exit, Layer, Option, Redacted, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { formatUnits } from "viem"

// Top-Ups paid with a Solana token 1Click doesn't take (ADR-0014). Luckout builds one transaction for the customer's
// wallet to sign: a Jupiter swap of an exact amount of their token into USDC in their own wallet, with a minimum
// out the chain enforces, then a transfer of exactly the USDC a 1Click quote needs to that quote's deposit address.
// From there it's an ordinary Solana USDC Top-Up.
//
// Why not Jupiter's ExactOut, which would deliver the USDC straight to the deposit address? It routes through fewer
// pools: on 2026-11-24 it cost 0.97–1.18% below ORE's market price, ExactIn 0.31%. The swap's minimum out covers the
// USDC needed, so the price can move by our slippage at most before the whole transaction fails; what it beats that
// minimum by stays in the customer's wallet as USDC.
//
// The customer spends exactly the amount of their token they were shown. Before handing a transaction out, the server
// simulates it and checks what it does, not only what it says.

/** A token taken through a Jupiter swap. Adding one is one line in SWAP_TOKENS, once its market has been checked. */
export interface SwapToken {
  readonly symbol: string
  readonly mint: string
  readonly decimals: number
}

export const SWAP_TOKENS: ReadonlyArray<SwapToken> = [
  // ore.com. Checked 2026-11-24: about $870k of liquidity on Jupiter; $5 to $500 swaps at 0.31% under the market.
  { symbol: "ORE", mint: "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp", decimals: 11 }
]
/** How a swap-paid token is named among the Top-Up tokens (1Click's are nep141:…, so they can't collide). */
export const swapAssetId = (t: SwapToken) => `jupiter:${t.mint}`
export const swapTokenOf = (assetId: string) => SWAP_TOKENS.find((t) => swapAssetId(t) === assetId)
export const swapTokenByMint = (mint: string | null | undefined) => SWAP_TOKENS.find((t) => t.mint === mint)

/** USDC on Solana: what the swap gives, and the 1Click asset a swap-paid Top-Up is quoted from. */
export const SOL_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
export const SOL_USDC_ASSET = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near"
const USDC_DECIMALS = 6

/** The most the price may move against the customer between Jupiter's quote and the swap landing. */
export const SLIPPAGE_BPS = 50
/** Below this much room the swap would fail on an ordinary tick: the price has moved, and a new quote is needed. */
const MIN_SLIPPAGE_BPS = 10
/** A little over what the route needs, so a quote that is a hair off still covers the USDC. */
const SIZING_BPS = 5
/** The most a route may cost against the market, fees included (Jupiter's priceImpactPct is a fraction). */
const MAX_IMPACT = 0.01
/** How far the swap's price may sit below Jupiter's market price before we suspect the route or the pool. */
const MAX_PRICE_GAP = 0.015
/** The priority fee's ceiling, in lamports (0.0002 SOL). */
export const MAX_PRIORITY_LAMPORTS = 200_000
/**
 * The most SOL the wallet may spend (0.005 SOL): fees, priority, rent for the deposit address's USDC account, and
 * for the wallet's own USDC account when it has none yet (0.00204 SOL each).
 */
const MAX_SOL_SPENT = 5_000_000n
export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
/** Compute for our own two instructions (opening the deposit's USDC account, the transfer): Jupiter's limit counts only its own. */
const OUR_UNITS = 60_000

export class SwapUnavailable extends Data.TaggedError("SwapUnavailable")<{ readonly message: string; readonly busy?: boolean }> {}

const JupiterQuote = Schema.Struct({
  inputMint: Schema.String,
  outputMint: Schema.String,
  inAmount: Schema.String,
  outAmount: Schema.String,
  /** ExactIn: the least USDC the swap may give, or it fails. */
  otherAmountThreshold: Schema.String,
  swapMode: Schema.String,
  slippageBps: Schema.Number,
  priceImpactPct: Schema.String,
  routePlan: Schema.Array(Schema.Struct({ swapInfo: Schema.Struct({ label: Schema.String }) }))
})
export type JupiterQuote = typeof JupiterQuote.Type

const Instruction = Schema.Struct({
  programId: Schema.String,
  accounts: Schema.Array(Schema.Struct({ pubkey: Schema.String, isSigner: Schema.Boolean, isWritable: Schema.Boolean })),
  data: Schema.String
})
type Instruction = typeof Instruction.Type
const SwapInstructions = Schema.Struct({
  computeBudgetInstructions: Schema.Array(Instruction),
  setupInstructions: Schema.Array(Instruction),
  swapInstruction: Instruction,
  cleanupInstruction: Schema.optional(Schema.NullOr(Instruction)),
  otherInstructions: Schema.optional(Schema.Array(Instruction)),
  addressLookupTableAddresses: Schema.Array(Schema.String)
})

const moved = (symbol: string) => `${symbol}'s price moved since your quote. Nothing was sent: top up again for a new price.`

/**
 * Why a route's price is unsafe, or undefined: it isn't our swap (ExactIn, the token to USDC), it moves the market too
 * much, or it pays too far under Jupiter's market price `usdPrice` (a bad route, or a pool being pushed).
 */
export const priceProblem = (q: JupiterQuote, token: SwapToken, usdPrice: number): string | undefined => {
  if (q.swapMode !== "ExactIn" || q.inputMint !== token.mint || q.outputMint !== SOL_USDC_MINT) return "Jupiter quoted a different swap. Nothing was sent: try again."
  if (!(Number(q.priceImpactPct) <= MAX_IMPACT)) return `That's a big swap for ${token.symbol}'s market right now. Try a smaller amount.`
  const paid = Number(q.outAmount) / 10 ** USDC_DECIMALS / (Number(q.inAmount) / 10 ** token.decimals)
  if (!(usdPrice > 0) || !(paid >= usdPrice * (1 - MAX_PRICE_GAP))) {
    return `Jupiter's price for ${token.symbol} is off the market right now. Nothing was sent: try again in a minute.`
  }
  return undefined
}

/**
 * Why this Jupiter quote must not become a transaction, or undefined: it must swap exactly `spend` (what the
 * customer was shown), its minimum out must cover `need` (the USDC 1Click's quote needs), and its price be sound.
 */
export const quoteProblem = (q: JupiterQuote, o: { token: SwapToken; spend: bigint; need: bigint; usdPrice: number }): string | undefined => {
  if (BigInt(q.inAmount) !== o.spend) return "Jupiter quoted a different swap. Nothing was sent: try again."
  return priceProblem(q, o.token, o.usdPrice) ?? (BigInt(q.otherAmountThreshold) < o.need ? moved(o.token.symbol) : undefined)
}

/**
 * How much of the token to swap for `need` USDC, from a route that gave `out` for `spend`: enough that its minimum
 * out after our slippage still covers `need`, and a hair more.
 */
export const sizeFor = (need: bigint, probe: { spend: bigint; out: bigint }) => {
  const exact = (need * 10_000n * probe.spend) / ((10_000n - BigInt(SLIPPAGE_BPS)) * probe.out)
  return exact + (exact * BigInt(SIZING_BPS)) / 10_000n + 1n
}

/**
 * The slippage for a route that gives `out` when `need` must be covered: our usual room, or less when the price has
 * since moved a little. Undefined when that leaves too little room to land.
 */
export const slippageFor = (out: bigint, need: bigint) => {
  const room = out > 0n ? Number(((out - need) * 10_000n) / out) : -1
  const bps = Math.min(SLIPPAGE_BPS, room)
  return bps >= MIN_SLIPPAGE_BPS ? bps : undefined
}

/** What Jupiter hands back to put around its swap. */
export interface JupiterInstructions {
  readonly budget: ReadonlyArray<TransactionInstruction>
  readonly setup: ReadonlyArray<TransactionInstruction>
  readonly swap: TransactionInstruction
  /** Its cleanup and "other" instructions: none are expected. */
  readonly rest: ReadonlyArray<TransactionInstruction>
}

/**
 * Why Jupiter's instructions mustn't be signed, or undefined. Only these pass: a compute unit limit, price or data
 * size; opening the wallet's own token accounts, paid by the wallet; and the swap, on Jupiter's program. Anything
 * else (an Approve, a transfer, a close, another program) is refused whatever the simulation shows: a delegate set
 * on the wallet's account would leave its balances unchanged today and empty them later.
 */
export const jupiterProblem = (j: JupiterInstructions, payer: PublicKey): string | undefined => {
  const refuse = (i: TransactionInstruction) => `Jupiter's route asks for something Luckout doesn't allow (${i.programId.toBase58()}). Nothing was sent.`
  // SetComputeUnitLimit (2) and SetLoadedAccountsDataSizeLimit (4) carry a u32, SetComputeUnitPrice (3) a u64.
  const budget = j.budget.find((i) =>
    !i.programId.equals(ComputeBudgetProgram.programId) || ![2, 3, 4].includes(i.data[0] ?? -1) || i.data.length !== (i.data[0] === 3 ? 9 : 5)
  )
  if (budget) return refuse(budget)
  // The Associated Token program's Create (no data, or 0) and CreateIdempotent (1), funded by the wallet, for itself.
  const setup = j.setup.find((i) =>
    !(i.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && (i.data.length === 0 || i.data[0] === 0 || i.data[0] === 1) &&
      i.keys[0]?.pubkey.equals(payer) && i.keys[2]?.pubkey.equals(payer))
  )
  if (setup) return refuse(setup)
  if (j.swap.programId.toBase58() !== JUPITER_PROGRAM) return refuse(j.swap)
  return j.rest[0] ? refuse(j.rest[0]) : undefined
}

/**
 * Jupiter's compute budget with room for our own instructions (its unit limit counts only its own), and its priority
 * price lowered where needed so the whole priority fee stays within MAX_PRIORITY_LAMPORTS: Jupiter is asked to keep
 * to it, and this makes it so whatever Jupiter answers.
 */
export const ourBudget = (budget: ReadonlyArray<TransactionInstruction>) => {
  const limit = budget.find((i) => i.data[0] === 2)
  // Without a limit from Jupiter, Solana's own default could reach its most, 1,400,000 units.
  const units = limit ? Math.min(1_400_000, Buffer.from(limit.data).readUInt32LE(1) + OUR_UNITS) : 1_400_000
  const most = BigInt(Math.floor((MAX_PRIORITY_LAMPORTS * 1_000_000) / units))
  return budget.map((i) => {
    if (i.data[0] === 2) return ComputeBudgetProgram.setComputeUnitLimit({ units })
    if (i.data[0] !== 3) return i
    const price = Buffer.from(i.data).readBigUInt64LE(1)
    return ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price < most ? price : most })
  })
}

type Account = { data: Uint8Array } | null | undefined
const tokenAccount = (a: Account) => (a && a.data.length >= AccountLayout.span ? AccountLayout.decode(Uint8Array.from(a.data).subarray(0, AccountLayout.span)) : undefined)
/** A token account's balance (base units), or 0 when it doesn't exist. */
const tokenBalance = (a: Account) => tokenAccount(a)?.amount ?? 0n
/** Who besides the owner may move a token account's balance or close it: a delegate, a close authority. */
const authorities = (a: Account) => {
  const t = tokenAccount(a)
  return `${t?.delegateOption ? t.delegate.toBase58() : "-"} ${t?.closeAuthorityOption ? t.closeAuthority.toBase58() : "-"}`
}
/** Whether this account is a token account (either token program's) that `owner` holds. */
const heldBy = (a: ({ owner: PublicKey } & NonNullable<Account>) | null | undefined, owner: PublicKey) =>
  !!a && (a.owner.equals(TOKEN_PROGRAM_ID) || a.owner.equals(TOKEN_2022_PROGRAM_ID)) && !!tokenAccount(a)?.owner.equals(owner)

/**
 * The wallet's SOL (lamports), its token, its USDC, and the deposit address's USDC; the balances of the wallet's
 * other token accounts the swap is handed; and who may spend or close each token account, besides its owner.
 */
export interface Balances {
  readonly lamports: bigint
  readonly token: bigint
  readonly usdc: bigint
  readonly deposit: bigint
  readonly others: ReadonlyArray<bigint>
  readonly authorities: ReadonlyArray<string>
}

/**
 * Why a simulated swap mustn't be signed, or undefined: the deposit address gets exactly `need` USDC; the wallet
 * spends exactly `spend` of its token, no USDC of its own, none of any other token it holds, and at most
 * MAX_SOL_SPENT of its SOL; and nobody new may spend from or close any of its accounts (a delegate leaves today's
 * balances as they are and empties them later).
 */
export const outcomeProblem = (before: Balances, after: Balances, expect: { need: bigint; spend: bigint }) => {
  if (after.deposit - before.deposit !== expect.need) return "The swap wouldn't deliver exactly the USDC this Top-Up needs. Nothing was sent: try again."
  if (before.token - after.token !== expect.spend) return "The swap wouldn't take exactly the amount shown. Nothing was sent: try again."
  if (after.usdc < before.usdc) return "The swap would take USDC from your wallet. Nothing was sent: try again."
  if (after.others.some((b, i) => b < (before.others[i] ?? 0n))) return "The swap would take another token from your wallet. Nothing was sent: try again."
  if (after.authorities.some((a, i) => a !== before.authorities[i])) return "The swap would let someone else spend from your wallet. Nothing was sent: try again."
  if (before.lamports - after.lamports > MAX_SOL_SPENT) return "The swap would cost more SOL in fees than expected. Nothing was sent: try again in a minute."
  return undefined
}

/** A failed simulation in the customer's words, from Solana's logs. */
export const simulationProblem = (logs: ReadonlyArray<string>, symbol: string) => {
  const text = logs.join("\n")
  // Jupiter's SlippageToleranceExceeded (6001).
  if (/0x1771\b|SlippageToleranceExceeded/.test(text)) return moved(symbol)
  // Our deposit account opening, which only the first payment can do.
  if (/already in use/i.test(text)) return "This Top-Up is already paid, or a payment for it is on its way. Nothing more was sent."
  if (/insufficient funds/i.test(text)) return `This wallet doesn't hold enough ${symbol} for this. Nothing was sent.`
  if (/insufficient lamports|no record of a prior credit|InsufficientFundsForRent/i.test(text)) {
    return "This wallet needs a little more SOL for the network fee and token accounts (up to 0.005 SOL). Nothing was sent."
  }
  return undefined
}

export interface SwapTransaction {
  /** Base64 of the unsigned v0 transaction, as simulated. */
  readonly transaction: string
  readonly lastValidBlockHeight: number
}

export class Swap extends Context.Service<Swap, {
  /** The swap-paid tokens with Jupiter's price, or none when Jupiter isn't configured (JUPITER_API_KEY). */
  readonly tokens: Effect.Effect<ReadonlyArray<SwapToken & { readonly price: number }>>
  /**
   * How much of the token (base units) to swap for `need` USDC (base units): from a fresh route, or for a price check
   * (`fresh` false) from the last one seen in the past 20 seconds, so a customer typing an amount costs no calls.
   */
  size(token: SwapToken, need: bigint, fresh: boolean): Effect.Effect<bigint, SwapUnavailable>
  /**
   * The transaction for `payer` to sign: swaps exactly `spend` of the token for at least `need` USDC in their own
   * wallet, then sends exactly `need` to the deposit address's USDC account (opened in the same transaction). It is
   * simulated and checked first. `retryBusy`: whether a busy Jupiter is asked again for a few seconds (for a signed-in
   * customer) or the busy answer is given at once (for a request anyone can make).
   */
  transaction(o: { token: SwapToken; payer: string; depositAddress: string; need: bigint; spend: bigint; retryBusy: boolean }): Effect.Effect<SwapTransaction, SwapUnavailable>
  /** The first transaction that put at least `need` USDC into this deposit address's USDC account, or undefined. */
  paidBy(depositAddress: string, need: bigint): Effect.Effect<string | undefined>
}>()("luckout/Swap") {
  static readonly layer = Layer.effect(
    Swap,
    Effect.gen(function*() {
      // Jupiter's keyed API (portal.jup.ag). Without a key no token is offered, and nothing here is called.
      const key = yield* Config.option(Config.Redacted("JUPITER_API_KEY"))
      const baseUrl = yield* Config.String("JUPITER_API_URL").pipe(Config.withDefault("https://api.jup.ag"))
      // Our own RPC, never Reown's: it answers getBlockHeight with the slot (PR #179). The public one suits staging.
      const rpc = yield* Config.String("SOLANA_RPC_URL").pipe(Config.withDefault("https://api.mainnet-beta.solana.com"))
      const connection = new Connection(rpc, { commitment: "confirmed", fetch: globalThis.fetch })
      const fail = (message: string) => new SwapUnavailable({ message })
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest((r) => {
          const req = HttpClientRequest.acceptJson(HttpClientRequest.prependUrl(r, baseUrl))
          return Option.isSome(key) ? HttpClientRequest.setHeader(req, "x-api-key", Redacted.value(key.value)) : req
        }),
        HttpClient.timeout("15 seconds")
      )
      const read = <A, I>(schema: Schema.Codec<A, I>) => (res: HttpClientResponse.HttpClientResponse) =>
        Effect.gen(function*() {
          if (res.status === 429) return yield* new SwapUnavailable({ message: "Jupiter is busy. Nothing was sent: try again in a few seconds.", busy: true })
          if (res.status >= 400) {
            const text = yield* res.text
            yield* Effect.logWarning("Jupiter refused", res.status, text.slice(0, 500))
            return yield* fail("Jupiter has no route for this swap right now. Nothing was sent: try again in a minute.")
          }
          return yield* HttpClientResponse.schemaBodyJson(schema)(res)
        })
      // Jupiter's rate limit is per key (staging's: 10 calls in 10 seconds): a busy answer is asked again for up to a
      // window before the customer hears it, unless `retryBusy` is false (a request anyone can make: asking again
      // would only spend more of the key's calls on it).
      // What went wrong underneath is logged, never told: the Solana Pay route answers anyone.
      const wrap = <A, E, R>(e: Effect.Effect<A, E, R>, retryBusy = true) =>
        e.pipe(
          Effect.catch((err) =>
            err instanceof SwapUnavailable
              ? Effect.fail(err)
              : Effect.logWarning("Jupiter unavailable", err).pipe(Effect.andThen(Effect.fail(fail("Jupiter didn't answer. Nothing was sent: try again in a minute."))))
          ),
          Effect.retry({ times: retryBusy ? 4 : 0, schedule: Schedule.spaced("2500 millis"), while: (err) => err.busy === true })
        )
      const solana = <A>(what: string, f: () => Promise<A>) =>
        Effect.tryPromise({ try: f, catch: (e) => e }).pipe(
          Effect.catch((e) =>
            Effect.logWarning(`Solana: ${what}`, e).pipe(Effect.andThen(Effect.fail(fail("Solana didn't answer. Nothing was sent: try again in a minute."))))
          )
        )

      const prices = yield* Cache.makeWith(
        (_: "all") =>
          wrap(
            http.get("/price/v3", { urlParams: { ids: SWAP_TOKENS.map((t) => t.mint).join(",") } }).pipe(
              Effect.flatMap(read(Schema.Record(Schema.String, Schema.Struct({ usdPrice: Schema.Number }))))
            )
          ),
        // Short: the price is also what a swap is checked against. A failure isn't kept: the next ask tries again.
        { capacity: 1, timeToLive: (exit) => (Exit.isSuccess(exit) ? "15 seconds" : "1 second") }
      )
      const priceOf = (t: SwapToken) =>
        Cache.get(prices, "all").pipe(Effect.flatMap((p) => {
          const usd = p[t.mint]?.usdPrice
          return usd && usd > 0 ? Effect.succeed(usd) : Effect.fail(fail(`Jupiter has no price for ${t.symbol} right now.`))
        }))

      // Both the raw quote (Jupiter wants it back verbatim to build the swap) and the fields we check.
      const quote = (t: SwapToken, spend: bigint, slippageBps: number, exclude: ReadonlyArray<string> = [], retryBusy = true) =>
        wrap(
          http.get("/swap/v1/quote", {
            urlParams: {
              inputMint: t.mint,
              outputMint: SOL_USDC_MINT,
              amount: String(spend),
              swapMode: "ExactIn",
              slippageBps: String(slippageBps),
              // Routes only through liquid tokens, and leaves room in the transaction for our own instructions.
              restrictIntermediateTokens: "true",
              maxAccounts: "40",
              ...(exclude.length > 0 ? { excludeDexes: exclude.join(",") } : {})
            }
          }).pipe(
            Effect.flatMap((res) =>
              read(Schema.Unknown)(res).pipe(Effect.flatMap((raw) => Schema.decodeUnknownEffect(JupiterQuote)(raw).pipe(Effect.map((q) => ({ q, raw })))))
            )
          ),
          retryBusy
        )

      const tokens = Option.isNone(key)
        ? Effect.succeed([])
        : Effect.forEach(SWAP_TOKENS, (t) => priceOf(t).pipe(Effect.map((price) => [{ ...t, price }]), Effect.orElseSucceed(() => [])))
          .pipe(Effect.map((ts) => ts.flat()))

      // One route at the market price gives the rate, and the amount is sized from it (one call: Jupiter's limit is per
      // key). The transaction checks a fresh route for exactly that amount before anything is signed.
      // ponytail: in memory, one process (ADR-0006).
      const rates = new Map<string, { spend: bigint; out: bigint; at: number }>()
      const size = (t: SwapToken, need: bigint, fresh: boolean) =>
        Effect.gen(function*() {
          if (Option.isNone(key)) return yield* fail(`${t.symbol} isn't taken here.`)
          const known = rates.get(t.mint)
          if (!fresh && known && Date.now() - known.at < 20_000) return sizeFor(need, known)
          const usdPrice = yield* priceOf(t)
          const guess = BigInt(Math.ceil((Number(need) / 10 ** USDC_DECIMALS / usdPrice) * 10 ** t.decimals))
          const { q: probe } = yield* quote(t, guess, SLIPPAGE_BPS)
          const problem = priceProblem(probe, t, usdPrice)
          if (problem) return yield* fail(problem)
          const rate = { spend: BigInt(probe.inAmount), out: BigInt(probe.outAmount) }
          rates.set(t.mint, { ...rate, at: Date.now() })
          return sizeFor(need, rate)
        })

      const toInstruction = (i: Instruction) =>
        new TransactionInstruction({
          programId: new PublicKey(i.programId),
          keys: i.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
          data: Buffer.from(i.data, "base64")
        })

      type Order = { token: SwapToken; payer: string; depositAddress: string; need: bigint; spend: bigint; retryBusy: boolean }
      /**
       * One try: a route, the transaction around it, and its simulation. A route that fails our slippage in the
       * simulation (a market whose quote was already stale) comes back as the markets to leave out next time.
       */
      const attempt = (o: Order, exclude: ReadonlyArray<string>) => Effect.gen(function*() {
        const payer = yield* Effect.try({ try: () => new PublicKey(o.payer), catch: () => fail("That isn't a Solana wallet address.") })
        if (!PublicKey.isOnCurve(payer.toBytes())) return yield* fail("That isn't a Solana wallet address.")
        const owner = yield* Effect.try({ try: () => new PublicKey(o.depositAddress), catch: () => fail("This Top-Up has no Solana deposit address.") })
        const usdcMint = new PublicKey(SOL_USDC_MINT)
        const source = getAssociatedTokenAddressSync(new PublicKey(o.token.mint), payer)
        const walletUsdc = getAssociatedTokenAddressSync(usdcMint, payer)
        const depositUsdc = getAssociatedTokenAddressSync(usdcMint, owner, true)

        // The chain first, before any call to Jupiter: a wallet without the token, or a Top-Up already being paid, ends
        // here. These balances are also what the simulation's are compared with.
        const watched = [payer, source, walletUsdc, depositUsdc]
        const { context, value: before } = yield* solana("balances", () => connection.getMultipleAccountsInfoAndContext(watched, "confirmed"))
        if (tokenBalance(before[1]) < o.spend) {
          return yield* fail(`This wallet doesn't hold the ${formatUnits(o.spend, o.token.decimals)} ${o.token.symbol} this Top-Up swaps. Nothing was sent.`)
        }
        if (before[3]) return yield* fail("This Top-Up is already paid, or a payment for it is on its way. Nothing more was sent.")

        // A fresh route for exactly the amount shown, its minimum out covering the USDC needed: our usual room when
        // the price allows it, a little less when it has moved a little, and none at all past that.
        const usdPrice = yield* priceOf(o.token)
        let { q, raw } = yield* quote(o.token, o.spend, SLIPPAGE_BPS, exclude, o.retryBusy)
        const bps = slippageFor(BigInt(q.outAmount), o.need)
        if (bps === undefined) return yield* fail(moved(o.token.symbol))
        if (bps !== q.slippageBps) ({ q, raw } = yield* quote(o.token, o.spend, bps, exclude, o.retryBusy))
        const problem = quoteProblem(q, { token: o.token, spend: o.spend, need: o.need, usdPrice })
        if (problem) return yield* fail(problem)

        const built = yield* wrap(
          HttpClientRequest.post("/swap/v1/swap-instructions").pipe(
            HttpClientRequest.bodyJsonUnsafe({
              quoteResponse: raw,
              userPublicKey: payer.toBase58(),
              wrapAndUnwrapSol: false,
              dynamicComputeUnitLimit: true,
              prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: MAX_PRIORITY_LAMPORTS, priorityLevel: "high" } }
            }),
            http.execute,
            Effect.flatMap(read(SwapInstructions))
          ),
          o.retryBusy
        )
        const jupiter: JupiterInstructions = {
          budget: built.computeBudgetInstructions.map(toInstruction),
          setup: built.setupInstructions.map(toInstruction),
          swap: toInstruction(built.swapInstruction),
          rest: [...(built.cleanupInstruction ? [built.cleanupInstruction] : []), ...(built.otherInstructions ?? [])].map(toInstruction)
        }
        const refused = jupiterProblem(jupiter, payer)
        if (refused) return yield* fail(refused)
        // The wallet's other token accounts the swap is handed (one of a token it routes through, say) are watched
        // too: an instruction reaches no account it isn't handed, and the swap may pass through those, never leave
        // them lower.
        const handed = [...new Set(jupiter.swap.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58()))]
          .filter((k) => !watched.some((w) => w.toBase58() === k))
          .map((k) => new PublicKey(k))
        const found = handed.length === 0 ? [] : yield* solana("swap accounts", () => connection.getMultipleAccountsInfo(handed, "confirmed"))
        const others = handed.flatMap((key, i) => (heldBy(found[i], payer) ? [{ key, before: found[i] }] : []))
        const instructions = [
          ...ourBudget(jupiter.budget),
          ...jupiter.setup,
          jupiter.swap,
          // Opened here, and not idempotently: once one payment has landed, any other transaction built for this quote
          // (a second tap, the QR code as well as the wallet) fails here instead of paying twice.
          createAssociatedTokenAccountInstruction(payer, depositUsdc, owner, usdcMint),
          // Exactly what 1Click's quote needs, out of what the swap just gave (at least that, or it failed).
          createTransferCheckedInstruction(walletUsdc, usdcMint, depositUsdc, payer, o.need, USDC_DECIMALS)
        ]

        const tables = yield* solana("lookup tables", () => Promise.all(built.addressLookupTableAddresses.map((a) => connection.getAddressLookupTable(new PublicKey(a)))))
        if (tables.some((t) => !t.value)) return yield* fail("Jupiter's route uses a lookup table Solana doesn't have. Nothing was sent: try again.")
        const { blockhash, lastValidBlockHeight } = yield* solana("blockhash", () => connection.getLatestBlockhash("confirmed"))
        const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message(tables.map((t) => t.value!))
        const tx = new VersionedTransaction(message)
        const tooBig = fail("Jupiter's route is too big for one transaction. Nothing was sent: try a smaller amount.")
        // Signatures included: web3.js only checks the message.
        const bytes = yield* Effect.try({ try: () => tx.serialize(), catch: () => tooBig })
        if (bytes.length > PACKET_DATA_SIZE) return yield* tooBig

        // What it does, not only what it says: the balances it leaves, simulated against the chain no older than the
        // balances read above.
        const sim = yield* solana("simulation", () =>
          connection.simulateTransaction(tx, {
            sigVerify: false,
            commitment: "confirmed",
            minContextSlot: context.slot,
            accounts: { encoding: "base64", addresses: [...watched, ...others.map((x) => x.key)].map((a) => a.toBase58()) }
          }))
        if (sim.value.err) {
          const markets = q.routePlan.map((r) => r.swapInfo.label)
          yield* Effect.logWarning("swap simulation failed", markets.join(" > "), JSON.stringify(sim.value.err), (sim.value.logs ?? []).slice(-6).join(" | "))
          const problem = simulationProblem(sim.value.logs ?? [], o.token.symbol)
          if (problem === moved(o.token.symbol)) return { retryWithout: markets }
          return yield* fail(problem ?? "The swap wouldn't go through right now. Nothing was sent: try again in a minute.")
        }
        const after = (sim.value.accounts ?? []).map((a) => (a ? { lamports: a.lamports, data: Buffer.from(a.data[0] ?? "", "base64") } : null))
        const balances = (list: ReadonlyArray<{ lamports: number; data: Uint8Array } | null | undefined>): Balances => ({
          lamports: BigInt(list[0]?.lamports ?? 0),
          token: tokenBalance(list[1]),
          usdc: tokenBalance(list[2]),
          deposit: tokenBalance(list[3]),
          others: others.map((_, i) => tokenBalance(list[4 + i])),
          authorities: list.slice(1, 4 + others.length).map(authorities)
        })
        const wrong = outcomeProblem(balances([...before, ...others.map((x) => x.before)]), balances(after), { need: o.need, spend: o.spend })
        if (wrong) return yield* fail(wrong)
        return { transaction: Buffer.from(bytes).toString("base64"), lastValidBlockHeight }
      })

      const transaction = Effect.fn("Swap.transaction")(function*(o: Order) {
        if (Option.isNone(key)) return yield* fail(`${o.token.symbol} isn't taken here.`)
        const first = yield* attempt(o, [])
        if (!("retryWithout" in first)) return first
        const second = yield* attempt(o, first.retryWithout)
        if ("retryWithout" in second) return yield* fail(moved(o.token.symbol))
        return second
      })

      const paidBy = (depositAddress: string, need: bigint) =>
        Effect.tryPromise({
          try: async () => {
            // Its USDC account, not the address: only a payment (or something opening it) touches that.
            const account = getAssociatedTokenAddressSync(new PublicKey(SOL_USDC_MINT), new PublicKey(depositAddress), true)
            const sigs = await connection.getSignaturesForAddress(account, { limit: 10 }, "confirmed")
            const held = (list: ReadonlyArray<{ owner?: string; mint: string; uiTokenAmount: { amount: string } }> | null | undefined) =>
              BigInt(list?.find((b) => b.owner === depositAddress && b.mint === SOL_USDC_MINT)?.uiTokenAmount.amount ?? "0")
            // Oldest first (they come newest first): the payment is the first that put at least `need` USDC there.
            for (const s of [...sigs].reverse().filter((s) => s.err === null).slice(0, 3)) {
              const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })
              if (held(tx?.meta?.postTokenBalances) - held(tx?.meta?.preTokenBalances) >= need) return s.signature
            }
            return undefined
          },
          catch: (e) => e
        }).pipe(Effect.catchCause((cause) => Effect.as(Effect.logWarning("Solana: couldn't look up a swap's payment", cause), undefined)))

      return Swap.of({ tokens, size, transaction, paidBy })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
}
