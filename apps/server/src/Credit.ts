import { CreditSettings } from "@luckout/api"
import { Context, Effect, Layer, Option, Ref, Schedule, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import { Alerts } from "./Alerts.ts"
import { Base } from "./Base.ts"
import { Bitrefill } from "./Bitrefill.ts"
import { Network } from "./Near.ts"
import { readSetting, writeSetting } from "./Settings.ts"

// Bitrefill credit (ADR-0009). Every real card is paid from our USD store credit, which can't be
// refunded, so we keep only what recent sales need. Bitrefill is asked for the balance every few
// minutes (its MCP endpoint allows 30 calls a minute per key; without a guest client the key also prices and
// buys, while with one, which mainnet requires, its MCP calls are only price lookups); in between,
// the estimate subtracts what we ordered since and what purchases in progress are about to order.
// One lock covers "is there credit for this card?" and recording the answer, so two purchases can
// never both count on the same dollars. Test cards are free and never touch any of this.

/** The smallest refill until an admin sets one (`CreditSettings.minRefill`): smaller ones cost relatively more. */
export const MIN_REFILL = 10_000_000
/** A swap tops the Base wallet up by at least this, so its fixed fees stay small; no refill may be set smaller. */
export const MIN_SWAP = 2_000_000
/** The smallest refill these settings allow. */
export const minRefillOf = (s: Pick<CreditSettings, "minRefill">) => s.minRefill ?? MIN_REFILL

/**
 * Until an admin changes them. Idle credit stays small (it can't be refunded); no order is refused
 * for its size: a big one waits, uncharged, for a refill sized for it, for up to a day.
 */
export const CREDIT_DEFAULTS = {
  mainnet: new CreditSettings({ autoRefill: true, floor: 10_000_000, ceiling: 30_000_000, dailyRefill: 300_000_000, waitMinutes: 1440, baseFloat: 50_000_000, minRefill: MIN_REFILL }),
  // Refills don't run on testnet, so neither does the float.
  testnet: new CreditSettings({ autoRefill: true, floor: 100_000_000, ceiling: 500_000_000, dailyRefill: 1_000_000_000, waitMinutes: 1440, baseFloat: 0, minRefill: MIN_REFILL })
} as const

/** Micro-USDC as dollars, for alerts and messages. */
export const usd = (micro: number | bigint) => `$${(Number(micro) / 1e6).toFixed(2)}`

/**
 * Steps after which a real card's price will soon leave the credit: it's being admitted, ordered, or (a guest
 * order, ADR-0012) paid from the Base Float. A payment is held until it's mined, and counts as spent from then
 * (`ordered_at`): the float only drops when the payment lands.
 */
const HELD_STEPS = ["admit", "ordering", "pay"]
/** Purchases waiting for credit: before being charged, or charged and waiting to be ordered. */
export const WAITING_STEPS = ["waiting", "restock"]
/** The Base Float has no cap of its own: a card it can't cover waits for a refill sized for it. */
const GUEST_ROOM = 1_000_000_000_000
/** A balance older than this is read again before deciding on a purchase. */
const STALE_MS = 10 * 60_000
/** USDC kept ready on Base (`CreditSettings.baseFloat`); 0 when off. */
export const floatOf = (s: Pick<CreditSettings, "baseFloat">) => s.baseFloat ?? 0
/** Days of sales the target covers: one when a Base float makes refills fast, else two. */
const targetDays = (s: Pick<CreditSettings, "baseFloat">) => (floatOf(s) > 0 ? 1 : 2)

/** Why settings are refused, or undefined when they hang together. */
export const settingsProblem = (s: CreditSettings) => {
  const min = minRefillOf(s)
  return s.floor > s.ceiling
    ? "The floor can't be above the ceiling."
    : min < MIN_SWAP
    ? `The smallest refill must be at least ${usd(MIN_SWAP)}, the smallest swap.`
    : s.dailyRefill < min
    ? `The daily refill limit must be at least ${usd(min)}, the smallest refill.`
    : (s.refillBelow ?? 0) > 0 && (s.refillBelow ?? 0) > s.floor - min
    ? `Refill when below must be at least ${usd(min)} under the amount refills top up to.`
    : undefined
}

/**
 * The credit to aim for, and the line below which a refill starts. The target covers two days of
 * sales (one with a Base float: Bitrefill credit can't be refunded, and refills then take a minute),
 * and the biggest card bought lately plus a refill's worth; the line never sits below that card or the
 * admin's own line, so cards of that size buy at once. Both stay within the floor and the ceiling, and
 * the line stays a refill's worth under the target.
 */
export const levels = (s: Pick<CreditSettings, "floor" | "ceiling" | "baseFloat" | "refillBelow" | "minRefill">, avgDaily: number, biggest: number) => {
  const min = minRefillOf(s)
  const target = Math.min(s.ceiling, Math.max(s.floor, targetDays(s) * avgDaily, biggest + min))
  const refillBelow = Math.max(Math.floor(target / 2), Math.min(Math.max(biggest, s.refillBelow ?? 0), target - min))
  return { target, refillBelow }
}

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
  /** The biggest real card ordered in the last 7 days. */
  readonly biggest: number
  /** The credit we aim to hold (see `levels`). */
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
   * Runs `f` holding the credit lock, with what's free to spend and when the balance behind it was
   * read. A purchase records whether it proceeds or waits inside `f`, so the next caller already
   * sees it. Unknown credit (Bitrefill unreachable) counts as plenty, read at no time: an order
   * Bitrefill then refuses for credit waits safely.
   */
  guard<A, E, R>(f: (free: number, readAt: Date | undefined) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
}>()("luckout/Credit") {
  static readonly layer = Layer.effect(
    Credit,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const bitrefill = yield* Bitrefill
      const base = yield* Base
      const alerts = yield* Alerts
      const network = yield* Network
      // Testnet sells only test cards, which are free: no credit to track, refill or alert on.
      const tracked = network === "mainnet"
      const lock = yield* Semaphore.make(1)
      const snapshot = yield* Ref.make<Snapshot | undefined>(undefined)

      const settings = readSetting("credit", CreditSettings, CREDIT_DEFAULTS[network]).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        // Settings saved before the float or the smallest refill existed get the defaults for them, keeping the rest.
        Effect.map((s) =>
          s.baseFloat === undefined || s.minRefill === undefined
            ? new CreditSettings({ ...s, baseFloat: s.baseFloat ?? CREDIT_DEFAULTS[network].baseFloat, minRefill: minRefillOf(s) })
            : s
        )
      )
      const configure = (next: CreditSettings, by: string) =>
        writeSetting("credit", CreditSettings, next, by).pipe(Effect.provideService(SqlClient.SqlClient, sql))

      // Real cards only: test cards are free on Bitrefill.
      const ledger = (since: Date) =>
        sql<{ held: string; ordered_since: string; in_flight: string; waiting: number; waiting_total: string; week: string; biggest: string; today: number }>`
          SELECT
            COALESCE(sum(reference_price) FILTER (WHERE step IN ${sql.in(HELD_STEPS)}), 0)::text AS held,
            COALESCE(sum(reference_price) FILTER (WHERE ordered_at > ${since}), 0)::text AS ordered_since,
            (SELECT COALESCE(sum(pay_amount), 0) FROM checkouts WHERE step = 'pay' AND pay_tx IS NOT NULL)::text AS in_flight,
            count(*) FILTER (WHERE step IN ${sql.in(WAITING_STEPS)})::int AS waiting,
            COALESCE(sum(reference_price) FILTER (WHERE step IN ${sql.in(WAITING_STEPS)}), 0)::text AS waiting_total,
            COALESCE(sum(reference_price) FILTER (WHERE ordered_at > now() - interval '7 days'), 0)::text AS week,
            COALESCE(max(reference_price) FILTER (WHERE ordered_at > now() - interval '7 days'), 0)::text AS biggest,
            count(*) FILTER (WHERE ordered_at > now() - interval '1 day')::int AS today
          FROM purchases WHERE voucher_id NOT LIKE 'test-%'`.pipe(
          Effect.map(([r]) => ({
            held: Number(r?.held ?? 0),
            orderedSince: Number(r?.ordered_since ?? 0),
            /** Base payments signed and not yet seen mined: each may already have left the float, or be about to. */
            inFlight: Number(r?.in_flight ?? 0),
            waiting: { count: r?.waiting ?? 0, total: Number(r?.waiting_total ?? 0) },
            week: Number(r?.week ?? 0),
            biggest: Number(r?.biggest ?? 0),
            today: r?.today ?? 0
          })),
          Effect.orDie
        )

      const refresh = Effect.gen(function*() {
        if (!tracked) return Option.none<Snapshot>()
        const readAt = new Date()
        // A guest's cards are paid from the Base Float, which holds whatever refills bring (ADR-0012).
        const source: Effect.Effect<{ readonly balance: number; readonly room: number }, unknown> = bitrefill.guest
          ? Effect.map(base.balances, (b) => ({ balance: b.usdc, room: GUEST_ROOM }))
          : bitrefill.credit
        const read = yield* source.pipe(Effect.timeout("15 seconds"), Effect.option)
        if (Option.isNone(read)) return Option.none<Snapshot>()
        const previous = yield* Ref.get(snapshot)
        const next: Snapshot = { balance: read.value.balance, room: read.value.room, readAt }
        // Credit only goes up when we refill; a drop our own orders don't explain means
        // someone else is spending it (or the API key, or the treasury's key, leaked).
        if (previous) {
          // A payment still on its way explains a drop of its size too: it may have landed just before this
          // read, before we saw it mined. (Counting it when it hasn't landed yet only makes the check more lenient.)
          const l = yield* ledger(previous.readAt)
          const unexplained = previous.balance - l.orderedSince - l.inFlight - next.balance
          if (unexplained > 1_000_000) {
            yield* alerts.admin(
              bitrefill.guest
                ? `The Base Float dropped ${usd(unexplained)} more than our payments explain. Check the Base Wallet for transfers we didn't make.`
                : `Bitrefill credit dropped ${usd(unexplained)} more than our orders explain. Check the Bitrefill account for purchases we didn't make.`
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
        return {
          settings: s,
          snapshot: snap,
          free: snap ? snap.balance - l.orderedSince - l.held : 0,
          held: l.held,
          waiting: l.waiting,
          avgDaily,
          biggest: l.biggest,
          ...levels(s, avgDaily, l.biggest),
          ordersToday: l.today
        } satisfies CreditView
      })

      const guard = <A, E, R>(f: (free: number, readAt: Date | undefined) => Effect.Effect<A, E, R>) =>
        lock.withPermits(1)(Effect.flatMap(current, (s) => Effect.flatMap(freeFrom(s), (free) => f(free, s?.readAt))))

      if (tracked) {
        yield* refresh.pipe(
          Effect.catchCause((cause) => Effect.as(Effect.logError("credit refresh failed", cause), Option.none())),
          Effect.repeat(Schedule.spaced("2 minutes")),
          Effect.forkScoped
        )
      }

      return Credit.of({ settings, configure, refresh, view, guard })
    })
  )
}
