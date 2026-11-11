import { PgClient } from "@effect/sql-pg"
import { PgliteClient } from "@effect/sql-pglite"
import { PGlite } from "@electric-sql/pglite"
import { Config, Effect, Layer, Option } from "effect"
import { Migrator, SqlClient } from "effect/sql"
import { mkdirSync } from "node:fs"
import { Network } from "./Near.ts"

// Exactly one server process per database (ADR-0006): a second one would poll Telegram twice
// and race the operator's transaction nonces. The lock lives as long as this connection.
const SingleInstance = Layer.effectDiscard(
  Effect.gen(function*() {
    const conn = yield* (yield* SqlClient.SqlClient).reserve
    const rows = yield* conn.execute("SELECT pg_try_advisory_lock(735001) AS ok", [], undefined)
    if (rows[0]?.ok !== true) return yield* Effect.die("Another Luckout server is already running against this database")
  }).pipe(Effect.orDie)
)

/** Postgres when DATABASE_URL is set, otherwise PGlite in `.data/` (no install, ADR-0006). */
const Client = Layer.unwrap(
  Effect.gen(function*() {
    const url = yield* Config.option(Config.Redacted("DATABASE_URL"))
    if (Option.isSome(url)) return SingleInstance.pipe(Layer.provideMerge(PgClient.layer({ url: url.value })))
    const dataDir = new URL("../.data/pglite", import.meta.url).pathname
    mkdirSync(dataDir, { recursive: true })
    return PgliteClient.layer({ dataDir })
  })
)

const migrations = Migrator.fromRecord({
  "0001_auth_and_purchases": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE auth_nonces (nonce TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL)`
    yield* sql`
      CREATE TABLE purchases (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        voucher_id TEXT NOT NULL,
        voucher_name TEXT NOT NULL,
        package_value TEXT NOT NULL,
        requested_mode JSONB,
        reference_price BIGINT NOT NULL,
        step TEXT NOT NULL,
        error TEXT,
        admit_tx JSONB,
        contract_purchase_id BIGINT,
        admitted JSONB,
        invoice_id TEXT,
        redemption TEXT,
        settle_tx JSONB,
        draw JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (account_id, idempotency_key)
      )`
    yield* sql`CREATE INDEX purchases_account ON purchases (account_id, created_at DESC)`
  }),
  "0002_telegram": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE telegram_link_codes (
        code TEXT PRIMARY KEY,
        telegram_user_id BIGINT NOT NULL,
        chat_id BIGINT NOT NULL,
        telegram_name TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      )`
    yield* sql`
      CREATE TABLE telegram_links (
        telegram_user_id BIGINT PRIMARY KEY,
        account_id TEXT NOT NULL,
        chat_id BIGINT NOT NULL,
        linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`
  }),
  // Security review: codes are now issued by the signed-in web session, not by the bot.
  "0003_web_issued_telegram_codes_and_max_debit": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DROP TABLE telegram_link_codes`
    yield* sql`
      CREATE TABLE telegram_link_codes (
        code TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      )`
    yield* sql`ALTER TABLE telegram_links ADD COLUMN telegram_name TEXT NOT NULL DEFAULT ''`
    yield* sql`ALTER TABLE purchases ADD COLUMN max_debit BIGINT`
  }),
  // Production review: reconciler backoff (S3) and one Telegram link per account (S4).
  "0004_reconciler_backoff_and_one_link_per_account": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE purchases ADD COLUMN attempts INT NOT NULL DEFAULT 0`
    yield* sql`ALTER TABLE purchases ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()`
    yield* sql`CREATE INDEX purchases_open ON purchases (next_attempt_at) WHERE step IN ('admit', 'ordering', 'delivery', 'confirm', 'fail')`
    yield* sql`DELETE FROM telegram_links a USING telegram_links b WHERE a.account_id = b.account_id AND a.linked_at < b.linked_at`
    yield* sql`CREATE UNIQUE INDEX telegram_links_account ON telegram_links (account_id)`
  }),
  // The contract's draw event calls it cashback now; rename it in stored Draws too.
  "0005_draw_cashback": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE purchases SET draw = (draw - 'refund') || jsonb_build_object('cashback', draw->'refund') WHERE draw ? 'refund'`
  }),
  // Relayed customer transactions (ADR-0008): dedupe by signature, daily quotas, resume after a crash.
  "0006_relays": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE relays (
        delegate_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        signed_tx JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`
    yield* sql`CREATE INDEX relays_created ON relays (created_at)`
  }),
  // Switches changed from the admin panel, such as the relayer's on/off and caps.
  "0007_settings": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`
  }),
  // Bitrefill credit (ADR-0009): purchases may wait for credit, and refills are tracked step by step.
  "0008_credit_and_refills": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE purchases ADD COLUMN ordered_at TIMESTAMPTZ`
    yield* sql`CREATE INDEX purchases_ordered ON purchases (ordered_at) WHERE ordered_at IS NOT NULL`
    yield* sql`CREATE INDEX purchases_waiting ON purchases (created_at) WHERE step IN ('waiting', 'restock')`
    yield* sql`
      CREATE TABLE refills (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        amount BIGINT NOT NULL,
        reason TEXT NOT NULL,
        requested_by TEXT,
        step TEXT NOT NULL,
        invoice_id TEXT,
        pay_address TEXT,
        invoice_at TIMESTAMPTZ,
        swap JSONB,
        sweep_tx JSONB,
        send_tx JSONB,
        swap_status TEXT,
        sent_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        error TEXT,
        attempts INT NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`
    // At most one refill runs at a time: the database enforces it, not just the code.
    yield* sql`CREATE UNIQUE INDEX refills_one_open ON refills ((true)) WHERE step IN ('invoice', 'quote', 'fund', 'send', 'swapping', 'crediting')`
  }),
  // Refills land in our Base wallet first, then pay Bitrefill from it (ADR-0009, amended 2026-11-10).
  "0009_base_wallet": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE refills ADD COLUMN pay_tx JSONB`
    yield* sql`ALTER TABLE refills ADD COLUMN paid_at TIMESTAMPTZ`
    yield* sql`DROP INDEX refills_one_open`
    yield* sql`CREATE UNIQUE INDEX refills_one_open ON refills ((true)) WHERE step IN ('fund', 'quote', 'send', 'swapping', 'invoice', 'pay', 'crediting')`
  }),
  // Audit fixes: a stuck refill remembers the step it stopped at, so only a stuck swap carries on by
  // itself; a Lucky Buy is admitted at the Lucky Amount it was accepted under, or not at all.
  "0010_refill_stuck_at_and_quoted_lucky_amount": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE refills ADD COLUMN stuck_at TEXT`
    // Refills already stuck: one that paid 1Click but never had a successful swap stopped while swapping.
    yield* sql`UPDATE refills SET stuck_at = 'swapping'
               WHERE step = 'stuck' AND send_tx IS NOT NULL AND pay_tx IS NULL AND swap_status IS DISTINCT FROM 'SUCCESS'`
    yield* sql`ALTER TABLE purchases ADD COLUMN quoted_lucky_amount BIGINT`
  }),
  // Every account that ever signed in, bought, relayed or linked Telegram: the solvency check sums their
  // balances. "Sign out everywhere" ends every session issued before its time.
  "0011_known_accounts_and_session_resets": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE known_accounts (account_id TEXT PRIMARY KEY, first_seen TIMESTAMPTZ NOT NULL DEFAULT now())`
    yield* sql`INSERT INTO known_accounts (account_id)
               SELECT account_id FROM purchases UNION SELECT account_id FROM relays UNION SELECT account_id FROM telegram_links
               ON CONFLICT DO NOTHING`
    yield* sql`CREATE TABLE session_resets (account_id TEXT PRIMARY KEY, after TIMESTAMPTZ NOT NULL)`
  }),
  // EVM wallets (ADR-0011): 1Click swaps into or out of a customer's NEAR Intents account. An inward
  // Top-Up's signed move-in waits here until its swap lands; an outward quote is what a transfer may pay.
  "0012_intents_swaps": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE intents_swaps (
        deposit_address TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        usdc BIGINT NOT NULL,
        move_in JSONB,
        move TEXT CHECK (move IN ('waiting', 'moved', 'failed')),
        move_detail TEXT,
        checked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`
    yield* sql`CREATE INDEX intents_swaps_waiting ON intents_swaps (checked_at NULLS FIRST) WHERE move = 'waiting'`
    // A Top-Up's own move-in is paid for but not counted against the daily caps.
    yield* sql`ALTER TABLE relays ADD COLUMN counted BOOLEAN NOT NULL DEFAULT true`
  })
})

const Migrations = Layer.effectDiscard(Migrator.make({})({ loader: migrations }))

/**
 * A database belongs to one network for good: the first server to start records it, and a server
 * for the other network refuses to start against it, so testnet and mainnet data can never mix.
 */
const NetworkLock = Layer.effectDiscard(
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const network = yield* Network
    yield* sql`INSERT INTO settings (key, value, updated_by) VALUES ('network', ${JSON.stringify(network)}::jsonb, 'server')
               ON CONFLICT (key) DO NOTHING`
    const [row] = yield* sql<{ value: unknown }>`SELECT value FROM settings WHERE key = 'network'`
    if (row?.value !== network) {
      return yield* Effect.die(`This database belongs to ${String(row?.value)}, but NEAR_NETWORK is ${network}. Point DATABASE_URL at the ${network} database.`)
    }
  }).pipe(Effect.orDie)
)

export const DbLive = NetworkLock.pipe(Layer.provideMerge(Migrations), Layer.provideMerge(Client))

// Tests migrate one database per process and start each fresh one from its dump: ~70ms instead of
// ~1s to boot and migrate. (The template is closed once dumped; left open, the process lingers 10s.)
let migrated: Promise<File | Blob> | undefined
const migratedDump = () =>
  migrated ??= PGlite.create().then(async (pg) => {
    await Effect.runPromise(Effect.provide(Migrator.make({})({ loader: migrations }), PgliteClient.layer({ liveClient: pg })))
    const dump = await pg.dumpDataDir("none")
    await pg.close()
    return dump
  })

/** A fresh in-memory database, for tests. */
export const DbMemory = PgliteClient.layerFrom(
  Effect.acquireRelease(
    Effect.promise(async () => PGlite.create({ loadDataDir: await migratedDump() })),
    (pg) => Effect.promise(() => pg.close())
  ).pipe(Effect.flatMap((liveClient) => PgliteClient.make({ liveClient })))
)
