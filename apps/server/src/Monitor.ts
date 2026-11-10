import { Effect, Layer, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { Alerts } from "./Alerts.ts"
import { Base } from "./Base.ts"
import { Near, Network } from "./Near.ts"

const NEAR = 10n ** 24n
/** NEAR storage staking: 1e19 yoctoNEAR per byte. */
const PER_BYTE = 10n ** 19n

/** Below these, each of our accounts gets an alert (the admin panel shows the same lines). */
export const GAS_ALERT = { operator: NEAR / 2n, relayer: NEAR / 2n, treasury: NEAR / 10n, contract: NEAR } as const
/** The Base wallet's ETH (wei): about 150 Bitrefill payments' worth of gas. */
export const BASE_GAS_ALERT = 100_000_000_000_000n // 0.0001 ETH

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
    const base = yield* Base
    // Refills, and so the Base wallet's gas, only matter where refills run.
    const refills = (yield* Network) === "mainnet"
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
      // The contract owes customers' balances, the reserve and the proceeds. Customer balances aren't summed
      // onchain, so what it holds must at least cover the other two; below that, customers' money is gone
      // (a bug or an attack). The admin panel shows the customers' share.
      const [held, owed] = yield* Effect.all([
        near.view<string>("ft_balance_of", { account_id: near.contractId }, near.usdcId),
        near.view<{ free: string; locked: string; proceeds: string }>("get_reserve")
      ])
      const house = BigInt(owed.free) + BigInt(owed.locked) + BigInt(owed.proceeds)
      if (BigInt(held) < house) {
        yield* alerts.admin(`contract ${near.contractId} holds ${Number(held) / 1e6} USDC, less than its reserve and proceeds alone (${Number(house) / 1e6}). Pause the contract and investigate now.`)
      }
      if (refills && base.configured) {
        // A Base RPC hiccup only skips this check.
        const w = yield* Effect.all([base.address, base.balances]).pipe(Effect.orElseSucceed(() => undefined))
        if (w && w[1].eth < BASE_GAS_ALERT) {
          yield* alerts.admin(`the Base wallet ${w[0]} has under 0.0001 ETH left for gas; Bitrefill refills stop when it runs out (send about $1 of ETH on Base)`)
        }
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
