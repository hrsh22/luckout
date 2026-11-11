import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

/** Objects (signed transactions, quotes) are stored as JSON; dates and scalars as they are. */
const json = (v: unknown) => (v === null || typeof v !== "object" || v instanceof Date ? v : JSON.stringify(v))

/**
 * Row plumbing for the two step machines, purchases and refills. A row moves on from the step it was
 * loaded at, or not at all, so each step's side effect happens once; and each step starts with its own
 * retries, so a backoff earned at one never delays the next.
 */
export const stepRows = (sql: SqlClient.SqlClient, table: "purchases" | "refills") => {
  const set = (fields: Record<string, unknown>) => sql.update(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, json(v)])))
  return {
    /** Saves fields without moving the row on. */
    save: (id: string, fields: Record<string, unknown>) =>
      sql`UPDATE ${sql(table)} SET ${set(fields)}, updated_at = now() WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie),
    /** Moves the row on from `row.step`; false if another worker already did, and this run then stops. */
    move: (row: { readonly id: string; readonly step: string }, fields: Record<string, unknown> & { step: string }) =>
      sql`UPDATE ${sql(table)} SET ${set(fields)}, attempts = 0, next_attempt_at = now(), updated_at = now()
          WHERE id = ${row.id} AND step = ${row.step} RETURNING id`.pipe(Effect.map((r) => r.length === 1), Effect.orDie)
  }
}
