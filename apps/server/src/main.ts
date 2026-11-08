import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Api, Authorization, CurrentAccount, NotFound } from "@luckout/api"
import { Config, Effect, Layer, Redacted } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { SqlClient } from "effect/sql"
import { createServer } from "node:http"
import { Auth } from "./Auth.ts"
import { Bitrefill } from "./Bitrefill.ts"
import { DbLive } from "./Db.ts"
import { Near } from "./Near.ts"
import { Purchases } from "./Purchases.ts"
import { rateLimit } from "./RateLimit.ts"
import { Telegram } from "./Telegram.ts"
import { TopUp } from "./TopUp.ts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SystemHandlers = HttpApiBuilder.group(Api, "system", (handlers) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    return handlers.handle("health", () => sql`select 1`.pipe(Effect.orDie, Effect.asVoid))
  })
)

const CatalogHandlers = HttpApiBuilder.group(Api, "catalog", (handlers) =>
  Effect.gen(function*() {
    const bitrefill = yield* Bitrefill
    const purchases = yield* Purchases
    return handlers.handleAll({
      search: ({ query }) => bitrefill.search(query.q),
      voucher: ({ params }) => bitrefill.voucher(params.id),
      quote: ({ query }) => purchases.quote(query.voucherId, query.value, query.game)
    })
  })
)

const AuthHandlers = HttpApiBuilder.group(Api, "auth", (handlers) =>
  Effect.gen(function*() {
    const auth = yield* Auth
    return handlers.handleAll({
      challenge: () => auth.challenge,
      verify: ({ payload }) => auth.verify(payload)
    })
  })
)

const PurchaseHandlers = HttpApiBuilder.group(Api, "purchases", (handlers) =>
  Effect.gen(function*() {
    const purchases = yield* Purchases
    return handlers.handleAll({
      create: ({ payload }) => CurrentAccount.use((a) => purchases.create(a.accountId, payload)),
      list: () => CurrentAccount.use((a) => purchases.list(a.accountId)),
      get: ({ params }) =>
        UUID.test(params.id)
          ? CurrentAccount.use((a) => purchases.get(a.accountId, params.id))
          : Effect.fail(new NotFound())
    })
  })
)

const TelegramHandlers = HttpApiBuilder.group(Api, "telegram", (handlers) =>
  Effect.gen(function*() {
    const telegram = yield* Telegram
    return handlers.handleAll({
      status: () => CurrentAccount.use((a) => telegram.status(a.accountId)),
      linkCode: () => CurrentAccount.use((a) => telegram.linkCode(a.accountId)),
      unlink: () => CurrentAccount.use((a) => telegram.unlink(a.accountId))
    })
  })
)

const TopUpHandlers = HttpApiBuilder.group(Api, "topup", (handlers) =>
  Effect.gen(function*() {
    const topup = yield* TopUp
    return handlers.handleAll({
      assets: () => topup.assets,
      quote: ({ payload }) => CurrentAccount.use((a) => topup.quote(a.accountId, payload.originAsset, payload.usdc)),
      status: ({ query }) => topup.status(query.depositAddress)
    })
  })
)

const AuthorizationLive = Layer.effect(
  Authorization,
  Effect.gen(function*() {
    const auth = yield* Auth
    return Authorization.of({
      bearer: (httpEffect, { credential }) =>
        Effect.flatMap(auth.authenticate(Redacted.value(credential)), (accountId) =>
          Effect.provideService(httpEffect, CurrentAccount, { accountId }))
    })
  })
)

const Services = Telegram.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Auth.layer, Purchases.layer)),
  Layer.provideMerge(Layer.mergeAll(Bitrefill.layer, Near.layer, TopUp.layer, DbLive))
)

const Routes = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide([SystemHandlers, CatalogHandlers, AuthHandlers, PurchaseHandlers, TelegramHandlers, TopUpHandlers]),
  Layer.provide(AuthorizationLive),
  Layer.provide(Services)
)

const Server = Layer.unwrap(
  Effect.gen(function*() {
    const port = yield* Config.Port("PORT").pipe(Config.withDefault(8787))
    // On the VM, HOST=127.0.0.1 so only nginx can reach the server.
    const host = yield* Config.String("HOST").pipe(Config.option)
    const webOrigin = yield* Config.String("WEB_ORIGIN").pipe(Config.withDefault("http://localhost:3000"))
    return HttpRouter.serve(Layer.mergeAll(Routes, HttpRouter.cors({ allowedOrigins: [webOrigin] }), HttpRouter.middleware(rateLimit, { global: true }))).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { port, ...(host._tag === "Some" ? { host: host.value } : {}) }))
    )
  })
)

Layer.launch(Server).pipe(NodeRuntime.runMain)
