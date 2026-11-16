import { BitrefillUnavailable, PurchaseInvalid } from "@luckout/api"
import { Config, Context, Effect, Layer, Option, Redacted, Schedule, Schema, Semaphore } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { createHash, randomBytes } from "node:crypto"
import { Bitrefill, MCP_RESOURCE } from "./Bitrefill.ts"
import { SealKey, sealWith, unsealWith } from "./Seal.ts"

// Connect Bitrefill (ADR-0012): a customer logs in to their own Bitrefill account from our site, and from then
// on their cards are ordered on it, under its limits instead of a guest's. We still pay every invoice from the
// Base Wallet. One Bitrefill Connection per account, its tokens sealed. An access token lasts 6 hours and a
// refresh token 7 days; a refresh token works once, and the reply carries the next one, saved before use.

const Tokens = Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String, expires_in: Schema.Number })
type Tokens = typeof Tokens.Type
/** Who started connecting and their PKCE verifier, sealed into the OAuth `state`, so no table holds them. */
interface State {
  readonly account: string
  readonly verifier: string
  readonly until: number
}
const STATE = "bitrefill-state"
const STATE_TTL_MS = 10 * 60_000
/** An access token this close to its end is renewed first, so it never lapses on its way to Bitrefill. */
const EARLY_MS = 5 * 60_000

export class Connect extends Context.Service<Connect, {
  /** Customers can connect here: guest checkout, with our redirect URI registered at Bitrefill (BITREFILL_REDIRECT_URI). */
  readonly offered: boolean
  /** Where the customer logs in to Bitrefill. */
  url(accountId: string): Effect.Effect<string, PurchaseInvalid>
  /** Bitrefill sends the browser back with these: saves the connection, and says where to send the browser next. */
  callback(query: URLSearchParams): Effect.Effect<string>
  connected(accountId: string): Effect.Effect<boolean>
  /**
   * An access token for the customer's own account, renewed first if it's about to end (or `renew`, after a 401);
   * undefined if they have no connection, or it just lapsed (Bitrefill refused the refresh, so it's deleted).
   */
  token(accountId: string, renew?: boolean): Effect.Effect<string | undefined, BitrefillUnavailable>
  /** Revokes the login at Bitrefill and forgets it. */
  disconnect(accountId: string): Effect.Effect<void>
}>()("luckout/Connect") {
  static readonly layer = Layer.effect(
    Connect,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const bitrefill = yield* Bitrefill
      const key = yield* SealKey
      const restUrl = yield* Config.String("BITREFILL_API_URL").pipe(Config.withDefault("https://api.bitrefill.com/v2"))
      const clientId = Option.getOrElse(yield* Config.option(Config.String("BITREFILL_CLIENT_ID")), () => "")
      const clientSecret = Option.match(yield* Config.option(Config.Redacted("BITREFILL_CLIENT_SECRET")), { onNone: () => "", onSome: Redacted.value })
      const redirectUri = yield* Config.option(Config.String("BITREFILL_REDIRECT_URI"))
      const webOrigin = yield* Config.String("WEB_ORIGIN").pipe(Config.withDefault("http://localhost:3000"))
      const offered = bitrefill.guest && Option.isSome(redirectUri) && Option.isSome(key)
      const issuer = new URL("/oauth/mcp", restUrl).href
      const http = (yield* HttpClient.HttpClient).pipe(HttpClient.timeout("15 seconds"))

      const seal = (aad: string, data: unknown) => sealWith(Option.getOrThrow(key), aad, data)
      const unseal = <A>(aad: string, sealed: string) => unsealWith(Option.getOrThrow(key), aad, sealed) as A

      /** Bitrefill's token endpoint. "invalid_grant": that code or refresh token is spent, expired or revoked. */
      const grant = (params: Record<string, string>) =>
        HttpClientRequest.post(new URL("/oauth/mcp/token", restUrl).href).pipe(
          HttpClientRequest.bodyUrlParams({ ...params, client_id: clientId, client_secret: clientSecret, resource: MCP_RESOURCE }),
          http.execute,
          Effect.flatMap((r): Effect.Effect<Tokens | "invalid_grant", unknown> =>
            r.status === 200
              // Never the reply itself in an error: it holds the tokens.
              ? Effect.mapError(Effect.flatMap(r.json, Schema.decodeUnknownEffect(Tokens)), () => "an unreadable token reply")
              : Effect.flatMap(Effect.orElseSucceed(r.json, () => undefined), (body) =>
                (body as { error?: unknown } | undefined)?.error === "invalid_grant" ? Effect.succeed("invalid_grant" as const) : Effect.fail(`HTTP ${r.status}`))
          ),
          Effect.mapError((e) => new BitrefillUnavailable({ message: `Bitrefill login failed: ${e}` }))
        )

      // The tokens are sealed together, bound to their account.
      const save = (accountId: string, t: Tokens) =>
        sql`INSERT INTO bitrefill_connections (account_id, tokens, access_expires_at)
            VALUES (${accountId}, ${seal(`bitrefill:${accountId}`, { access: t.access_token, refresh: t.refresh_token })},
                    ${new Date(Date.now() + t.expires_in * 1000).toISOString()})
            ON CONFLICT (account_id) DO UPDATE SET tokens = EXCLUDED.tokens, access_expires_at = EXCLUDED.access_expires_at, refreshed_at = now()`.pipe(
          Effect.orDie
        )
      const load = (accountId: string) =>
        sql<{ tokens: string; access_expires_at: Date | string }>`SELECT tokens, access_expires_at FROM bitrefill_connections WHERE account_id = ${accountId}`.pipe(
          Effect.orDie,
          Effect.map(([r]) => r && { ...unseal<{ access: string; refresh: string }>(`bitrefill:${accountId}`, r.tokens), expiresAt: new Date(r.access_expires_at).getTime() })
        )

      // A refresh token works once, so one account's renewals (and connecting, disconnecting) take turns.
      // ponytail: locks in memory, one server process (ADR-0006); a row lock if it ever scales out.
      const locks = new Map<string, Semaphore.Semaphore>()
      const locked = <A, E>(accountId: string, self: Effect.Effect<A, E>) => {
        const lock = locks.get(accountId) ?? Semaphore.makeUnsafe(1)
        locks.set(accountId, lock)
        return lock.withPermits(1)(self)
      }

      const token = (accountId: string, renew = false) =>
        !offered ? Effect.succeed(undefined) : locked(accountId, Effect.gen(function*() {
          const t = yield* load(accountId)
          if (!t) return undefined
          if (!renew && t.expiresAt - EARLY_MS > Date.now()) return t.access
          const next = yield* grant({ grant_type: "refresh_token", refresh_token: t.refresh })
          if (next === "invalid_grant") {
            yield* sql`DELETE FROM bitrefill_connections WHERE account_id = ${accountId}`.pipe(Effect.orDie)
            yield* Effect.logWarning(`${accountId}'s Bitrefill login lapsed (Bitrefill refused its refresh); they need to connect again`)
            return undefined
          }
          // The old refresh token is spent: the new one is saved before anything uses it.
          yield* save(accountId, next)
          return next.access_token
        }))

      const url = (accountId: string) =>
        Effect.suspend(() => {
          if (!offered || Option.isNone(redirectUri)) return Effect.fail(new PurchaseInvalid({ message: "Connecting a Bitrefill account isn't available here." }))
          const verifier = randomBytes(32).toString("base64url")
          const state: State = { account: accountId, verifier, until: Date.now() + STATE_TTL_MS }
          const u = new URL("/oauth/mcp/authorize", restUrl)
          u.search = new URLSearchParams({
            response_type: "code",
            client_id: clientId,
            redirect_uri: redirectUri.value,
            scope: "mcp",
            resource: MCP_RESOURCE,
            // URL-safe, so no "+" comes back as a space (unsealing reads either alphabet).
            state: Buffer.from(seal(STATE, state), "base64").toString("base64url"),
            code_challenge: createHash("sha256").update(verifier).digest("base64url"),
            code_challenge_method: "S256"
          }).toString()
          return Effect.succeed(u.href)
        })

      const openState = (sealed: string | null) => {
        try {
          const s = unseal<State>(STATE, sealed ?? "")
          return s.until > Date.now() ? s : undefined
        } catch {
          return undefined
        }
      }

      // Anyone can call this, so it trusts only the sealed state, and Bitrefill (the issuer) for the code.
      const callback = (q: URLSearchParams) => {
        const back = (outcome: "connected" | "failed") => `${webOrigin}/wallet?bitrefill=${outcome}`
        const refuse = (why: string) => Effect.as(Effect.logWarning(`Bitrefill connect failed: ${why}`), back("failed"))
        return Effect.gen(function*() {
          if (!offered || Option.isNone(redirectUri)) return yield* refuse("not offered here")
          const s = openState(q.get("state"))
          if (!s) return yield* refuse("state missing, altered or expired")
          if (q.get("iss") !== issuer) return yield* refuse(`${s.account}: the reply isn't from Bitrefill`)
          const code = q.get("code")
          // Declined at Bitrefill (access_denied) or anything else without a code.
          if (!code) return yield* refuse(`${s.account}: ${(q.get("error") ?? "no code").slice(0, 60)}`)
          const t = yield* grant({ grant_type: "authorization_code", code, redirect_uri: redirectUri.value, code_verifier: s.verifier })
          if (t === "invalid_grant") return yield* refuse(`${s.account}: Bitrefill refused the code`)
          yield* locked(s.account, save(s.account, t))
          yield* Effect.log(`${s.account} connected their Bitrefill account`)
          return back("connected")
        }).pipe(Effect.catch((e) => refuse(e.message)))
      }

      const connected = (accountId: string) =>
        !offered ? Effect.succeed(false) : sql`SELECT 1 FROM bitrefill_connections WHERE account_id = ${accountId}`.pipe(
          Effect.orDie,
          Effect.map((r) => r.length > 0)
        )

      const disconnect = (accountId: string) =>
        locked(accountId, Effect.gen(function*() {
          const t = yield* load(accountId)
          if (!t) return
          // Revoking the refresh token ends its access tokens too. If Bitrefill doesn't answer, the login is
          // still forgotten here, and its refresh token lapses unused within 7 days.
          yield* HttpClientRequest.post(new URL("/oauth/mcp/revoke", restUrl).href).pipe(
            HttpClientRequest.bodyUrlParams({ token: t.refresh, token_type_hint: "refresh_token", client_id: clientId, client_secret: clientSecret }),
            http.execute,
            Effect.flatMap((r) => (r.status === 200 ? Effect.void : Effect.fail(`HTTP ${r.status}`))),
            Effect.catch((e) => Effect.logWarning(`revoking ${accountId}'s Bitrefill login failed: ${e}`))
          )
          yield* sql`DELETE FROM bitrefill_connections WHERE account_id = ${accountId}`.pipe(Effect.orDie)
        }))

      // Daily: a connection unused for 5 days is renewed, so an idle customer's refresh token (7 days) never lapses.
      const sweep = sql<{ account_id: string }>`SELECT account_id FROM bitrefill_connections WHERE refreshed_at < now() - interval '5 days'`.pipe(
        Effect.orDie,
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (r) => token(r.account_id, true).pipe(Effect.catch((e) => Effect.logWarning(`renewing ${r.account_id}'s Bitrefill login: ${e.message}`))), {
            discard: true
          })
        ),
        Effect.catchCause((cause) => Effect.logError("renewing Bitrefill logins failed", cause))
      )
      if (offered) yield* sweep.pipe(Effect.repeat(Schedule.spaced("1 day")), Effect.forkScoped)

      return Connect.of({ offered, url, callback, connected, token, disconnect })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
}
