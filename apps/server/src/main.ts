import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { type AdminInvalid, Api, BitrefillUnavailable, CatalogPage, ChainUnavailable, CurrentAccount, DepositAddress, NotFound, PopularCards, PreparedTransaction, ProgramInfo, PurchaseInvalid, Submitted, Voucher } from "@luckout/api"
import { Admin } from "./Admin.ts"
import { OneClick } from "./OneClick.ts"
import { Config, Effect, Exit, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { SqlClient } from "effect/sql"
import { createServer } from "node:http"
import { Alerts } from "./Alerts.ts"
import { Auth, AuthorizationLive, dropCookie, sessionToken, startSession } from "./Auth.ts"
import { Bitrefill, NO_SUCH_VOUCHER } from "./Bitrefill.ts"
import { Connect } from "./Connect.ts"
import { DbLive } from "./Db.ts"
import { Deposits, DepositsWebhook } from "./Deposits.ts"
import { edge } from "./Edge.ts"
import { McpRoute } from "./Mcp.ts"
import { Monitor } from "./Monitor.ts"
import { maxCashback } from "./Program.ts"
import { Purchases } from "./Purchases.ts"
import { Chain, checkKeys, Cluster, Solana } from "./Solana.ts"
import { Sales } from "./Sales.ts"
import { Swap } from "./Swap.ts"
import { Telegram } from "./Telegram.ts"
import { TopUp } from "./TopUp.ts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Chain trouble, said without its details (RPC URLs, upstream text), which stay in our logs. */
const chainUnavailable = (e: { readonly message: string }) =>
  Effect.logWarning(e.message).pipe(Effect.as(new ChainUnavailable({ message: "Solana isn't answering right now. Try again in a moment." })))

/** The program's public state, from its Config (ADR-0015): what the landing page, the shop and Fairness show. */
export const readProgram = Effect.gen(function*() {
  const solana = yield* Solana
  const c = yield* solana.config
  return new ProgramInfo({
    cluster: solana.cluster,
    programId: solana.program.id.toBase58(),
    usdcMint: c.usdc_mint.toBase58(),
    versions: c.versions.map((v) => ({
      name: v.name,
      premiumBps: v.premium_bps,
      outcomes: v.outcomes.map((o) => ({ finalBps: o.final_bps, chanceBps: o.chance_bps }))
    })),
    reserve: {
      free: Number(c.free_reserve),
      maxCashback: Number(maxCashback(c)),
      cashbackCap: { fixed: c.cashback_cap.fixed === null ? null : Number(c.cashback_cap.fixed), reserveBps: c.cashback_cap.reserve_bps }
    },
    minLuckyCheckout: Number(c.min_lucky_checkout),
    stats: { luckySettled: Number(c.lucky_settled), luckyAmountTotal: Number(c.lucky_amount_total), luckyPaidTotal: Number(c.lucky_paid_total) }
  })
})

export const SystemHandlers = HttpApiBuilder.group(Api, "system", (handlers) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const sales = yield* Sales
    const telegram = yield* Telegram
    // Anyone may ask, so every visitor shares one read every 30 seconds; a failed read isn't kept.
    const program = yield* readProgram.pipe(
      Effect.provideService(Solana, yield* Solana),
      Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? "30 seconds" : 0))
    )
    return handlers.handleAll({
      health: () => sql`select 1`.pipe(Effect.orDie, Effect.asVoid),
      status: () => sales.status,
      program: () => program.pipe(Effect.catchTag("SolanaUnavailable", (e) => Effect.flatMap(chainUnavailable(e), Effect.fail))),
      attestation: () => telegram.attestation
    })
  })
)

/** Where Cloudflare says the visitor is ("XX" unknown, "T1" Tor). It only picks which cards to suggest. */
const visitorCountry = Effect.gen(function*() {
  const seen = (yield* HttpServerRequest.HttpServerRequest).headers["cf-ipcountry"]?.toUpperCase()
  return seen && /^[A-Z]{2}$/.test(seen) && seen !== "XX" && seen !== "T1" ? seen : undefined
})

export const CatalogHandlers = HttpApiBuilder.group(Api, "catalog", (handlers) =>
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
      browse: ({ query: { near, ...query } }) =>
        Effect.gen(function*() {
          const country = query.country ?? (near ? yield* visitorCountry : undefined)
          const page = yield* quiet(bitrefill.browse({ ...query, ...(country ? { country } : {}) }))
          return country ? new CatalogPage({ ...page, country }) : page
        }),
      popular: ({ query }) =>
        Effect.gen(function*() {
          const country = query.country ?? (yield* visitorCountry)
          const items = yield* bitrefill.popular(country, query.category)
          return new PopularCards({ ...(country ? { country } : {}), items })
        }),
      voucher: ({ params }) =>
        quiet(Effect.zipWith(bitrefill.voucher(params.id, { page: true }), purchases.useBy(params.id), (v, useBy) => (useBy ? new Voucher({ ...v, useBy }) : v))).pipe(
          Effect.mapError((e) => (e.message === NO_SUCH_VOUCHER ? new NotFound() : e))
        ),
      quote: ({ query }) => quiet(purchases.quote(query.voucherId, query.value, query.game)),
      quoteCart: ({ payload }) => quiet(purchases.quoteCart(payload.items))
    })
  })
)

const AuthHandlers = HttpApiBuilder.group(Api, "auth", (handlers) =>
  Effect.gen(function*() {
    const auth = yield* Auth
    const purchases = yield* Purchases
    return handlers.handleAll({
      // The token goes only into the HttpOnly session cookie; the answer says who signed in and until when. The login
      // email becomes the Checkout Email if the customer has none yet (ADR-0015); they can change it in Wallet.
      privy: ({ payload }) =>
        startSession(Effect.tap(auth.privy(payload), (s) =>
          s.linked.email
            ? Effect.flatMap(purchases.checkoutEmail(s.accountId), (c) => (c.email ? Effect.void : purchases.setCheckoutEmail(s.accountId, s.linked.email!).pipe(Effect.ignore)))
            : Effect.void))
    })
  })
)

// Deposits (ADR-0015): the customer's Deposit Address, their one-time approval, and any transaction they sign that we
// pay for, co-signed only if it's the one we prepared.
const DepositsHandlers = HttpApiBuilder.group(Api, "deposits", (handlers) =>
  Effect.gen(function*() {
    const deposits = yield* Deposits
    const solana = yield* Solana
    const invalid = (e: { readonly message: string }) => new PurchaseInvalid({ message: e.message })
    const prepared = <E extends { readonly message: string }>(f: (accountId: string) => Effect.Effect<{ transaction: string; token: string }, E>) =>
      CurrentAccount.use((a) => f(a.accountId)).pipe(Effect.map((p) => new PreparedTransaction(p)), Effect.mapError(invalid))
    return handlers.handleAll({
      account: () => CurrentAccount.use((a) => deposits.account(a.accountId)).pipe(Effect.catchTag("SolanaUnavailable", (e) => Effect.flatMap(chainUnavailable(e), Effect.fail))),
      address: () => CurrentAccount.use((a) => deposits.status(a.accountId)).pipe(Effect.map((d) => new DepositAddress(d)), Effect.mapError(invalid)),
      approval: ({ payload }) =>
        CurrentAccount.use((a) => deposits.approval(a.accountId, payload.mode)).pipe(Effect.map((p) => new PreparedTransaction(p)), Effect.mapError(invalid)),
      submit: ({ payload }) =>
        solana.cosign(payload.transaction, payload.token).pipe(
          Effect.tap(() => deposits.nudge),
          Effect.map((o) => new Submitted({ signature: o.signature })),
          Effect.mapError(invalid)
        ),
      withdrawal: ({ payload }) => prepared((a) => deposits.withdrawal(a, payload.amount, payload.to)),
      limits: ({ payload }) => prepared((a) => deposits.limits(a, BigInt(payload.perPurchase), BigInt(payload.daily))),
      defaultMode: ({ payload }) => prepared((a) => deposits.defaultMode(a, payload.mode)),
      reclaim: ({ payload }) => prepared((a) => deposits.reclaim(a, payload.purchaseId))
    })
  })
)

const SessionHandlers = HttpApiBuilder.group(Api, "session", (handlers) =>
  Effect.gen(function*() {
    const auth = yield* Auth
    return handlers.handleAll({
      // The session to end is the one this request came with; this browser drops its cookie either way.
      signOut: () => Effect.flatMap(sessionToken, auth.signOut).pipe(Effect.andThen(dropCookie)),
      signOutEverywhere: () => CurrentAccount.use((a) => auth.signOutEverywhere(a.accountId)).pipe(Effect.andThen(dropCookie))
    })
  })
)

const PurchaseHandlers = HttpApiBuilder.group(Api, "purchases", (handlers) =>
  Effect.gen(function*() {
    const purchases = yield* Purchases
    const connect = yield* Connect
    return handlers.handleAll({
      create: ({ payload }) => CurrentAccount.use((a) => purchases.create(a.accountId, payload)),
      createCart: ({ payload }) => CurrentAccount.use((a) => purchases.createCart(a.accountId, payload.items)),
      list: ({ query }) => CurrentAccount.use((a) => purchases.list(a.accountId, { before: query.before })),
      get: ({ params }) =>
        UUID.test(params.id)
          ? CurrentAccount.use((a) => purchases.get(a.accountId, params.id))
          : Effect.fail(new NotFound()),
      cancel: ({ params }) =>
        UUID.test(params.id)
          ? CurrentAccount.use((a) => purchases.cancel(a.accountId, params.id))
          : Effect.fail(new NotFound()),
      setUsed: ({ params, payload }) =>
        UUID.test(params.id)
          ? CurrentAccount.use((a) => purchases.setUsed(a.accountId, params.id, payload.used))
          : Effect.fail(new NotFound()),
      checkoutEmail: () => CurrentAccount.use((a) => purchases.checkoutEmail(a.accountId)),
      setCheckoutEmail: ({ payload }) => CurrentAccount.use((a) => purchases.setCheckoutEmail(a.accountId, payload.email)),
      connectBitrefill: () => CurrentAccount.use((a) => Effect.map(connect.url(a.accountId), (url) => ({ url }))),
      finishBitrefill: ({ payload }) => CurrentAccount.use((a) => Effect.andThen(connect.finish(a.accountId, payload.code, payload.state), purchases.checkoutEmail(a.accountId))),
      disconnectBitrefill: () => CurrentAccount.use((a) => Effect.andThen(connect.disconnect(a.accountId), purchases.checkoutEmail(a.accountId)))
    })
  })
)

const TelegramHandlers = HttpApiBuilder.group(Api, "telegram", (handlers) =>
  Effect.gen(function*() {
    const telegram = yield* Telegram
    return handlers.handleAll({
      status: () => CurrentAccount.use((a) => telegram.status(a.accountId)),
      unlink: () => CurrentAccount.use((a) => telegram.unlink(a.accountId))
    })
  })
)

const TopUpHandlers = HttpApiBuilder.group(Api, "topup", (handlers) =>
  Effect.gen(function*() {
    const topup = yield* TopUp
    return handlers.handleAll({
      assets: () => topup.assets,
      quote: ({ payload }) => CurrentAccount.use((a) => topup.quote(a.accountId, payload.originAsset, payload.usdc, payload.refundTo, payload.dry ?? false)),
      status: ({ query }) => CurrentAccount.use((a) => topup.status(a.accountId, query.depositAddress)),
      // The transaction it answers is signed in the app and sent to /transactions/submit, like any the customer signs.
      swap: ({ payload }) => CurrentAccount.use((a) => topup.swap(a.accountId, payload.assetId, payload.amount)),
      transfers: () => CurrentAccount.use((a) => topup.transfers(a.accountId)),
      sent: ({ payload }) => CurrentAccount.use((a) => topup.sent(a.accountId, payload.depositAddress, payload.txHash)),
      dismiss: ({ payload }) => CurrentAccount.use((a) => topup.dismiss(a.accountId, payload.depositAddress))
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
      // An id that isn't a UUID matches nothing (Postgres would refuse to compare it).
      purchases: ({ query }) =>
        Effect.andThen(signedInAdmin, query.id !== undefined && !UUID.test(query.id) ? Effect.succeed([]) : admin.purchases(query.account, query.id)),
      users: () => Effect.andThen(signedInAdmin, admin.users),
      sales: ({ payload }) => Effect.flatMap(signedInAdmin, (by) => admin.setSales(payload.open, by)),
      retry: ({ params }) =>
        Effect.flatMap(signedInAdmin, (by): Effect.Effect<void, NotFound | PurchaseInvalid> =>
          UUID.test(params.id) ? admin.retry(params.id, by) : Effect.fail(new NotFound()))
    })
  })
)

const Services = Layer.mergeAll(Telegram.layer, Monitor, Admin.layer, TopUp.layer).pipe(
  // Swap builds on Solana (prepare, simulate), as Deposits does.
  Layer.provideMerge(Layer.mergeAll(Auth.layer, Purchases.layer, Deposits.layer, Swap.layer)),
  Layer.provideMerge(Layer.mergeAll(Sales.layer, Connect.layer)),
  Layer.provideMerge(Layer.mergeAll(Bitrefill.layer, Solana.layer.pipe(Layer.provide(Chain.layer)), OneClick.layer, Alerts.layer)),
  Layer.provideMerge(DbLive)
)

// On mainnet, refuse to start half-configured instead of falling back to testnet defaults,
// PGlite, or sessions that end on restart.
const MAINNET_REQUIRES = [
  "DATABASE_URL",
  "WEB_ORIGIN",
  "SESSION_SECRET",
  "REDEMPTION_KEY",
  // This deployment's program, a paid RPC, and our three keys (ADR-0015).
  "SOLANA_PROGRAM_ID",
  "SOLANA_RPC_URL",
  "SOLANA_OPERATOR_SECRET_KEY",
  "SOLANA_FEE_PAYER_SECRET_KEY",
  "SOLANA_PAY_WALLET_SECRET_KEY",
  // Sign-in (ADR-0015).
  "PRIVY_APP_ID",
  // The key only reads the catalog and prices; orders go through the guest client (ADR-0012).
  "BITREFILL_API_KEY",
  "BITREFILL_CLIENT_ID",
  "BITREFILL_CLIENT_SECRET",
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

const Routes = Layer.mergeAll(
  HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide([SystemHandlers, CatalogHandlers, AuthHandlers, SessionHandlers, PurchaseHandlers, TelegramHandlers, TopUpHandlers, AdminHandlers, DepositsHandlers]),
    Layer.provide(AuthorizationLive)
  ),
  // Read-only tools for other AI agents (Mcp.ts).
  McpRoute,
  // Bitrefill sends the customer's browser back here after they log in. No session here: it checks the reply and
  // forwards the code to the Wallet page, which finishes connecting in the customer's own session.
  Layer.unwrap(Effect.gen(function*() {
    const connect = yield* Connect
    return HttpRouter.add("GET", "/bitrefill/callback", (request) =>
      Effect.map(connect.callback(new URL(request.url, "http://callback").searchParams), (to) => HttpServerResponse.redirect(to)))
  })),
  DepositsWebhook
).pipe(Layer.provide(Services))

const Server = Layer.unwrap(
  Effect.gen(function*() {
    const missing = (yield* Cluster) === "mainnet" ? mainnetProblems(process.env) : []
    if (missing.length > 0) return yield* Effect.die(`SOLANA_CLUSTER=mainnet also needs ${missing.join(", ")}`)
    // Refuses to start with keys that aren't the program's: every admission, settlement and payment would fail.
    if (process.env.SOLANA_OPERATOR_SECRET_KEY) yield* checkKeys.pipe(Effect.provide(Solana.layer.pipe(Layer.provide(Chain.layer))))
    const port = yield* Config.Port("PORT").pipe(Config.withDefault(8787))
    // On the VM, HOST=127.0.0.1 so only nginx can reach the server.
    const host = yield* Config.String("HOST").pipe(Config.option)
    const webOrigin = yield* Config.String("WEB_ORIGIN").pipe(Config.withDefault("http://localhost:3000"))
    // More sites that may call this server (exact origins, comma-separated), e.g. testnet's own domain.
    const more = (yield* Config.String("CORS_ORIGINS").pipe(Config.withDefault(""))).split(",").map((o) => o.trim()).filter(Boolean)
    return HttpRouter.serve(Layer.mergeAll(Routes, edge([webOrigin, ...more]))).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { port, ...(host._tag === "Some" ? { host: host.value } : {}) }))
    )
  })
)

// Run as `node src/main.ts` (pm2, pnpm start/dev); a test that imports the handlers starts nothing.
if (import.meta.main) Layer.launch(Server).pipe(NodeRuntime.runMain)
