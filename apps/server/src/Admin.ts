import { AdminOverview, AttentionPurchase, PurchaseInvalid, type RelaySettings } from "@luckout/api"
import { Config, Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { Alerts } from "./Alerts.ts"
import { Bitrefill } from "./Bitrefill.ts"
import { GAS_ALERT, spendable } from "./Monitor.ts"
import { Near, Network } from "./Near.ts"
import { OPEN_STEPS } from "./Purchases.ts"
import { Relay } from "./Relay.ts"

// The admin panel's server side. Only accounts in ADMIN_ACCOUNTS get anything; everyone else is
// told the page doesn't exist. Nothing here moves money: reserve, proceeds, pausing and gas are
// transactions the admin signs in their own wallet, and the contract checks the owner itself.

/** Bitrefill's purchase cap on our account, per day across all products (deploy/RUNBOOK.md). */
const BITREFILL_DAILY_CAP = 15
/** A purchase that gave up at a step NEAR can safely repeat: confirm and fail are idempotent onchain. */
const GAVE_UP_AT = /^Gave up after \d+ attempts at (confirm|fail):/

interface Row {
  id: string
  account_id: string
  voucher_name: string
  package_value: string
  step: string
  error: string | null
  attempts: number
  created_at: Date | string
}

const retryStep = (r: Pick<Row, "step" | "error">) =>
  OPEN_STEPS.includes(r.step) ? r.step : r.step === "stuck" ? GAVE_UP_AT.exec(r.error ?? "")?.[1] : undefined

export class Admin extends Context.Service<Admin, {
  isAdmin(accountId: string): boolean
  readonly overview: Effect.Effect<AdminOverview>
  configureRelay(settings: RelaySettings, by: string): Effect.Effect<RelaySettings>
  /** Runs a purchase's next step now instead of after its backoff. Never re-buys or re-charges. */
  retry(id: string, by: string): Effect.Effect<void, PurchaseInvalid>
}>()("luckout/Admin") {
  static readonly layer = Layer.effect(
    Admin,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const near = yield* Near
      const relay = yield* Relay
      const bitrefill = yield* Bitrefill
      const alerts = yield* Alerts
      const network = yield* Network
      const admins = new Set(
        (yield* Config.String("ADMIN_ACCOUNTS").pipe(Config.withDefault(""))).split(",").map((a) => a.trim()).filter(Boolean)
      )

      const overview = Effect.gen(function*() {
        const gasOf = (role: keyof typeof GAS_ALERT, accountId: string | undefined) =>
          accountId
            ? spendable(near, accountId).pipe(Effect.map((s) => [{ role, accountId, spendable: String(s), alertBelow: String(GAS_ALERT[role]) }]))
            : Effect.succeed([])
        const [config, reserve, stats, gas, settings, relays, top, purchases, attention, bitrefillUsd] = yield* Effect.all([
          near.view<{ owner: string; operator: string; usdc: string; paused: boolean; max_cashback: string }>("get_config"),
          near.view<{ free: string; locked: string; discount_cap: string; proceeds: string }>("get_reserve"),
          near.view<{ lucky_settled: number; lucky_amount_total: string; lucky_paid_total: string }>("get_stats"),
          Effect.all([gasOf("operator", near.operatorId), gasOf("relayer", near.relayerId), gasOf("contract", near.contractId)]).pipe(
            Effect.map((g) => g.flat())
          ),
          relay.settings,
          sql<{ n: number }>`SELECT count(*)::int AS n FROM relays WHERE created_at > now() - interval '1 day'`,
          sql<{ account_id: string; n: number }>`
            SELECT account_id, count(*)::int AS n FROM relays WHERE created_at > now() - interval '1 day'
            GROUP BY account_id ORDER BY n DESC LIMIT 5`,
          sql<{ today: number; delivered: number; ordered: number }>`
            SELECT count(*)::int AS today,
                   count(*) FILTER (WHERE step = 'settled')::int AS delivered,
                   count(*) FILTER (WHERE invoice_id IS NOT NULL)::int AS ordered
            FROM purchases WHERE created_at > now() - interval '1 day'`,
          sql<Row>`
            SELECT id, account_id, voucher_name, package_value, step, error, attempts, created_at FROM purchases
            WHERE step = 'stuck' OR (step IN ${sql.in(OPEN_STEPS)} AND created_at < now() - interval '15 minutes')
            ORDER BY created_at DESC LIMIT 20`,
          bitrefill.usdBalance.pipe(Effect.timeout("10 seconds"), Effect.option)
        ], { concurrency: "unbounded" })
        const p = purchases[0] ?? { today: 0, delivered: 0, ordered: 0 }
        return new AdminOverview({
          network,
          contract: { id: near.contractId, owner: config.owner, operator: config.operator, usdc: config.usdc, paused: config.paused },
          reserve: {
            free: Number(reserve.free),
            locked: Number(reserve.locked),
            discountCap: Number(reserve.discount_cap),
            proceeds: Number(reserve.proceeds),
            maxCashback: Number(config.max_cashback)
          },
          stats: { luckySettled: stats.lucky_settled, luckyAmountTotal: Number(stats.lucky_amount_total), luckyPaidTotal: Number(stats.lucky_paid_total) },
          gas,
          relay: {
            configured: near.relayerId !== undefined,
            settings,
            usedToday: relays[0]?.n ?? 0,
            topAccounts: top.map((t) => ({ accountId: t.account_id, count: t.n }))
          },
          purchases: {
            today: p.today,
            deliveredToday: p.delivered,
            bitrefillOrders: p.ordered,
            bitrefillCap: BITREFILL_DAILY_CAP,
            attention: attention.map((r) =>
              new AttentionPurchase({
                id: r.id,
                accountId: r.account_id,
                voucherName: r.voucher_name,
                value: r.package_value,
                step: r.step,
                ...(r.error ? { error: r.error } : {}),
                attempts: r.attempts,
                createdAt: new Date(r.created_at).toISOString(),
                retryable: retryStep(r) !== undefined
              })
            )
          },
          ...(Option.isSome(bitrefillUsd) ? { bitrefillUsd: bitrefillUsd.value } : {})
        })
      }).pipe(Effect.orDie)

      const configureRelay = (settings: RelaySettings, by: string) =>
        relay.configure(settings, by).pipe(
          Effect.tap((s) =>
            alerts.admin(
              `${by} set the relayer ${s.enabled ? "on" : "off"}: ${s.perAccountDaily} free per account, ${s.allDaily} in all per day`
            )
          )
        )

      const retry = (id: string, by: string) =>
        Effect.gen(function*() {
          const [row] = yield* sql<Pick<Row, "step" | "error">>`SELECT step, error FROM purchases WHERE id = ${id}`
          if (!row) return yield* new PurchaseInvalid({ message: "No such purchase." })
          const step = retryStep(row)
          if (!step) return yield* new PurchaseInvalid({ message: "This one needs a manual check. See deploy/RUNBOOK.md." })
          // updated_at in the past lets the reconciler pick it up on its next pass (it skips rows touched in the last 30s).
          yield* sql`UPDATE purchases SET step = ${step}, error = NULL, attempts = 0, next_attempt_at = now(), updated_at = now() - interval '1 minute'
                     WHERE id = ${id} AND step = ${row.step}`
          yield* Effect.log(`admin ${by} retried purchase ${id} at ${step}`)
        }).pipe(Effect.catchTag("SqlError", Effect.die))

      return Admin.of({ isAdmin: (a) => admins.has(a), overview, configureRelay, retry })
    })
  )
}
