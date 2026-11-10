import { Effect, Layer, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { Alerts } from "./Alerts.ts"
import { Near } from "./Near.ts"

const NEAR = 10n ** 24n
/** NEAR storage staking: 1e19 yoctoNEAR per byte. */
const PER_BYTE = 10n ** 19n

/** Below these, each of our accounts gets an alert (the admin panel shows the same lines). */
export const GAS_ALERT = { operator: NEAR / 2n, relayer: NEAR / 2n, treasury: NEAR / 10n, contract: NEAR } as const

/** NEAR an account can spend: its balance minus what its storage locks. */
export const spendable = (near: Near["Service"], id: string) =>
  near.account(id).pipe(Effect.map((a) => a.amount - BigInt(a.storageUsage) * PER_BYTE))

/**
 * Every 10 minutes, the things that quietly stop purchases if nobody notices.
 * ponytail: Bitrefill's USD float isn't checked (no API for the USD sub-account); add when one exists.
 */
export const Monitor = Layer.effectDiscard(
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const near = yield* Near
    const alerts = yield* Alerts

    const check = Effect.gen(function*() {
      if (near.operatorId && (yield* spendable(near, near.operatorId)) < GAS_ALERT.operator) {
        yield* alerts.admin(`operator ${near.operatorId} has under 0.5 NEAR left for gas`)
      }
      if (near.relayerId && (yield* spendable(near, near.relayerId)) < GAS_ALERT.relayer) {
        yield* alerts.admin(`relayer ${near.relayerId} has under 0.5 NEAR left; customers' wallets pay their own fees when it runs out`)
      }
      if (near.treasuryId && (yield* spendable(near, near.treasuryId)) < GAS_ALERT.treasury) {
        yield* alerts.admin(`treasury ${near.treasuryId} has under 0.1 NEAR left for gas; Bitrefill refills stop when it runs out`)
      }
      if ((yield* spendable(near, near.contractId)) < GAS_ALERT.contract) {
        yield* alerts.admin(`contract ${near.contractId} has under 1 NEAR free for storage; purchases fail when it runs out`)
      }
      const [r] = yield* sql<{ stuck: number; late: number }>`
        SELECT count(*) FILTER (WHERE step = 'stuck')::int AS stuck,
               count(*) FILTER (WHERE step IN ('admit', 'ordering', 'delivery', 'confirm', 'fail')
                                AND created_at < now() - interval '15 minutes')::int AS late
        FROM purchases`
      if (r && r.stuck > 0) yield* alerts.admin(`${r.stuck} purchase(s) stuck; see deploy/RUNBOOK.md`)
      if (r && r.late > 0) yield* alerts.admin(`${r.late} purchase(s) still unfinished after 15 minutes`)
    }).pipe(Effect.catchCause((cause) => Effect.logError("monitor check failed", cause)))

    yield* check.pipe(Effect.repeat(Schedule.spaced("10 minutes")), Effect.forkScoped)
  })
)
