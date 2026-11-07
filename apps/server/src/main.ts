import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Api } from "@luckout/api"
import { Config, Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { SqlClient } from "effect/sql"
import { createServer } from "node:http"
import { Bitrefill } from "./Bitrefill.ts"
import { DbLive } from "./Db.ts"

const SystemHandlers = HttpApiBuilder.group(Api, "system", (handlers) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    return handlers.handle("health", () => sql`select 1`.pipe(Effect.orDie, Effect.asVoid))
  })
)

const CatalogHandlers = HttpApiBuilder.group(Api, "catalog", (handlers) =>
  Effect.gen(function*() {
    const bitrefill = yield* Bitrefill
    return handlers.handle("search", ({ query }) => bitrefill.search(query.q))
  })
)

const Routes = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide([SystemHandlers, CatalogHandlers]),
  Layer.provide([Bitrefill.layer, DbLive])
)

const Server = Layer.unwrap(
  Effect.gen(function*() {
    const port = yield* Config.Port("PORT").pipe(Config.withDefault(8787))
    const webOrigin = yield* Config.String("WEB_ORIGIN").pipe(Config.withDefault("http://localhost:3000"))
    return HttpRouter.serve(Layer.mergeAll(Routes, HttpRouter.cors({ allowedOrigins: [webOrigin] }))).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { port }))
    )
  })
)

Layer.launch(Server).pipe(NodeRuntime.runMain)
