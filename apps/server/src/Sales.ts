import { ShopStatus } from "@luckout/api"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Alerts } from "./Alerts.ts"
import { Bitrefill, ORDERS_PER_DAY, type OrderRoom } from "./Bitrefill.ts"
import { Near } from "./Near.ts"
import { readSetting, writeSetting } from "./Settings.ts"

// Whether new purchases may start. Three things stop them:
// - "stopped": any admin, on the server, at once (Admin → Stop sales). For incidents.
// - "paused": the contract's own pause, which only the owner's wallet can set. The hard stop.
// - "limit": Bitrefill's orders for the last 24 hours are used up; it reopens on its own.
// Purchases already in progress finish either way, and customers can always withdraw.

export const CLOSED_MESSAGE = "Purchases are paused for a few minutes. Your balance is safe; try again soon."

/** "2 h 14 min", "14 min": how long until `at`. */
const inAbout = (at: number) => {
  const minutes = Math.max(1, Math.ceil((at - Date.now()) / 60_000))
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}
/** What a customer is told when a purchase can't start. */
export const closedMessage = (s: ShopStatus) =>
  s.reason === "limit" && s.reopensAt
    ? `We've hit Bitrefill's daily order limit. Back in ${inAbout(s.reopensAt)}; your balance is safe.`
    : CLOSED_MESSAGE

const SalesSetting = Schema.Struct({ open: Schema.Boolean })
const OPEN = { open: true }
/** The contract's pause is read at most this often. */
const PAUSE_TTL_MS = 15_000
/** Admins hear once when only this many of Bitrefill's daily orders are left. */
const FEW_LEFT = 3

export class Sales extends Context.Service<Sales, {
  readonly status: Effect.Effect<ShopStatus>
  setOpen(open: boolean, by: string): Effect.Effect<ShopStatus>
}>()("luckout/Sales") {
  static readonly layer = Layer.effect(
    Sales,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const near = yield* Near
      const bitrefill = yield* Bitrefill
      const alerts = yield* Alerts
      let paused = { value: false, at: 0 }

      const contractPaused = Effect.suspend(() =>
        Date.now() - paused.at < PAUSE_TTL_MS
          ? Effect.succeed(paused.value)
          : near.view<{ paused: boolean }>("get_config").pipe(
            Effect.map((c) => {
              paused = { value: c.paused, at: Date.now() }
              return c.paused
            }),
            // Unreadable: assume not paused; the contract refuses a paused admission anyway.
            Effect.orElseSucceed(() => paused.value)
          )
      )

      // Purchases admitted but not yet ordered take a slot too, so two buyers can't both take the last one.
      const inFlight = sql<{ n: number }>`SELECT count(*)::int AS n FROM purchases WHERE step IN ('admit', 'ordering')`.pipe(
        Effect.map((r) => r[0]?.n ?? 0),
        Effect.orDie
      )

      // ponytail: in memory, one process; a restart may repeat an alert.
      let told = 0
      /** Tells admins when the orders run low (1) and when they run out (2), once each until there's room again. */
      const watch = (room: OrderRoom) => {
        const level = room.reopensAt !== undefined ? 2 : room.used >= ORDERS_PER_DAY - FEW_LEFT ? 1 : 0
        const was = told
        told = level
        if (level <= was) return Effect.void
        return Effect.asVoid(alerts.admin(
          level === 2
            ? `Bitrefill's daily order limit is reached: the shop reopens at ${new Date(room.reopensAt!).toISOString().slice(11, 16)} UTC.`
            : `Bitrefill orders: ${room.used} of ${ORDERS_PER_DAY} used in the last 24 hours.`
        ))
      }

      const status = Effect.gen(function*() {
        const setting = yield* readSetting("sales", SalesSetting, OPEN).pipe(Effect.provideService(SqlClient.SqlClient, sql))
        if (!setting.open) return new ShopStatus({ open: false, reason: "stopped" })
        if (yield* contractPaused) return new ShopStatus({ open: false, reason: "paused" })
        // Unreadable: assume there's room; Bitrefill refuses an order past its limit anyway (and it's refunded).
        const room = yield* bitrefill.orderLimit(yield* inFlight)
        if (room) yield* watch(room)
        if (room?.reopensAt !== undefined) return new ShopStatus({ open: false, reason: "limit", reopensAt: room.reopensAt })
        return new ShopStatus({ open: true })
      })

      const setOpen = (open: boolean, by: string) =>
        Effect.gen(function*() {
          yield* writeSetting("sales", SalesSetting, { open }, by).pipe(Effect.provideService(SqlClient.SqlClient, sql))
          yield* alerts.admin(open ? `${by} restarted sales` : `${by} stopped sales: no new purchases until restarted`)
          return yield* status
        })

      return Sales.of({ status, setOpen })
    })
  )
}
