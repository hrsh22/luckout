import { Config, Effect, Layer, Option, Schedule, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { PublicKey } from "@solana/web3.js"
import { Alerts } from "./Alerts.ts"
import { Solana } from "./Solana.ts"
import { OPEN_STEPS } from "./Purchases.ts"
import { readSetting, writeSetting } from "./Settings.ts"

const SOL = 1_000_000_000n
/**
 * Below these the owner hears of it (the admin panel shows the same lines). Production keeps the full lines; staging
 * runs on a fraction, so it sets GAS_ALERT_PERCENT.
 */
const PERCENT = BigInt(process.env.GAS_ALERT_PERCENT || 100)
export const LOW_LINES = {
  /** The fee payer pays every fee and rent (Customer and Checkout accounts, ORAO's requests): about a week of it. */
  feePayer: SOL * PERCENT / 100n,
  /** The Pay Wallet's float pays Bitrefill until `settle` repays it: about a busy hour of cards. */
  float: 100_000_000n * PERCENT / 100n
} as const
const solText = (lamports: bigint) => `${Number(lamports) / 1e9} SOL`
/**
 * A low-balance alert is said when an account drops under its line, then once a day while it stays there. When each
 * was last said is kept in the database, so a restart or a deploy doesn't say it again; back over its line, the next
 * drop is news again.
 */
const LOW_REPEAT_MS = 24 * 60 * 60_000
const LowSaid = Schema.Record(Schema.String, Schema.Number)

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

/** Every 10 minutes, the things that quietly stop purchases if nobody notices. */
export const Monitor = Layer.effectDiscard(
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const solana = yield* Solana
    const alerts = yield* Alerts

    // Each check stands alone: one that fails (say, an RPC read that times out) is logged, and the rest still run.
    const section = <E>(name: string, body: Effect.Effect<void, E>) =>
      body.pipe(Effect.catchCause((cause) => Effect.logError(`monitor: the ${name} check failed`, cause)))

    // Reads only our database, so it runs first: an RPC outage is exactly when purchases stall.
    const purchases = Effect.gen(function*() {
      const [r] = yield* sql<{ stuck: number; late: number }>`
        SELECT count(*) FILTER (WHERE step = 'stuck')::int AS stuck,
               count(*) FILTER (WHERE step IN ${sql.in(OPEN_STEPS)} AND created_at < now() - interval '15 minutes')::int AS late
        FROM purchases`
      if (r && r.stuck > 0) yield* alerts.admin(`${r.stuck} purchase(s) stuck; see deploy/RUNBOOK.md`)
      if (r && r.late > 0) yield* alerts.admin(`${r.late} purchase(s) still unfinished after 15 minutes`)
    })

    /** Says `text` on the drop under the line, then once a day while it lasts (LOW_REPEAT_MS). */
    const low = (key: string, under: boolean, text: string) =>
      Effect.gen(function*() {
        const said = yield* readSetting("low_balances", LowSaid, {})
        const at = said[key]
        const now = Date.now()
        if (under && (at === undefined || now - at > LOW_REPEAT_MS)) {
          yield* alerts.admin(text)
          yield* writeSetting("low_balances", LowSaid, { ...said, [key]: now }, "server")
        } else if (!under && at !== undefined) {
          const { [key]: _, ...rest } = said
          yield* writeSetting("low_balances", LowSaid, rest, "server")
        }
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql))

    const gas = Effect.gen(function*() {
      if (solana.feePayer) {
        yield* low(
          "feePayer",
          (yield* solana.balance(solana.feePayer)) < LOW_LINES.feePayer,
          `the fee payer ${solana.feePayer.toBase58()} has under ${solText(LOW_LINES.feePayer)} left; every purchase, deposit and Draw stops when it runs out`
        )
      }
      const config = yield* solana.config
      const float = yield* solana.account(config.pay_wallet)
      const usdc = float ? float.data.readBigUInt64LE(64) : 0n
      yield* low("float", usdc < LOW_LINES.float, `the Pay Wallet's float is down to ${Number(usdc) / 1e6} USDC; checkouts wait for it once it can't pay Bitrefill`)
      // `settle` repays the float only up to the owner's daily cap: past it, the float runs down while Proceeds grow.
      const today = BigInt(Math.floor(Date.now() / 86_400_000))
      const repaid = config.repay_day === today ? config.repaid_today : 0n
      yield* low(
        "repayCap",
        config.repay_daily_cap > 0n && repaid * 5n >= config.repay_daily_cap * 4n,
        `today's repayments to the Pay Wallet reached ${Number(repaid) / 1e6} of the ${Number(config.repay_daily_cap) / 1e6} USDC daily cap; raise it in the admin panel`
      )
    })

    // The Vault must hold at least what the program owes: customers' Balances, the reserve, the Proceeds, and what open
    // Checkouts debited and haven't paid out. Below it, customers' money is gone (a bug or an attack). Balances aren't
    // summed onchain, so this sums every customer we know of (Db: known_accounts) and every open Checkout. Missing ones
    // only make the debt look smaller, never a false alarm.
    // ponytail: every customer read every 10 minutes, 100 to a call; keep an onchain total when there are hundreds of thousands.
    const solvency = Effect.gen(function*() {
      const config = yield* solana.config
      const [known, open] = yield* Effect.all([
        sql<{ account_id: string }>`SELECT account_id FROM known_accounts`.pipe(Effect.orDie),
        sql<{ address: string }>`SELECT address FROM checkouts WHERE address IS NOT NULL AND step NOT IN ('done', 'rejected')`.pipe(Effect.orDie)
      ])
      const wallets = known.flatMap((r) => {
        try {
          return [new PublicKey(r.account_id)]
        } catch {
          return []
        }
      })
      const [vault, customers, checkouts] = yield* Effect.all([
        solana.account(config.vault),
        Effect.forEach(wallets, (w) => solana.customer(w), { concurrency: 4 }),
        Effect.forEach(open, (c) => solana.checkout(new PublicKey(c.address)), { concurrency: 4 })
      ])
      const held = vault ? vault.data.readBigUInt64LE(64) : 0n
      const balances = customers.reduce((sum, c) => sum + (c?.balance ?? 0n), 0n)
      const inFlight = checkouts.reduce((sum, co) =>
        sum + (co?.cards ?? []).reduce((s, card) =>
          s + (card.status.kind === "Pending" ? card.max_price : card.status.kind === "Drawing" ? card.max_price - card.reference_price : 0n), 0n), 0n)
      const owed = balances + config.free_reserve + config.locked_reserve + config.proceeds + inFlight
      if (held < owed) {
        yield* alerts.admin(
          `the Vault holds ${Number(held) / 1e6} USDC, less than the program owes: ${Number(owed) / 1e6} (Balances ${Number(balances) / 1e6}, ` +
            `reserve and Proceeds ${Number(config.free_reserve + config.locked_reserve + config.proceeds) / 1e6}, open Checkouts ${Number(inFlight) / 1e6}). Pause the program and investigate now.`
        )
      }
    })

    // A Draw waits only for ORAO (4-20 s); one still unfinished after ten minutes needs a look.
    const draws = Effect.gen(function*() {
      const [r] = yield* sql<{ n: number }>`SELECT count(*)::int AS n FROM checkouts WHERE step = 'draw' AND updated_at < now() - interval '10 minutes'`.pipe(Effect.orDie)
      if (r && r.n > 0) yield* alerts.admin(`${r.n} checkout(s) have a Draw still unfinished after 10 minutes`)
    })

    const check = Effect.all([section("purchases", purchases), section("gas", gas), section("solvency", solvency), section("draws", draws)], { discard: true })

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
