import { AccountLayout, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token"
import { AddressLookupTableAccount, ComputeBudgetProgram, PACKET_DATA_SIZE, PublicKey, TransactionInstruction } from "@solana/web3.js"
import { Cache, Config, Context, Data, Effect, Exit, Layer, Option, Redacted, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { formatUnits } from "viem"
import { MIN_DEPOSIT } from "./Deposits.ts"
import { type Customer, decodeAccount, type Program } from "./Program.ts"
import { type RawAccount, Solana } from "./Solana.ts"

// USDT and ORE in a customer's own wallet (their Deposit Address) reach their Balance in one transaction they sign and
// we pay for (ADR-0014, amended by ADR-0015): a Jupiter ExactIn swap of exactly the amount shown into their own USDC
// account, with a minimum out the chain enforces, then `deposit_for`, which moves that account's USDC into their
// Balance and nowhere else. Our fee payer pays the fee and any rent: the customer holds no SOL.
//
// Why ExactIn: it routes through more pools than ExactOut. On 2026-11-24 ORE's ExactIn route cost 0.31% under the
// market, ExactOut 0.97–1.18%.
//
// Before handing a transaction out, the server simulates it and checks what it does, not only what it says. The fee
// payer only ever pays: it funds the customer's own token accounts and the fee, and is an authority over nothing.

/** A token taken through a Jupiter swap. Adding one is one line in SWAP_TOKENS, once its market has been checked. */
export interface SwapToken {
  readonly symbol: string
  readonly mint: string
  readonly decimals: number
}

export const SWAP_TOKENS: ReadonlyArray<SwapToken> = [
  // Tether on Solana: most of our customers hold USDT (ADR-0015).
  { symbol: "USDT", mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
  // ore.com. Checked 2026-11-24: about $870k of liquidity on Jupiter; $5 to $500 swaps at 0.31% under the market.
  { symbol: "ORE", mint: "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp", decimals: 11 }
]
/** How a swap-paid token is named among the Top-Up tokens (1Click's are nep141:…, so they can't collide). */
export const swapAssetId = (t: SwapToken) => `jupiter:${t.mint}`
export const swapTokenOf = (assetId: string) => SWAP_TOKENS.find((t) => swapAssetId(t) === assetId)

/** USDC on Solana, as 1Click names it: what a Top-Up from another chain delivers to the Deposit Address. */
export const SOL_USDC_ASSET = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near"
const USDC_DECIMALS = 6

/** The most the price may move against the customer between Jupiter's quote and the swap landing. */
export const SLIPPAGE_BPS = 50
/** The most a route may cost against the market, fees included (Jupiter's priceImpactPct is a fraction). */
const MAX_IMPACT = 0.01
/** How far the swap's price may sit below Jupiter's market price before we suspect the route or the pool. */
const MAX_PRICE_GAP = 0.015
/**
 * The most our fee payer may spend on one swap (0.007 SOL): the fee, and rent for up to three token accounts at about
 * 0.00204 SOL each, which Jupiter's setup opens for the wallet (one for a token the route passes through, say).
 */
// ponytail: a customer can close a token account we funded and keep its rent, then swap again (Jupiter's docs warn of
// this). Bounded per swap by this cap, one build per wallet at a time and /topup/swap's rate limit; count opened
// accounts per customer if it's ever farmed.
export const MAX_FEE_PAYER_SPEND = 7_000_000n
export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
/** Compute for our own `deposit_for`: Jupiter's limit counts only its own. */
const OUR_UNITS = 60_000

/** `busy`: Jupiter's rate limit, worth asking again in a few seconds. */
export class SwapUnavailable extends Data.TaggedError("SwapUnavailable")<{ readonly message: string; readonly busy?: boolean }> {}

/** Whether `address` is a Solana wallet: a key on the curve, which can sign (an account a program owns can't). */
export const isWallet = (address: string) => {
  try {
    return PublicKey.isOnCurve(new PublicKey(address).toBytes())
  } catch {
    return false
  }
}

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

const moved = (symbol: string) => `${symbol}'s price moved. Nothing was sent: try again for a new price.`

/**
 * Why a route must not become a transaction, or undefined: it must be our swap (ExactIn, exactly `spend` of the token
 * to `usdcMint`), not move the market too much, pay near Jupiter's market price `usdPrice` (else a bad route, or a pool
 * being pushed), and promise at least the program's smallest deposit.
 */
export const quoteProblem = (q: JupiterQuote, o: { token: SwapToken; spend: bigint; usdPrice: number; usdcMint: string }): string | undefined => {
  if (q.swapMode !== "ExactIn" || q.inputMint !== o.token.mint || q.outputMint !== o.usdcMint || BigInt(q.inAmount) !== o.spend) {
    return "Jupiter quoted a different swap. Nothing was sent: try again."
  }
  if (!(Number(q.priceImpactPct) <= MAX_IMPACT)) return `That's a big swap for ${o.token.symbol}'s market right now. Try a smaller amount.`
  const paid = Number(q.outAmount) / 10 ** USDC_DECIMALS / (Number(q.inAmount) / 10 ** o.token.decimals)
  if (!(o.usdPrice > 0) || !(paid >= o.usdPrice * (1 - MAX_PRICE_GAP))) {
    return `Jupiter's price for ${o.token.symbol} is off the market right now. Nothing was sent: try again in a minute.`
  }
  if (BigInt(q.otherAmountThreshold) < MIN_DEPOSIT) return `That's less than 1 USDC of ${o.token.symbol}. Swap at least 1 USDC's worth.`
  return undefined
}

/** What Jupiter hands back to put around its swap. */
export interface JupiterInstructions {
  /** Its compute budget: only its unit limit is read; our own budget replaces it. */
  readonly budget: ReadonlyArray<TransactionInstruction>
  readonly setup: ReadonlyArray<TransactionInstruction>
  readonly swap: TransactionInstruction
  /** Its cleanup and "other" instructions: none are expected. */
  readonly rest: ReadonlyArray<TransactionInstruction>
}

/**
 * Why Jupiter's instructions mustn't be signed, or undefined. Only these pass: opening the wallet's own token accounts,
 * their rent paid by our fee payer; and the swap, on Jupiter's program, without the fee payer in it. The fee payer
 * signs the whole transaction, so anywhere else it would be an authority, not a payer. Anything else (an Approve, a
 * transfer, a close, another program) is refused whatever the simulation shows: a delegate set on the wallet's account
 * would leave its balances unchanged today and empty them later.
 */
export const jupiterProblem = (j: JupiterInstructions, o: { wallet: PublicKey; feePayer: PublicKey }): string | undefined => {
  const refuse = (i: TransactionInstruction) => `Jupiter's route asks for something Luckout doesn't allow (${i.programId.toBase58()}). Nothing was sent.`
  // The Associated Token program's Create (no data, or 0) and CreateIdempotent (1): funded by the fee payer, for the wallet.
  const setup = j.setup.find((i) =>
    !(i.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && (i.data.length === 0 || i.data[0] === 0 || i.data[0] === 1) &&
      i.keys[0]?.pubkey.equals(o.feePayer) && i.keys[2]?.pubkey.equals(o.wallet))
  )
  if (setup) return refuse(setup)
  if (j.swap.programId.toBase58() !== JUPITER_PROGRAM || j.swap.keys.some((k) => k.pubkey.equals(o.feePayer))) return refuse(j.swap)
  return j.rest[0] ? refuse(j.rest[0]) : undefined
}

/** The compute the transaction asks for: Jupiter's own limit and room for `deposit_for`, at most Solana's 1,400,000. */
export const unitsFor = (budget: ReadonlyArray<TransactionInstruction>) => {
  const limit = budget.find((i) => i.programId.equals(ComputeBudgetProgram.programId) && i.data[0] === 2 && i.data.length === 5)
  return limit ? Math.min(1_400_000, Buffer.from(limit.data).readUInt32LE(1) + OUR_UNITS) : 1_400_000
}

/** The transaction's instructions: Jupiter's setup and swap, then `deposit_for` of the wallet's USDC account. */
export const swapInstructions = (program: Program, j: Pick<JupiterInstructions, "setup" | "swap">, wallet: PublicKey, usdc: PublicKey) => [
  ...j.setup,
  j.swap,
  program.instruction("deposit_for", {
    config: program.config,
    customer: program.customer(wallet),
    source: usdc,
    vault: program.vault,
    vault_authority: program.vaultAuthority
  })
]

type Account = RawAccount | undefined
const tokenAccount = (a: Account) => (a && a.data.length >= AccountLayout.span ? AccountLayout.decode(Uint8Array.from(a.data).subarray(0, AccountLayout.span)) : undefined)
/** A token account's balance (base units), or 0 when it doesn't exist. */
const tokenBalance = (a: Account) => tokenAccount(a)?.amount ?? 0n
/** Who besides the owner may move a token account's balance or close it: a delegate, a close authority. */
const authorities = (a: Account) => {
  const t = tokenAccount(a)
  return `${t?.delegateOption ? t.delegate.toBase58() : "-"} ${t?.closeAuthorityOption ? t.closeAuthority.toBase58() : "-"}`
}
/** Whether this account is a token account (either token program's) that `owner` holds. */
const heldBy = (a: Account, owner: PublicKey) =>
  !!a && (a.owner.equals(TOKEN_PROGRAM_ID) || a.owner.equals(TOKEN_2022_PROGRAM_ID)) && !!tokenAccount(a)?.owner.equals(owner)

/**
 * The wallet's SOL and our fee payer's (lamports); the wallet's token, its USDC and its Luckout Balance; the balances
 * of the wallet's other token accounts the swap is handed; and, for each of the wallet's token accounts (its token, its
 * USDC, the others), who may spend or close it besides its owner, and its owner (undefined where there's none).
 */
export interface Balances {
  readonly lamports: bigint
  readonly feePayer: bigint
  readonly token: bigint
  readonly usdc: bigint
  readonly balance: bigint
  readonly others: ReadonlyArray<bigint>
  readonly authorities: ReadonlyArray<string>
  readonly owners: ReadonlyArray<string | undefined>
}

/**
 * Why a simulated swap mustn't be signed, or undefined: the wallet spends exactly `spend` of its token; its USDC, in
 * its account and its Balance together, rises by at least the swap's minimum, and its Balance rises (the deposit ran);
 * none of any other token it holds is taken; nobody new may spend from or close any of its accounts (a delegate leaves
 * today's balances as they are and empties them later); every token account of its own is still there and still its
 * own (one the transaction opens for it included); its SOL isn't spent; and our fee payer spends at most
 * MAX_FEE_PAYER_SPEND.
 */
export const outcomeProblem = (before: Balances, after: Balances, expect: { spend: bigint; minOut: bigint; wallet: string }) => {
  if (before.token - after.token !== expect.spend) return "The swap wouldn't take exactly the amount shown. Nothing was sent: try again."
  if (!(after.balance > before.balance) || after.balance + after.usdc - (before.balance + before.usdc) < expect.minOut) {
    return "The swap wouldn't put at least its minimum into your Balance. Nothing was sent: try again."
  }
  if (after.others.some((b, i) => b < (before.others[i] ?? 0n))) return "The swap would take another token from your wallet. Nothing was sent: try again."
  // Closing one, even empty, sends its rent wherever the swap says.
  if (after.owners.some((o, i) => o === undefined && before.owners[i] !== undefined)) {
    return "The swap would close one of your wallet's token accounts. Nothing was sent: try again."
  }
  if (after.owners.some((o) => o !== undefined && o !== expect.wallet)) return "The swap would hand one of your wallet's token accounts to someone else. Nothing was sent: try again."
  if (after.authorities.some((a, i) => a !== before.authorities[i])) return "The swap would let someone else spend from your wallet. Nothing was sent: try again."
  if (after.lamports < before.lamports) return "The swap would spend your wallet's SOL. Nothing was sent: try again."
  if (before.feePayer - after.feePayer > MAX_FEE_PAYER_SPEND) return "The swap would cost more in fees and rent than expected. Nothing was sent: try again in a minute."
  return undefined
}

/** A failed simulation in the customer's words, from Solana's logs. */
export const simulationProblem = (logs: ReadonlyArray<string>, symbol: string) => {
  const text = logs.join("\n")
  // Jupiter's SlippageToleranceExceeded (6001).
  if (/0x1771\b|SlippageToleranceExceeded/.test(text)) return moved(symbol)
  // The program's DepositTooSmall (6024).
  if (/0x1788\b|Deposit at least 1 USDC/.test(text)) return `That's less than 1 USDC of ${symbol}. Swap at least 1 USDC's worth.`
  if (/insufficient funds/i.test(text)) return `This wallet doesn't hold enough ${symbol} for this. Nothing was sent.`
  // Our fee payer's SOL, not the customer's: they need none.
  if (/insufficient lamports|no record of a prior credit|InsufficientFundsForRent/i.test(text)) {
    return "Luckout can't pay this swap's network fee right now. Nothing was sent: try again later."
  }
  return undefined
}

/** A swap's transaction, prepared for the customer to sign (Solana.prepare), and what it gives. */
export interface SwapTransaction {
  readonly transaction: string
  readonly token: string
  /** Exactly what it swaps (base units of the token). */
  readonly spend: bigint
  /** USDC (base units): what the route gives, and the least it may, or it fails. */
  readonly usdcOut: bigint
  readonly minUsdcOut: bigint
}

export class Swap extends Context.Service<Swap, {
  /** The swap-paid tokens with Jupiter's price, or none when Jupiter isn't configured (JUPITER_API_KEY). */
  readonly tokens: Effect.Effect<ReadonlyArray<SwapToken & { readonly price: number }>>
  /**
   * The transaction for `wallet` to sign: swaps exactly `spend` of the token (by default all they hold) into their USDC
   * account, then moves that account's USDC into their Balance. It is simulated and checked first.
   */
  transaction(o: { token: SwapToken; wallet: string; spend?: bigint | undefined }): Effect.Effect<SwapTransaction, SwapUnavailable>
}>()("luckout/Swap") {
  static readonly layer = Layer.effect(
    Swap,
    Effect.gen(function*() {
      // Jupiter's keyed API (portal.jup.ag). Without a key no token is offered, and nothing here is called.
      const key = yield* Config.option(Config.Redacted("JUPITER_API_KEY"))
      const baseUrl = yield* Config.String("JUPITER_API_URL").pipe(Config.withDefault("https://api.jup.ag"))
      const solana = yield* Solana
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
      // window before the customer hears it. What went wrong underneath is logged, never told.
      const told = <A, E, R>(e: Effect.Effect<A, E, R>): Effect.Effect<A, SwapUnavailable, R> =>
        e.pipe(Effect.catch((err) =>
          err instanceof SwapUnavailable
            ? Effect.fail(err)
            : Effect.logWarning("Jupiter unavailable", err).pipe(Effect.andThen(Effect.fail(fail("Jupiter didn't answer. Nothing was sent: try again in a minute."))))
        ))
      const patiently = <A, R>(e: Effect.Effect<A, SwapUnavailable, R>) =>
        e.pipe(Effect.retry({ times: 4, schedule: Schedule.spaced("2500 millis"), while: (err) => err.busy === true }))
      const wrap = <A, E, R>(e: Effect.Effect<A, E, R>) => patiently(told(e))
      const onChain = <A, E extends { readonly message: string }>(what: string, e: Effect.Effect<A, E>) =>
        e.pipe(Effect.catch((err) =>
          Effect.logWarning(`Solana: ${what}`, err.message).pipe(Effect.andThen(Effect.fail(fail("Solana didn't answer. Nothing was sent: try again in a minute."))))
        ))

      const prices = yield* Cache.makeWith(
        (_: "all") =>
          told(
            http.get("/price/v3", { urlParams: { ids: SWAP_TOKENS.map((t) => t.mint).join(",") } }).pipe(
              Effect.flatMap(read(Schema.Record(Schema.String, Schema.Struct({ usdPrice: Schema.Number }))))
            )
          ),
        // Short: the price is also what a swap is checked against. A failure isn't kept: the next ask tries again.
        { capacity: 1, timeToLive: (exit) => (Exit.isSuccess(exit) ? "15 seconds" : "1 second") }
      )
      const priceOf = (t: SwapToken) =>
        Cache.get(prices, "all").pipe(patiently, Effect.flatMap((p) => {
          const usd = p[t.mint]?.usdPrice
          return usd && usd > 0 ? Effect.succeed(usd) : Effect.fail(fail(`Jupiter has no price for ${t.symbol} right now.`))
        }))

      // Both the raw quote (Jupiter wants it back verbatim to build the swap) and the fields we check.
      const quote = (t: SwapToken, spend: bigint, usdcMint: string, exclude: ReadonlyArray<string>) =>
        wrap(
          http.get("/swap/v1/quote", {
            urlParams: {
              inputMint: t.mint,
              outputMint: usdcMint,
              amount: String(spend),
              swapMode: "ExactIn",
              slippageBps: String(SLIPPAGE_BPS),
              // Routes only through liquid tokens, and leaves room in the transaction for our fee payer and deposit.
              restrictIntermediateTokens: "true",
              maxAccounts: "32",
              ...(exclude.length > 0 ? { excludeDexes: exclude.join(",") } : {})
            }
          }).pipe(
            Effect.flatMap((res) =>
              read(Schema.Unknown)(res).pipe(Effect.flatMap((raw) => Schema.decodeUnknownEffect(JupiterQuote)(raw).pipe(Effect.map((q) => ({ q, raw })))))
            )
          )
        )

      const tokens = Option.isNone(key)
        ? Effect.succeed([])
        : Effect.forEach(SWAP_TOKENS, (t) => priceOf(t).pipe(Effect.map((price) => [{ ...t, price }]), Effect.orElseSucceed(() => [])))
          .pipe(Effect.map((ts) => ts.flat()))

      const toInstruction = (i: Instruction) =>
        new TransactionInstruction({
          programId: new PublicKey(i.programId),
          keys: i.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
          data: Buffer.from(i.data, "base64")
        })

      type Order = { token: SwapToken; wallet: PublicKey; feePayer: PublicKey; spend: bigint; usdcMint: PublicKey; before: Array<Account> }
      /**
       * One try: a route, the transaction around it, and its simulation. A route that fails our slippage in the
       * simulation (a market whose quote was already stale) comes back as the markets to leave out next time.
       */
      const attempt = (o: Order, exclude: ReadonlyArray<string>) => Effect.gen(function*() {
        const program = solana.program
        const usdc = getAssociatedTokenAddressSync(o.usdcMint, o.wallet)
        const source = getAssociatedTokenAddressSync(new PublicKey(o.token.mint), o.wallet)
        const usdPrice = yield* priceOf(o.token)
        const { q, raw } = yield* quote(o.token, o.spend, o.usdcMint.toBase58(), exclude)
        const problem = quoteProblem(q, { token: o.token, spend: o.spend, usdPrice, usdcMint: o.usdcMint.toBase58() })
        if (problem) return yield* fail(problem)

        const built = yield* wrap(
          HttpClientRequest.post("/swap/v1/swap-instructions").pipe(
            HttpClientRequest.bodyJsonUnsafe({
              quoteResponse: raw,
              userPublicKey: o.wallet.toBase58(),
              // Our fee payer pays the fee and the rent of any token account the route opens for the wallet. No
              // `feeAccount`: that is Jupiter's platform fee, which we don't take.
              payer: o.feePayer.toBase58(),
              wrapAndUnwrapSol: false,
              dynamicComputeUnitLimit: true
            }),
            http.execute,
            Effect.flatMap(read(SwapInstructions))
          )
        )
        const jupiter: JupiterInstructions = {
          budget: built.computeBudgetInstructions.map(toInstruction),
          setup: built.setupInstructions.map(toInstruction),
          swap: toInstruction(built.swapInstruction),
          rest: [...(built.cleanupInstruction ? [built.cleanupInstruction] : []), ...(built.otherInstructions ?? [])].map(toInstruction)
        }
        const refused = jupiterProblem(jupiter, o)
        if (refused) return yield* fail(refused)
        // The wallet's other token accounts the swap is handed (one of a token it routes through, say) are watched
        // too: an instruction reaches no account it isn't handed, and the swap may pass through those, never leave
        // them lower. Read-only ones as well: whether an account is writable is decided for the whole transaction, so
        // another instruction (opening that account, a no-op) can make it writable for the swap too. And one that
        // Jupiter's setup opens for the wallet in this transaction: it must end up the wallet's alone, or what the wallet
        // is sent in that token later lands where someone else can take it.
        const watched = [o.wallet, o.feePayer, source, usdc, program.customer(o.wallet)]
        const handed = [...new Set(jupiter.swap.keys.map((k) => k.pubkey.toBase58()))]
          .filter((k) => !watched.some((w) => w.toBase58() === k))
          .map((k) => new PublicKey(k))
        const found = handed.length === 0 ? [] : yield* onChain("swap accounts", solana.accounts(handed))
        // jupiterProblem let through only the Associated Token program's opening of the wallet's own accounts: the second key.
        const opened = new Set(jupiter.setup.map((i) => i.keys[1]?.pubkey.toBase58()))
        const others = handed.flatMap((key, i) => (heldBy(found[i], o.wallet) || (!found[i] && opened.has(key.toBase58())) ? [{ key, before: found[i] }] : []))

        const tableKeys = built.addressLookupTableAddresses.map((a) => new PublicKey(a))
        const tables = tableKeys.length === 0 ? [] : yield* onChain("lookup tables", solana.accounts(tableKeys))
        if (tables.some((t) => !t)) return yield* fail("Jupiter's route uses a lookup table Solana doesn't have. Nothing was sent: try again.")
        const lookupTables = tables.map((t, i) => new AddressLookupTableAccount({ key: tableKeys[i]!, state: AddressLookupTableAccount.deserialize(t!.data) }))
        const tooBig = fail("Jupiter's route is too big for one transaction. Nothing was sent: try a smaller amount.")
        const prepared = yield* solana.prepare(swapInstructions(program, jupiter, o.wallet, usdc), o.wallet, { units: unitsFor(jupiter.budget), lookupTables }).pipe(
          Effect.catch((e) => (/too big/.test(e.message) ? Effect.fail(tooBig) : onChain("prepare", Effect.fail(e))))
        )
        // Signatures included: compiling only checks the message.
        if (Buffer.from(prepared.transaction, "base64").length > PACKET_DATA_SIZE) return yield* tooBig

        // What it does, not only what it says: the balances it leaves.
        const sim = yield* onChain("simulation", solana.inspect(prepared.transaction, [...watched, ...others.map((x) => x.key)]))
        if (sim.error) {
          const markets = q.routePlan.map((r) => r.swapInfo.label)
          yield* Effect.logWarning("swap simulation failed", markets.join(" > "), sim.error.text, sim.logs.slice(-6).join(" | "))
          const problem = simulationProblem(sim.logs, o.token.symbol)
          if (problem === moved(o.token.symbol)) return { retryWithout: markets }
          return yield* fail(problem ?? "The swap wouldn't go through right now. Nothing was sent: try again in a minute.")
        }
        const balances = (list: ReadonlyArray<Account>): Balances => {
          const wallets = [list[2], list[3], ...list.slice(5)]
          const customer = list[4]
          return {
            lamports: list[0]?.lamports ?? 0n,
            feePayer: list[1]?.lamports ?? 0n,
            token: tokenBalance(list[2]),
            usdc: tokenBalance(list[3]),
            balance: customer ? decodeAccount<Customer>("Customer", customer.data).balance : 0n,
            others: list.slice(5).map(tokenBalance),
            authorities: wallets.map(authorities),
            owners: wallets.map((a) => tokenAccount(a)?.owner.toBase58())
          }
        }
        const wrong = outcomeProblem(balances([...o.before, ...others.map((x) => x.before)]), balances(sim.accounts), {
          spend: o.spend,
          minOut: BigInt(q.otherAmountThreshold),
          wallet: o.wallet.toBase58()
        })
        if (wrong) return yield* fail(wrong)
        return { ...prepared, spend: o.spend, usdcOut: BigInt(q.outAmount), minUsdcOut: BigInt(q.otherAmountThreshold) }
      })

      // ponytail: in memory, one process (ADR-0006). One build at a time per wallet: each asks Jupiter, whose limit is
      // per key, and simulates.
      const building = new Set<string>()
      const transaction = Effect.fn("Swap.transaction")(function*(o: { token: SwapToken; wallet: string; spend?: bigint | undefined }) {
        if (Option.isNone(key)) return yield* fail(`${o.token.symbol} isn't taken here.`)
        if (!isWallet(o.wallet)) return yield* fail("That isn't a Solana wallet address.")
        const feePayer = solana.feePayer
        if (!feePayer) return yield* fail("Swaps are resting. Nothing was sent: try again later.")
        const wallet = new PublicKey(o.wallet)
        if (building.has(o.wallet)) return yield* fail("Your swap is on its way. Try again in a few seconds.")
        building.add(o.wallet)
        return yield* Effect.gen(function*() {
          // The chain first, before any call to Jupiter: a wallet without the token, or without its approval, ends here.
          // These are also what the simulation's balances are compared with.
          const config = yield* onChain("config", solana.config)
          const usdc = getAssociatedTokenAddressSync(config.usdc_mint, wallet)
          const source = getAssociatedTokenAddressSync(new PublicKey(o.token.mint), wallet)
          const before = yield* onChain("balances", solana.accounts([wallet, feePayer, source, usdc, solana.program.customer(wallet)]))
          const account = tokenAccount(before[3])
          if (!before[4] || !account?.delegateOption || !account.delegate.equals(solana.program.vaultAuthority)) {
            return yield* fail("Approve your Deposit Address first: open Wallet in the app. Nothing was sent.")
          }
          const held = tokenBalance(before[2])
          const spend = o.spend ?? held
          if (spend <= 0n) return yield* fail(`This wallet holds no ${o.token.symbol}. Nothing was sent.`)
          if (held < spend) return yield* fail(`This wallet doesn't hold the ${formatUnits(spend, o.token.decimals)} ${o.token.symbol} to swap. Nothing was sent.`)
          const order = { token: o.token, wallet, feePayer, spend, usdcMint: config.usdc_mint, before }
          const first = yield* attempt(order, [])
          if (!("retryWithout" in first)) return first
          const second = yield* attempt(order, first.retryWithout)
          if ("retryWithout" in second) return yield* fail(moved(o.token.symbol))
          return second
        }).pipe(Effect.ensuring(Effect.sync(() => building.delete(o.wallet))))
      })

      return Swap.of({ tokens, transaction })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
}
