import {
  ExitQuote,
  HeldToken,
  SendBackQuote,
  type SignedIntent,
  SwapTx,
  solanaAddress,
  TopUpAsset,
  TopUpQuote,
  TopUpStatus,
  TopUpUnavailable,
  Transfer,
  type TransferPhase,
  tokenAmount,
  type Wallet,
  walletOf
} from "@luckout/api"
import { Config, Context, Effect, Layer, Schedule, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { formatUnits } from "viem"
import { SqlClient } from "effect/sql"
import { parsePayload, payloadRefusal, signedBy } from "./Intents.ts"
import { Alerts } from "./Alerts.ts"
import { Near, Network } from "./Near.ts"
import { echoProblem, OneClick, type QuoteRequest, type SwapDetails } from "./OneClick.ts"
import { Relay } from "./Relay.ts"
import { isWallet, SOL_USDC_ASSET, Swap, swapAssetId, type SwapTransaction, swapTokenByMint, swapTokenOf } from "./Swap.ts"

// Top-ups (ADR-0001): a NEAR Intents 1Click swap from any supported chain that lands native
// USDC in the customer's own NEAR account; one deposit then moves it into their Balance.
// The server pins the destination (USDC) and the recipient (the signed-in account), so this
// endpoint can't be used to swap anything else or pay anyone else.
//
// EVM and Solana wallets (ADR-0011) have no NEAR account: their swap lands in their own NEAR Intents
// account, and the intent they signed when it started moves exactly that USDC into Luckout once it lands.
// Withdrawals go the other way: a 1Click quote from their Intents account to their own address.
//
// What 1Click sends back (a refund, or the extra a Top-Up asked for) goes to the wallet it came from when that's an
// EVM or Solana wallet paying on its own chain; otherwise it lands in the customer's NEAR Intents account, in the
// token paid with, and a send-back moves it to their own wallet (direction 'back').
//
// A Solana account is named like a NEAR implicit one, so the kind of wallet comes from the session, and each swap
// keeps the kind it was quoted for (`wallet`; rows from before it are read from the account's name).
//
// A token 1Click doesn't take, like ORE, is paid through a swap (ADR-0014, Swap.ts): the row is 1Click's side, USDC
// on Solana, and its paid_* columns say what the customer's own transaction swaps into it. That transaction is built
// for their Solana wallet when they sign in with one, or for whichever wallet scans its Solana Pay code.

export const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
export const NEAR_USDC_ASSET = `nep141:${MAINNET_USDC}`
const SYMBOLS = new Set(["USDC", "USDT", "ETH", "BTC", "SOL", "wNEAR"])
const CHAINS = new Set(["eth", "arb", "base", "sol", "btc", "pol", "bsc", "near"])
/** Chains an EVM wallet can withdraw to: its own address works on each. */
const EVM_CHAINS = new Set(["eth", "arb", "base", "pol", "bsc"])
/** USDC on Base: where an EVM wallet's change from a swap-paid Top-Up (ADR-0014), USDC on Solana, goes. */
const BASE_USDC_ASSET = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"
/** An EVM wallet paying through a Solana Pay code has no address on Solana: 1Click's change lands there as USDC on Solana. */
const evmChange = (wallet: Wallet, assetId: string) => wallet === "evm" && assetId === SOL_USDC_ASSET
/** A swap's transaction can land up to about 90 seconds after it's built: none is built closer than this to the deadline. */
const SWAP_DEADLINE_MARGIN_MS = 2 * 60_000
/**
 * A swap's blockhash lasts 150 blocks, about a minute. A wallet that scanned the code and asks again within its first
 * 30 seconds (Solana Pay wallets often do) gets the same transaction, which still leaves it half a minute to be
 * approved and land; after that, a fresh one. The signed-in app asks only to send, so it always gets a fresh one: a
 * customer sending again after a failed swap needs a new route.
 */
const SWAP_REUSE_MS = 30_000
/**
 * The most transactions built for one quote. Paying takes one; a wallet asking again within SWAP_REUSE_MS costs
 * nothing, and neither does a refusal before Jupiter is asked (a wallet without the token, scanned by mistake); a send
 * that failed when the price moved, a slow approval, or a busy Jupiter each take one more. Eight leaves room for all of
 * those, and past it a new quote is one tap. It bounds what one quote can spend of Jupiter's per-key limit (each build
 * is up to two routes of three calls) on a request anyone holding its Solana Pay link can make.
 */
const SWAP_BUILDS = 8
/** The chains a wallet signing through NEAR Intents has its own address on. */
const HOME_CHAINS: Record<Wallet, ReadonlySet<string>> = { near: new Set(), evm: EVM_CHAINS, solana: new Set(["sol"]) }
/** That wallet's address on its own chains: an EVM account is its address; a Solana account is its key in hex. */
const homeAddress = (accountId: string, wallet: Wallet) => (wallet === "solana" ? solanaAddress(accountId) : accountId)
/** Top-Ups whose move-in may wait at once, per account, so nobody can crowd out everyone else's. */
const MOST_WAITING = 3
/** Swaps checked per pass, least recently checked first. */
const PER_PASS = 40
/** Of those, how many are kept for swaps 1Click has seen money in; quotes nobody has paid into yet get the rest. */
const SEEN_PER_PASS = 30
/** Quotes of one account that 1Click has seen no money in and the tracking pass still follows, at once. */
const MOST_OPEN = 10
/** Paid Top-Ups 1Click hasn't seen that an admin hears about one by one, per two hours; past that, one line covers the rest. */
const UNSEEN_ALERTS = 5
/**
 * The relayer's message when NEAR didn't answer: before anything was sent (it's sent next pass), or after (it may still
 * have run, so the saved transaction is resumed). Either way the move-in waits, never fails.
 */
const UNANSWERED = /didn't answer/
/** 1Click is done with these: the money arrived or went back. */
const FINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"])
/** A quote nobody paid into is still checked this long past its deadline, in case the transfer was late. */
const LATE_DEPOSIT_GRACE_MS = 2 * 60 * 60 * 1000
/**
 * The same for a swap-paid one. Its payment is a transaction we build, none closer than SWAP_DEADLINE_MARGIN_MS to the
 * deadline, but a Solana Pay wallet may give it a fresh blockhash (the spec lets it, for a transaction it signs alone),
 * so one approved late can still land well after the deadline. An hour covers a customer who scanned the code and
 * came back to it.
 */
const SWAP_LATE_GRACE_MS = 60 * 60_000
/**
 * How long past its deadline an unpaid swap-paid quote holds a place in the account's cap: shorter than it's watched,
 * since its price may have moved past use in minutes, and the customer needs a new quote, not a place held for an hour.
 */
const SWAP_CAP_GRACE_MS = 10 * 60_000
/** A paid Top-Up 1Click hasn't seen this long past its deadline is chased: the customer and an admin are told. */
const UNSEEN_MS = 5 * 60_000
/** A landed Top-Up whose move-in has waited this long is late (it normally runs within one 15-second pass): both are told. */
const MOVE_LATE_MS = 5 * 60_000
/**
 * When 1Click starts refunding a swap that hasn't completed: what the customer is told to beat. (1Click's own
 * `deadline` in a quote is days later: how long the deposit address stays open, not when refunds begin.)
 */
const refundsBegin = () => new Date(Date.now() + 30 * 60 * 1000)
const CHAIN_NAMES: Record<string, string> = { eth: "Ethereum", arb: "Arbitrum", base: "Base", pol: "Polygon", bsc: "BNB Chain", sol: "Solana", btc: "Bitcoin", near: "NEAR" }
const chainName = (c: string | null) => (c ? CHAIN_NAMES[c] ?? c : "another chain")
const walletOn = (c: string | null) => (c === "near" ? "your NEAR wallet" : `your wallet on ${chainName(c)}`)
/**
 * Chains where 1Click's refund to the paying wallet costs it a fraction of a cent: it pays the gas out of the refund
 * (on Base, 0.0024 of a 0.0101 USDC change), so on Ethereum a Top-Up's change could be eaten whole.
 */
const CHEAP_REFUND_CHAINS = new Set(["arb", "base", "pol", "bsc", "sol"])
/** The kind of wallet a swap was quoted for. */
const walletOfRow = (r: Pick<SwapRow, "account_id" | "wallet">): Wallet => r.wallet ?? walletOf(r.account_id)
/**
 * A Top-Up's refund goes straight back to the wallet it came from: an EVM or Solana wallet signs with its own key
 * (Intents.ts), so its address is its own on its chains. Anything else goes to their NEAR Intents account.
 */
export const refundsToWallet = (r: Pick<SwapRow, "direction" | "account_id" | "chain" | "wallet">) =>
  r.direction === "in" && r.chain !== null && CHEAP_REFUND_CHAINS.has(r.chain) && HOME_CHAINS[walletOfRow(r)].has(r.chain)
const usd = (micro: number) => `$${(micro / 1e6).toFixed(2)}`
/** A swap-paid Top-Up's "0.26566 ORE": rounded up, as an amount to pay is, never its 11 decimals. */
const paidText = (r: Pick<SwapRow, "paid_amount" | "paid_symbol">) => `${tokenAmount(r.paid_amount ?? "", r.paid_symbol ?? "", "up")} ${r.paid_symbol}`

/** A row of `intents_swaps`: one 1Click swap of a customer's money. */
export interface SwapRow {
  readonly deposit_address: string
  readonly deposit_memo: string | null
  readonly account_id: string
  /** The kind of wallet it was quoted for; null on rows from before Solana wallets. */
  readonly wallet?: Wallet | null
  readonly direction: "in" | "out" | "back"
  readonly usdc: string
  readonly symbol: string | null
  readonly chain: string | null
  readonly amount_in: string | null
  readonly amount_out: string | null
  readonly deposited: string | null
  readonly deadline: Date | string | null
  readonly time_estimate: number | null
  readonly status: string | null
  readonly deposit_seen_at: Date | string | null
  readonly status_at: Date | string | null
  readonly delivered_tx: string | null
  readonly refunded: string | null
  readonly refund_reason: string | null
  readonly move: string | null
  readonly move_detail: string | null
  readonly move_in: SignedIntent | null
  /** A send-back: the held token and all of it (base units) it takes from their NEAR Intents account. */
  readonly origin_asset: string | null
  readonly origin_amount: string | null
  /** The customer's transfer to the deposit address, when the app sent it (or we found it, for a swap-paid Top-Up). */
  readonly deposit_tx: string | null
  /** A swap-paid Top-Up (ADR-0014): the token the customer's transaction swaps into this USDC, and exactly how much. */
  readonly paid_symbol?: string | null
  readonly paid_mint?: string | null
  readonly paid_amount?: string | null
  readonly paid_raw?: string | null
  /** Base units of amount_in: the USDC the swap's transaction sends on to 1Click. */
  readonly amount_in_raw?: string | null
  /** The customer dismissed it before paying into it (see TopUp.dismiss). */
  readonly dismissed_at?: Date | string | null
  readonly told: ReadonlyArray<string>
  readonly created_at: Date | string
}

const ms = (d: Date | string | null) => (d === null ? undefined : new Date(d).getTime())

/** Where the money is, in the customer's words (see TransferPhase). */
export const phaseOf = (r: Pick<SwapRow, "direction" | "account_id" | "wallet" | "status" | "move">): TransferPhase => {
  if (r.status === "REFUNDED" || r.status === "FAILED") return "refunded"
  if (r.status === "INCOMPLETE_DEPOSIT" && r.direction === "in") return "incomplete"
  if (r.status === "SUCCESS") {
    if (r.direction !== "in") return "done"
    if (walletOfRow(r) === "near") return "in-wallet"
    return r.move === "moved" ? "done" : r.move === "waiting" ? "moving" : "in-intents"
  }
  if (!r.status || r.status === "PENDING_DEPOSIT") return r.direction === "in" ? "awaiting-transfer" : "swapping"
  return "swapping"
}

/**
 * 1Click has the money but it's taking well over its usual time, or it landed and its move-in still hasn't run
 * after MOVE_LATE_MS: safe, and the customer should hear so. Never a short payment: that waits on the customer,
 * who is told so instead.
 */
export const isLate = (r: Pick<SwapRow, "status" | "status_at" | "move" | "deposit_seen_at" | "time_estimate">, now: number) => {
  if (r.status === "SUCCESS" && r.move === "waiting") return now - (ms(r.status_at) ?? now) > MOVE_LATE_MS
  const seen = ms(r.deposit_seen_at)
  if (seen === undefined || (r.status && (FINAL.has(r.status) || r.status === "INCOMPLETE_DEPOSIT"))) return false
  return now - seen > Math.max(10 * 60_000, 3 * (r.time_estimate ?? 0) * 1000)
}

/** 1Click gives refund reasons as codes (QUOTE_EXPIRED); the customer reads words. */
const reasonText = (code: string) =>
  code === "QUOTE_EXPIRED"
    ? "the full amount didn't arrive before the deadline"
    : /^[A-Z_]+$/.test(code) ? code.toLowerCase().replaceAll("_", " ") : code

const explorerOf = (depositAddress: string) => `https://explorer.near-intents.org/transactions/${depositAddress}`

/** The Telegram notice for what just happened to this swap, keyed so each is sent once. */
export const noticeFor = (r: SwapRow, now: number, web: string): { key: string; text: string } | undefined => {
  const phase = phaseOf(r)
  const amount = usd(Number(r.usdc))
  const leg = `${r.amount_in ? tokenAmount(r.amount_in, r.symbol ?? "", "up") : ""} ${r.symbol ?? ""} on ${chainName(r.chain)}`.replace(/\s+/g, " ").trim()
  // A swap-paid Top-Up's USDC came from the customer's own swap: what they paid with is said too.
  const from = r.paid_symbol ? `${leg}, from ${paidText(r)}` : leg
  const refundPlace = refundsToWallet(r) ? walletOn(r.chain) : "your NEAR Intents account"
  if (r.direction === "in") {
    if (phase === "incomplete") {
      const left = (ms(r.deadline) ?? now) - now
      return {
        key: "incomplete",
        text: `1Click got ${r.deposited ? tokenAmount(r.deposited, r.symbol ?? "", "down") : "part"} of the ${from} your ${amount} Top-Up needs. ${
          left > 60_000
            ? `Send the rest to the same address within ${Math.floor(left / 60_000)} min, or what arrived goes back to ${refundPlace}.`
            : `What arrived goes back to ${refundPlace}.`
        } See ${web}/wallet`
      }
    }
    if (phase === "done") return { key: "landed", text: `Your ${amount} Top-Up is in your Luckout balance.` }
    if (phase === "in-wallet") return { key: "landed", text: `Your ${amount} Top-Up landed in your NEAR wallet. Deposit it into Luckout at ${web}/wallet` }
    if (phase === "in-intents") {
      return { key: "landed", text: `Your ${amount} Top-Up landed in your NEAR Intents account${r.move_detail ? ` but didn't move into Luckout (${r.move_detail})` : ""}. Move it in at ${web}/wallet` }
    }
    if (phase === "refunded") {
      return {
        key: "refunded",
        text: `Your Top-Up (${from}) didn't go through${r.refund_reason ? `: ${reasonText(r.refund_reason)}` : ""}. 1Click sent ${r.refunded ? `${tokenAmount(r.refunded, r.symbol ?? "", "down")} ${r.symbol ?? ""}`.trim() : "it"} back to ${refundPlace}. See ${web}/wallet`
      }
    }
  } else if (r.direction === "back") {
    if (phase === "done") return { key: "arrived", text: `${r.amount_out ?? "It"} ${r.symbol ?? ""} is in ${walletOn(r.chain)}.`.replace(/\s+/g, " ") }
    if (phase === "refunded") return { key: "refunded", text: `Sending it to ${walletOn(r.chain)} didn't go through. It's still in your NEAR Intents account: ${web}/wallet` }
  } else {
    if (phase === "done") return { key: "arrived", text: `Your ${amount} withdrawal arrived: ${r.amount_out ?? ""} ${r.symbol ?? "USDC"} on ${chainName(r.chain)}.`.replace(/\s+/g, " ") }
    if (phase === "refunded") return { key: "refunded", text: `Your ${amount} withdrawal to ${chainName(r.chain)} was refunded to your NEAR Intents account. Move it back into Luckout at ${web}/wallet` }
  }
  // Paid (we have the transaction), but 1Click still hasn't seen it after the deadline: say so, and we're told too.
  if (r.direction === "in" && r.deposit_tx && (!r.status || r.status === "PENDING_DEPOSIT") && now > (ms(r.deadline) ?? now) + UNSEEN_MS) {
    return {
      key: "unseen",
      text: `1Click hasn't confirmed your ${amount} Top-Up transfer (${from}) yet. It's at 1Click's deposit address: it either goes through or comes back to ${refundPlace}. Luckout is looking into it. Track it: ${explorerOf(r.deposit_address)}`
    }
  }
  if (phase === "moving" && isLate(r, now)) {
    return {
      key: "late",
      text: `Your ${amount} Top-Up landed, but moving it into your Luckout balance is taking longer than usual. It's safe in your NEAR Intents account, and Luckout keeps trying. See ${web}/wallet`
    }
  }
  if (isLate(r, now)) {
    return {
      key: "late",
      text: `${r.direction === "back" ? `Sending to ${walletOn(r.chain)}` : `Your ${amount} ${r.direction === "in" ? "Top-Up" : "withdrawal"}`} is taking longer than usual. It's safe: it either arrives or 1Click refunds it. Track it: ${explorerOf(r.deposit_address)}`
    }
  }
  return undefined
}

export class TopUp extends Context.Service<TopUp, {
  readonly assets: Effect.Effect<ReadonlyArray<TopUpAsset>, TopUpUnavailable>
  /** `wallet`: how the customer signed in (by default, read from the account's name). */
  quote(accountId: string, originAsset: string, usdc: number, dry?: boolean, wallet?: Wallet): Effect.Effect<TopUpQuote, TopUpUnavailable>
  status(accountId: string, depositAddress: string): Effect.Effect<TopUpStatus, TopUpUnavailable>
  /** Solana wallets, a swap-paid Top-Up (ADR-0014): the transaction that pays it, for their own wallet to sign. */
  swapTx(accountId: string, depositAddress: string, wallet?: Wallet): Effect.Effect<SwapTx, TopUpUnavailable>
  /** Solana Pay (ADR-0014): the same transaction for whichever Solana wallet scanned the Top-Up's code, and what it shows. */
  solanaPay(depositAddress: string, payer: string): Effect.Effect<{ readonly transaction: string; readonly message: string }, TopUpUnavailable>
  /** The app paid this Top-Up from the customer's wallet: keeps the transaction and passes it to 1Click. */
  sent(accountId: string, depositAddress: string, txHash: string): Effect.Effect<void, TopUpUnavailable>
  /** The customer is done with a Top-Up they haven't paid into: it leaves their list, and a swap-paid one is cancelled. */
  dismiss(accountId: string, depositAddress: string): Effect.Effect<void, TopUpUnavailable>
  /** EVM and Solana wallets: keeps the signed intent that moves this Top-Up into Luckout, and sends it once the swap lands. */
  move(accountId: string, depositAddress: string, signed: SignedIntent): Effect.Effect<void, TopUpUnavailable>
  /** Testnet, EVM and Solana wallets: 100 test USDC into their NEAR Intents account (they move it in themselves), once a day. */
  faucet(accountId: string, wallet?: Wallet): Effect.Effect<void, TopUpUnavailable>
  /** The customer's swaps still on their way, and those that ended in the last day. */
  transfers(accountId: string): Effect.Effect<ReadonlyArray<Transfer>>
  /** What else is in the customer's NEAR Intents account (change and refunds from 1Click), so none of it is out of sight. */
  held(accountId: string, wallet?: Wallet): Effect.Effect<ReadonlyArray<HeldToken>, TopUpUnavailable>
  /** A quote to send all of a held token to the customer's own wallet; they sign the transfer into it. */
  sendBack(accountId: string, assetId: string, wallet?: Wallet): Effect.Effect<SendBackQuote, TopUpUnavailable>
  /** One tracking pass now, as the background loop runs every 15 seconds (tests). */
  readonly trackNow: Effect.Effect<void>
  /** EVM and Solana wallets: a quote to send USDC from their NEAR Intents account to their own address on their own chain. */
  exit(accountId: string, destinationAsset: string, usdc: number, wallet?: Wallet): Effect.Effect<ExitQuote, TopUpUnavailable>
}>()("luckout/TopUp") {
  static readonly layer = Layer.effect(
    TopUp,
    Effect.gen(function*() {
      const oneClick = yield* OneClick
      const sql = yield* SqlClient.SqlClient
      const near = yield* Near
      const relay = yield* Relay
      const alerts = yield* Alerts
      const swaps = yield* Swap
      const mainnet = (yield* Network) === "mainnet"
      const web = yield* Config.String("WEB_ORIGIN").pipe(Config.withDefault("http://localhost:3000"))
      const fail = (message: string) => new TopUpUnavailable({ message })
      const unavailable = (e: { message: string }) => fail(e.message)

      const assets = oneClick.tokens.pipe(
        Effect.map((ts) =>
          ts.filter((t) => SYMBOLS.has(t.symbol) && CHAINS.has(t.blockchain) && t.assetId !== NEAR_USDC_ASSET)
            .map((t) =>
              new TopUpAsset({
                assetId: t.assetId,
                symbol: t.symbol,
                chain: t.blockchain,
                ...(t.contractAddress && (EVM_CHAINS.has(t.blockchain) || t.blockchain === "sol") ? { contract: t.contractAddress } : {}),
                ...(t.decimals !== undefined ? { decimals: t.decimals } : {}),
                ...(t.price !== undefined ? { price: t.price } : {})
              })
            )
        ),
        Effect.mapError(unavailable)
      )
      /** The tokens taken through a swap (ADR-0014): on Solana, never withdrawn to or sent back as. */
      const swapAssets = swaps.tokens.pipe(Effect.map((ts) =>
        ts.map((t) => new TopUpAsset({ assetId: swapAssetId(t), symbol: t.symbol, chain: "sol", contract: t.mint, decimals: t.decimals, price: t.price, swap: true }))
      ))

      const quote = Effect.fn("TopUp.quote")(function*(accountId: string, originAsset: string, usdc: number, dry = false, wallet: Wallet = walletOf(accountId)) {
        if (!mainnet && !dry) return yield* fail("Top-ups from other chains run on mainnet. On testnet, use the test USDC faucet.")
        if (!Number.isInteger(usdc) || usdc < 1_000_000 || usdc > 2_000_000_000) return yield* fail("Top up between 1 and 2,000 USDC")
        const swapToken = swapTokenOf(originAsset)
        const asset = (yield* (swapToken ? swapAssets : assets)).find((t) => t.assetId === originAsset)
        if (!asset) return yield* fail("That token isn't supported for top-ups")
        const home = refundsToWallet({ direction: "in", account_id: accountId, chain: asset.chain, wallet })
        const deadline = refundsBegin()
        const asked: QuoteRequest = {
          dry,
          swapType: "EXACT_OUTPUT",
          slippageTolerance: 100,
          // A swap-paid token reaches 1Click as USDC on Solana, from the customer's own transaction.
          originAsset: swapToken ? SOL_USDC_ASSET : originAsset,
          destinationAsset: NEAR_USDC_ASSET,
          amount: String(usdc),
          recipient: accountId,
          // An EVM or Solana wallet's USDC lands in its own NEAR Intents account (ADR-0011).
          recipientType: wallet === "near" ? "DESTINATION_CHAIN" : "INTENTS",
          // Refunds, and the extra this asks for, go back to the paying wallet when we know its address there;
          // otherwise to the customer's own NEAR Intents account.
          refundTo: home ? homeAddress(accountId, wallet) : accountId,
          refundType: home ? "ORIGIN_CHAIN" : "INTENTS",
          deadline: deadline.toISOString()
        }
        const { quote: q, quoteRequest: echo } = yield* oneClick.quote(asked).pipe(Effect.mapError(unavailable))
        if (!dry && !q.depositAddress) return yield* fail("1Click returned no deposit address")
        // A price check (dry) creates nothing to pay into, so it's only checked when 1Click echoes it.
        const problem = echo || !dry ? echoProblem(echo, asked) : undefined
        if (problem) return yield* fail(`${problem}. Try again.`)
        // Swap-paid: exactly how much of the token the customer's transaction swaps for the USDC 1Click needs.
        const spend = swapToken ? yield* swaps.size(swapToken, BigInt(q.amountIn), !dry).pipe(Effect.mapError(unavailable)) : undefined
        const paid = swapToken && spend !== undefined
          ? { symbol: swapToken.symbol, mint: swapToken.mint, raw: String(spend), amount: formatUnits(spend, swapToken.decimals) }
          : undefined
        // Every Top-Up is recorded, so the customer can always see where their money is, even after leaving.
        if (!dry) {
          yield* sql`INSERT INTO intents_swaps (deposit_address, account_id, wallet, direction, usdc, symbol, chain, amount_in, amount_in_raw, deposit_memo,
                                                deadline, time_estimate, paid_symbol, paid_mint, paid_amount, paid_raw)
                     VALUES (${q.depositAddress!}, ${accountId}, ${wallet}, 'in', ${Number(q.amountOut)}, ${paid ? "USDC" : asset.symbol}, ${asset.chain},
                             ${q.amountInFormatted}, ${q.amountIn}, ${q.depositMemo ?? null}, ${deadline}, ${q.timeEstimate},
                             ${paid?.symbol ?? null}, ${paid?.mint ?? null}, ${paid?.amount ?? null}, ${paid?.raw ?? null})`.pipe(Effect.orDie)
        }
        return new TopUpQuote({
          depositAddress: q.depositAddress ?? "",
          ...(q.depositMemo ? { depositMemo: q.depositMemo } : {}),
          amountIn: paid?.raw ?? q.amountIn,
          amountInFormatted: paid?.amount ?? q.amountInFormatted,
          symbol: asset.symbol,
          chain: asset.chain,
          usdcOut: Number(q.amountOut),
          timeEstimateSeconds: q.timeEstimate,
          deadline: deadline.toISOString(),
          ...(paid ? { swap: true } : {})
        })
      })

      /**
       * 1Click has seen no money in it: a quote not paid into yet (or paid, as far as only the customer says).
       * KNOWN_DEPOSIT_TX counts too: 1Click reports a deposit transaction it knows of, and its docs don't say it
       * checks a hash it was told about (deposit/submit) on chain first. Anyone can name one for their own quote.
       */
      const unseen = sql`coalesce(status, 'PENDING_DEPOSIT') IN ('PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX')`
      /** A swap-paid quote the customer dismissed: no transaction is built for it again (see dismiss). */
      const cancelled = sql`(paid_mint IS NOT NULL AND dismissed_at IS NOT NULL)`
      /** How long past its deadline a quote nobody paid into is still followed (`swap` for a swap-paid one). */
      const grace = (swap: number) =>
        sql`CASE WHEN paid_mint IS NULL THEN ${`${LATE_DEPOSIT_GRACE_MS / 1000} seconds`}::interval ELSE ${`${swap / 1000} seconds`}::interval END`

      // ponytail: in memory, one process (ADR-0006). One real quote at a time per account, so parallel requests
      // can't all pass the cap below before one of them is saved.
      const quoting = new Set<string>()
      /**
       * Runs `make`, which asks 1Click for a real quote and records it, unless this account already has as many
       * unpaid quotes as we follow at once. Signing in is free and every quote is a row the tracking pass checks for
       * hours, so without this one account could crowd out everyone's swaps.
       */
      const capped = <A>(accountId: string, make: Effect.Effect<A, TopUpUnavailable>): Effect.Effect<A, TopUpUnavailable> =>
        Effect.suspend(() => {
          if (quoting.has(accountId)) return Effect.fail(fail("One quote at a time. Try again in a moment."))
          quoting.add(accountId)
          return Effect.gen(function*() {
            // The rows the tracking pass still follows that 1Click has seen no money in (see trackPass), less the
            // swap-paid ones some minutes past their deadline (SWAP_CAP_GRACE_MS) or cancelled (dismiss).
            // ponytail: quoting and cancelling over and over keeps more of one account's swap quotes tracked than
            // MOST_OPEN (each until SWAP_LATE_GRACE_MS past its deadline); one quote at a time and the per-IP limit
            // bound it. Count cancelled ones for an hour if that's ever abused.
            const [{ open = 0 } = {}] = yield* sql<{ open: number }>`
              SELECT count(*)::int AS open FROM intents_swaps
              WHERE account_id = ${accountId} AND ${unseen} AND created_at > now() - interval '3 days'
                AND NOT (deposit_tx IS NULL AND (coalesce(deadline, created_at + interval '30 minutes') < now() - ${grace(SWAP_CAP_GRACE_MS)}
                                                 OR ${cancelled}))`.pipe(Effect.orDie)
            if (open >= MOST_OPEN) return yield* fail("You have several quotes open already. Use one of them, or try again in a couple of hours.")
            return yield* make
            // Only the request that took the guard gives it back.
          }).pipe(Effect.ensuring(Effect.sync(() => quoting.delete(accountId))))
        })

      const swap = (accountId: string, depositAddress: string) =>
        sql<{ direction: string; usdc: string; move: string | null; move_in: SignedIntent | null }>`
          SELECT direction, usdc::text AS usdc, move, move_in FROM intents_swaps
          WHERE deposit_address = ${depositAddress} AND account_id = ${accountId}`.pipe(Effect.orDie, Effect.map((r) => r[0]))

      const status = (accountId: string, depositAddress: string) =>
        Effect.gen(function*() {
          const [s, row] = yield* Effect.all([oneClick.status(depositAddress).pipe(Effect.mapError(unavailable)), swap(accountId, depositAddress)])
          const move = row?.move === "waiting" || row?.move === "moved" || row?.move === "failed" ? row.move : undefined
          return new TopUpStatus({ status: s, ...(move ? { move } : {}) })
        })

      const move = Effect.fn("TopUp.move")(function*(accountId: string, depositAddress: string, signed: SignedIntent) {
        const row = yield* swap(accountId, depositAddress)
        if (!row || row.direction !== "in") return yield* fail("No Top-Up of yours has that deposit address")
        // Each Top-Up's move-in is armed once: a second one, uncounted, would let anyone make us pay for refusals.
        if (row.move === "waiting" && row.move_in?.payload === signed.payload) return
        if (row.move !== null) return yield* fail("This Top-Up's USDC was already handled. Move what's in your NEAR Intents account from the wallet page.")
        const [{ waiting = 0 } = {}] = yield* sql<{ waiting: number }>`
          SELECT count(*)::int AS waiting FROM intents_swaps WHERE account_id = ${accountId} AND move = 'waiting'
            -- A quote left unpaid past its deadline can't land, so it doesn't hold up new ones (its approval lasts a day),
            -- nor does a cancelled swap-paid one (still armed, should a transaction built before land).
            AND NOT (coalesce(status, 'PENDING_DEPOSIT') = 'PENDING_DEPOSIT' AND deposit_tx IS NULL
                     AND (coalesce(deadline, created_at + interval '30 minutes') < now() OR ${cancelled}))`.pipe(Effect.orDie)
        if (waiting >= MOST_WAITING) return yield* fail("Finish your other Top-Ups first.")
        const p = parsePayload(signed.payload)
        const why = payloadRefusal(p, { accountId, intentsId: near.intentsId, contractId: near.contractId, usdcId: near.usdcId, now: new Date() })
        if (why) return yield* fail(why)
        // Exactly what the swap delivers, so it can't take more than this Top-Up from their Intents account.
        if (p!.intents[0]!.intent !== "ft_withdraw" || p!.intents[0]!.amount !== row.usdc) {
          return yield* fail("That doesn't move this Top-Up's USDC into Luckout")
        }
        if (!(yield* Effect.promise(() => signedBy(signed, accountId)))) return yield* fail("The signature doesn't match your account.")
        yield* sql`UPDATE intents_swaps SET move_in = ${JSON.stringify(signed)}::jsonb, move = 'waiting', move_detail = NULL
                   WHERE deposit_address = ${depositAddress} AND move IS NULL`.pipe(Effect.orDie)
      })

      const sent = Effect.fn("TopUp.sent")(function*(accountId: string, depositAddress: string, txHash: string) {
        // An EVM or Bitcoin hash (hex), or a Solana or NEAR one (base58). 1Click checks it against the chain.
        // ponytail: a customer can name any hash for their own quote; at worst that keeps a few rows in sight (their
        // unpaid quotes are capped) and sends a handful of admin alerts (capped too). Check it on chain ourselves if
        // that's ever abused.
        if (!/^(0x)?[0-9a-fA-F]{64}$|^[1-9A-HJ-NP-Za-km-z]{43,88}$/.test(txHash)) return yield* fail("That isn't a transaction hash")
        // Not for a swap-paid Top-Up: a sent swap may still fail or never land, and its customer must be able to send
        // another. Its payment is recorded once the tracking pass finds it on chain.
        const [row] = yield* sql`UPDATE intents_swaps SET deposit_tx = ${txHash}
                                 WHERE deposit_address = ${depositAddress} AND account_id = ${accountId} AND direction = 'in' AND deposit_tx IS NULL
                                   AND paid_mint IS NULL
                                 RETURNING 1`.pipe(Effect.orDie)
        if (row) yield* oneClick.submitDeposit({ txHash, depositAddress })
      })

      /**
       * Only one nobody has paid into, as far as anyone knows. Tracking is untouched: a plain transfer can't be stopped
       * once its address is out, nor a swap transaction built before, so money that arrives anyway is moved in as usual
       * and the Top-Up is listed again. A swap-paid one gets no new transaction (swapTransaction).
       */
      const dismiss = Effect.fn("TopUp.dismiss")(function*(accountId: string, depositAddress: string) {
        const [row] = yield* sql`UPDATE intents_swaps SET dismissed_at = coalesce(dismissed_at, now())
                                 WHERE deposit_address = ${depositAddress} AND account_id = ${accountId} AND direction = 'in'
                                   AND deposit_tx IS NULL AND coalesce(status, 'PENDING_DEPOSIT') = 'PENDING_DEPOSIT'
                                 RETURNING 1`.pipe(Effect.orDie)
        if (!row) return yield* fail("Only an unpaid Top-Up of yours can be dismissed. One already paid stays listed until it lands.")
      })

      /**
       * The swap transactions handed out, by deposit address. A wallet that scanned the code asking again gets the same
       * one while it still has time to land (SWAP_REUSE_MS); another wallet gets none while one may still land, so a
       * quote is paid once even if 1Click were to close its USDC account between two payments.
       * ponytail: in memory, one process (ADR-0006); a restart forgets them, and each quote's builds below.
       */
      const handedOut = new Map<string, { payer: string; tx: SwapTransaction; at: number }>()
      /** Each quote's builds so far (each asks Jupiter, whose limit is per key, and simulates), kept until its deadline. */
      const builds = new Map<string, { count: number; until: number }>()
      const building = new Set<string>()
      /**
       * A swap-paid Top-Up's transaction for `payer`, while its quote is unpaid and open. `scanned`: asked for by a
       * wallet that scanned its Solana Pay code, which anyone holding the link can be: it may be handed the same
       * transaction again, and a busy Jupiter isn't asked again for it (Swap.transaction's `retryBusy`).
       */
      const swapTransaction = (r: SwapRow | undefined, payer: string, scanned: boolean) =>
        Effect.gen(function*() {
          if (!r || r.direction !== "in" || !r.paid_mint || !r.paid_raw || !r.amount_in_raw) return yield* fail("No Top-Up is paid that way")
          if (!isWallet(payer)) return yield* fail("That isn't a Solana wallet address.")
          if (r.deposit_tx || (r.status !== null && r.status !== "PENDING_DEPOSIT")) return yield* fail("This Top-Up is already paid.")
          if (r.dismissed_at) return yield* fail("This Top-Up was cancelled. Nothing was sent: top up again for a new one.")
          if (!(Date.now() < (ms(r.deadline) ?? 0) - SWAP_DEADLINE_MARGIN_MS)) {
            return yield* fail("This price has expired, or is about to. Nothing was sent: top up again for a new one.")
          }
          const token = swapTokenByMint(r.paid_mint)
          if (!token) return yield* fail("That token isn't taken for top-ups any more. Nothing was sent.")
          const now = Date.now()
          for (const [address, h] of handedOut) if (now - h.at > 120_000) handedOut.delete(address)
          for (const [address, b] of builds) if (now > b.until) builds.delete(address)
          const last = handedOut.get(r.deposit_address)
          if (last && last.payer !== payer && now - last.at < 90_000) {
            return yield* fail("Another wallet is paying this Top-Up right now. If that doesn't go through, try again in a minute.")
          }
          if (scanned && last && last.payer === payer && now - last.at < SWAP_REUSE_MS) return last.tx
          // Checked and taken with nothing in between, so two requests at once can't both build.
          if (building.has(r.deposit_address)) return yield* fail("This Top-Up's transaction is on its way. Try again in a few seconds.")
          const built = builds.get(r.deposit_address)?.count ?? 0
          if (built >= SWAP_BUILDS) return yield* fail("This price was fetched too many times. Nothing was sent: top up again for a new one.")
          builds.set(r.deposit_address, { count: built + 1, until: ms(r.deadline) ?? now })
          building.add(r.deposit_address)
          const order = { token, payer, depositAddress: r.deposit_address, need: BigInt(r.amount_in_raw), spend: BigInt(r.paid_raw), retryBusy: !scanned }
          const tx = yield* swaps.transaction(order).pipe(
            // Refused before Jupiter was asked: it cost nothing, so the build is given back.
            Effect.tapError((e) => Effect.sync(() => e.early && builds.set(r.deposit_address, { count: built, until: ms(r.deadline) ?? now }))),
            Effect.mapError(unavailable),
            Effect.ensuring(Effect.sync(() => building.delete(r.deposit_address)))
          )
          handedOut.set(r.deposit_address, { payer, tx, at: Date.now() })
          return tx
        })
      const swapRow = (depositAddress: string) =>
        sql<SwapRow>`SELECT * FROM intents_swaps WHERE deposit_address = ${depositAddress}`.pipe(Effect.orDie, Effect.map((rs) => rs[0]))

      const swapTx = Effect.fn("TopUp.swapTx")(function*(accountId: string, depositAddress: string, wallet: Wallet = walletOf(accountId)) {
        if (wallet !== "solana") return yield* fail("Pay from a Solana wallet: scan the code with Phantom, Solflare or Backpack.")
        const r = yield* swapRow(depositAddress)
        const tx = yield* swapTransaction(r?.account_id === accountId ? r : undefined, solanaAddress(accountId), false)
        return new SwapTx(tx)
      })

      // Anyone holding the link may ask: it only ever builds a transaction that pays this Top-Up from their own wallet.
      const solanaPay = Effect.fn("TopUp.solanaPay")(function*(depositAddress: string, payer: string) {
        const r = yield* swapRow(depositAddress)
        const tx = yield* swapTransaction(r, payer, true)
        return { transaction: tx.transaction, message: `Luckout: a ${usd(Number(r!.usdc))} Top-Up for ${paidText(r!)}` }
      })

      const exit = Effect.fn("TopUp.exit")(function*(accountId: string, destinationAsset: string, usdc: number, wallet: Wallet = walletOf(accountId)) {
        if (wallet === "near") return yield* fail("Withdrawals to other chains are for EVM and Solana wallets")
        if (!mainnet) return yield* fail("Withdrawals to other chains run on mainnet.")
        if (!Number.isInteger(usdc) || usdc < 1_000_000 || usdc > 2_000_000_000) return yield* fail("Withdraw between 1 and 2,000 USDC")
        const asset = (yield* assets).find((t) => t.assetId === destinationAsset && HOME_CHAINS[wallet].has(t.chain))
        if (!asset) return yield* fail("That token can't be withdrawn to your wallet")
        const deadline = refundsBegin()
        const asked: QuoteRequest = {
          dry: false,
          swapType: "EXACT_INPUT",
          slippageTolerance: 100,
          originAsset: NEAR_USDC_ASSET,
          depositType: "INTENTS",
          destinationAsset,
          amount: String(usdc),
          // Their own address, on the chain they picked.
          recipient: homeAddress(accountId, wallet),
          recipientType: "DESTINATION_CHAIN",
          refundTo: accountId,
          refundType: "INTENTS",
          deadline: deadline.toISOString()
        }
        const { quote: q, quoteRequest: echo } = yield* oneClick.quote(asked).pipe(Effect.mapError(unavailable))
        if (!q.depositAddress) return yield* fail("1Click returned no deposit address")
        const problem = echoProblem(echo, asked)
        if (problem) return yield* fail(`${problem}. Try again.`)
        yield* sql`INSERT INTO intents_swaps (deposit_address, account_id, wallet, direction, usdc, symbol, chain, amount_out, deadline, time_estimate)
                   VALUES (${q.depositAddress}, ${accountId}, ${wallet}, 'out', ${usdc}, ${asset.symbol}, ${asset.chain}, ${q.amountOutFormatted ?? null},
                           ${deadline}, ${q.timeEstimate})`.pipe(Effect.orDie)
        return new ExitQuote({
          depositAddress: q.depositAddress,
          usdcIn: usdc,
          amountOutFormatted: q.amountOutFormatted ?? q.amountOut,
          symbol: asset.symbol,
          chain: asset.chain,
          timeEstimateSeconds: q.timeEstimate
        })
      })

      // An EVM or Solana wallet on testnet has no NEAR account to call the faucet from: our relayer gets the test
      // USDC and deposits it into their NEAR Intents account, the way 1Click delivers a Top-Up on mainnet.
      const faucet = Effect.fn("TopUp.faucet")(function*(accountId: string, wallet: Wallet = walletOf(accountId)) {
        if (mainnet) return yield* fail("There's no faucet on mainnet")
        if (wallet === "near") return yield* fail("NEAR wallets call the faucet themselves")
        const day = new Date().toISOString().slice(0, 10)
        const persist = (key: string) => (tx: { hash: string; bytes: string }) =>
          sql`INSERT INTO relays (delegate_hash, account_id, signed_tx) VALUES (${key}, ${accountId}, ${JSON.stringify(tx)}::jsonb)
              ON CONFLICT DO NOTHING`.pipe(
            Effect.asVoid,
            Effect.orDie
          )
        const [used] = yield* sql`SELECT 1 FROM relays WHERE delegate_hash = ${`faucet:${accountId}:${day}`}`.pipe(Effect.orDie)
        if (used) return yield* fail("You've had today's test USDC. Come back tomorrow.")
        // The relayer's switch and caps bound the faucet too; its deposit counts as one relay.
        if (!(yield* relay.available(accountId))) return yield* fail("The faucet is resting. Try again later.")
        yield* near.relayerCall(near.usdcId, "faucet", {}, () => Effect.void).pipe(
          Effect.flatMap(() =>
            near.relayerCall(
              near.usdcId,
              "ft_transfer_call",
              { receiver_id: near.intentsId, amount: "100000000", msg: accountId },
              persist(`faucet:${accountId}:${day}`),
              1n
            )
          ),
          Effect.mapError((e) => fail(`The faucet didn't go through: ${e.message}`))
        )
      })

      // Sends a Top-Up's signed move-in once its swap has landed (EVM and Solana wallets). A refunded swap, or one that
      // never lands, leaves the money in the customer's own NEAR Intents account, where the web app offers to move it.
      const moveIn = (r: SwapRow, d: SwapDetails) =>
        Effect.gen(function*() {
          const done = (move: "moved" | "failed", detail: string | null) =>
            sql`UPDATE intents_swaps SET move = ${move}, move_detail = ${detail} WHERE deposit_address = ${r.deposit_address}`.pipe(
              Effect.orDie,
              Effect.as({ ...r, move, move_detail: detail })
            )
          // Its signature is good until its own deadline (a day at most); past that it can never run.
          const expired = !(Date.parse(parsePayload(r.move_in!.payload)?.deadline ?? "") > Date.now())
          if (d.status === "SUCCESS" && !expired) {
            return yield* relay.sendIntent(r.account_id, r.move_in!, { counted: false }).pipe(
              Effect.flatMap(() => done("moved", null)),
              // NEAR didn't answer: it may have run. Next pass resumes the same saved transaction.
              Effect.catchTag("RelayFailed", (e) =>
                UNANSWERED.test(e.message) ? Effect.as(Effect.logWarning("move-in unanswered, resumed next pass", r.deposit_address), r) : done("failed", e.message)
              ),
              // Not sent (the relayer is off): stays waiting and is tried again.
              Effect.catchTag("RelayUnavailable", (e) => Effect.as(Effect.logWarning("move-in waits for the relayer", e.message), r))
            )
          }
          if (d.status === "REFUNDED" || d.status === "FAILED") return yield* done("failed", `The swap was ${d.status.toLowerCase()}`)
          if (expired) return yield* done("failed", "The swap didn't land before your approval expired")
          return r
        })

      // Follows one swap: 1Click's latest, the move-in when it lands, and the customer's Telegram notice, once each.
      const track = (row: SwapRow) =>
        Effect.gen(function*() {
          // A swap-paid Top-Up may be paid by a transaction the app never hears of (a Solana Pay code, a closed tab):
          // it's looked for on chain, so it stays in sight like one the app sent.
          if (row.paid_mint && row.amount_in_raw && !row.deposit_tx && (row.status === null || row.status === "PENDING_DEPOSIT")) {
            const paidBy = yield* swaps.paidBy(row.deposit_address, BigInt(row.amount_in_raw))
            const [claimed] = paidBy
              ? yield* sql`UPDATE intents_swaps SET deposit_tx = ${paidBy} WHERE deposit_address = ${row.deposit_address} AND deposit_tx IS NULL RETURNING 1`.pipe(Effect.orDie)
              : []
            if (claimed) yield* oneClick.submitDeposit({ txHash: paidBy!, depositAddress: row.deposit_address })
          }
          const d = yield* oneClick.details(row.deposit_address).pipe(Effect.option)
          if (d._tag === "None") return
          const changed = d.value.status !== row.status
          const seen = row.deposit_seen_at ?? (d.value.status !== "PENDING_DEPOSIT" ? new Date() : null)
          const [fresh] = yield* sql<SwapRow>`
            UPDATE intents_swaps SET
              status = ${d.value.status},
              status_at = CASE WHEN ${changed} THEN now() ELSE status_at END,
              deposit_seen_at = ${seen},
              amount_out = CASE WHEN direction <> 'in' THEN coalesce(${d.value.amountOut ?? null}, amount_out) ELSE amount_out END,
              deposited = coalesce(${d.value.deposited ?? null}, deposited),
              delivered_tx = coalesce(${d.value.deliveredTx ?? null}, delivered_tx),
              refunded = coalesce(${d.value.refunded ?? null}, refunded),
              refund_reason = coalesce(${d.value.refundReason ?? null}, refund_reason)
            WHERE deposit_address = ${row.deposit_address}
            RETURNING *`.pipe(Effect.orDie)
          let r = fresh ?? row
          if (r.direction === "in" && r.move === "waiting" && r.move_in) r = yield* moveIn(r, d.value)
          const notice = noticeFor(r, Date.now(), web)
          if (notice && !r.told.includes(notice.key)) {
            // Saved first: a notice is never sent twice, even if Telegram is slow or the server restarts.
            const [claimed] = yield* sql`UPDATE intents_swaps SET told = array_append(told, ${notice.key}), retell = false
                                         WHERE deposit_address = ${r.deposit_address} AND NOT (${notice.key} = ANY(told)) RETURNING 1`.pipe(Effect.orDie)
            if (claimed && !(yield* alerts.customer(r.account_id, notice.text))) {
              // Telegram didn't take it: unclaimed, and the swap stays tracked, so a later pass sends it again.
              yield* sql`UPDATE intents_swaps SET told = array_remove(told, ${notice.key}), retell = true
                         WHERE deposit_address = ${r.deposit_address}`.pipe(Effect.orDie)
            }
            if (claimed && notice.key === "late" && phaseOf(r) === "moving") {
              yield* alerts.admin(
                `A ${usd(Number(r.usdc))} Top-Up landed over 5 minutes ago and still hasn't moved into Luckout: deposit ${r.deposit_address}, for ${r.account_id}. Check the relayer's NEAR and the server log.`
              )
            }
            if (claimed && notice.key === "unseen") {
              // Anyone can name a transaction for their own quote, so these are told one by one only up to a handful:
              // past that, one line (the same text goes out at most hourly) says where the rest are.
              const [{ chased = 0 } = {}] = yield* sql<{ chased: number }>`
                SELECT count(*)::int AS chased FROM intents_swaps WHERE 'unseen' = ANY(told) AND deadline > now() - interval '2 hours'`.pipe(Effect.orDie)
              yield* alerts.admin(
                chased <= UNSEEN_ALERTS
                  ? `1Click hasn't seen a paid Top-Up: deposit ${r.deposit_address}, tx ${r.deposit_tx} on ${chainName(r.chain)}, ${r.amount_in ?? "?"} ${r.symbol ?? ""}, for ${r.account_id}. Ask 1Click support.`
                  : `More than ${UNSEEN_ALERTS} paid Top-Ups in the last two hours are unseen by 1Click. Either 1Click is behind (ask its support), or someone is naming transfers they never made. They're the rows of intents_swaps with 'unseen' in told.`
              )
            }
          }
        })

      // Swaps still in motion. A quote nobody paid into stops being checked two hours past its deadline (a swap-paid
      // one, an hour).
      const tracked = sql`(move = 'waiting'
             -- A notice Telegram didn't take is tried again, for a day.
             OR (retell AND coalesce(status_at, created_at) > now() - interval '1 day')
             OR (created_at > now() - interval '3 days'
                 AND coalesce(status, '') NOT IN ('SUCCESS', 'REFUNDED', 'FAILED')
                 AND NOT (coalesce(status, 'PENDING_DEPOSIT') = 'PENDING_DEPOSIT' AND deposit_tx IS NULL
                          AND coalesce(deadline, created_at + interval '30 minutes') < now() - ${grace(SWAP_LATE_GRACE_MS)})))`
      // Least recently checked first, in two queues: swaps 1Click has seen money in are never held up by quotes
      // nobody paid into, however many of those there are, and those always get the rest of the pass (at least
      // PER_PASS - SEEN_PER_PASS), so a new payment is still noticed when many swaps are in flight.
      const trackPass = sql<SwapRow>`
        UPDATE intents_swaps SET checked_at = now()
        WHERE deposit_address IN (
          SELECT deposit_address FROM (
            (SELECT deposit_address, 0 AS queue, checked_at FROM intents_swaps WHERE ${tracked} AND NOT ${unseen}
             ORDER BY checked_at NULLS FIRST LIMIT ${SEEN_PER_PASS})
            UNION ALL
            (SELECT deposit_address, 1 AS queue, checked_at FROM intents_swaps WHERE ${tracked} AND ${unseen}
             ORDER BY checked_at NULLS FIRST LIMIT ${PER_PASS})
          ) due ORDER BY queue, checked_at NULLS FIRST LIMIT ${PER_PASS})
        RETURNING *`.pipe(
        Effect.orDie,
        Effect.flatMap((rows) => Effect.forEach(rows, track, { discard: true, concurrency: 8 })),
        Effect.catchCause((cause) => Effect.logError("swap tracking pass failed", cause))
      )
      yield* trackPass.pipe(Effect.repeat(Schedule.spaced("15 seconds")), Effect.forkScoped)

      const transfers = (accountId: string) =>
        sql<SwapRow>`
          SELECT * FROM intents_swaps
          WHERE account_id = ${accountId} AND created_at > now() - interval '7 days'
            AND NOT (coalesce(status, 'PENDING_DEPOSIT') = 'PENDING_DEPOSIT'
                     AND CASE direction
                           -- A Top-Up we know was paid stays in sight until 1Click settles it; an unpaid one the
                           -- customer dismissed leaves at once, and is back once money arrives.
                           WHEN 'in' THEN deposit_tx IS NULL AND (dismissed_at IS NOT NULL OR coalesce(deadline, created_at + interval '30 minutes') < now())
                           -- A withdrawal is sent the moment it's quoted and 1Click sees it within seconds: one
                           -- still unseen after 3 minutes was never signed, and the money never left.
                           ELSE created_at < now() - interval '3 minutes' END)
            AND NOT (coalesce(status, '') IN ('SUCCESS', 'REFUNDED', 'FAILED') AND coalesce(status_at, created_at) < now() - interval '1 day')
          ORDER BY created_at DESC LIMIT 20`.pipe(
          Effect.orDie,
          Effect.map((rows) =>
            rows.map((r) =>
              new Transfer({
                depositAddress: r.deposit_address,
                ...(r.deposit_memo ? { depositMemo: r.deposit_memo } : {}),
                direction: r.direction,
                usdc: Number(r.usdc),
                symbol: r.symbol ?? "USDC",
                chain: r.chain ?? "",
                ...(r.amount_in ? { amountIn: r.amount_in } : {}),
                ...(r.paid_symbol ? { paidWith: paidText(r) } : {}),
                ...(r.amount_out ? { amountOut: r.amount_out } : {}),
                ...(r.deposited ? { deposited: r.deposited } : {}),
                ...(r.deposit_tx ? { depositTx: r.deposit_tx } : {}),
                phase: phaseOf(r),
                late: isLate(r, Date.now()),
                createdAt: new Date(r.created_at).toISOString(),
                ...(r.deadline ? { deadline: new Date(r.deadline).toISOString() } : {}),
                ...(r.time_estimate !== null ? { timeEstimateSeconds: r.time_estimate } : {}),
                ...(r.direction !== "in" && r.delivered_tx ? { deliveredTx: r.delivered_tx } : {}),
                ...(r.refunded ? { refunded: r.refunded } : {}),
                ...(refundsToWallet(r) ? { refundsToWallet: true } : {}),
                ...(r.refund_reason ? { detail: reasonText(r.refund_reason) } : r.move_detail ? { detail: r.move_detail } : {}),
                explorer: explorerOf(r.deposit_address)
              })
            )
          )
        )

      // An EVM or Solana wallet's USDC in NEAR Intents is its Luckout wallet balance already (ADR-0011): everything else is listed.
      const holdings = (accountId: string, wallet: Wallet) =>
        Effect.gen(function*() {
          const nearUsdc = `nep141:${near.usdcId}`
          const intents = wallet !== "near"
          const owned = yield* near.view<ReadonlyArray<{ token_id: string }>>("mt_tokens_for_owner", { account_id: accountId }, near.intentsId)
          const ids = owned.map((t) => t.token_id).filter((id) => !(intents && id === nearUsdc))
          if (ids.length === 0) return []
          const [balances, tokens] = yield* Effect.all([
            near.view<ReadonlyArray<string>>("mt_batch_balance_of", { account_id: accountId, token_ids: ids }, near.intentsId),
            oneClick.tokens.pipe(Effect.orElseSucceed(() => []))
          ])
          return ids.flatMap((id, i) => {
            const raw = BigInt(balances[i] ?? "0")
            const t = id === nearUsdc ? { symbol: "USDC", blockchain: "near", decimals: 6 } : tokens.find((x) => x.assetId === id)
            // ponytail: tokens 1Click doesn't list are skipped; nothing Luckout sends a customer is one of them.
            if (raw === 0n || !t || t.decimals === undefined) return []
            // An EVM or Solana wallet takes it as it is, on its own chain; a NEAR wallet as USDC (its NEAR USDC there: near-intents.org).
            // An EVM wallet's change on Solana (a swap-paid Top-Up's, ADR-0014) goes to it as USDC on Base.
            const sendable = mainnet && (intents ? HOME_CHAINS[wallet].has(t.blockchain) || evmChange(wallet, id) : id !== nearUsdc)
            return [{ assetId: id, symbol: t.symbol, chain: t.blockchain, raw, amount: formatUnits(raw, t.decimals), sendable }]
          })
        })

      const held = (accountId: string, wallet: Wallet = walletOf(accountId)) =>
        holdings(accountId, wallet).pipe(
          Effect.map((hs) => hs.map(({ raw: _, ...h }) => new HeldToken(h))),
          Effect.mapError(unavailable)
        )

      const sendBack = Effect.fn("TopUp.sendBack")(function*(accountId: string, assetId: string, wallet: Wallet = walletOf(accountId)) {
        const h = (yield* holdings(accountId, wallet).pipe(Effect.mapError(unavailable))).find((x) => x.assetId === assetId)
        if (!h?.sendable) return yield* fail("There's none of that to send to your wallet.")
        const to = wallet === "near"
          ? { asset: `nep141:${near.usdcId}`, symbol: "USDC", chain: "near" }
          : evmChange(wallet, assetId)
          ? { asset: BASE_USDC_ASSET, symbol: "USDC", chain: "base" }
          : { asset: assetId, symbol: h.symbol, chain: h.chain }
        const deadline = refundsBegin()
        const asked: QuoteRequest = {
          dry: false,
          swapType: "EXACT_INPUT",
          slippageTolerance: 100,
          originAsset: assetId,
          depositType: "INTENTS",
          destinationAsset: to.asset,
          amount: String(h.raw),
          recipient: homeAddress(accountId, wallet),
          recipientType: "DESTINATION_CHAIN",
          // If it doesn't go through, it's back where it was.
          refundTo: accountId,
          refundType: "INTENTS",
          deadline: deadline.toISOString()
        }
        const { quote: q, quoteRequest: echo } = yield* oneClick.quote(asked).pipe(Effect.mapError(unavailable))
        if (!q.depositAddress) return yield* fail("1Click returned no deposit address")
        const problem = echoProblem(echo, asked)
        if (problem) return yield* fail(`${problem}. Try again.`)
        yield* sql`INSERT INTO intents_swaps (deposit_address, account_id, wallet, direction, usdc, symbol, chain, amount_in, amount_out, origin_asset, origin_amount, deadline, time_estimate)
                   VALUES (${q.depositAddress}, ${accountId}, ${wallet}, 'back', 0, ${to.symbol}, ${to.chain}, ${h.amount}, ${q.amountOutFormatted ?? null},
                           ${assetId}, ${String(h.raw)}, ${deadline}, ${q.timeEstimate})`.pipe(Effect.orDie)
        return new SendBackQuote({
          depositAddress: q.depositAddress,
          assetId,
          amount: String(h.raw),
          amountOutFormatted: q.amountOutFormatted ?? q.amountOut,
          symbol: to.symbol,
          chain: to.chain,
          timeEstimateSeconds: q.timeEstimate
        })
      })

      return TopUp.of({
        assets: Effect.zipWith(assets, swapAssets, (a, b) => [...a, ...b]),
        // A price check (dry) creates nothing, so only real quotes count against the account's cap.
        quote: (accountId, originAsset, usdc, dry = false, wallet = walletOf(accountId)) =>
          dry ? quote(accountId, originAsset, usdc, true, wallet) : capped(accountId, quote(accountId, originAsset, usdc, false, wallet)),
        status,
        sent,
        dismiss,
        swapTx,
        solanaPay,
        move,
        faucet,
        transfers,
        held,
        sendBack: (accountId, assetId, wallet) => capped(accountId, sendBack(accountId, assetId, wallet)),
        trackNow: trackPass,
        exit: (accountId, destinationAsset, usdc, wallet) => capped(accountId, exit(accountId, destinationAsset, usdc, wallet))
      })
    })
  )
}

/**
 * Solana Pay transaction requests (ADR-0014): a wallet that scans a swap-paid Top-Up's code asks here for the
 * transaction that pays it. No session: whoever asks only ever gets a transaction paying that Top-Up from their own
 * wallet. A wallet app sends no Origin, so the edge's same-site check lets it through.
 */
export const SolanaPayRoute = Layer.unwrap(Effect.gen(function*() {
  const topup = yield* TopUp
  const web = yield* Config.String("WEB_ORIGIN").pipe(Config.withDefault("http://localhost:3000"))
  const refused = (message: string) => HttpServerResponse.jsonUnsafe({ message }, { status: 400 })
  return Layer.mergeAll(
    HttpRouter.add("GET", "/solana-pay/:depositAddress", HttpServerResponse.jsonUnsafe({ label: "Luckout", icon: `${web}/logo.png` })),
    HttpRouter.add("POST", "/solana-pay/:depositAddress", Effect.gen(function*() {
      const { depositAddress = "" } = yield* HttpRouter.params
      const { account } = yield* HttpServerRequest.schemaBodyJson(Schema.Struct({ account: Schema.String }))
      return HttpServerResponse.jsonUnsafe(yield* topup.solanaPay(depositAddress, account))
    }).pipe(
      Effect.catchTag("TopUpUnavailable", (e) => Effect.succeed(refused(e.message))),
      Effect.catch(() => Effect.succeed(refused("Send the wallet's account as JSON: {\"account\": \"…\"}.")))
    ))
  )
}))
