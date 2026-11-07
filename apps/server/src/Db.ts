import { PgClient } from "@effect/sql-pg"
import { PgliteClient } from "@effect/sql-pglite"
import { Config, Effect, Layer, Option } from "effect"
import { mkdirSync } from "node:fs"

/** Postgres when DATABASE_URL is set, otherwise PGlite in `.data/` (no install, ADR-0006). */
export const DbLive = Layer.unwrap(
  Effect.gen(function*() {
    const url = yield* Config.option(Config.Redacted("DATABASE_URL"))
    if (Option.isSome(url)) return PgClient.layer({ url: url.value })
    const dataDir = new URL("../.data/pglite", import.meta.url).pathname
    mkdirSync(dataDir, { recursive: true })
    return PgliteClient.layer({ dataDir })
  })
)
