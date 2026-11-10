import { CreditSettings } from "@luckout/api"
import { Context, Effect, Layer, Option, Ref, Schedule, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import { Alerts } from "./Alerts.ts"
import { Bitrefill } from "./Bitrefill.ts"
import { readSetting, writeSetting } from "./Settings.ts"

// Bitrefill credit (ADR-0009). Every real card is paid from our USD store credit, which can't be
// refunded, so we keep only what recent sales need. Bitrefill is asked for the balance every few
// minutes (its MCP endpoint allows 30 calls a minute, shared with prices and buys); in between,
// the estimate subtracts what we ordered since and what purchases in progress are about to order.
// One lock covers "is there credit for this card?" and recording the answer, so two purchases can
// never both count on the same dollars. Test cards are free and never touch any of this.

export const DEFAULT_CREDIT = new CreditSettings({
  autoRefill: true,
  floor: 100_000_000,
  ceiling: 500_000_000,
  maxOrder: 300_000_000,
  dailyRefill: 1_000_000_000,
  waitMinutes: 30
})

/** Steps after which a real card's price will soon leave the credit (it's being admitted or ordered). */
const HELD_STEPS = ["admit", "ordering"]
/** Purchases waiting for credit: before being charged, or charged and waiting to be ordered. */
export const WAITING_STEPS = ["waiting", "restock"]
/** A balance older than this is read again before deciding on a purchase. */
const STALE_MS = 10 * 60_000
/** Days of sales the target covers, and the refill line as a share of it. */
const TARGET_DAYS = 2

/** Why settings are refused, or undefined when they hang together. */
export const settingsProblem = (s: CreditSettings) =>
  s.floor > s.ceiling
    ? "The floor can't be above the ceiling."
    : s.maxOrder > s.ceiling
    ? "The largest order can't be above the ceiling: a refill could never cover it."
    : s.maxOrder < 500_000
    ? "The largest order must be at least $0.50, the smallest purchase."
    : undefined

export interface Snapshot {
  /** USD credit at Bitrefill, micro-USDC. */
  readonly balance: number
  /** How much more Bitrefill lets the account hold. */
  readonly room: number
  readonly readAt: Date
}

export interface CreditView {
  readonly settings: CreditSettings
  readonly snapshot: Snapshot | undefined
  /** What's left to spend right now, by our estimate. */
  readonly free: number
  /** Prices of real purchases being admitted or ordered right now. */
  readonly held: number
  readonly waiting: { readonly count: number; readonly total: number }
  /** Average real-card spend per day over the last 7 days. */
  readonly avgDaily: number
  /** The credit we aim to hold: two days of sales, between the floor and the ceiling. */
  readonly target: number
  /** Below this a refill starts. */
  readonly refillBelow: number
  /** Real cards ordered in the last 24 hours, against Bitrefill's daily purchase cap. */
  readonly ordersToday: number
}

export class Credit extends Context.Service<Credit, {
  readonly settings: Effect.Effect<CreditSettings>
  configure(settings: CreditSettings, by: string): Effect.Effect<CreditSettings>
  /** Reads the balance from Bitrefill now. */
  readonly refresh: Effect.Effect<Option.Option<Snapshot>>
  readonly view: Effect.Effect<CreditView>
  /**
   * Runs `f` holding the credit lock, with what's free to spend. A purchase records whether it
   * proceeds or waits inside `f`, so the next caller already sees it. Unknown credit (Bitrefill
   * unreachable) counts as plenty: an order Bitrefill then refuses for credit waits safely.
   */
  guard<A, E, R>(f: (free: number) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
}>()("luckout/Credit") {
  static readonly layer = Layer.effect(
    Credit,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const bitrefill = yield* Bitrefill
      const alerts = yield* Alerts
      const lock = yield* Semaphore.make(1)
      const snapshot = yield* Ref.make<Snapshot | undefined>(undefined)

      const settings = readSetting("credit", CreditSettings, DEFAULT_CREDIT).pipe(Effect.provideService(SqlClient.SqlClient, sql))
      const configure = (next: CreditSettings, by: string) =>
        writeSetting("credit", CreditSettings, next, by).pipe(Effect.provideService(SqlClient.SqlClient, sql))

      // Real cards only: test cards are free on Bitrefill.
      const ledger = (since: Date) =>
        sql<{ held: string; ordered_since: string; waiting: number; waiting_total: string; week: string; today: number }>`
          SELECT
            COALESCE(sum(reference_price) FILTER (WHERE step IN ${sql.in(HELD_STEPS)}), 0)::text AS held,
            COALESCE(sum(reference_price) FILTER (WHERE ordered_at > ${since}), 0)::text AS ordered_since,
            count(*) FILTER (WHERE step IN ${sql.in(WAITING_STEPS)})::int AS waiting,
            COALESCE(sum(reference_price) FILTER (WHERE step IN ${sql.in(WAITING_STEPS)}), 0)::text AS waiting_total,
            COALESCE(sum(reference_price) FILTER (WHERE ordered_at > now() - interval '7 days'), 0)::text AS week,
            count(*) FILTER (WHERE ordered_at > now() - interval '1 day')::int AS today
          FROM purchases WHERE voucher_id NOT LIKE 'test-%'`.pipe(
          Effect.map(([r]) => ({
            held: Number(r?.held ?? 0),
            orderedSince: Number(r?.ordered_since ?? 0),
            waiting: { count: r?.waiting ?? 0, total: Number(r?.waiting_total ?? 0) },
            week: Number(r?.week ?? 0),
            today: r?.today ?? 0
          })),
          Effect.orDie
        )

      const refresh = Effect.gen(function*() {
        const readAt = new Date()
        const read = yield* bitrefill.credit.pipe(Effect.timeout("15 seconds"), Effect.option)
        if (Option.isNone(read)) return Option.none<Snapshot>()
        const previous = yield* Ref.get(snapshot)
        const next: Snapshot = { balance: read.value.balance, room: read.value.room, readAt }
        // Credit only goes up when we refill; a drop our own orders don't explain means
        // someone else is spending it (or the API key leaked).
        if (previous) {
          const orderedBetween = (yield* ledger(previous.readAt)).orderedSince
          const unexplained = previous.balance - orderedBetween - next.balance
          if (unexplained > 1_000_000) {
            yield* alerts.admin(
              `Bitrefill credit dropped $${(unexplained / 1e6).toFixed(2)} more than our orders explain. Check the Bitrefill account for purchases we didn't make.`
            )
          }
        }
        yield* Ref.set(snapshot, next)
        return Option.some(next)
      })

      const freeFrom = (s: Snapshot | undefined) =>
        Effect.gen(function*() {
          if (!s) return Number.POSITIVE_INFINITY
          const l = yield* ledger(s.readAt)
          return s.balance - l.orderedSince - l.held
        })

      const current = Effect.gen(function*() {
        const s = yield* Ref.get(snapshot)
        if (s && Date.now() - s.readAt.getTime() < STALE_MS) return s
        return Option.getOrUndefined(yield* refresh)
      })

      const view = Effect.gen(function*() {
        const s = yield* settings
        const snap = yield* Ref.get(snapshot)
        const l = yield* ledger(snap?.readAt ?? new Date(0))
        const avgDaily = Math.ceil(l.week / 7)
        const target = Math.min(s.ceiling, Math.max(s.floor, TARGET_DAYS * avgDaily))
        return {
          settings: s,
          snapshot: snap,
          free: snap ? snap.balance - l.orderedSince - l.held : 0,
          held: l.held,
          waiting: l.waiting,
          avgDaily,
          target,
          refillBelow: Math.floor(target / 2),
          ordersToday: l.today
        } satisfies CreditView
      })

      const guard = <A, E, R>(f: (free: number) => Effect.Effect<A, E, R>) =>
        lock.withPermits(1)(Effect.flatMap(Effect.flatMap(current, freeFrom), f))

      yield* refresh.pipe(
        Effect.catchCause((cause) => Effect.as(Effect.logError("credit refresh failed", cause), Option.none())),
        Effect.repeat(Schedule.spaced("2 minutes")),
        Effect.forkScoped
      )

      return Credit.of({ settings, configure, refresh, view, guard })
    })
  )
}
