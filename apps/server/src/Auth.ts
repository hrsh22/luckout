import {
  Authorization,
  base58Decode,
  Challenge,
  CurrentAccount,
  evmSignInMessage,
  Session,
  sessionCookie,
  type SignedChallenge,
  type SignedEvmChallenge,
  type SignedSolanaChallenge,
  solanaAccountId,
  solanaSignInMessage,
  Unauthorized,
  Wallet,
  walletOf
} from "@luckout/api"
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { SqlClient } from "effect/sql"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { getAddress, verifyMessage } from "viem"
import { ed25519Signed } from "./Intents.ts"
import { Near, Network } from "./Near.ts"

const NONCE_TTL_MINUTES = 5
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** A new session: its token goes into the cookie (startSession), never into an answer's body. */
export interface SignedIn {
  readonly accountId: string
  readonly wallet: Wallet
  readonly token: string
  readonly expiresAt: number
}

export class Auth extends Context.Service<Auth, {
  readonly challenge: Effect.Effect<Challenge>
  verify(signed: SignedChallenge): Effect.Effect<SignedIn, Unauthorized>
  /** EVM sign-in (ADR-0011): a personal_sign of `evmSignInMessage`, made on one of our own sites, by a regular EVM account (EOA). */
  verifyEvm(signed: SignedEvmChallenge): Effect.Effect<SignedIn, Unauthorized>
  /** Solana sign-in (ADR-0011): an ed25519 signature of `solanaSignInMessage`, made on one of our own sites. */
  verifySolana(signed: SignedSolanaChallenge): Effect.Effect<SignedIn, Unauthorized>
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
      const near = yield* Near
      // Bound to its network: the wallet shows which one, and a session from the other one is refused.
      const network = yield* Network
      const message = `Sign in to Luckout (${network})`
      // The sites a sign-in may come from: the same ones main.ts lets call this server.
      const webOrigin = yield* Config.String("WEB_ORIGIN").pipe(Config.withDefault("http://localhost:3000"))
      const sites = new Set([webOrigin, ...(yield* Config.String("CORS_ORIGINS").pipe(Config.withDefault(""))).split(",").map((o) => o.trim()).filter(Boolean)])
      // What a NEAR wallet shows as the message's recipient (NEP-413): our site's host.
      const recipient = new URL(webOrigin).host
      const configured = yield* Config.option(Config.Redacted("SESSION_SECRET"))
      if (Option.isNone(configured)) yield* Effect.logWarning("SESSION_SECRET not set: sessions end when the server restarts")
      const secret = Option.match(configured, { onNone: () => randomBytes(32), onSome: (s) => Buffer.from(Redacted.value(s)) })

      const mac = (payload: string) => createHmac("sha256", secret).update(payload).digest("base64url")
      const denied = (message: string) => new Unauthorized({ message })

      const challenge = Effect.gen(function*() {
        const nonce = randomBytes(32).toString("base64")
        yield* sql`DELETE FROM auth_nonces WHERE expires_at < now()`
        yield* sql`INSERT INTO auth_nonces (nonce, expires_at) VALUES (${nonce}, now() + make_interval(mins => ${NONCE_TTL_MINUTES}))`
        return new Challenge({ message, recipient, nonce })
      }).pipe(Effect.orDie)

      // Single use: the nonce is deleted whether or not the signature checks out.
      const useNonce = (nonce: string) =>
        sql`DELETE FROM auth_nonces WHERE nonce = ${nonce} AND expires_at > now() RETURNING nonce`.pipe(
          Effect.orDie,
          Effect.flatMap((used) => (used.length === 0 ? Effect.fail(denied("Sign-in request expired; try again")) : Effect.void))
        )

      const verify = Effect.fn("Auth.verify")(function*(signed: SignedChallenge) {
        yield* useNonce(signed.nonce)
        const ok = yield* near.verifySignIn({
          accountId: signed.accountId,
          publicKey: signed.publicKey,
          signature: Buffer.from(signed.signature, "base64"),
          message,
          recipient,
          nonce: Buffer.from(signed.nonce, "base64")
        })
        if (!ok) return yield* denied("Signature is not from a full-access key of this account")
        return yield* issue(signed.accountId, walletOf(signed.accountId))
      })

      const verifyEvm = Effect.fn("Auth.verifyEvm")(function*(signed: SignedEvmChallenge) {
        yield* useNonce(signed.nonce)
        const address = signed.address.toLowerCase()
        if (!/^0x[0-9a-f]{40}$/.test(address) || !/^0x[0-9a-fA-F]{130}$/.test(signed.signature)) return yield* denied("That isn't an EVM signature")
        // Only a message made on one of our own sites: the wallet showed that site's name, and warns when the
        // page asking isn't it, so a signature phished on a look-alike site signs nobody in here.
        if (!sites.has(signed.uri)) return yield* denied("Sign in from Luckout's own site")
        // Key recovery only: the same check NEAR Intents makes, so a smart-contract wallet can't sign in here
        // and then find it can't sign intents either. The message is rebuilt from what we expect, never parsed.
        const ok = yield* Effect.tryPromise(async () =>
          verifyMessage({
            address: address as `0x${string}`,
            message: evmSignInMessage({ challenge: { message, nonce: signed.nonce }, address: getAddress(address), uri: signed.uri, chainId: signed.chainId, issuedAt: signed.issuedAt }),
            signature: signed.signature as `0x${string}`
          })
        ).pipe(Effect.orElseSucceed(() => false))
        if (!ok) return yield* denied("That signature isn't from this address. Luckout works with regular EVM accounts, not smart-contract wallets.")
        return yield* issue(address, "evm")
      })

      const verifySolana = Effect.fn("Auth.verifySolana")(function*(signed: SignedSolanaChallenge) {
        yield* useNonce(signed.nonce)
        // The account is the key in hex, as NEAR Intents names it (ADR-0011).
        const accountId = solanaAccountId(signed.address)
        const signature = Buffer.from(signed.signature, "base64")
        if (!accountId || signature.length !== 64) return yield* denied("That isn't a Solana signature")
        if (!sites.has(signed.uri)) return yield* denied("Sign in from Luckout's own site")
        // The same check NEAR Intents makes on the raw bytes, so a wallet that signs in can also sign intents.
        const text = solanaSignInMessage({ challenge: { message, nonce: signed.nonce }, address: signed.address, uri: signed.uri, issuedAt: signed.issuedAt })
        if (!ed25519Signed(base58Decode(signed.address), text, signature)) return yield* denied("That signature isn't from this Solana address.")
        return yield* issue(accountId, "solana")
      })

      const issue = (accountId: string, wallet: Wallet) =>
        Effect.gen(function*() {
          // Remembered so the solvency check can count this customer's balance (Monitor).
          yield* sql`INSERT INTO known_accounts (account_id) VALUES (${accountId}) ON CONFLICT DO NOTHING`.pipe(Effect.orDie)
          const issuedAt = Date.now()
          const expiresAt = issuedAt + SESSION_TTL_MS
          const payload = Buffer.from(JSON.stringify({ a: accountId, e: expiresAt, n: network, i: issuedAt, w: wallet })).toString("base64url")
          return { accountId, wallet, token: `${payload}.${mac(payload)}`, expiresAt } satisfies SignedIn
        })

      const authenticate = (token: string) =>
        Effect.gen(function*() {
          const [payload = "", tag = ""] = token.split(".")
          const expected = Buffer.from(mac(payload))
          const given = Buffer.from(tag)
          if (given.length !== expected.length || !timingSafeEqual(given, expected)) return yield* denied("Invalid session")
          const session = yield* Effect.try({
            try: () => JSON.parse(Buffer.from(payload, "base64url").toString()) as { a: string; e: number; n: string; i: number; w?: unknown },
            catch: () => denied("Invalid session")
          })
          if (typeof session.a !== "string" || typeof session.e !== "number" || typeof session.i !== "number" || session.n !== network) {
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

      return Auth.of({ challenge, verify, verifyEvm, verifySolana, authenticate, signOut, signOutEverywhere })
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
