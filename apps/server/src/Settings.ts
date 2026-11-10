import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"

// Switches changed from the admin panel live in the `settings` table, one JSON value per key,
// with who changed it last. A missing or unreadable row falls back to the default.

/** The saved value for `key`, or `fallback` when nothing valid is saved. */
export const readSetting = <A, I>(key: string, schema: Schema.Codec<A, I>, fallback: A) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ value: unknown }>`SELECT value FROM settings WHERE key = ${key}`
    if (!row) return fallback
    return yield* Schema.decodeUnknownEffect(schema)(row.value).pipe(
      Effect.catchCause((cause) => Effect.as(Effect.logError(`setting ${key} is unreadable; using the default`, cause), fallback))
    )
  }).pipe(Effect.orDie)

export const writeSetting = <A, I>(key: string, schema: Schema.Codec<A, I>, value: A, by: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // Saved as plain JSON and checked the way it will be read back, so nothing unreadable is ever stored.
    const json = JSON.stringify(value)
    yield* Schema.decodeUnknownEffect(schema)(JSON.parse(json))
    yield* sql`INSERT INTO settings (key, value, updated_by) VALUES (${key}, ${json}::jsonb, ${by})
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`
    return value
  }).pipe(Effect.orDie)
