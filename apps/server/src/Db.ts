import { PgClient } from "@effect/sql-pg"
import { PgliteClient } from "@effect/sql-pglite"
import { Config, Effect, Layer, Option } from "effect"
import { Migrator, SqlClient } from "effect/sql"
import { mkdirSync } from "node:fs"

/** Postgres when DATABASE_URL is set, otherwise PGlite in `.data/` (no install, ADR-0006). */
const Client = Layer.unwrap(
  Effect.gen(function*() {
    const url = yield* Config.option(Config.Redacted("DATABASE_URL"))
    if (Option.isSome(url)) return PgClient.layer({ url: url.value })
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
  })
})

export const DbLive = Layer.effectDiscard(Migrator.make({})({ loader: migrations })).pipe(Layer.provideMerge(Client))
