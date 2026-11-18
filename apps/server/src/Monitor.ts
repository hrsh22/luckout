import { Config, Effect, Layer, Option, Schedule, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Alerts } from "./Alerts.ts"
import { Base } from "./Base.ts"
import { Near, Network, OPERATOR_GAS, RELAY_GAS, TREASURY_GAS, upfront } from "./Near.ts"
import { OPEN_STEPS } from "./Purchases.ts"

const NEAR = 10n ** 24n
/** NEAR storage staking: 1e19 yoctoNEAR per byte. */
const PER_BYTE = 10n ** 19n

/**
 * Below these, each of our accounts gets an alert (the admin panel shows the same lines). Production
 * keeps the full lines; staging runs on a fifth of the NEAR, so it sets GAS_ALERT_PERCENT=20.
 */
const PERCENT = BigInt(process.env.GAS_ALERT_PERCENT || 100)
/** Never under what the account's heaviest call needs up front, and a quarter more: the alert comes before NEAR refuses one. */
const covering = (line: bigint, gas: bigint) => (line > upfront(gas) * 5n / 4n ? line : upfront(gas) * 5n / 4n)
export const GAS_ALERT = {
  operator: covering(NEAR * PERCENT / 200n, OPERATOR_GAS),
  relayer: covering(NEAR * PERCENT / 200n, RELAY_GAS),
  treasury: covering(NEAR * PERCENT / 1000n, TREASURY_GAS),
  contract: NEAR * PERCENT / 100n
} as const
const nearText = (yocto: bigint) => `${Number(yocto / 10n ** 20n) / 1e4} NEAR`
/** The Base wallet's ETH (wei): about 150 Bitrefill payments' worth of gas. */
export const BASE_GAS_ALERT = 100_000_000_000_000n // 0.0001 ETH
/** Accounts the contract isn't known to hold money for that the solvency check asks about each round, in turn. */
const UNSEEN_PER_ROUND = 50

/** NEAR an account can spend: its balance minus what its storage locks. */
export const spendable = (near: Near["Service"], id: string) =>
  near.account(id).pipe(Effect.map((a) => a.amount - BigInt(a.storageUsage) * PER_BYTE))

/** How long before the Bitrefill client secret lapses the admin starts hearing about it. */
const SECRET_WARNING_MS = 14 * 24 * 60 * 60_000

/**
 * What to tell the admin about our Bitrefill client's secret, if anything. `expiresAt` is the
 * `client_secret_expires_at` Bitrefill returned when the client was registered: seconds since 1970,
 * or 0 for a secret that never expires. Once it lapses no guest login works, so no card can be bought.
 */
export const secretWarning = (expiresAt: number, now: number) => {
  if (expiresAt === 0) return undefined
  const left = expiresAt * 1000 - now
  if (left > SECRET_WARNING_MS) return undefined
  const day = new Date(expiresAt * 1000).toISOString().slice(0, 10)
  return left <= 0
    ? `the Bitrefill client secret expired on ${day}: guest checkout and Connect Bitrefill are down until a new client is registered (deploy/README.md)`
    : `the Bitrefill client secret expires on ${day}, in ${Math.ceil(left / 86_400_000)} day(s): register a new client before then (deploy/README.md), or cards stop being sold`
}

/**
 * Every 10 minutes, the things that quietly stop purchases if nobody notices. Bitrefill's USD credit
 * isn't checked here: Credit.ts reads it every two minutes (and alerts on unexplained drops), and
 * Refill.ts tops it up or says why it can't.
 */
export const Monitor = Layer.effectDiscard(
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const near = yield* Near
    const base = yield* Base
    // Refills, and so the Base wallet's gas, only matter where refills run.
    const refills = (yield* Network) === "mainnet"
    const alerts = yield* Alerts

    // Each check stands alone: one that fails (say, a NEAR view that times out) is logged, and the rest still run.
    const section = <E>(name: string, body: Effect.Effect<void, E>) =>
      body.pipe(Effect.catchCause((cause) => Effect.logError(`monitor: the ${name} check failed`, cause)))

    // Reads only our database, so it runs first: a NEAR outage is exactly when purchases stall.
    const purchases = Effect.gen(function*() {
      const [r] = yield* sql<{ stuck: number; late: number }>`
        SELECT count(*) FILTER (WHERE step = 'stuck')::int AS stuck,
               count(*) FILTER (WHERE step IN ${sql.in(OPEN_STEPS)} AND created_at < now() - interval '15 minutes')::int AS late
        FROM purchases`
      if (r && r.stuck > 0) yield* alerts.admin(`${r.stuck} purchase(s) stuck; see deploy/RUNBOOK.md`)
      if (r && r.late > 0) yield* alerts.admin(`${r.late} purchase(s) still unfinished after 15 minutes`)
    })

    const gas = Effect.gen(function*() {
      if (near.operatorId && (yield* spendable(near, near.operatorId)) < GAS_ALERT.operator) {
        yield* alerts.admin(`operator ${near.operatorId} has under ${nearText(GAS_ALERT.operator)} left for gas`)
      }
      if (near.relayerId && (yield* spendable(near, near.relayerId)) < GAS_ALERT.relayer) {
        yield* alerts.admin(`relayer ${near.relayerId} has under ${nearText(GAS_ALERT.relayer)} left; NEAR wallets then pay their own fees, and EVM wallets' top-ups, withdrawals and settings wait until it has more`)
      }
      if (near.treasuryId && (yield* spendable(near, near.treasuryId)) < GAS_ALERT.treasury) {
        yield* alerts.admin(`treasury ${near.treasuryId} has under ${nearText(GAS_ALERT.treasury)} left for gas; refills and Base payments to Bitrefill stop when it runs out`)
      }
      if ((yield* spendable(near, near.contractId)) < GAS_ALERT.contract) {
        yield* alerts.admin(`contract ${near.contractId} has under ${nearText(GAS_ALERT.contract)} free for storage; purchases fail when it runs out`)
      }
    })

    // The contract owes customers' balances, the reserve and the proceeds, and must hold at least that much;
    // below it, customers' money is gone (a bug or an attack). Balances aren't summed onchain, so this sums
    // every account we know of (Db: known_accounts). Missing ones only make the debt look smaller, never a
    // false alarm. (A Draw in flight holds its premium in no bucket for a block: also never a false alarm.)
    // ponytail: one view per account the contract knows every 10 minutes; batch or add an onchain total when there are thousands.
    const solvency = Effect.gen(function*() {
      const [held, owed, known] = yield* Effect.all([
        near.view<string>("ft_balance_of", { account_id: near.contractId }, near.usdcId),
        near.view<{ free: string; locked: string; proceeds: string }>("get_reserve"),
        // Signing in is free, so not every account that ever did is read every round: those the contract has been
        // seen to know, or that bought or were relayed, always are; the rest take turns, a few a round.
        sql<{ account_id: string }>`
          SELECT account_id FROM known_accounts
          WHERE onchain
             OR account_id IN (SELECT account_id FROM purchases UNION SELECT account_id FROM relays)
             OR account_id IN (SELECT account_id FROM known_accounts WHERE NOT onchain ORDER BY coalesce(checked_at, first_seen) LIMIT ${UNSEEN_PER_ROUND})`
          .pipe(Effect.orDie)
      ])
      const house = BigInt(owed.free) + BigInt(owed.locked) + BigInt(owed.proceeds)
      const each = yield* Effect.forEach(known, ({ account_id }) =>
        near.view<{ balance: string } | null>("get_account", { account_id }).pipe(
          // Checked only once read, so one whose read fails keeps its turn. The contract knows it: from now on it's read every round.
          Effect.tap((a) => sql`UPDATE known_accounts SET checked_at = now(), onchain = onchain OR ${a !== null} WHERE account_id = ${account_id}`.pipe(Effect.orDie)),
          Effect.map((a) => BigInt(a?.balance ?? 0))
        ), { concurrency: 4 })
      const balances = each.reduce((sum, b) => sum + b, 0n)
      if (BigInt(held) < house + balances) {
        yield* alerts.admin(
          `contract ${near.contractId} holds ${Number(held) / 1e6} USDC, less than it owes: reserve and proceeds ${Number(house) / 1e6} plus ` +
            `customers' balances ${Number(balances) / 1e6}. Pause the contract and investigate now.`
        )
      }
    })

    const baseGas = Effect.gen(function*() {
      if (!refills || !base.configured) return
      // A Base RPC hiccup only skips this check.
      const w = yield* Effect.all([base.address, base.balances]).pipe(Effect.orElseSucceed(() => undefined))
      if (w && w[1].eth < BASE_GAS_ALERT) {
        yield* alerts.admin(`the Base wallet ${w[0]} has under 0.0001 ETH left for gas; Base payments to Bitrefill stop when it runs out (send about $1 of ETH on Base)`)
      }
    })

    const check = Effect.all([section("purchases", purchases), section("gas", gas), section("solvency", solvency), section("Base gas", baseGas)], { discard: true })

    // A registered Bitrefill client's secret lasts 90 days. Said once a day (and at each start) from two
    // weeks out: by the time a guest login fails, cards have already stopped.
    // Seconds since 1970, as Bitrefill gives it. Milliseconds, NaN or Infinity would never warn, so they stop the
    // server at start like any other value that isn't one.
    const secretExpiry = yield* Config.option(Config.schema(
      Schema.Finite.check(Schema.isLessThanOrEqualTo(1e11, { message: "seconds since 1970, not milliseconds" })),
      "BITREFILL_CLIENT_SECRET_EXPIRES_AT"
    ))
    const hasClient = Option.isSome(yield* Config.option(Config.String("BITREFILL_CLIENT_ID")))
    if (Option.isSome(secretExpiry)) {
      yield* Effect.suspend(() => {
        const warning = secretWarning(secretExpiry.value, Date.now())
        return warning ? alerts.admin(warning) : Effect.void
      }).pipe(Effect.repeat(Schedule.spaced("1 day")), Effect.forkScoped)
    } else if (hasClient) {
      // Forked, so a slow Telegram never delays the server's start.
      yield* alerts.admin("BITREFILL_CLIENT_SECRET_EXPIRES_AT isn't set, so nothing will warn before the Bitrefill client secret expires (deploy/README.md)").pipe(Effect.forkScoped)
    }
    yield* check.pipe(Effect.repeat(Schedule.spaced("10 minutes")), Effect.forkScoped)
  })
)
