import { BitrefillUnavailable, Draw, type Mode, NewPurchase, NotFound, Purchase, PurchaseInvalid, Quote } from "@luckout/api"
import { Config, Context, Effect, Fiber, FiberSet, Layer, Option, Redacted, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { Bitrefill } from "./Bitrefill.ts"
import { ContractRejected, Near, NearUnavailable, type Outcome, type Signed, TxExpired } from "./Near.ts"

// A purchase walks these steps (ADR-0001). Every step is saved before its side effect,
// so after a crash the reconciler resumes it without buying or charging twice:
//   admit → ordering → delivery → confirm → settled
//                    ↘ fail → failed          (admit refused → rejected)
// "ordering" found by the reconciler means we may have paid Bitrefill without saving the
// invoice id; it becomes "stuck" for a human, and the customer can still Reclaim after 24h.
type Step = "admit" | "ordering" | "delivery" | "confirm" | "fail" | "settled" | "failed" | "rejected" | "stuck"

interface Row {
  id: string
  account_id: string
  voucher_id: string
  voucher_name: string
  package_value: string
  requested_mode: Mode | null
  reference_price: number | string | bigint
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
      const keyHex = yield* Config.option(Config.Redacted("REDEMPTION_KEY"))
      const testnet = (yield* Config.String("NEAR_NETWORK").pipe(Config.withDefault("testnet"))) === "testnet"
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
              const outcome = yield* submit(row, "admit_tx", "purchase", {
                customer: row.account_id,
                reference_price: String(row.reference_price),
                mode: row.requested_mode
              }).pipe(Effect.catchTag("ContractRejected", (e: ContractRejected) => Effect.succeed(e)))
              if (outcome instanceof ContractRejected) {
                yield* save(row.id, { step: "rejected", error: outcome.message })
                return false
              }
              const admitted = outcome.events.find((e) => e.event === "purchase")?.data[0]?.purchase
              yield* save(row.id, {
                step: "ordering",
                contract_purchase_id: Number(outcome.value),
                admitted
              })
              return true
            }
            case "ordering": {
              if (resumed) {
                yield* save(row.id, { step: "stuck", error: "Bitrefill order outcome unknown; check the Bitrefill account" })
                yield* Effect.logError("purchase stuck at ordering", row.id)
                return false
              }
              const order = yield* bitrefill.order(row.voucher_id, row.package_value)
              yield* order._tag === "Ordered"
                ? save(row.id, { step: "delivery", invoice_id: order.invoiceId })
                : save(row.id, { step: "fail", error: `Bitrefill refused: ${order.reason}` })
              return true
            }
            case "delivery": {
              const d = yield* bitrefill.delivery(row.invoice_id!)
              yield* d._tag === "Delivered"
                ? save(row.id, { step: "confirm", redemption: seal(row.id, d.redemption) })
                : save(row.id, { step: "fail", error: d.reason })
              return true
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
                // Already closed onchain (e.g. the customer reclaimed it after 24 hours).
                yield* Effect.logError("settlement refused", row.id, outcome.message)
                yield* save(row.id, { step: confirm ? "stuck" : "failed", error: outcome.message })
                return false
              }
              const draw = outcome.events.find((e) => e.event === "draw")?.data[0] ?? null
              yield* save(row.id, { step: confirm ? "settled" : "failed", draw })
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
      const advance = (id: string, resumed: boolean) =>
        Effect.gen(function*() {
          if (running.has(id)) return
          running.add(id)
          let first = true
          while (yield* Effect.flatMap(load(id), (row) => step(row, resumed && first))) first = false
        }).pipe(
          Effect.catch((e: Unknown) => Effect.logWarning(`purchase ${id} paused: ${e.message}`)),
          Effect.ensuring(Effect.sync(() => running.delete(id)))
        )

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
          ...(status === "failed" ? { error: "Bitrefill couldn't deliver this voucher. The full amount went back to your balance." } : {}),
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
                refund: Number(d.refund)
              })
            }
            : {}),
          ...(row.redemption && row.step === "settled" ? { redemption: unseal(row.id, row.redemption) } : {}),
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

      const create = Effect.fn("Purchases.create")(function*(accountId: string, input: NewPurchase) {
        if (Option.isNone(key)) return yield* new PurchaseInvalid({ message: "Purchases are disabled: REDEMPTION_KEY is not set" })
        // Testnet balances are test money: never let them buy a real voucher paid from our real Bitrefill balance.
        if (testnet && !input.voucherId.startsWith("test-")) {
          return yield* new PurchaseInvalid({ message: "On testnet only Bitrefill test vouchers can be bought" })
        }
        const { voucher, referencePrice } = yield* price(input.voucherId, input.value)
        const inserted = yield* sql<{ id: string }>`
          INSERT INTO purchases (account_id, idempotency_key, voucher_id, voucher_name, package_value, requested_mode, reference_price, step)
          VALUES (${accountId}, ${input.idempotencyKey}, ${voucher.id}, ${voucher.name}, ${input.value},
                  ${input.mode === undefined ? null : JSON.stringify(input.mode)}, ${referencePrice}, 'admit')
          ON CONFLICT (account_id, idempotency_key) DO NOTHING
          RETURNING id`.pipe(Effect.orDie)
        // A retry with the same key returns the original purchase instead of buying again.
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

      // Reconciler: every 30 seconds, resume anything left part-way for over 30 seconds.
      const reconcile = sql<{ id: string }>`
        SELECT id FROM purchases
        WHERE step IN ('admit', 'ordering', 'delivery', 'confirm', 'fail') AND updated_at < now() - interval '30 seconds'
        ORDER BY created_at LIMIT 50`.pipe(
        Effect.orDie,
        Effect.flatMap((rows) => Effect.forEach(rows, (r) => advance(r.id, true), { discard: true }))
      )
      yield* reconcile.pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped)

      return Purchases.of({ quote, create, list, get })
    })
  )
}
