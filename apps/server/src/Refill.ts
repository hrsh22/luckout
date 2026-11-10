import { AdminInvalid, BitrefillUnavailable, RefillView } from "@luckout/api"
import { Context, Effect, Layer, Schedule, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import { actions, teraToGas } from "near-api-js"
import { Alerts } from "./Alerts.ts"
import { Bitrefill } from "./Bitrefill.ts"
import { Credit } from "./Credit.ts"
import { spendable } from "./Monitor.ts"
import { ContractRejected, Near, NearUnavailable, Network, type Signed, TxExpired } from "./Near.ts"
import { OneClick, OneClickUnavailable, type QuoteResponse } from "./OneClick.ts"
import { USDC_REGISTRATION } from "./Relay.ts"
import { NEAR_USDC_ASSET } from "./TopUp.ts"

// Refilling our Bitrefill credit (ADR-0009). Real money moves here, so:
//   invoice → quote → fund → send → swapping → crediting → done
//                                ↘ failed (nothing moved)   ↘ refunded (back in the treasury)
//                                                           ↘ stuck (a human looks; auto-refill pauses)
// - Bitrefill sells USD credit 1:1 for USDC on Base; the deposit is refused unless it costs exactly that.
// - NEAR Intents swaps the treasury's USDC on NEAR into exactly the invoice amount, sent straight to
//   Bitrefill's address; the quote is refused unless 1Click echoes that recipient, asset and amount,
//   and costs at most 1% more (the slippage buffer comes back to the treasury).
// - The treasury holds only what refills need: in automatic mode it pulls each refill's shortfall from
//   the proceeds, within the daily cap the owner set in the contract; in manual mode it waits for the
//   owner to move proceeds in.
// - Every step is saved before its side effect and every transaction before it's sent, so a restart
//   resumes without paying twice. One refill runs at a time, and anything unclear stops automatic
//   refills until an admin resolves it.

export const BASE_USDC_ASSET = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"
/** Smaller refills cost relatively more and churn invoices. */
export const MIN_REFILL = 10_000_000
/** The most a refill may cost above the credit it buys, slippage buffer included. */
const MAX_COST_BPS = 100n
const SLIPPAGE_BPS = 50
/** Bitrefill's crypto invoices expire after 60 minutes; we start over well before. */
const INVOICE_TTL_MS = 40 * 60_000
const QUOTE_MIN_LEFT_MS = 10 * 60_000
const SEND_MIN_LEFT_MS = 5 * 60_000
const SWAP_GRACE_MS = 30 * 60_000
const CREDIT_TIMEOUT_MS = 60 * 60_000
/** The treasury needs a little NEAR to sign refills. */
const TREASURY_MIN_GAS = 50_000_000_000_000_000_000_000n // 0.05 NEAR

export const OPEN_REFILL_STEPS = ["invoice", "quote", "fund", "send", "swapping", "crediting"]
const AUTO_OFF = "Automatic refills are switched off."

interface Swap {
  readonly depositAddress: string
  readonly amountIn: string
  readonly minAmountIn: string
  readonly deadline: string
}
interface Row {
  id: string
  amount: number | string
  reason: string
  step: string
  invoice_id: string | null
  pay_address: string | null
  invoice_at: Date | string | null
  swap: Swap | null
  sweep_tx: Signed | null
  send_tx: Signed | null
  sent_at: Date | string | null
  error: string | null
  attempts: number
  created_at: Date | string
  updated_at: Date | string
}

type Unknown = NearUnavailable | OneClickUnavailable | BitrefillUnavailable
/** What a step did: moved on (go again), or must wait (try again after a while). */
type Next = "next" | "wait"

const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/
const usd = (micro: number | bigint) => `$${(Number(micro) / 1e6).toFixed(2)}`
const cents = (micro: number) => Math.ceil(micro / 10_000) * 10_000
const time = (v: Date | string | null) => (v ? new Date(v).getTime() : 0)

/** Why this quote must not be paid, or undefined when it does exactly what we asked. */
export const quoteProblem = (r: QuoteResponse, want: { amount: number; recipient: string; refundTo: string }, now = Date.now()) => {
  const q = r.quote
  const echo = r.quoteRequest
  if (!q.depositAddress || !NEAR_ACCOUNT.test(q.depositAddress)) return "no valid NEAR deposit address"
  if (q.amountOut !== String(want.amount) || (q.minAmountOut ?? q.amountOut) !== String(want.amount)) {
    return `it delivers ${q.minAmountOut ?? q.amountOut}, not exactly ${want.amount}`
  }
  if (!echo) return "1Click didn't echo the request"
  if (echo.recipient.toLowerCase() !== want.recipient.toLowerCase()) return `it pays ${echo.recipient}, not Bitrefill's ${want.recipient}`
  if (echo.destinationAsset !== BASE_USDC_ASSET || echo.originAsset !== NEAR_USDC_ASSET) return "it swaps the wrong assets"
  if (echo.refundTo !== want.refundTo) return `it refunds to ${echo.refundTo}, not the treasury`
  if (echo.swapType !== "EXACT_OUTPUT" || echo.amount !== String(want.amount)) return "it isn't an exact-output swap of the invoice amount"
  if (BigInt(q.amountIn) * 10_000n > BigInt(want.amount) * (10_000n + MAX_COST_BPS)) {
    return `it costs ${usd(BigInt(q.amountIn))} for ${usd(want.amount)}, over the 1% limit`
  }
  if (!q.deadline || new Date(q.deadline).getTime() - now < QUOTE_MIN_LEFT_MS) return "its deadline is too close"
  return undefined
}

export interface TreasuryState {
  readonly accountId: string | undefined
  readonly contractTreasury: string | undefined
  readonly dailyCap: number
  readonly sweptToday: number
  readonly proceeds: number
  /** USDC the treasury holds. */
  readonly usdc: number
}

export interface RefillStatus {
  readonly refills: ReadonlyArray<RefillView>
  readonly refilledToday: number
  /** Why automatic refills won't run right now. */
  readonly paused: string | undefined
  readonly available: boolean
  /** In manual mode, what the open refill is waiting for the owner to move into the treasury. */
  readonly needs: number | undefined
  readonly treasury: TreasuryState
}

export class Refill extends Context.Service<Refill, {
  /** Plans a refill now instead of at the next pass: a purchase started waiting for credit. */
  readonly kick: Effect.Effect<void>
  /** An admin asks for a refill now (default: what the target and waiting purchases need). */
  request(amount: number | undefined, by: string): Effect.Effect<RefillView, AdminInvalid>
  /** An admin checked a stuck refill by hand and closes it, which lets automatic refills run again. */
  resolve(id: string, note: string, by: string): Effect.Effect<void, AdminInvalid>
  readonly status: Effect.Effect<RefillStatus>
  /** One pass over open refills that are due (also runs every 10 seconds by itself). */
  readonly process: Effect.Effect<void>
}>()("luckout/Refill") {
  static readonly layer = Layer.effect(
    Refill,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const near = yield* Near
      const bitrefill = yield* Bitrefill
      const oneClick = yield* OneClick
      const credit = yield* Credit
      const alerts = yield* Alerts
      const mainnet = (yield* Network) === "mainnet"
      const planLock = yield* Semaphore.make(1)
      const running = new Set<string>()

      const load = (id: string) => sql<Row>`SELECT * FROM refills WHERE id = ${id}`.pipe(Effect.map((r) => r[0]), Effect.orDie)
      const json = (v: unknown) => (v === null || typeof v !== "object" || v instanceof Date ? v : JSON.stringify(v))
      const save = (id: string, fields: Record<string, unknown>) =>
        sql`UPDATE refills SET ${sql.update(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, json(v)])))}, updated_at = now() WHERE id = ${id}`
          .pipe(Effect.asVoid, Effect.orDie)
      /** Moves on from the step it was loaded at; false if something else already did. */
      const move = (row: Row, fields: Record<string, unknown> & { step: string }) =>
        sql`UPDATE refills SET ${sql.update(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, json(v)])))}, attempts = 0, updated_at = now()
            WHERE id = ${row.id} AND step = ${row.step} RETURNING id`.pipe(Effect.map((r) => r.length === 1), Effect.orDie)

      const toView = (r: Row) =>
        new RefillView({
          id: r.id,
          amount: Number(r.amount),
          reason: r.reason,
          step: r.step,
          ...(r.error ? { error: r.error } : {}),
          ...(r.send_tx ? { sendTx: r.send_tx.hash } : {}),
          createdAt: new Date(r.created_at).toISOString(),
          updatedAt: new Date(r.updated_at).toISOString()
        })

      const treasury = Effect.gen(function*() {
        const [config, reserve, usdc] = yield* Effect.all([
          near.view<{ treasury: string | null; sweep_daily_cap?: string; swept_today?: string }>("get_config"),
          near.view<{ proceeds: string }>("get_reserve"),
          near.treasuryId ? near.view<string>("ft_balance_of", { account_id: near.treasuryId }, near.usdcId) : Effect.succeed("0")
        ], { concurrency: 3 })
        return {
          accountId: near.treasuryId,
          contractTreasury: config.treasury ?? undefined,
          dailyCap: Number(config.sweep_daily_cap ?? 0),
          sweptToday: Number(config.swept_today ?? 0),
          proceeds: Number(reserve.proceeds),
          usdc: Number(usdc)
        } satisfies TreasuryState
      })

      const stop = (row: Row, error: string) =>
        Effect.gen(function*() {
          if (yield* move(row, { step: "stuck", error })) {
            yield* alerts.admin(`Refill ${row.id.slice(0, 8)} (${usd(Number(row.amount))}) needs a look: ${error}. Automatic refills are paused until it's resolved in Admin.`)
          }
          return "wait" as Next
        })

      /** Sends (or resumes) a treasury transaction whose signed bytes live in `column`. Undefined: it expired unsent. */
      const treasuryTx = (row: Row, column: "sweep_tx" | "send_tx", receiver: string, txActions: Parameters<Near["Service"]["treasurySend"]>[1]) =>
        Effect.gen(function*() {
          const saved = row[column]
          if (saved) {
            const resumed = yield* near.resume(saved).pipe(
              Effect.map((o) => ({ outcome: o })),
              Effect.catchTag("TxExpired", (_: TxExpired) => Effect.succeed(undefined))
            )
            if (resumed) return resumed.outcome
            // It never executed and never can: forget it so the next pass signs afresh.
            yield* save(row.id, { [column]: null })
            return undefined
          }
          return yield* near.treasurySend(receiver, txActions, (signed) => save(row.id, { [column]: signed }))
        })

      const step = (row: Row): Effect.Effect<Next, Unknown> =>
        Effect.gen(function*() {
          const amount = Number(row.amount)
          switch (row.step) {
            case "invoice": {
              const d = yield* bitrefill.deposit(amount)
              yield* move(row, { step: "quote", invoice_id: d.invoiceId, pay_address: d.address, invoice_at: new Date().toISOString(), swap: null })
              return "next"
            }
            case "quote": {
              if (Date.now() - time(row.invoice_at) > INVOICE_TTL_MS) {
                yield* move(row, { step: "invoice", invoice_id: null, pay_address: null, swap: null })
                return "next"
              }
              const want = { amount, recipient: row.pay_address!, refundTo: near.treasuryId! }
              const deadline = new Date(Math.min(time(row.invoice_at) + INVOICE_TTL_MS + 5 * 60_000, Date.now() + 30 * 60_000))
              const r = yield* oneClick.quote({
                dry: false,
                swapType: "EXACT_OUTPUT",
                slippageTolerance: SLIPPAGE_BPS,
                originAsset: NEAR_USDC_ASSET,
                destinationAsset: BASE_USDC_ASSET,
                amount: String(amount),
                recipient: want.recipient,
                refundTo: want.refundTo,
                refundType: "ORIGIN_CHAIN",
                deadline: deadline.toISOString()
              })
              const problem = quoteProblem(r, want)
              if (problem) {
                // Nothing was sent: drop this one, and say why, so a bad quote never turns into a payment.
                yield* move(row, { step: "failed", error: `Refused the 1Click quote: ${problem}` })
                yield* alerts.admin(`Refill ${row.id.slice(0, 8)} refused a 1Click quote: ${problem}`)
                return "wait"
              }
              const q = r.quote
              yield* move(row, {
                step: "fund",
                // Our deadline, when 1Click starts refunding an unfilled swap. The quote's own `deadline`
                // is when the deposit address dies (days later), too late to re-quote or call it stuck.
                swap: { depositAddress: q.depositAddress!, amountIn: q.amountIn, minAmountIn: q.minAmountIn ?? q.amountIn, deadline: deadline.toISOString() }
              })
              return "next"
            }
            case "fund": {
              const swap = row.swap!
              if (time(swap.deadline) - Date.now() < QUOTE_MIN_LEFT_MS && !row.sweep_tx) {
                yield* move(row, { step: "quote", swap: null })
                return "next"
              }
              const refused = (e: ContractRejected) =>
                Effect.gen(function*() {
                  yield* save(row.id, { sweep_tx: null, error: `The contract refused the treasury's pull: ${e.message}` })
                  yield* alerts.admin(`The treasury's pull for refill ${row.id.slice(0, 8)} was refused: ${e.message}`)
                  return "wait" as Next
                })
              if (row.sweep_tx) {
                const done = yield* treasuryTx(row, "sweep_tx", near.contractId, []).pipe(
                  Effect.map(() => "next" as Next),
                  Effect.catchTag("ContractRejected", refused)
                )
                if (done === "next") yield* save(row.id, { sweep_tx: null })
                return done
              }
              const t = yield* treasury
              const need = Number(swap.amountIn)
              if (t.usdc >= need) {
                yield* move(row, { step: "send" })
                return "next"
              }
              if (t.contractTreasury !== near.treasuryId) {
                yield* save(row.id, { error: `The contract's treasury is ${t.contractTreasury ?? "not set"}, not ${near.treasuryId}. Fix it in Admin → Treasury.` })
                yield* alerts.admin(`Refills can't be funded: the contract's treasury is ${t.contractTreasury ?? "not set"}, but the server signs as ${near.treasuryId}.`)
                return "wait"
              }
              const shortfall = cents(need - t.usdc)
              if (t.dailyCap === 0) {
                yield* save(row.id, { error: `Waiting for ${usd(shortfall)} of proceeds in the treasury (manual mode).` })
                yield* alerts.admin(`A Bitrefill refill is waiting: move ${usd(shortfall)} of proceeds to the treasury in Admin → Treasury, or switch it to automatic.`)
                return "wait"
              }
              const allowed = Math.min(t.dailyCap - t.sweptToday, t.proceeds)
              if (allowed < shortfall) {
                yield* save(row.id, { error: `The treasury needs ${usd(shortfall)}; today's cap and the proceeds allow ${usd(Math.max(0, allowed))}.` })
                yield* alerts.admin(`A Bitrefill refill needs ${usd(shortfall)} more in the treasury, but today's cap and the proceeds allow only ${usd(Math.max(0, allowed))}.`)
                return "wait"
              }
              // Pull exactly the shortfall: the treasury never holds more than refills need.
              const pulled = yield* treasuryTx(row, "sweep_tx", near.contractId, [
                actions.functionCall("sweep_proceeds", { amount: String(shortfall) }, teraToGas("60"), 1n)
              ]).pipe(Effect.map(() => "next" as Next), Effect.catchTag("ContractRejected", refused))
              if (pulled === "next") {
                yield* save(row.id, { sweep_tx: null, error: null })
                yield* alerts.admin(`Treasury pulled ${usd(shortfall)} of proceeds for refill ${row.id.slice(0, 8)}.`)
              }
              return pulled
            }
            case "send": {
              const swap = row.swap!
              if (!row.send_tx) {
                if (time(swap.deadline) - Date.now() < SEND_MIN_LEFT_MS) {
                  yield* move(row, { step: "quote", swap: null })
                  return "next"
                }
                const gas = yield* spendable(near, near.treasuryId!)
                if (gas < TREASURY_MIN_GAS) {
                  yield* save(row.id, { error: "The treasury needs a little NEAR for gas." })
                  yield* alerts.admin(`The treasury ${near.treasuryId} is out of NEAR for gas; send it 0.1 NEAR in Admin → Gas.`)
                  return "wait"
                }
              }
              // One transaction: register the deposit address on USDC (refunded if already done), then pay it.
              const outcome = yield* treasuryTx(row, "send_tx", near.usdcId, [
                actions.functionCall("storage_deposit", { account_id: swap.depositAddress, registration_only: true }, teraToGas("10"), USDC_REGISTRATION),
                actions.functionCall("ft_transfer", { receiver_id: swap.depositAddress, amount: swap.amountIn, memo: `Luckout refill ${row.id}` }, teraToGas("20"), 1n)
              ]).pipe(Effect.catchTag("ContractRejected", (e: ContractRejected) => Effect.succeed(e)))
              if (outcome === undefined) return "next"
              if (outcome instanceof ContractRejected) {
                // The whole transaction reverted: no USDC left the treasury.
                yield* move(row, { step: "failed", error: `The treasury's transfer was refused: ${outcome.message}` })
                yield* alerts.admin(`Refill ${row.id.slice(0, 8)}: the treasury's transfer was refused (${outcome.message}). Nothing was sent.`)
                return "wait"
              }
              yield* oneClick.submitDeposit({ txHash: outcome.hash, depositAddress: swap.depositAddress, nearSenderAccount: near.treasuryId! })
              yield* move(row, { step: "swapping", sent_at: new Date().toISOString(), error: null })
              return "next"
            }
            case "swapping": {
              const status = yield* oneClick.status(row.swap!.depositAddress)
              yield* save(row.id, { swap_status: status })
              if (status === "SUCCESS") {
                yield* move(row, { step: "crediting" })
                return "next"
              }
              if (status === "REFUNDED") {
                yield* move(row, { step: "refunded", error: "1Click refunded the swap to the treasury." })
                yield* alerts.admin(`Refill ${row.id.slice(0, 8)}: 1Click refunded the swap; the USDC is back in the treasury.`)
                return "wait"
              }
              if (status === "FAILED" || status === "INCOMPLETE_DEPOSIT") return yield* stop(row, `1Click reports the swap ${status}`)
              if (Date.now() > time(row.swap!.deadline) + SWAP_GRACE_MS) return yield* stop(row, `the swap is still ${status} long after its deadline`)
              return "wait"
            }
            case "crediting": {
              const d = yield* bitrefill.depositState(row.invoice_id!)
              if (d.state === "credited") {
                yield* move(row, { step: "done", finished_at: new Date().toISOString(), error: null })
                yield* credit.refresh
                yield* alerts.admin(`Bitrefill credit refilled: +${usd(amount)} (refill ${row.id.slice(0, 8)}).`)
                return "wait"
              }
              if (d.state === "failed") return yield* stop(row, `Bitrefill marked the deposit ${d.status} after the USDC arrived`)
              if (Date.now() - time(row.sent_at) > CREDIT_TIMEOUT_MS) return yield* stop(row, `Bitrefill hasn't credited the deposit after an hour (${d.status})`)
              return "wait"
            }
            default:
              return "wait"
          }
        })

      /** How long a step waits before it's tried again when it couldn't move on. */
      const pause = (s: string) => (s === "swapping" ? "10 seconds" : s === "crediting" ? "20 seconds" : s === "fund" ? "1 minute" : "30 seconds")

      const advance = (id: string) =>
        Effect.gen(function*() {
          if (running.has(id)) return
          running.add(id)
          for (;;) {
            const row = yield* load(id)
            if (!row || !OPEN_REFILL_STEPS.includes(row.step)) return
            const next = yield* step(row)
            if (next === "wait") {
              yield* sql`UPDATE refills SET next_attempt_at = now() + ${pause(row.step)}::interval WHERE id = ${id}`.pipe(Effect.orDie)
              return
            }
          }
        }).pipe(
          Effect.catch((e: Unknown) =>
            Effect.gen(function*() {
              // Unknown outcome (network): back off and try the same step again; never guess.
              yield* Effect.logWarning(`refill ${id} paused: ${e.message}`)
              yield* sql`UPDATE refills SET attempts = attempts + 1, error = ${e.message},
                next_attempt_at = now() + LEAST(interval '10 minutes', interval '30 seconds' * power(2, attempts)) WHERE id = ${id}`.pipe(Effect.orDie)
            })
          ),
          Effect.catchCause((cause) => Effect.logError(`refill ${id} paused`, cause)),
          Effect.ensuring(Effect.sync(() => running.delete(id))),
          // A shutdown waits for the step in progress: stopping between a payment and saving it
          // would leave the refill for a human.
          Effect.uninterruptible
        )

      const recent = sql<Row>`SELECT * FROM refills ORDER BY created_at DESC LIMIT 10`.pipe(Effect.orDie)
      const refilledToday = sql<{ total: string }>`
        SELECT COALESCE(sum(amount), 0)::text AS total FROM refills
        WHERE created_at > now() - interval '1 day' AND step NOT IN ('failed', 'refunded')`.pipe(
        Effect.map(([r]) => Number(r?.total ?? 0)),
        Effect.orDie
      )

      /** Why no refill may start right now, for automatic ones (`auto`) or for an admin's. */
      const blocked = (auto: boolean) =>
        Effect.gen(function*() {
          if (!mainnet) return "Refills run on mainnet: NEAR Intents doesn't run on testnet, and test cards are free."
          if (!near.treasuryId) return "The server has no treasury key (TREASURY_ACCOUNT_ID / TREASURY_PRIVATE_KEY)."
          const [open] = yield* sql<{ id: string }>`SELECT id FROM refills WHERE step IN ${sql.in(OPEN_REFILL_STEPS)} LIMIT 1`.pipe(Effect.orDie)
          if (open) return `Refill ${open.id.slice(0, 8)} is still running.`
          const [stuck] = yield* sql<{ id: string }>`SELECT id FROM refills WHERE step = 'stuck' LIMIT 1`.pipe(Effect.orDie)
          if (stuck) return `Refill ${stuck.id.slice(0, 8)} is stuck; resolve it in Admin first.`
          if (!auto) return undefined
          if (!(yield* credit.settings).autoRefill) return AUTO_OFF
          const [bad] = yield* sql<{ n: number }>`
            SELECT count(*)::int AS n FROM refills WHERE step IN ('failed', 'refunded') AND updated_at > now() - interval '6 hours'`.pipe(Effect.orDie)
          if ((bad?.n ?? 0) >= 2) return "Two refills failed or were refunded in the last 6 hours; check them, then refill by hand."
          return undefined
        })

      /** The refill the target and waiting purchases call for right now, within every cap; 0 for none. */
      const size = (requested: number | undefined) =>
        Effect.gen(function*() {
          // Money moves on this number: read Bitrefill afresh, and never size a refill blind.
          if ((yield* credit.refresh)._tag === "None") return { amount: 0, why: "Bitrefill's balance can't be read right now." }
          const c = yield* credit.view
          const s = c.settings
          const free = Math.max(0, c.free)
          const room = Math.max(0, (c.snapshot?.room ?? 0))
          const left = s.dailyRefill - (yield* refilledToday)
          // Credit never goes above the ceiling: that bounds what can ever sit unused at Bitrefill.
          const limit = Math.min(s.ceiling - free, room, left)
          const wanted = requested ?? Math.min(s.ceiling, c.target + c.waiting.total) - free
          const due = requested !== undefined || (c.waiting.total > 0 ? wanted > 0 : free < c.refillBelow)
          if (!due || wanted <= 0) return { amount: 0, why: "Credit is above the refill line." }
          const amount = Math.floor(Math.min(cents(Math.max(wanted, MIN_REFILL)), limit) / 10_000) * 10_000
          if (amount < MIN_REFILL) {
            const cap = limit === left ? "today's refill cap" : limit === room ? "Bitrefill's account limit" : "the ceiling"
            return { amount: 0, why: `A refill would be under ${usd(MIN_REFILL)} because of ${cap}.` }
          }
          return { amount, why: c.waiting.total > 0 ? "waiting" : "target" }
        })

      const start = (amount: number, reason: string, by: string | null) =>
        sql<Row>`INSERT INTO refills (amount, reason, requested_by, step) VALUES (${amount}, ${reason}, ${by}, 'invoice') RETURNING *`.pipe(
          Effect.map((r) => r[0]!),
          Effect.orDie
        )

      const plan = planLock.withPermits(1)(Effect.gen(function*() {
        const why = yield* blocked(true)
        if (why === AUTO_OFF) {
          // Off by choice: still say when a refill is due, so nobody has to watch the number.
          const due = yield* size(undefined)
          if (due.amount > 0) yield* alerts.admin(`Bitrefill credit is low and automatic refills are off: a ${usd(due.amount)} refill is due (Admin → Bitrefill credit).`)
        }
        if (why) return
        const s = yield* size(undefined)
        if (s.amount === 0) return
        const row = yield* start(s.amount, s.why, null)
        yield* Effect.log(`refill ${row.id} started: ${usd(s.amount)} (${s.why})`)
        yield* Effect.forkDetach(advance(row.id))
      })).pipe(Effect.catchCause((cause) => Effect.logError("refill planning failed", cause)))

      const request = (amount: number | undefined, by: string) =>
        planLock.withPermits(1)(Effect.gen(function*() {
          const why = yield* blocked(false)
          if (why) return yield* new AdminInvalid({ message: why })
          const s = yield* size(amount)
          if (s.amount === 0) return yield* new AdminInvalid({ message: s.why })
          const row = yield* start(s.amount, "manual", by)
          yield* alerts.admin(`${by} started a ${usd(s.amount)} Bitrefill refill.`)
          yield* Effect.forkDetach(advance(row.id))
          return toView(row)
        }))

      const resolve = (id: string, note: string, by: string) =>
        Effect.gen(function*() {
          const row = yield* load(id)
          if (!row || row.step !== "stuck") return yield* new AdminInvalid({ message: "Only a stuck refill can be resolved." })
          yield* move(row, { step: "resolved", error: `${row.error ?? ""} | Resolved by ${by}: ${note}` })
          yield* alerts.admin(`${by} resolved refill ${id.slice(0, 8)}: ${note}`)
        })

      const status = Effect.gen(function*() {
        const [rows, today, paused, t] = yield* Effect.all([recent, refilledToday, blocked(true), treasury], { concurrency: 4 })
        const funding = rows.find((r) => r.step === "fund" && r.swap)
        const needs = funding && t.dailyCap === 0 ? Math.max(0, cents(Number(funding.swap!.amountIn) - t.usdc)) : undefined
        return { refills: rows.map(toView), refilledToday: today, paused, available: mainnet && !!near.treasuryId, needs, treasury: t } satisfies RefillStatus
      }).pipe(Effect.orDie)

      // Resume open refills every 10 seconds (each waits out its own pause), and plan every minute.
      const resumeOpen = sql<{ id: string }>`SELECT id FROM refills WHERE step IN ${sql.in(OPEN_REFILL_STEPS)} AND next_attempt_at <= now()`.pipe(
        Effect.orDie,
        Effect.flatMap((rows) => Effect.forEach(rows, (r) => advance(r.id), { discard: true })),
        Effect.catchCause((cause) => Effect.logError("refill pass failed", cause))
      )
      yield* resumeOpen.pipe(Effect.repeat(Schedule.spaced("10 seconds")), Effect.forkScoped)
      yield* plan.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped)

      return Refill.of({ kick: Effect.asVoid(Effect.forkDetach(plan)), request, resolve, status, process: resumeOpen })
    })
  )
}
