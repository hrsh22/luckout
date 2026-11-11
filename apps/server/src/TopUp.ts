import {
  ExitQuote,
  isEvmAccount,
  type SignedIntent,
  TopUpAsset,
  TopUpQuote,
  TopUpStatus,
  TopUpUnavailable,
  Transfer,
  type TransferPhase
} from "@luckout/api"
import { Config, Context, Effect, Layer, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { parsePayload, payloadRefusal, signedBy } from "./Intents.ts"
import { Alerts } from "./Alerts.ts"
import { Near, Network } from "./Near.ts"
import { OneClick, type SwapDetails } from "./OneClick.ts"
import { Relay } from "./Relay.ts"

// Top-ups (ADR-0001): a NEAR Intents 1Click swap from any supported chain that lands native
// USDC in the customer's own NEAR account; one deposit then moves it into their Balance.
// The server pins the destination (USDC) and the recipient (the signed-in account), so this
// endpoint can't be used to swap anything else or pay anyone else.
//
// EVM wallets (ADR-0011) have no NEAR account: their swap lands in their own NEAR Intents account,
// and the intent they signed when it started moves exactly that USDC into Luckout once it lands.
// Withdrawals go the other way: a 1Click quote from their Intents account to their own address.

export const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
export const NEAR_USDC_ASSET = `nep141:${MAINNET_USDC}`
const SYMBOLS = new Set(["USDC", "USDT", "ETH", "BTC", "SOL", "wNEAR"])
const CHAINS = new Set(["eth", "arb", "base", "sol", "btc", "pol", "bsc", "near"])
/** Chains an EVM wallet can withdraw to: its own address works on each. */
const EVM_CHAINS = new Set(["eth", "arb", "base", "pol", "bsc"])
/** Top-Ups whose move-in may wait at once, per account, so nobody can crowd out everyone else's. */
const MOST_WAITING = 3
/** Waiting move-ins checked per pass, least recently checked first. */
const PER_PASS = 40
/** The relayer's message when NEAR didn't answer: the intent may still have run, so it's resumed, not failed. */
const UNANSWERED = /didn't answer in time/
/** 1Click is done with these: the money arrived or went back. */
const FINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"])
/** A quote nobody paid into is still checked this long past its deadline, in case the transfer was late. */
const LATE_DEPOSIT_GRACE_MS = 2 * 60 * 60 * 1000
const CHAIN_NAMES: Record<string, string> = { eth: "Ethereum", arb: "Arbitrum", base: "Base", pol: "Polygon", bsc: "BNB Chain", sol: "Solana", btc: "Bitcoin", near: "NEAR" }
const chainName = (c: string | null) => (c ? CHAIN_NAMES[c] ?? c : "another chain")
const usd = (micro: number) => `$${(micro / 1e6).toFixed(2)}`

/** A row of `intents_swaps`: one 1Click swap of a customer's money. */
export interface SwapRow {
  readonly deposit_address: string
  readonly deposit_memo: string | null
  readonly account_id: string
  readonly direction: "in" | "out"
  readonly usdc: string
  readonly symbol: string | null
  readonly chain: string | null
  readonly amount_in: string | null
  readonly amount_out: string | null
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
  readonly told: ReadonlyArray<string>
  readonly created_at: Date | string
}

const ms = (d: Date | string | null) => (d === null ? undefined : new Date(d).getTime())

/** Where the money is, in the customer's words (see TransferPhase). */
export const phaseOf = (r: Pick<SwapRow, "direction" | "account_id" | "status" | "move">): TransferPhase => {
  if (r.status === "REFUNDED" || r.status === "FAILED") return "refunded"
  if (r.status === "SUCCESS") {
    if (r.direction === "out") return "done"
    if (!isEvmAccount(r.account_id)) return "in-wallet"
    return r.move === "moved" ? "done" : r.move === "waiting" ? "moving" : "in-intents"
  }
  if (!r.status || r.status === "PENDING_DEPOSIT") return r.direction === "out" ? "swapping" : "awaiting-transfer"
  return "swapping"
}

/** 1Click has the money but it's taking well over its usual time: safe, and the customer should hear so. */
export const isLate = (r: Pick<SwapRow, "status" | "deposit_seen_at" | "time_estimate">, now: number) => {
  const seen = ms(r.deposit_seen_at)
  if (seen === undefined || (r.status && FINAL.has(r.status))) return false
  return now - seen > Math.max(10 * 60_000, 3 * (r.time_estimate ?? 0) * 1000)
}

const explorerOf = (depositAddress: string) => `https://explorer.near-intents.org/transactions/${depositAddress}`

/** The Telegram notice for what just happened to this swap, keyed so each is sent once. */
export const noticeFor = (r: SwapRow, now: number, web: string): { key: string; text: string } | undefined => {
  const phase = phaseOf(r)
  const amount = usd(Number(r.usdc))
  const from = `${r.amount_in ?? ""} ${r.symbol ?? ""} on ${chainName(r.chain)}`.replace(/\s+/g, " ").trim()
  if (r.direction === "in") {
    if (phase === "done") return { key: "landed", text: `Your ${amount} Top-Up is in your Luckout balance.` }
    if (phase === "in-wallet") return { key: "landed", text: `Your ${amount} Top-Up landed in your NEAR wallet. Deposit it into Luckout at ${web}/wallet` }
    if (phase === "in-intents") {
      return { key: "landed", text: `Your ${amount} Top-Up landed in your NEAR Intents account${r.move_detail ? ` but didn't move into Luckout (${r.move_detail})` : ""}. Move it in at ${web}/wallet` }
    }
    if (phase === "refunded") {
      return {
        key: "refunded",
        text: `Your Top-Up (${from}) didn't go through${r.refund_reason ? `: ${r.refund_reason}` : ""}. 1Click sent ${r.refunded ? `${r.refunded} ${r.symbol ?? ""}`.trim() : "it"} back to your NEAR Intents account. See ${web}/wallet`
      }
    }
  } else {
    if (phase === "done") return { key: "arrived", text: `Your ${amount} withdrawal arrived: ${r.amount_out ?? ""} ${r.symbol ?? "USDC"} on ${chainName(r.chain)}.`.replace(/\s+/g, " ") }
    if (phase === "refunded") return { key: "refunded", text: `Your ${amount} withdrawal to ${chainName(r.chain)} was refunded to your NEAR Intents account. Move it back into Luckout at ${web}/wallet` }
  }
  if (isLate(r, now)) {
    return {
      key: "late",
      text: `Your ${amount} ${r.direction === "in" ? "Top-Up" : "withdrawal"} is taking longer than usual. It's safe: it either arrives or 1Click refunds it. Track it: ${explorerOf(r.deposit_address)}`
    }
  }
  return undefined
}

export class TopUp extends Context.Service<TopUp, {
  readonly assets: Effect.Effect<ReadonlyArray<TopUpAsset>, TopUpUnavailable>
  quote(accountId: string, originAsset: string, usdc: number, dry?: boolean): Effect.Effect<TopUpQuote, TopUpUnavailable>
  status(accountId: string, depositAddress: string): Effect.Effect<TopUpStatus, TopUpUnavailable>
  /** EVM wallets: keeps the signed intent that moves this Top-Up into Luckout, and sends it once the swap lands. */
  move(accountId: string, depositAddress: string, signed: SignedIntent): Effect.Effect<void, TopUpUnavailable>
  /** Testnet, EVM wallets: 100 test USDC into their NEAR Intents account (they move it in themselves), once a day. */
  faucet(accountId: string): Effect.Effect<void, TopUpUnavailable>
  /** The customer's swaps still on their way, and those that ended in the last day. */
  transfers(accountId: string): Effect.Effect<ReadonlyArray<Transfer>>
  /** One tracking pass now, as the background loop runs every 15 seconds (tests). */
  readonly trackNow: Effect.Effect<void>
  /** EVM wallets: a quote to send USDC from their NEAR Intents account to their own address on another chain. */
  exit(accountId: string, destinationAsset: string, usdc: number): Effect.Effect<ExitQuote, TopUpUnavailable>
}>()("luckout/TopUp") {
  static readonly layer = Layer.effect(
    TopUp,
    Effect.gen(function*() {
      const oneClick = yield* OneClick
      const sql = yield* SqlClient.SqlClient
      const near = yield* Near
      const relay = yield* Relay
      const alerts = yield* Alerts
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
                ...(t.contractAddress && EVM_CHAINS.has(t.blockchain) ? { contract: t.contractAddress } : {}),
                ...(t.decimals !== undefined ? { decimals: t.decimals } : {})
              })
            )
        ),
        Effect.mapError(unavailable)
      )

      const quote = Effect.fn("TopUp.quote")(function*(accountId: string, originAsset: string, usdc: number, dry = false) {
        if (!mainnet && !dry) return yield* fail("Top-ups from other chains run on mainnet. On testnet, use the test USDC faucet.")
        if (!Number.isInteger(usdc) || usdc < 1_000_000 || usdc > 2_000_000_000) return yield* fail("Top up between 1 and 2,000 USDC")
        const asset = (yield* assets).find((t) => t.assetId === originAsset)
        if (!asset) return yield* fail("That token isn't supported for top-ups")
        const evm = isEvmAccount(accountId)
        const { quote: q, quoteRequest: echo } = yield* oneClick.quote({
          dry,
          swapType: "EXACT_OUTPUT",
          slippageTolerance: 100,
          originAsset,
          destinationAsset: NEAR_USDC_ASSET,
          amount: String(usdc),
          recipient: accountId,
          // An EVM wallet's USDC lands in its own NEAR Intents account (ADR-0011).
          recipientType: evm ? "INTENTS" : "DESTINATION_CHAIN",
          // We don't know the customer's address on the origin chain, so refunds go to
          // their own NEAR account inside Intents.
          refundTo: accountId,
          refundType: "INTENTS",
          deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString()
        }).pipe(Effect.mapError(unavailable))
        if (!dry && !q.depositAddress) return yield* fail("1Click returned no deposit address")
        if (evm && echo && (echo.recipient !== accountId || echo.recipientType !== "INTENTS")) {
          return yield* fail("1Click quoted a different recipient. Try again.")
        }
        // Every Top-Up is recorded, so the customer can always see where their money is, even after leaving.
        if (!dry) {
          yield* sql`INSERT INTO intents_swaps (deposit_address, account_id, direction, usdc, symbol, chain, amount_in, deposit_memo, deadline, time_estimate)
                     VALUES (${q.depositAddress!}, ${accountId}, 'in', ${Number(q.amountOut)}, ${asset.symbol}, ${asset.chain}, ${q.amountInFormatted},
                             ${q.depositMemo ?? null}, ${q.deadline ? new Date(q.deadline) : null}, ${q.timeEstimate})`.pipe(Effect.orDie)
        }
        return new TopUpQuote({
          depositAddress: q.depositAddress ?? "",
          ...(q.depositMemo ? { depositMemo: q.depositMemo } : {}),
          amountIn: q.amountIn,
          amountInFormatted: q.amountInFormatted,
          symbol: asset.symbol,
          chain: asset.chain,
          usdcOut: Number(q.amountOut),
          timeEstimateSeconds: q.timeEstimate,
          deadline: q.deadline ?? ""
        })
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
          SELECT count(*)::int AS waiting FROM intents_swaps WHERE account_id = ${accountId} AND move = 'waiting'`.pipe(Effect.orDie)
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

      const exit = Effect.fn("TopUp.exit")(function*(accountId: string, destinationAsset: string, usdc: number) {
        if (!isEvmAccount(accountId)) return yield* fail("Withdrawals to other chains are for EVM wallets")
        if (!mainnet) return yield* fail("Withdrawals to other chains run on mainnet.")
        if (!Number.isInteger(usdc) || usdc < 1_000_000 || usdc > 2_000_000_000) return yield* fail("Withdraw between 1 and 2,000 USDC")
        const asset = (yield* assets).find((t) => t.assetId === destinationAsset && EVM_CHAINS.has(t.chain))
        if (!asset) return yield* fail("That token can't be withdrawn to an EVM wallet")
        const { quote: q, quoteRequest: echo } = yield* oneClick.quote({
          dry: false,
          swapType: "EXACT_INPUT",
          slippageTolerance: 100,
          originAsset: NEAR_USDC_ASSET,
          depositType: "INTENTS",
          destinationAsset,
          amount: String(usdc),
          // Their own address, on the chain they picked.
          recipient: accountId,
          recipientType: "DESTINATION_CHAIN",
          refundTo: accountId,
          refundType: "INTENTS",
          deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString()
        }).pipe(Effect.mapError(unavailable))
        if (!q.depositAddress) return yield* fail("1Click returned no deposit address")
        if (echo && (echo.recipient.toLowerCase() !== accountId || echo.depositType !== "INTENTS")) {
          return yield* fail("1Click quoted a different recipient. Try again.")
        }
        yield* sql`INSERT INTO intents_swaps (deposit_address, account_id, direction, usdc, symbol, chain, amount_out, deadline, time_estimate)
                   VALUES (${q.depositAddress}, ${accountId}, 'out', ${usdc}, ${asset.symbol}, ${asset.chain}, ${q.amountOutFormatted ?? null},
                           ${q.deadline ? new Date(q.deadline) : null}, ${q.timeEstimate})`.pipe(Effect.orDie)
        return new ExitQuote({
          depositAddress: q.depositAddress,
          usdcIn: usdc,
          amountOutFormatted: q.amountOutFormatted ?? q.amountOut,
          symbol: asset.symbol,
          chain: asset.chain,
          timeEstimateSeconds: q.timeEstimate
        })
      })

      // An EVM wallet on testnet has no NEAR account to call the faucet from: our relayer gets the test
      // USDC and deposits it into their NEAR Intents account, the way 1Click delivers a Top-Up on mainnet.
      const faucet = Effect.fn("TopUp.faucet")(function*(accountId: string) {
        if (mainnet) return yield* fail("There's no faucet on mainnet")
        if (!isEvmAccount(accountId)) return yield* fail("NEAR wallets call the faucet themselves")
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

      // Sends a Top-Up's signed move-in once its swap has landed (EVM wallets). A refunded swap, or one that
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
              Effect.catchTag("RelayFailed", (e) => (UNANSWERED.test(e.message) ? Effect.succeed(r) : done("failed", e.message))),
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
          const d = yield* oneClick.details(row.deposit_address).pipe(Effect.option)
          if (d._tag === "None") return
          const changed = d.value.status !== row.status
          const seen = row.deposit_seen_at ?? (d.value.status !== "PENDING_DEPOSIT" ? new Date() : null)
          const [fresh] = yield* sql<SwapRow>`
            UPDATE intents_swaps SET
              status = ${d.value.status},
              status_at = CASE WHEN ${changed} THEN now() ELSE status_at END,
              deposit_seen_at = ${seen},
              amount_out = CASE WHEN direction = 'out' THEN coalesce(${d.value.amountOut ?? null}, amount_out) ELSE amount_out END,
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
            const [claimed] = yield* sql`UPDATE intents_swaps SET told = array_append(told, ${notice.key})
                                         WHERE deposit_address = ${r.deposit_address} AND NOT (${notice.key} = ANY(told)) RETURNING 1`.pipe(Effect.orDie)
            if (claimed) yield* alerts.customer(r.account_id, notice.text)
          }
        })

      // Swaps still in motion, least recently checked first, so a pile of quotes nobody pays into can't hold up
      // everyone else's. A quote nobody paid into stops being checked two hours past its deadline.
      const trackPass = sql<SwapRow>`
        UPDATE intents_swaps SET checked_at = now()
        WHERE deposit_address IN (
          SELECT deposit_address FROM intents_swaps
          WHERE move = 'waiting'
             OR (created_at > now() - interval '3 days'
                 AND coalesce(status, '') NOT IN ('SUCCESS', 'REFUNDED', 'FAILED')
                 AND NOT (coalesce(status, 'PENDING_DEPOSIT') = 'PENDING_DEPOSIT'
                          AND coalesce(deadline, created_at + interval '30 minutes') < now() - ${`${LATE_DEPOSIT_GRACE_MS / 1000} seconds`}::interval))
          ORDER BY checked_at NULLS FIRST LIMIT ${PER_PASS})
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
            AND NOT (coalesce(status, 'PENDING_DEPOSIT') = 'PENDING_DEPOSIT' AND direction = 'in'
                     AND coalesce(deadline, created_at + interval '30 minutes') < now())
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
                ...(r.amount_out ? { amountOut: r.amount_out } : {}),
                phase: phaseOf(r),
                late: isLate(r, Date.now()),
                createdAt: new Date(r.created_at).toISOString(),
                ...(r.deadline ? { deadline: new Date(r.deadline).toISOString() } : {}),
                ...(r.time_estimate !== null ? { timeEstimateSeconds: r.time_estimate } : {}),
                ...(r.delivered_tx ? { deliveredTx: r.delivered_tx } : {}),
                ...(r.refunded ? { refunded: r.refunded } : {}),
                ...(r.refund_reason || r.move_detail ? { detail: (r.refund_reason ?? r.move_detail)! } : {}),
                explorer: explorerOf(r.deposit_address)
              })
            )
          )
        )

      return TopUp.of({ assets, quote, status, move, faucet, transfers, trackNow: trackPass, exit })
    })
  )
}
