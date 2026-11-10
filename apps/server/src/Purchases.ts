import { BitrefillUnavailable, Draw, type Mode, NewPurchase, NotFound, Purchase, PurchaseInvalid, Quote } from "@luckout/api"
import { Config, Context, Effect, Fiber, FiberSet, Layer, Option, Redacted, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { Alerts } from "./Alerts.ts"
import { Bitrefill } from "./Bitrefill.ts"
import { ContractRejected, Near, NearUnavailable, Network, type Outcome, type Signed, TxExpired } from "./Near.ts"

// A purchase walks these steps (ADR-0001). Every step is saved before its side effect,
// so after a crash the reconciler resumes it without buying or charging twice:
//   admit → ordering → delivery → confirm → settled
//                    ↘ fail → failed          (admit refused → rejected)
// "ordering" found by the reconciler means we may have paid Bitrefill without saving the
// invoice id; it becomes "stuck" for a human, and the customer can still Reclaim after 24h.
// The reconciler backs off on each retry and gives up (stuck, with an alert) after MAX_ATTEMPTS.
type Step = "admit" | "ordering" | "delivery" | "confirm" | "fail" | "settled" | "failed" | "rejected" | "stuck"

interface Row {
  id: string
  account_id: string
  voucher_id: string
  voucher_name: string
  package_value: string
  requested_mode: Mode | null
  reference_price: number | string | bigint
  max_debit: number | string | bigint | null
  step: Step
  error: string | null
  admit_tx: Signed | null
  contract_purchase_id: number | string | bigint | null
  admitted: { mode: Mode; max_price: string; lucky_amount: string } | null
  invoice_id: string | null
  redemption: string | null
  settle_tx: Signed | null
  draw: Record<string, unknown> | null
  created_at: Date | string
}

interface QuoteView {
  mode: Mode
  reference_price: string
  lucky_amount: string
  max_price: string
}

/** Thrown on to stop a run; the reconciler picks the purchase up again later. */
type Unknown = NearUnavailable | BitrefillUnavailable

export const OPEN_STEPS = ["admit", "ordering", "delivery", "confirm", "fail"]
/** About six hours of retries with backoff (30s doubling, capped at an hour). */
const MAX_ATTEMPTS = 12
/** Unfinished purchases one account may have at once. */
const MAX_OPEN_PER_ACCOUNT = 3
const DAY_MS = 24 * 60 * 60 * 1000

/** The contract's view of a customer (amounts in micro-USDC strings). */
interface ContractAccount {
  balance: string
  per_purchase_limit: string
  daily_limit: string
  day: number
  spent_today: string
}

export class Purchases extends Context.Service<Purchases, {
  quote(voucherId: string, value: string, game: number | undefined): Effect.Effect<Quote, BitrefillUnavailable | PurchaseInvalid>
  create(accountId: string, input: NewPurchase): Effect.Effect<Purchase, BitrefillUnavailable | PurchaseInvalid>
  list(accountId: string): Effect.Effect<ReadonlyArray<Purchase>>
  get(accountId: string, id: string): Effect.Effect<Purchase, NotFound>
}>()("luckout/Purchases") {
  static readonly layer = Layer.effect(
    Purchases,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const near = yield* Near
      const bitrefill = yield* Bitrefill
      const alerts = yield* Alerts
      const keyHex = yield* Config.option(Config.Redacted("REDEMPTION_KEY"))
      const testnet = (yield* Network) === "testnet"
      const webOrigin = yield* Config.String("WEB_ORIGIN").pipe(Config.withDefault("http://localhost:3000"))
      const key = Option.map(keyHex, (k) => Buffer.from(Redacted.value(k), "hex")).pipe(Option.filter((k) => k.length === 32))

      // Redemption Data is encrypted at rest (AES-256-GCM), bound to its purchase id.
      const seal = (id: string, data: unknown) => {
        const iv = randomBytes(12)
        const c = createCipheriv("aes-256-gcm", Option.getOrThrow(key), iv).setAAD(Buffer.from(id))
        const body = Buffer.concat([c.update(JSON.stringify(data)), c.final()])
        return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64")
      }
      const unseal = (id: string, sealed: string): Record<string, unknown> => {
        const b = Buffer.from(sealed, "base64")
        const d = createDecipheriv("aes-256-gcm", Option.getOrThrow(key), b.subarray(0, 12))
          .setAAD(Buffer.from(id))
          .setAuthTag(b.subarray(12, 28))
        return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString())
      }

      const load = (id: string) =>
        sql<Row>`SELECT * FROM purchases WHERE id = ${id}`.pipe(Effect.map((r) => r[0]!), Effect.orDie)
      const save = (id: string, fields: Record<string, unknown>) => {
        const json = (v: unknown) => (v === null || typeof v !== "object" ? v : JSON.stringify(v))
        const values = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, json(v)]))
        return sql`UPDATE purchases SET ${sql.update(values)}, updated_at = now() WHERE id = ${id}`.pipe(
          Effect.asVoid,
          Effect.orDie
        )
      }
      /**
       * Moves a purchase on from the step it was loaded at. False if another worker already
       * moved it, in which case this run stops: each step's side effect happens once.
       */
      const move = (row: Row, fields: Record<string, unknown> & { step: Step }) => {
        const json = (v: unknown) => (v === null || typeof v !== "object" ? v : JSON.stringify(v))
        const values = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, json(v)]))
        return sql`UPDATE purchases SET ${sql.update(values)}, updated_at = now() WHERE id = ${row.id} AND step = ${row.step} RETURNING id`
          .pipe(Effect.map((r) => r.length === 1), Effect.orDie)
      }

      /** Sends (or resumes) one contract call whose signed transaction lives in `column`. */
      const submit = (row: Row, column: "admit_tx" | "settle_tx", method: string, args: object) => {
        const fresh = near.call(method, args, (signed) => save(row.id, { [column]: signed }))
        const saved = row[column]
        return (saved ? near.resume(saved) : fresh).pipe(
          Effect.catchTag("TxExpired", (_: TxExpired) => fresh)
        )
      }

      /** One step forward. Returns false when the purchase is finished or must wait. */
      const step = (row: Row, resumed: boolean): Effect.Effect<boolean, Unknown> =>
        Effect.gen(function*() {
          switch (row.step) {
            case "admit": {
              // order_id makes admission idempotent onchain: re-sending can never debit twice.
              const outcome = yield* submit(row, "admit_tx", "purchase", {
                customer: row.account_id,
                reference_price: String(row.reference_price),
                mode: row.requested_mode,
                order_id: row.id,
                max_debit: String(row.max_debit ?? row.reference_price)
              }).pipe(Effect.catchTag("ContractRejected", (e: ContractRejected) => Effect.succeed(e)))
              if (outcome instanceof ContractRejected) {
                yield* move(row, { step: "rejected", error: outcome.message })
                return false
              }
              // A repeated admission logs no event; read the purchase back from the contract.
              const purchaseId = Number(outcome.value)
              const admitted = outcome.events.find((e) => e.event === "purchase")?.data[0]?.purchase ??
                (yield* near.view("get_purchase", { purchase_id: purchaseId }))
              return yield* move(row, { step: "ordering", contract_purchase_id: purchaseId, admitted })
            }
            case "ordering": {
              if (resumed) {
                yield* move(row, { step: "stuck", error: "Bitrefill order outcome unknown; check the Bitrefill account" })
                yield* Effect.logError("purchase stuck at ordering", row.id)
                return false
              }
              const order = yield* bitrefill.order(row.voucher_id, row.package_value)
              return yield* order._tag === "Ordered"
                ? move(row, { step: "delivery", invoice_id: order.invoiceId })
                : move(row, { step: "fail", error: `Bitrefill refused: ${order.reason}` })
            }
            case "delivery": {
              const d = yield* bitrefill.delivery(row.invoice_id!)
              return yield* d._tag === "Delivered"
                ? move(row, { step: "confirm", redemption: seal(row.id, d.redemption) })
                : move(row, { step: "fail", error: d.reason })
            }
            case "confirm":
            case "fail": {
              const confirm = row.step === "confirm"
              const outcome = yield* submit(
                row,
                "settle_tx",
                confirm ? "confirm_delivery" : "fail_purchase",
                { purchase_id: Number(row.contract_purchase_id) }
              ).pipe(Effect.catchTag("ContractRejected", (e: ContractRejected) => Effect.succeed(e)))
              if (outcome instanceof ContractRejected) {
                // Refused: read what actually happened onchain before telling the customer anything.
                const onchain = yield* near.view<{ status: string } | null>("get_purchase", { purchase_id: Number(row.contract_purchase_id) })
                const status = onchain?.status
                yield* Effect.logWarning(`settlement of ${row.id} refused (${outcome.message}); onchain ${status}`)
                if (status === "Pending" || status === "Drawing") {
                  // Not closed yet, e.g. the Draw callback failed: sign a fresh transaction next attempt.
                  yield* save(row.id, { settle_tx: null, error: outcome.message })
                  return false
                }
                if (status === "Delivered") {
                  if (confirm) yield* move(row, { step: "settled", error: outcome.message })
                  else {
                    yield* move(row, { step: "stuck", error: `fail_purchase refused, delivered onchain: ${outcome.message}` })
                    yield* alerts.admin(`purchase ${row.id} is delivered onchain but we tried to fail it`)
                  }
                  return false
                }
                // Failed or Reclaimed: the customer already has the full amount back.
                yield* move(row, { step: "failed", error: status === "Reclaimed" ? "Reclaimed" : outcome.message })
                if (confirm) yield* alerts.admin(`purchase ${row.id} was delivered but closed onchain as ${status}; its voucher cost is ours`)
                return false
              }
              const draw = outcome.events.find((e) => e.event === "draw")?.data[0] ?? null
              yield* move(row, { step: confirm ? "settled" : "failed", draw })
              return false
            }
            default:
              return false
          }
        })

      // Workflows run in fibers owned by this service, not by the HTTP request:
      // a client that disconnects stops waiting, but never stops a purchase mid-step.
      const workflows = yield* FiberSet.make<void, never>()

      // ponytail: in-process guard, assumes one server process (ADR-0006); use row locks if it ever scales out.
      const running = new Set<string>()
      // A customer who left before the reconciler finished hears about it in Telegram (if linked).
      const notify = (row: Row) => {
        const what = `${row.voucher_name} ${row.package_value}`
        const text = row.step === "settled"
          ? `Your ${what} is ready. See the code at ${webOrigin}/purchases`
          : row.step === "failed"
          ? `Your ${what} couldn't be delivered. The full amount is back in your Luckout balance.`
          : row.step === "stuck"
          ? `Your ${what} needs a manual check by our team. We'll sort it out; you can also reclaim the full amount 24 hours after purchase.`
          : undefined
        return text ? alerts.customer(row.account_id, text) : Effect.void
      }

      const advance = (id: string, resumed: boolean) =>
        Effect.gen(function*() {
          if (running.has(id)) return
          running.add(id)
          let first = true
          while (yield* Effect.flatMap(load(id), (row) => step(row, resumed && first))) first = false
          if (resumed) yield* Effect.flatMap(load(id), notify)
        }).pipe(
          Effect.catch((e: Unknown) => Effect.logWarning(`purchase ${id} paused: ${e.message}`)),
          // Anything unexpected (database, decryption) pauses this purchase only; the reconciler retries it.
          Effect.catchCause((cause) => Effect.logError(`purchase ${id} paused`, cause)),
          Effect.ensuring(Effect.sync(() => running.delete(id))),
          // A deploy or shutdown waits for the run to finish: stopping between a side effect and
          // saving its result would leave the purchase for a human (pm2 kill_timeout allows for it).
          Effect.uninterruptible
        )

      // A row that fails to decrypt (key missing or rotated) must not break the whole list.
      const openRedemption = (row: Row) => {
        try {
          return { redemption: unseal(row.id, row.redemption!) }
        } catch {
          return {}
        }
      }

      const view = (row: Row): Purchase => {
        const status = row.step === "settled"
          ? "delivered"
          : row.step === "failed" || row.step === "rejected"
          ? row.step
          : "pending"
        const d = row.draw
        return new Purchase({
          id: row.id,
          voucherId: row.voucher_id,
          voucherName: row.voucher_name,
          value: row.package_value,
          status,
          // Rejections are the contract's own words (limits, balance); internal details stay in the database.
          ...(status === "rejected" && row.error ? { error: row.error } : {}),
          ...(status === "failed"
            ? {
              error: row.error === "Reclaimed"
                ? "You reclaimed the full amount after 24 hours."
                : "Bitrefill couldn't deliver this voucher. The full amount went back to your balance."
            }
            : {}),
          ...(row.step === "stuck" ? { error: "This purchase needs a manual check. If it isn't resolved, you can reclaim the full amount after 24 hours." } : {}),
          ...(row.admitted ? { mode: row.admitted.mode } : row.requested_mode ? { mode: row.requested_mode } : {}),
          referencePrice: Number(row.reference_price),
          ...(row.admitted
            ? { maxPrice: Number(row.admitted.max_price), luckyAmount: Number(row.admitted.lucky_amount) }
            : {}),
          ...(d
            ? {
              draw: new Draw({
                gameVersion: Number(d.game_version),
                seed: String(d.seed),
                random: String(d.random),
                roll: Number(d.roll),
                finalBps: Number(d.final_bps),
                finalPrice: Number(d.final_price),
                cashback: Number(d.cashback)
              })
            }
            : {}),
          ...(row.redemption && row.step === "settled" ? openRedemption(row) : {}),
          ...(row.admit_tx ? { admitTx: row.admit_tx.hash } : {}),
          ...(row.settle_tx ? { settleTx: row.settle_tx.hash } : {}),
          createdAt: new Date(row.created_at).toISOString()
        })
      }

      const price = (voucherId: string, value: string) =>
        Effect.gen(function*() {
          const voucher = yield* bitrefill.voucher(voucherId)
          const pkg = voucher.packages.find((p) => p.value === value)
          if (!pkg) return yield* new PurchaseInvalid({ message: `${voucher.name} has no ${value} package` })
          return { voucher, referencePrice: pkg.priceMicroUsdc }
        })

      const quote = Effect.fn("Purchases.quote")(function*(voucherId: string, value: string, game: number | undefined) {
        const { referencePrice } = yield* price(voucherId, value)
        const mode: Mode = game === undefined ? "normal" : { lucky: game }
        const q = yield* near.view<QuoteView>("quote", { reference_price: String(referencePrice), mode }).pipe(
          Effect.mapError((e) => new PurchaseInvalid({ message: e.message.includes("Reserve too small") ? "The reserve is too small for a Lucky Buy right now; use Normal" : e.message }))
        )
        return new Quote({
          mode: q.mode,
          referencePrice: Number(q.reference_price),
          luckyAmount: Number(q.lucky_amount),
          maxPrice: Number(q.max_price)
        })
      })

      // Checked before signing anything, so an empty or capped account can't make the operator pay
      // gas for purchases the contract would refuse. The contract still checks all of it.
      const preflight = Effect.fn("Purchases.preflight")(function*(accountId: string, referencePrice: number, maxPrice: number) {
        const invalid = (message: string) => new PurchaseInvalid({ message })
        const [open] = yield* sql<{ n: number }>`
          SELECT count(*)::int AS n FROM purchases WHERE account_id = ${accountId} AND step IN ${sql.in(OPEN_STEPS)}`.pipe(Effect.orDie)
        if ((open?.n ?? 0) >= MAX_OPEN_PER_ACCOUNT) return yield* invalid("You have purchases still in progress; try again when they finish")
        if (maxPrice < referencePrice) return yield* invalid("Price changed since you confirmed; please confirm again")
        const a = yield* near.view<ContractAccount | null>("get_account", { account_id: accountId }).pipe(
          Effect.mapError(() => invalid("Couldn't read your balance from NEAR; try again in a moment"))
        )
        if (!a) return yield* invalid("No balance yet; add funds first")
        if (Number(a.balance) < referencePrice) return yield* invalid("Insufficient balance; add funds first")
        if (Number(a.per_purchase_limit) < referencePrice) return yield* invalid("Over the per-purchase spending limit")
        const spent = a.day === Math.floor(Date.now() / DAY_MS) ? Number(a.spent_today) : 0
        if (spent + referencePrice > Number(a.daily_limit)) return yield* invalid("Over the daily spending limit")
      })

      const create = Effect.fn("Purchases.create")(function*(accountId: string, input: NewPurchase) {
        if (Option.isNone(key)) return yield* new PurchaseInvalid({ message: "Purchases are disabled: REDEMPTION_KEY is not set" })
        // Testnet balances are test money: never let them buy a real voucher paid from our real Bitrefill balance.
        if (testnet && !input.voucherId.startsWith("test-")) {
          return yield* new PurchaseInvalid({ message: "On testnet only Bitrefill test vouchers can be bought" })
        }
        // A retry with the same key returns the original purchase instead of buying again.
        const existing = yield* sql<{ id: string }>`SELECT id FROM purchases WHERE account_id = ${accountId} AND idempotency_key = ${input.idempotencyKey}`
          .pipe(Effect.orDie)
        if (existing[0]) return view(yield* load(existing[0].id))
        const { voucher, referencePrice } = yield* price(input.voucherId, input.value)
        yield* preflight(accountId, referencePrice, input.maxPrice)
        const inserted = yield* sql<{ id: string }>`
          INSERT INTO purchases (account_id, idempotency_key, voucher_id, voucher_name, package_value, requested_mode, reference_price, max_debit, step)
          VALUES (${accountId}, ${input.idempotencyKey}, ${voucher.id}, ${voucher.name}, ${input.value},
                  ${input.mode === undefined ? null : JSON.stringify(input.mode)}, ${referencePrice}, ${input.maxPrice}, 'admit')
          ON CONFLICT (account_id, idempotency_key) DO NOTHING
          RETURNING id`.pipe(Effect.orDie)
        // Two requests with the same key at once: the second returns the first's purchase.
        const id = inserted[0]?.id ??
          (yield* sql<{ id: string }>`SELECT id FROM purchases WHERE account_id = ${accountId} AND idempotency_key = ${input.idempotencyKey}`
            .pipe(Effect.orDie))[0]!.id
        if (inserted.length > 0) yield* Fiber.join(yield* FiberSet.run(workflows, advance(id, false)))
        return view(yield* load(id))
      })

      const list = (accountId: string) =>
        sql<Row>`SELECT * FROM purchases WHERE account_id = ${accountId} ORDER BY created_at DESC LIMIT 100`.pipe(
          Effect.map((rows) => rows.map(view)),
          Effect.orDie
        )

      const get = (accountId: string, id: string) =>
        sql<Row>`SELECT * FROM purchases WHERE id = ${id} AND account_id = ${accountId}`.pipe(
          Effect.orDie,
          Effect.flatMap((r) => (r[0] ? Effect.succeed(view(r[0])) : Effect.fail(new NotFound())))
        )

      const giveUp = (id: string) =>
        Effect.gen(function*() {
          const row = yield* load(id)
          if (!(yield* move(row, { step: "stuck", error: `Gave up after ${MAX_ATTEMPTS} attempts at ${row.step}: ${row.error ?? ""}` }))) return
          yield* alerts.admin(`purchase ${id} stuck after ${MAX_ATTEMPTS} attempts at ${row.step}`)
          yield* notify(yield* load(id))
        })

      // Reconciler: every 30 seconds, resume anything left part-way, each purchase with its own
      // backoff, so a few broken purchases can never starve newer ones.
      const reconcile = sql<{ id: string; attempts: number }>`
        UPDATE purchases SET attempts = attempts + 1,
          next_attempt_at = now() + LEAST(interval '1 hour', interval '30 seconds' * power(2, attempts))
        WHERE id IN (
          SELECT id FROM purchases
          WHERE step IN ${sql.in(OPEN_STEPS)} AND updated_at < now() - interval '30 seconds' AND next_attempt_at <= now()
          ORDER BY next_attempt_at LIMIT 20)
        RETURNING id, attempts`.pipe(
        Effect.orDie,
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (r) => (r.attempts > MAX_ATTEMPTS ? giveUp(r.id) : advance(r.id, true)), { discard: true, concurrency: 4 })
        ),
        // A failed pass (e.g. the database blinked) must never end the reconciler.
        Effect.catchCause((cause) => Effect.logError("reconcile pass failed", cause))
      )
      yield* reconcile.pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped)

      return Purchases.of({ quote, create, list, get })
    })
  )
}
