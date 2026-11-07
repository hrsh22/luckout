import { Challenge, Session, type SignedChallenge, Unauthorized } from "@luckout/api"
import { Config, Context, Effect, Layer, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { Near } from "./Near.ts"

const MESSAGE = "Sign in to Luckout"
const RECIPIENT = "luckout"
const NONCE_TTL_MINUTES = 5
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export class Auth extends Context.Service<Auth, {
  readonly challenge: Effect.Effect<Challenge>
  verify(signed: SignedChallenge): Effect.Effect<Session, Unauthorized>
  /** The account a session token belongs to. */
  authenticate(token: string): Effect.Effect<string, Unauthorized>
}>()("luckout/Auth") {
  static readonly layer = Layer.effect(
    Auth,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const near = yield* Near
      const configured = yield* Config.option(Config.Redacted("SESSION_SECRET"))
      if (Option.isNone(configured)) yield* Effect.logWarning("SESSION_SECRET not set: sessions end when the server restarts")
      const secret = Option.match(configured, { onNone: () => randomBytes(32), onSome: (s) => Buffer.from(Redacted.value(s)) })

      const mac = (payload: string) => createHmac("sha256", secret).update(payload).digest("base64url")
      const denied = (message: string) => new Unauthorized({ message })

      const challenge = Effect.gen(function*() {
        const nonce = randomBytes(32).toString("base64")
        yield* sql`DELETE FROM auth_nonces WHERE expires_at < now()`
        yield* sql`INSERT INTO auth_nonces (nonce, expires_at) VALUES (${nonce}, now() + make_interval(mins => ${NONCE_TTL_MINUTES}))`
        return new Challenge({ message: MESSAGE, recipient: RECIPIENT, nonce })
      }).pipe(Effect.orDie)

      const verify = Effect.fn("Auth.verify")(function*(signed: SignedChallenge) {
        // Single use: the nonce is deleted whether or not the signature checks out.
        const used = yield* sql`DELETE FROM auth_nonces WHERE nonce = ${signed.nonce} AND expires_at > now() RETURNING nonce`
          .pipe(Effect.orDie)
        if (used.length === 0) return yield* denied("Sign-in request expired; try again")
        const ok = yield* near.verifySignIn({
          accountId: signed.accountId,
          publicKey: signed.publicKey,
          signature: Buffer.from(signed.signature, "base64"),
          message: MESSAGE,
          recipient: RECIPIENT,
          nonce: Buffer.from(signed.nonce, "base64")
        })
        if (!ok) return yield* denied("Signature is not from a full-access key of this account")
        const expiresAt = Date.now() + SESSION_TTL_MS
        const payload = Buffer.from(JSON.stringify({ a: signed.accountId, e: expiresAt })).toString("base64url")
        return new Session({ accountId: signed.accountId, token: `${payload}.${mac(payload)}`, expiresAt })
      })

      const authenticate = (token: string) =>
        Effect.gen(function*() {
          const [payload = "", tag = ""] = token.split(".")
          const expected = Buffer.from(mac(payload))
          const given = Buffer.from(tag)
          if (given.length !== expected.length || !timingSafeEqual(given, expected)) return yield* denied("Invalid session")
          const session = yield* Effect.try({
            try: () => JSON.parse(Buffer.from(payload, "base64url").toString()) as { a: string; e: number },
            catch: () => denied("Invalid session")
          })
          if (typeof session.a !== "string" || typeof session.e !== "number") return yield* denied("Invalid session")
          if (Date.now() > session.e) return yield* denied("Session expired; sign in again")
          return session.a
        })

      return Auth.of({ challenge, verify, authenticate })
    })
  )
}
