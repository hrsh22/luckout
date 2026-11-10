import { ShopStatus } from "@luckout/api"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Alerts } from "./Alerts.ts"
import { Near } from "./Near.ts"
import { readSetting, writeSetting } from "./Settings.ts"

// Whether new purchases may start. Two switches stop them:
// - "stopped": any admin, on the server, at once (Admin → Stop sales). For incidents.
// - "paused": the contract's own pause, which only the owner's wallet can set. The hard stop.
// Purchases already in progress finish either way, and customers can always withdraw.

export const CLOSED_MESSAGE = "Purchases are paused for a few minutes. Your balance is safe; try again soon."

const SalesSetting = Schema.Struct({ open: Schema.Boolean })
const OPEN = { open: true }
/** The contract's pause is read at most this often. */
const PAUSE_TTL_MS = 15_000

export class Sales extends Context.Service<Sales, {
  readonly status: Effect.Effect<ShopStatus>
  setOpen(open: boolean, by: string): Effect.Effect<ShopStatus>
}>()("luckout/Sales") {
  static readonly layer = Layer.effect(
    Sales,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const near = yield* Near
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

      const status = Effect.gen(function*() {
        const setting = yield* readSetting("sales", SalesSetting, OPEN).pipe(Effect.provideService(SqlClient.SqlClient, sql))
        if (!setting.open) return new ShopStatus({ open: false, reason: "stopped" })
        if (yield* contractPaused) return new ShopStatus({ open: false, reason: "paused" })
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
