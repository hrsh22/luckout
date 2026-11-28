import { Authorization, CurrentAccount, Session, sessionCookie, Unauthorized, Wallet, walletOf } from "@luckout/api"
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { SqlClient } from "effect/sql"
import { createHmac, createPublicKey, type KeyObject, randomBytes, timingSafeEqual, verify as verifySignature } from "node:crypto"
import { Cluster, ProgramId } from "./Solana.ts"

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** A new session: its token goes into the cookie (startSession), never into an answer's body. */
export interface SignedIn {
  readonly accountId: string
  readonly wallet: Wallet
  readonly token: string
  readonly expiresAt: number
}

/** What the customer linked in Privy, besides their wallet: their email, and their Telegram account. */
export interface Linked {
  readonly email?: string
  readonly telegram?: { readonly id: string; readonly name: string }
}

/** Privy's tokens from the browser: the access token says who, the identity token what they linked. */
export interface PrivyTokens {
  readonly accessToken: string
  readonly identityToken: string
}

/** One of the accounts in an identity token's `linked_accounts`, as far as we read it. */
interface PrivyAccount {
  readonly type?: string
  readonly address?: string
  readonly email?: string
  readonly chain_type?: string
  readonly wallet_client_type?: string
  readonly telegram_user_id?: string | number
  readonly username?: string | null
  readonly first_name?: string | null
}

/**
 * A JWT's claims if it's an ES256 token signed by one of `keys`; "unknown key" if it names a key we don't have
 * (Privy rotated them); undefined for anything else.
 */
export const jwtClaims = (token: string, keys: ReadonlyMap<string, KeyObject>): Record<string, unknown> | "unknown key" | undefined => {
  const [h, p, sig, ...rest] = token.split(".")
  if (!h || !p || !sig || rest.length > 0) return undefined
  try {
    const header = JSON.parse(Buffer.from(h, "base64url").toString()) as { alg?: unknown; kid?: unknown }
    if (header.alg !== "ES256") return undefined
    const key = typeof header.kid === "string" ? keys.get(header.kid) : undefined
    if (!key) return "unknown key"
    const ok = verifySignature("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"))
    return ok ? (JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export class Auth extends Context.Service<Auth, {
  /** Signs in with Privy's tokens: the account is the customer's Privy Solana wallet (ADR-0015). */
  privy(tokens: PrivyTokens): Effect.Effect<SignedIn & { readonly linked: Linked }, Unauthorized>
  /** The account a session token belongs to, and the kind of wallet it signed in with. */
  authenticate(token: string): Effect.Effect<{ readonly accountId: string; readonly wallet: Wallet }, Unauthorized>
  /** Ends the one session `token` is, so a copy of it kept elsewhere stops working. */
  signOut(token: string): Effect.Effect<void>
  /** Ends every session the account has now, on every device. */
  signOutEverywhere(accountId: string): Effect.Effect<void>
}>()("luckout/Auth") {
  static readonly layer = Layer.effect(
    Auth,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      // Bound to its deployment: staging and production share mainnet, so their programs tell them apart.
      const cluster = yield* Cluster
      const programId = (yield* ProgramId).toBase58()
      const appId = yield* Config.String("PRIVY_APP_ID").pipe(Config.withDefault(""))
      const jwksUrl = yield* Config.String("PRIVY_JWKS_URL").pipe(Config.withDefault(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`))
      const configured = yield* Config.option(Config.Redacted("SESSION_SECRET"))
      if (Option.isNone(configured)) yield* Effect.logWarning("SESSION_SECRET not set: sessions end when the server restarts")
      const secret = Option.match(configured, { onNone: () => randomBytes(32), onSome: (s) => Buffer.from(Redacted.value(s)) })

      const mac = (payload: string) => createHmac("sha256", secret).update(payload).digest("base64url")
      const denied = (message: string) => new Unauthorized({ message })

      // Privy's signing keys, fetched when first needed and again when a token names one we don't have (at most once a minute).
      let keys = new Map<string, KeyObject>()
      let fetchedAt = 0
      const fetchKeys = Effect.tryPromise(async () => {
        const res = await fetch(jwksUrl, { signal: AbortSignal.timeout(10_000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { keys?: Array<{ kid?: string; kty?: string } & Record<string, unknown>> }
        keys = new Map((body.keys ?? []).filter((k) => k.kid && k.kty === "EC").map((k) => [k.kid!, createPublicKey({ key: k as never, format: "jwk" })]))
        fetchedAt = Date.now()
      }).pipe(Effect.tapError((e) => Effect.logWarning(`couldn't read Privy's keys: ${e}`)), Effect.orElseSucceed(() => undefined))

      /** A Privy token's claims, checked: signed by Privy, for our app, not expired. */
      const privyClaims = (token: string, what: string) =>
        Effect.gen(function*() {
          if (!appId) return yield* denied("Sign-in isn't set up on this server (PRIVY_APP_ID)")
          let claims = jwtClaims(token, keys)
          if (claims === "unknown key" && Date.now() - fetchedAt > 60_000) {
            yield* fetchKeys
            claims = jwtClaims(token, keys)
          }
          if (!claims || claims === "unknown key") return yield* denied(`That ${what} isn't from Privy; sign in again`)
          const aud = claims.aud
          if (claims.iss !== "privy.io" || (Array.isArray(aud) ? !aud.includes(appId) : aud !== appId)) return yield* denied(`That ${what} is for another app`)
          if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return yield* denied("Your sign-in expired; sign in again")
          if (typeof claims.sub !== "string") return yield* denied(`That ${what} names nobody`)
          return claims as Record<string, unknown> & { readonly sub: string }
        })

      const privy = Effect.fn("Auth.privy")(function*(tokens: PrivyTokens) {
        const access = yield* privyClaims(tokens.accessToken, "access token")
        const identity = yield* privyClaims(tokens.identityToken, "identity token")
        if (identity.sub !== access.sub) return yield* denied("Those tokens are for two different people; sign in again")
        const linked = yield* Effect.try({
          try: () => {
            const raw = identity.linked_accounts
            return (typeof raw === "string" ? JSON.parse(raw) : raw ?? []) as ReadonlyArray<PrivyAccount>
          },
          catch: () => denied("Privy's identity token couldn't be read; sign in again")
        })
        // Everyone has a Privy Solana wallet, even one who signs in with Phantom: their account belongs to it.
        const wallet = linked.find((a) => a.type === "wallet" && a.chain_type === "solana" && a.wallet_client_type === "privy")?.address
        if (!wallet) return yield* denied("Your Solana wallet is still being made; try again in a moment")
        const email = linked.find((a) => a.type === "email")?.address ?? linked.find((a) => a.type === "google_oauth")?.email
        const tg = linked.find((a) => a.type === "telegram" && a.telegram_user_id !== undefined)
        const telegram = tg ? { id: String(tg.telegram_user_id), name: tg.username ?? tg.first_name ?? "" } : undefined
        // The bot knows the customer by the Telegram account they linked in Privy (its private chat has the user's id).
        // Unlinking it in Privy unlinks it here too.
        yield* sql.withTransaction(Effect.gen(function*() {
          if (!telegram) return yield* sql`DELETE FROM telegram_links WHERE account_id = ${wallet}`
          yield* sql`DELETE FROM telegram_links WHERE account_id = ${wallet} OR telegram_user_id = ${telegram.id}`
          yield* sql`INSERT INTO telegram_links (telegram_user_id, account_id, chat_id, telegram_name) VALUES (${telegram.id}, ${wallet}, ${telegram.id}, ${telegram.name})`
        })).pipe(Effect.orDie)
        const signedIn = yield* issue(wallet, "solana")
        return { ...signedIn, linked: { ...(email ? { email } : {}), ...(telegram ? { telegram } : {}) } }
      })

      const issue = (accountId: string, wallet: Wallet) =>
        Effect.gen(function*() {
          // Remembered so the solvency check can count this customer's balance (Monitor).
          yield* sql`INSERT INTO known_accounts (account_id) VALUES (${accountId}) ON CONFLICT DO NOTHING`.pipe(Effect.orDie)
          const issuedAt = Date.now()
          const expiresAt = issuedAt + SESSION_TTL_MS
          // `c`: staging and production share mainnet, so the program, not the cluster, says which deployment it's for.
          const payload = Buffer.from(JSON.stringify({ a: accountId, e: expiresAt, n: cluster, c: programId, i: issuedAt, w: wallet })).toString("base64url")
          return { accountId, wallet, token: `${payload}.${mac(payload)}`, expiresAt } satisfies SignedIn
        })

      const authenticate = (token: string) =>
        Effect.gen(function*() {
          const [payload = "", tag = ""] = token.split(".")
          const expected = Buffer.from(mac(payload))
          const given = Buffer.from(tag)
          if (given.length !== expected.length || !timingSafeEqual(given, expected)) return yield* denied("Invalid session")
          const session = yield* Effect.try({
            try: () => JSON.parse(Buffer.from(payload, "base64url").toString()) as { a: string; e: number; n: string; c?: unknown; i: number; w?: unknown },
            catch: () => denied("Invalid session")
          })
          if (
            typeof session.a !== "string" || typeof session.e !== "number" || typeof session.i !== "number" || session.n !== cluster ||
            session.c !== programId
          ) {
            return yield* denied("Invalid session")
          }
          if (Date.now() > session.e) return yield* denied("Session expired; sign in again")
          const [state] = yield* sql<{ after: Date | string | null; ended: boolean }>`
            SELECT (SELECT after FROM session_resets WHERE account_id = ${session.a}) AS after,
                   EXISTS (SELECT 1 FROM ended_sessions WHERE tag = ${tag}) AS ended`.pipe(Effect.orDie)
          if (state?.ended) return yield* denied("Signed out; sign in again")
          if (state?.after && session.i <= new Date(state.after).getTime()) return yield* denied("Signed out everywhere; sign in again")
          // Signed by us, so `w` is one we wrote; tokens from before it named no wallet, and none of those was Solana.
          return { accountId: session.a, wallet: Schema.is(Wallet)(session.w) ? session.w : walletOf(session.a) }
        })

      // A token is its own proof until it expires, so ending one early means remembering it until then
      // (by its signature, never the token itself). Ones past their expiry are cleared as others are added.
      const signOut = (token: string) =>
        Effect.gen(function*() {
          const [payload = "", tag = ""] = token.split(".")
          const expiresAt = yield* Effect.try(() => Number((JSON.parse(Buffer.from(payload, "base64url").toString()) as { e: number }).e)).pipe(Effect.orElseSucceed(() => Number.NaN))
          if (!tag || !Number.isFinite(expiresAt)) return
          yield* sql`DELETE FROM ended_sessions WHERE expires_at < now()`
          yield* sql`INSERT INTO ended_sessions (tag, expires_at) VALUES (${tag}, ${new Date(expiresAt).toISOString()}) ON CONFLICT DO NOTHING`
        }).pipe(Effect.orDie)

      const signOutEverywhere = (accountId: string) =>
        sql`INSERT INTO session_resets (account_id, after) VALUES (${accountId}, now())
            ON CONFLICT (account_id) DO UPDATE SET after = now()`.pipe(Effect.asVoid, Effect.orDie)

      return Auth.of({ privy, authenticate, signOut, signOutEverywhere })
    })
  )
}

// The session cookie (ADR-0006, amended 2026-11-17): HttpOnly and Secure (securitySetCookie's defaults), so only
// the browser holds it and only over HTTPS (or http://localhost); SameSite=Lax, so other sites' requests go
// without it. Edge.ts refuses changes from our sibling sites, which SameSite counts as the same site.
const COOKIE = { sameSite: "lax", path: "/" } as const

/** Answers a sign-in: the token is set as the session cookie, lasting as long as the token, and the body says who and until when. */
export const startSession = <E, R>(signedIn: Effect.Effect<SignedIn, E, R>) =>
  Effect.flatMap(signedIn, (s) =>
    Effect.as(
      HttpApiBuilder.securitySetCookie(sessionCookie, s.token, { ...COOKIE, expires: new Date(s.expiresAt) }),
      new Session({ accountId: s.accountId, wallet: s.wallet, expiresAt: s.expiresAt })
    ))

/** The session token the request came with, "" without one. */
export const sessionToken = Effect.map(HttpServerRequest.HttpServerRequest, (r) => r.cookies[sessionCookie.key] ?? "")

/** Tells the browser to drop the session cookie. */
export const dropCookie = HttpApiBuilder.securitySetCookie(sessionCookie, "", { ...COOKIE, maxAge: 0 })

/** Signs in every call to an endpoint behind `Authorization`, by the session cookie it carries. */
export const AuthorizationLive = Layer.effect(
  Authorization,
  Effect.gen(function*() {
    const auth = yield* Auth
    return Authorization.of({
      cookie: (httpEffect, { credential }) =>
        Effect.flatMap(auth.authenticate(Redacted.value(credential)), (who) => Effect.provideService(httpEffect, CurrentAccount, who))
    })
  })
)
