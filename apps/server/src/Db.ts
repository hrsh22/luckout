import { PgClient } from "@effect/sql-pg"
import { PgliteClient } from "@effect/sql-pglite"
import { Config, Effect, Layer, Option } from "effect"
import { Migrator, SqlClient } from "effect/sql"
import { mkdirSync } from "node:fs"

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
  })
})

const Migrations = Layer.effectDiscard(Migrator.make({})({ loader: migrations }))

export const DbLive = Migrations.pipe(Layer.provideMerge(Client))

/** A fresh in-memory database, for tests. */
export const DbMemory = Migrations.pipe(Layer.provideMerge(PgliteClient.layer({})))
