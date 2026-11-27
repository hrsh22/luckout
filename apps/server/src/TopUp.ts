import { SwapTx, TopUpAsset, TopUpQuote, TopUpStatus, TopUpUnavailable, Transfer, type TransferPhase, tokenAmount } from "@luckout/api"
import { PublicKey } from "@solana/web3.js"
import { Config, Context, Effect, Layer, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { Alerts } from "./Alerts.ts"
import { Deposits } from "./Deposits.ts"
import { echoProblem, OneClick, type QuoteRequest } from "./OneClick.ts"
import { Cluster } from "./Solana.ts"
import { SOL_USDC_ASSET, Swap, swapAssetId, swapTokenOf } from "./Swap.ts"

// Top-Ups from other chains (ADR-0015): a 1Click quote that delivers USDC on Solana to the customer's Deposit Address,
// their own wallet, where `deposit_for` moves it into their Balance (Deposits.ts). The server pins the destination
// (USDC on Solana) and the recipient (the signed-in wallet), so this can't swap anything else or pay anyone else. The
// quote swaps whatever arrives above its minimum (FLEX_INPUT), so the extra a customer sends for fees lands too. 1Click
// refunds to the address on the source chain the customer gives (`refundTo`), not to the sender, who may be an exchange.
//
// USDC and USDT on Solana need no 1Click: they're sent straight to the Deposit Address, and USDT or ORE there reaches
// the Balance through a swap the customer signs (Swap.ts).

const SYMBOLS = new Set(["USDC", "USDT", "ETH", "BTC", "SOL", "wNEAR"])
const CHAINS = new Set(["eth", "arb", "base", "sol", "btc", "pol", "bsc", "near", "tron"])
const EVM_CHAINS = new Set(["eth", "arb", "base", "pol", "bsc"])
/** Swaps checked per pass, least recently checked first. */
const PER_PASS = 40
/** Of those, how many are kept for swaps 1Click has seen money in; quotes nobody has paid into yet get the rest. */
const SEEN_PER_PASS = 30
/** Quotes of one account that 1Click has seen no money in and the tracking pass still follows, at once. */
const MOST_OPEN = 10
/** Paid Top-Ups 1Click hasn't seen that an admin hears about one by one, per two hours; past that, one line covers the rest. */
const UNSEEN_ALERTS = 5
/** 1Click is done with these: the money arrived or went back. */
const FINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"])
/** A quote nobody paid into is still checked this long past its deadline, in case the transfer was late. */
const LATE_DEPOSIT_GRACE = "2 hours"
/** A paid Top-Up 1Click hasn't seen this long past its deadline is chased: the customer and an admin are told. */
const UNSEEN_MS = 5 * 60_000
/**
 * When 1Click starts refunding a swap that hasn't completed: what the customer is told to beat. (1Click's own
 * `deadline` in a quote is days later: how long the deposit address stays open, not when refunds begin.)
 */
const refundsBegin = () => new Date(Date.now() + 30 * 60 * 1000)
const CHAIN_NAMES: Record<string, string> = {
  eth: "Ethereum", arb: "Arbitrum", base: "Base", pol: "Polygon", bsc: "BNB Chain", sol: "Solana", btc: "Bitcoin", near: "NEAR", tron: "Tron"
}
const chainName = (c: string | null) => (c ? CHAIN_NAMES[c] ?? c : "another chain")
const usd = (micro: number) => `$${(micro / 1e6).toFixed(2)}`
const isSolanaAddress = (address: string) => {
  try {
    return new PublicKey(address).toBase58() === address
  } catch {
    return false
  }
}

/** Why `address` can't take a refund on `chain`, or undefined. A light check: 1Click checks it too. */
export const refundProblem = (chain: string, address: string): string | undefined => {
  const ok = EVM_CHAINS.has(chain)
    ? /^0x[0-9a-fA-F]{40}$/.test(address)
    : chain === "sol"
    ? isSolanaAddress(address)
    : chain === "btc"
    ? /^(bc1[02-9ac-hj-np-z]{6,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(address)
    : chain === "tron"
    ? /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)
    : chain === "near"
    ? address.length >= 2 && address.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(address)
    : false
  return ok ? undefined : `That isn't an address on ${chainName(chain)}. Give one there for 1Click to refund to.`
}

/** A row of `intents_swaps`: one customer's 1Click Top-Up. */
export interface SwapRow {
  readonly deposit_address: string
  readonly deposit_memo: string | null
  readonly account_id: string
  readonly usdc: string
  readonly symbol: string | null
  readonly chain: string | null
  readonly amount_in: string | null
  readonly deposited: string | null
  readonly deadline: Date | string | null
  readonly time_estimate: number | null
  readonly status: string | null
  readonly deposit_seen_at: Date | string | null
  readonly status_at: Date | string | null
  readonly delivered_tx: string | null
  readonly refunded: string | null
  readonly refund_reason: string | null
  /** Where 1Click refunds, on the source chain. */
  readonly refund_to: string | null
  /** The customer's transfer to the deposit address, when the app sent it. */
  readonly deposit_tx: string | null
  /** The customer dismissed it before paying into it (see TopUp.dismiss). */
  readonly dismissed_at?: Date | string | null
  readonly told: ReadonlyArray<string>
  readonly created_at: Date | string
}

const ms = (d: Date | string | null) => (d === null ? undefined : new Date(d).getTime())

/** Where the money is, in the customer's words (see TransferPhase). */
export const phaseOf = (r: Pick<SwapRow, "status">): TransferPhase => {
  if (r.status === "REFUNDED" || r.status === "FAILED") return "refunded"
  if (r.status === "INCOMPLETE_DEPOSIT") return "incomplete"
  if (r.status === "SUCCESS") return "done"
  if (!r.status || r.status === "PENDING_DEPOSIT") return "awaiting-transfer"
  return "swapping"
}

/**
 * 1Click has the money but it's taking well over its usual time: safe, and the customer should hear so. Never a short
 * payment: that waits on the customer, who is told so instead.
 */
export const isLate = (r: Pick<SwapRow, "status" | "deposit_seen_at" | "time_estimate">, now: number) => {
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

/**
 * The Telegram notice for what just happened to this Top-Up, keyed so each is sent once. Its arrival has none: the
 * deposit sweep tells the customer when it reaches their Balance (Deposits.ts).
 */
export const noticeFor = (r: SwapRow, now: number, web: string): { key: string; text: string } | undefined => {
  const phase = phaseOf(r)
  const amount = usd(Number(r.usdc))
  const from = `${r.amount_in ? tokenAmount(r.amount_in, r.symbol ?? "", "up") : ""} ${r.symbol ?? ""} on ${chainName(r.chain)}`.replace(/\s+/g, " ").trim()
  const refundPlace = `${r.refund_to ?? "your refund address"} on ${chainName(r.chain)}`
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
  if (phase === "refunded") {
    return {
      key: "refunded",
      text: `Your Top-Up (${from}) didn't go through${r.refund_reason ? `: ${reasonText(r.refund_reason)}` : ""}. 1Click sent ${
        r.refunded ? `${tokenAmount(r.refunded, r.symbol ?? "", "down")} ${r.symbol ?? ""}`.trim() : "it"
      } back to ${refundPlace}. See ${web}/wallet`
    }
  }
  // Paid (we have the transaction), but 1Click still hasn't seen it after the deadline: say so, and we're told too.
  if (r.deposit_tx && (!r.status || r.status === "PENDING_DEPOSIT") && now > (ms(r.deadline) ?? now) + UNSEEN_MS) {
    return {
      key: "unseen",
      text: `1Click hasn't confirmed your ${amount} Top-Up transfer (${from}) yet. It's at 1Click's deposit address: it either goes through or comes back to ${refundPlace}. Luckout is looking into it. Track it: ${explorerOf(r.deposit_address)}`
    }
  }
  if (isLate(r, now)) {
    return {
      key: "late",
      text: `Your ${amount} Top-Up is taking longer than usual. It's safe: it either arrives or 1Click refunds it. Track it: ${explorerOf(r.deposit_address)}`
    }
  }
  return undefined
}

export class TopUp extends Context.Service<TopUp, {
  /** The tokens 1Click takes from other chains, and those swapped from the customer's own wallet (Swap.ts). */
  readonly assets: Effect.Effect<ReadonlyArray<TopUpAsset>, TopUpUnavailable>
  /** `refundTo`: an address on the source chain, where 1Click sends back what it can't swap. */
  quote(accountId: string, originAsset: string, usdc: number, refundTo: string, dry?: boolean): Effect.Effect<TopUpQuote, TopUpUnavailable>
  status(accountId: string, depositAddress: string): Effect.Effect<TopUpStatus, TopUpUnavailable>
  /** USDT or ORE in the customer's wallet: the transaction that swaps it into their Balance, for them to sign. */
  swap(accountId: string, assetId: string, amount?: string): Effect.Effect<SwapTx, TopUpUnavailable>
  /** The app paid this Top-Up from the customer's wallet: keeps the transaction and passes it to 1Click. */
  sent(accountId: string, depositAddress: string, txHash: string): Effect.Effect<void, TopUpUnavailable>
  /** The customer is done with a Top-Up they haven't paid into: it leaves their list. */
  dismiss(accountId: string, depositAddress: string): Effect.Effect<void, TopUpUnavailable>
  /** The customer's Top-Ups still on their way, and those that ended in the last day. */
  transfers(accountId: string): Effect.Effect<ReadonlyArray<Transfer>>
  /** One tracking pass now, as the background loop runs every 15 seconds (tests). */
  readonly trackNow: Effect.Effect<void>
}>()("luckout/TopUp") {
  static readonly layer = Layer.effect(
    TopUp,
    Effect.gen(function*() {
      const oneClick = yield* OneClick
      const sql = yield* SqlClient.SqlClient
      const alerts = yield* Alerts
      const swaps = yield* Swap
      const deposits = yield* Deposits
      const mainnet = (yield* Cluster) === "mainnet"
      const web = yield* Config.String("WEB_ORIGIN").pipe(Config.withDefault("http://localhost:3000"))
      const fail = (message: string) => new TopUpUnavailable({ message })
      const unavailable = (e: { message: string }) => fail(e.message)

      const assets = oneClick.tokens.pipe(
        Effect.map((ts) =>
          // USDC and USDT on Solana go straight to the Deposit Address.
          ts.filter((t) => SYMBOLS.has(t.symbol) && CHAINS.has(t.blockchain) && !(t.blockchain === "sol" && (t.symbol === "USDC" || t.symbol === "USDT")))
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
      const swapAssets = swaps.tokens.pipe(Effect.map((ts) =>
        ts.map((t) => new TopUpAsset({ assetId: swapAssetId(t), symbol: t.symbol, chain: "sol", contract: t.mint, decimals: t.decimals, price: t.price, swap: true }))
      ))

      const quote = Effect.fn("TopUp.quote")(function*(accountId: string, originAsset: string, usdc: number, refundTo: string, dry = false) {
        if (!mainnet && !dry) return yield* fail("Top-ups from other chains run on mainnet only.")
        if (!Number.isInteger(usdc) || usdc < 1_000_000 || usdc > 2_000_000_000) return yield* fail("Top up between 1 and 2,000 USDC")
        if (!isSolanaAddress(accountId)) return yield* fail("Top-ups go to your Deposit Address: sign in again.")
        const asset = (yield* assets).find((t) => t.assetId === originAsset)
        if (!asset) return yield* fail("That token isn't supported for top-ups")
        const wrong = refundProblem(asset.chain, refundTo)
        if (wrong) return yield* fail(wrong)
        const deadline = refundsBegin()
        const asked = (swapType: QuoteRequest["swapType"], amount: string, dry: boolean): QuoteRequest => ({
          dry,
          swapType,
          slippageTolerance: 100,
          originAsset,
          destinationAsset: SOL_USDC_ASSET,
          amount,
          recipient: accountId,
          recipientType: "DESTINATION_CHAIN",
          refundTo,
          refundType: "ORIGIN_CHAIN",
          depositType: "ORIGIN_CHAIN",
          deadline: deadline.toISOString()
        })
        // What to send for `usdc`: 1Click's price for exactly that out, which creates nothing to pay into.
        const { quote: price } = yield* oneClick.quote(asked("EXACT_OUTPUT", String(usdc), true)).pipe(Effect.mapError(unavailable))
        const shown = { symbol: asset.symbol, chain: asset.chain, deadline: deadline.toISOString(), refundTo }
        if (dry) {
          return new TopUpQuote({
            ...shown,
            depositAddress: "",
            amountIn: price.amountIn,
            amountInFormatted: price.amountInFormatted,
            usdcOut: Number(price.amountOut),
            timeEstimateSeconds: price.timeEstimate
          })
        }
        // The quote paid into: that much in, and whatever arrives above its minimum is swapped.
        const flex = asked("FLEX_INPUT", price.amountIn, false)
        const { quote: q, quoteRequest: echo } = yield* oneClick.quote(flex).pipe(Effect.mapError(unavailable))
        if (!q.depositAddress) return yield* fail("1Click returned no deposit address")
        const problem = echoProblem(echo, flex)
        if (problem) return yield* fail(`${problem}. Try again.`)
        // Every Top-Up is recorded, so the customer can always see where their money is, even after leaving.
        yield* sql`INSERT INTO intents_swaps (deposit_address, account_id, direction, usdc, symbol, chain, amount_in, amount_in_raw, deposit_memo,
                                              deadline, time_estimate, refund_to)
                   VALUES (${q.depositAddress}, ${accountId}, 'in', ${Number(q.amountOut)}, ${asset.symbol}, ${asset.chain}, ${q.amountInFormatted},
                           ${q.amountIn}, ${q.depositMemo ?? null}, ${deadline}, ${q.timeEstimate}, ${refundTo})`.pipe(Effect.orDie)
        return new TopUpQuote({
          ...shown,
          depositAddress: q.depositAddress,
          ...(q.depositMemo ? { depositMemo: q.depositMemo } : {}),
          amountIn: q.amountIn,
          amountInFormatted: q.amountInFormatted,
          ...(q.minAmountIn ? { minAmountIn: q.minAmountIn } : {}),
          usdcOut: Number(q.amountOut),
          timeEstimateSeconds: q.timeEstimate
        })
      })

      /**
       * 1Click has seen no money in it: a quote not paid into yet (or paid, as far as only the customer says).
       * KNOWN_DEPOSIT_TX counts too: 1Click reports a deposit transaction it knows of, and its docs don't say it
       * checks a hash it was told about (deposit/submit) on chain first. Anyone can name one for their own quote.
       */
      const unseen = sql`coalesce(status, 'PENDING_DEPOSIT') IN ('PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX')`
      /** Unpaid, as far as anyone knows, and past its deadline by more than a late transfer takes. */
      const lapsed = sql`(deposit_tx IS NULL AND coalesce(deadline, created_at + interval '30 minutes') < now() - ${LATE_DEPOSIT_GRACE}::interval)`

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
            // The rows the tracking pass still follows that 1Click has seen no money in (see trackPass).
            const [{ open = 0 } = {}] = yield* sql<{ open: number }>`
              SELECT count(*)::int AS open FROM intents_swaps
              WHERE account_id = ${accountId} AND ${unseen} AND created_at > now() - interval '3 days' AND NOT ${lapsed}`.pipe(Effect.orDie)
            if (open >= MOST_OPEN) return yield* fail("You have several quotes open already. Use one of them, or try again in a couple of hours.")
            return yield* make
            // Only the request that took the guard gives it back.
          }).pipe(Effect.ensuring(Effect.sync(() => quoting.delete(accountId))))
        })

      const status = Effect.fn("TopUp.status")(function*(accountId: string, depositAddress: string) {
        const [row] = yield* sql`SELECT 1 FROM intents_swaps WHERE deposit_address = ${depositAddress} AND account_id = ${accountId}`.pipe(Effect.orDie)
        if (!row) return yield* fail("No Top-Up of yours has that deposit address")
        return new TopUpStatus({ status: yield* oneClick.status(depositAddress).pipe(Effect.mapError(unavailable)) })
      })

      const swap = Effect.fn("TopUp.swap")(function*(accountId: string, assetId: string, amount?: string) {
        const token = swapTokenOf(assetId)
        if (!token) return yield* fail("That token isn't swapped here")
        const tx = yield* swaps.transaction({ token, wallet: accountId, spend: amount === undefined ? undefined : BigInt(amount) }).pipe(Effect.mapError(unavailable))
        return new SwapTx({ transaction: tx.transaction, token: tx.token, spend: String(tx.spend), usdcOut: Number(tx.usdcOut), minUsdcOut: Number(tx.minUsdcOut) })
      })

      const sent = Effect.fn("TopUp.sent")(function*(accountId: string, depositAddress: string, txHash: string) {
        // An EVM or Bitcoin hash (hex), or a Solana, NEAR or Tron one. 1Click checks it against the chain.
        // ponytail: a customer can name any hash for their own quote; at worst that keeps a few rows in sight (their
        // unpaid quotes are capped) and sends a handful of admin alerts (capped too). Check it on chain ourselves if
        // that's ever abused.
        if (!/^(0x)?[0-9a-fA-F]{64}$|^[1-9A-HJ-NP-Za-km-z]{43,88}$/.test(txHash)) return yield* fail("That isn't a transaction hash")
        const [row] = yield* sql`UPDATE intents_swaps SET deposit_tx = ${txHash}
                                 WHERE deposit_address = ${depositAddress} AND account_id = ${accountId} AND deposit_tx IS NULL
                                 RETURNING 1`.pipe(Effect.orDie)
        if (row) yield* oneClick.submitDeposit({ txHash, depositAddress })
      })

      /**
       * Only one nobody has paid into, as far as anyone knows. Tracking is untouched: a transfer can't be stopped once
       * its address is out, so money that arrives anyway lands as usual and the Top-Up is listed again.
       */
      const dismiss = Effect.fn("TopUp.dismiss")(function*(accountId: string, depositAddress: string) {
        const [row] = yield* sql`UPDATE intents_swaps SET dismissed_at = coalesce(dismissed_at, now())
                                 WHERE deposit_address = ${depositAddress} AND account_id = ${accountId}
                                   AND deposit_tx IS NULL AND coalesce(status, 'PENDING_DEPOSIT') = 'PENDING_DEPOSIT'
                                 RETURNING 1`.pipe(Effect.orDie)
        if (!row) return yield* fail("Only an unpaid Top-Up of yours can be dismissed. One already paid stays listed until it lands.")
      })

      // Follows one swap: 1Click's latest, a sweep once it delivers, and the customer's Telegram notice, once each.
      const track = (row: SwapRow) =>
        Effect.gen(function*() {
          const d = yield* oneClick.details(row.deposit_address).pipe(Effect.option)
          if (d._tag === "None") return
          const changed = d.value.status !== row.status
          const seen = row.deposit_seen_at ?? (d.value.status !== "PENDING_DEPOSIT" ? new Date() : null)
          const [fresh] = yield* sql<SwapRow>`
            UPDATE intents_swaps SET
              status = ${d.value.status},
              status_at = CASE WHEN ${changed} THEN now() ELSE status_at END,
              deposit_seen_at = ${seen},
              deposited = coalesce(${d.value.deposited ?? null}, deposited),
              delivered_tx = coalesce(${d.value.deliveredTx ?? null}, delivered_tx),
              refunded = coalesce(${d.value.refunded ?? null}, refunded),
              refund_reason = coalesce(${d.value.refundReason ?? null}, refund_reason)
            WHERE deposit_address = ${row.deposit_address}
            RETURNING *`.pipe(Effect.orDie)
          const r = fresh ?? row
          // The USDC is at the Deposit Address: the sweep moves it into the Balance and tells the customer.
          if (changed && d.value.status === "SUCCESS") yield* deposits.nudge
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

      // Swaps still in motion. A quote nobody paid into stops being checked two hours past its deadline.
      const tracked = sql`(
             -- A notice Telegram didn't take is tried again, for a day.
             (retell AND coalesce(status_at, created_at) > now() - interval '1 day')
             OR (created_at > now() - interval '3 days'
                 AND coalesce(status, '') NOT IN ('SUCCESS', 'REFUNDED', 'FAILED')
                 AND NOT (coalesce(status, 'PENDING_DEPOSIT') = 'PENDING_DEPOSIT' AND ${lapsed})))`
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
            -- A Top-Up we know was paid stays in sight until 1Click settles it; an unpaid one the customer dismissed, or
            -- past its deadline, leaves at once, and is back once money arrives.
            AND NOT (coalesce(status, 'PENDING_DEPOSIT') = 'PENDING_DEPOSIT' AND deposit_tx IS NULL
                     AND (dismissed_at IS NOT NULL OR coalesce(deadline, created_at + interval '30 minutes') < now()))
            AND NOT (coalesce(status, '') IN ('SUCCESS', 'REFUNDED', 'FAILED') AND coalesce(status_at, created_at) < now() - interval '1 day')
          ORDER BY created_at DESC LIMIT 20`.pipe(
          Effect.orDie,
          Effect.map((rows) =>
            rows.map((r) =>
              new Transfer({
                depositAddress: r.deposit_address,
                ...(r.deposit_memo ? { depositMemo: r.deposit_memo } : {}),
                usdc: Number(r.usdc),
                symbol: r.symbol ?? "USDC",
                chain: r.chain ?? "",
                ...(r.amount_in ? { amountIn: r.amount_in } : {}),
                ...(r.deposited ? { deposited: r.deposited } : {}),
                ...(r.deposit_tx ? { depositTx: r.deposit_tx } : {}),
                phase: phaseOf(r),
                late: isLate(r, Date.now()),
                createdAt: new Date(r.created_at).toISOString(),
                ...(r.deadline ? { deadline: new Date(r.deadline).toISOString() } : {}),
                ...(r.time_estimate !== null ? { timeEstimateSeconds: r.time_estimate } : {}),
                ...(r.delivered_tx ? { deliveredTx: r.delivered_tx } : {}),
                ...(r.refunded ? { refunded: r.refunded } : {}),
                ...(r.refund_to ? { refundTo: r.refund_to } : {}),
                ...(r.refund_reason ? { detail: reasonText(r.refund_reason) } : {}),
                explorer: explorerOf(r.deposit_address)
              })
            )
          )
        )

      return TopUp.of({
        assets: Effect.zipWith(assets, swapAssets, (a, b) => [...a, ...b]),
        // A price check (dry) creates nothing, so only real quotes count against the account's cap.
        quote: (accountId, originAsset, usdc, refundTo, dry = false) =>
          dry ? quote(accountId, originAsset, usdc, refundTo, true) : capped(accountId, quote(accountId, originAsset, usdc, refundTo, false)),
        status,
        swap,
        sent,
        dismiss,
        transfers,
        trackNow: trackPass
      })
    })
  )
}
