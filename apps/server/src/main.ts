import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { type AdminInvalid, Api, Authorization, BitrefillUnavailable, CurrentAccount, NotFound, PopularCards, type PurchaseInvalid } from "@luckout/api"
import { Admin } from "./Admin.ts"
import { Credit } from "./Credit.ts"
import { OneClick } from "./OneClick.ts"
import { Refill } from "./Refill.ts"
import { Config, Effect, Layer, Redacted } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { SqlClient } from "effect/sql"
import { createServer } from "node:http"
import { Alerts } from "./Alerts.ts"
import { Auth } from "./Auth.ts"
import { Base } from "./Base.ts"
import { Bitrefill } from "./Bitrefill.ts"
import { DbLive } from "./Db.ts"
import { Monitor } from "./Monitor.ts"
import { Near, Network, otherNetworkAccounts } from "./Near.ts"
import { Purchases } from "./Purchases.ts"
import { rateLimit } from "./RateLimit.ts"
import { Relay } from "./Relay.ts"
import { Sales } from "./Sales.ts"
import { Telegram } from "./Telegram.ts"
import { TopUp } from "./TopUp.ts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SystemHandlers = HttpApiBuilder.group(Api, "system", (handlers) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const sales = yield* Sales
    return handlers.handleAll({
      health: () => sql`select 1`.pipe(Effect.orDie, Effect.asVoid),
      status: () => sales.status
    })
  })
)

const CatalogHandlers = HttpApiBuilder.group(Api, "catalog", (handlers) =>
  Effect.gen(function*() {
    const bitrefill = yield* Bitrefill
    const purchases = yield* Purchases
    // Anyone can call these: a transport failure's details (URLs, upstream text) stay in our logs.
    const quiet = <A, E>(self: Effect.Effect<A, E>) =>
      self.pipe(Effect.mapError((e) => {
        if (!(e instanceof BitrefillUnavailable) || !e.message.startsWith("Bitrefill request failed")) return e
        console.warn(e.message)
        return new BitrefillUnavailable({ message: "Bitrefill isn't answering right now. Try again in a moment." }) as E
      }))
    return handlers.handleAll({
      search: ({ query }) => quiet(bitrefill.search(query.q)),
      browse: ({ query }) => quiet(bitrefill.browse(query)),
      popular: ({ query }) =>
        Effect.gen(function*() {
          // Cloudflare says where the visitor is ("XX" unknown, "T1" Tor). It only picks which cards to suggest.
          const seen = (yield* HttpServerRequest.HttpServerRequest).headers["cf-ipcountry"]?.toUpperCase()
          const country = query.country ?? (seen && /^[A-Z]{2}$/.test(seen) && seen !== "XX" && seen !== "T1" ? seen : undefined)
          const items = yield* bitrefill.popular(country, query.category)
          return new PopularCards({ ...(country ? { country } : {}), items })
        }),
      voucher: ({ params }) => quiet(bitrefill.voucher(params.id)),
      quote: ({ query }) => quiet(purchases.quote(query.voucherId, query.value, query.game))
    })
  })
)

const AuthHandlers = HttpApiBuilder.group(Api, "auth", (handlers) =>
  Effect.gen(function*() {
    const auth = yield* Auth
    return handlers.handleAll({
      challenge: () => auth.challenge,
      verify: ({ payload }) => auth.verify(payload),
      verifyEvm: ({ payload }) => auth.verifyEvm(payload)
    })
  })
)

const SessionHandlers = HttpApiBuilder.group(Api, "session", (handlers) =>
  Effect.gen(function*() {
    const auth = yield* Auth
    return handlers.handleAll({
      signOutEverywhere: () => CurrentAccount.use((a) => auth.signOutEverywhere(a.accountId))
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
          : Effect.fail(new NotFound()),
      cancel: ({ params }) =>
        UUID.test(params.id)
          ? CurrentAccount.use((a) => purchases.cancel(a.accountId, params.id))
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
      quote: ({ payload }) => CurrentAccount.use((a) => topup.quote(a.accountId, payload.originAsset, payload.usdc, payload.dry ?? false)),
      status: ({ query }) => CurrentAccount.use((a) => topup.status(a.accountId, query.depositAddress)),
      move: ({ payload }) => CurrentAccount.use((a) => topup.move(a.accountId, payload.depositAddress, payload.signed)),
      faucet: () => CurrentAccount.use((a) => topup.faucet(a.accountId)),
      transfers: () => CurrentAccount.use((a) => topup.transfers(a.accountId)),
      held: () => CurrentAccount.use((a) => topup.held(a.accountId)),
      sent: ({ payload }) => CurrentAccount.use((a) => topup.sent(a.accountId, payload.depositAddress, payload.txHash)),
      sendBack: ({ payload }) => CurrentAccount.use((a) => topup.sendBack(a.accountId, payload.assetId)),
      exit: ({ payload }) => CurrentAccount.use((a) => topup.exit(a.accountId, payload.destinationAsset, payload.usdc))
    })
  })
)

const RelayHandlers = HttpApiBuilder.group(Api, "relay", (handlers) =>
  Effect.gen(function*() {
    const relay = yield* Relay
    return handlers.handleAll({
      status: () => CurrentAccount.use((a) => relay.available(a.accountId).pipe(Effect.map((available) => ({ available })))),
      send: ({ payload }) => CurrentAccount.use((a) => relay.send(a.accountId, payload.signedDelegate)),
      intent: ({ payload }) => CurrentAccount.use((a) => relay.sendIntent(a.accountId, payload.signed))
    })
  })
)

// Admins only; to anyone else the endpoints answer NotFound, and /openapi.json leaves them out.
const AdminHandlers = HttpApiBuilder.group(Api, "admin", (handlers) =>
  Effect.gen(function*() {
    const admin = yield* Admin
    const signedInAdmin = Effect.gen(function*() {
      const { accountId } = yield* CurrentAccount
      if (!admin.isAdmin(accountId)) return yield* new NotFound()
      return accountId
    })
    return handlers.handleAll({
      me: () => Effect.asVoid(signedInAdmin),
      overview: () => Effect.andThen(signedInAdmin, admin.overview),
      relay: ({ payload }) => Effect.flatMap(signedInAdmin, (by) => admin.configureRelay(payload, by)),
      sales: ({ payload }) => Effect.flatMap(signedInAdmin, (by) => admin.setSales(payload.open, by)),
      credit: ({ payload }) => Effect.flatMap(signedInAdmin, (by) => admin.configureCredit(payload, by)),
      refill: ({ payload }) => Effect.flatMap(signedInAdmin, (by) => admin.refill(payload.amount, by)),
      resolveRefill: ({ params, payload }) =>
        Effect.flatMap(signedInAdmin, (by): Effect.Effect<void, NotFound | AdminInvalid> =>
          UUID.test(params.id) ? admin.resolveRefill(params.id, payload.note, by) : Effect.fail(new NotFound())),
      retry: ({ params }) =>
        Effect.flatMap(signedInAdmin, (by): Effect.Effect<void, NotFound | PurchaseInvalid> =>
          UUID.test(params.id) ? admin.retry(params.id, by) : Effect.fail(new NotFound()))
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

const Services = Layer.mergeAll(Telegram.layer, Monitor, Admin.layer, TopUp.layer).pipe(
  Layer.provideMerge(Layer.mergeAll(Auth.layer, Purchases.layer, Relay.layer)),
  Layer.provideMerge(Layer.mergeAll(Refill.layer, Sales.layer)),
  Layer.provideMerge(Layer.mergeAll(Credit.layer, Base.layer)),
  Layer.provideMerge(Layer.mergeAll(Bitrefill.layer, Near.layer, OneClick.layer, Alerts.layer)),
  Layer.provideMerge(DbLive)
)

// On mainnet, refuse to start half-configured instead of falling back to testnet defaults,
// PGlite, or sessions that end on restart.
const MAINNET_REQUIRES = [
  "DATABASE_URL",
  "WEB_ORIGIN",
  "SESSION_SECRET",
  "REDEMPTION_KEY",
  "LUCKOUT_CONTRACT_ID",
  "OPERATOR_ACCOUNT_ID",
  "OPERATOR_PRIVATE_KEY",
  "BITREFILL_API_KEY",
  // Refills pay Bitrefill from our Base wallet; without a Base RPC they can't run.
  "BASE_RPC_URL",
  // Real money: alerts must reach a human (through the bot), and someone must be able to open the admin panel.
  "TELEGRAM_BOT_TOKEN",
  "ALERT_TELEGRAM_CHAT_ID",
  "ADMIN_ACCOUNTS"
]

/** What a mainnet .env lacks: missing values, and keys too weak to use. */
const mainnetProblems = (env: Record<string, string | undefined>) => [
  ...MAINNET_REQUIRES.filter((k) => !env[k]),
  // Purchases decodes it as hex and can't seal codes unless that gives 32 bytes.
  ...(env.REDEMPTION_KEY && Buffer.from(env.REDEMPTION_KEY, "hex").length !== 32 ? ["REDEMPTION_KEY as 64 hex characters"] : []),
  ...(env.SESSION_SECRET && env.SESSION_SECRET.length < 32 ? ["SESSION_SECRET of at least 32 characters"] : [])
]

const Routes = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide([SystemHandlers, CatalogHandlers, AuthHandlers, SessionHandlers, PurchaseHandlers, TelegramHandlers, TopUpHandlers, RelayHandlers, AdminHandlers]),
  Layer.provide(AuthorizationLive),
  Layer.provide(Services)
)

const Server = Layer.unwrap(
  Effect.gen(function*() {
    const missing = (yield* Network) === "mainnet" ? mainnetProblems(process.env) : []
    if (missing.length > 0) return yield* Effect.die(`NEAR_NETWORK=mainnet also needs ${missing.join(", ")}`)
    const mixed = otherNetworkAccounts(yield* Network, process.env)
    if (mixed.length > 0) return yield* Effect.die(`NEAR_NETWORK=${yield* Network} but these accounts belong to the other network: ${mixed.join(", ")}`)
    const port = yield* Config.Port("PORT").pipe(Config.withDefault(8787))
    // On the VM, HOST=127.0.0.1 so only nginx can reach the server.
    const host = yield* Config.String("HOST").pipe(Config.option)
    const webOrigin = yield* Config.String("WEB_ORIGIN").pipe(Config.withDefault("http://localhost:3000"))
    // More sites that may call this server (exact origins, comma-separated), e.g. testnet's own domain.
    const more = (yield* Config.String("CORS_ORIGINS").pipe(Config.withDefault(""))).split(",").map((o) => o.trim()).filter(Boolean)
    return HttpRouter.serve(Layer.mergeAll(Routes, HttpRouter.cors({ allowedOrigins: [webOrigin, ...more] }), HttpRouter.middleware(rateLimit, { global: true }))).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { port, ...(host._tag === "Some" ? { host: host.value } : {}) }))
    )
  })
)

Layer.launch(Server).pipe(NodeRuntime.runMain)
