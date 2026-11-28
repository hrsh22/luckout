import { NodeHttpServer } from "@effect/platform-node"
import { AuthApi, CurrentAccount, SessionApi } from "@luckout/api"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { SqlClient } from "effect/sql"
import assert from "node:assert/strict"
import { createHmac, generateKeyPairSync, type KeyObject, sign } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { Auth, AuthorizationLive, dropCookie, sessionToken, startSession } from "./Auth.ts"
import { DbMemory } from "./Db.ts"
import { edge } from "./Edge.ts"
import { IDL_PROGRAM_ID } from "./Program.ts"

// Privy's side, faked: its signing key, published as a key set on a local server, and the tokens it would issue.
const APP = "app-test"
const privyKey = generateKeyPairSync("ec", { namedCurve: "P-256" })
const jwks = createServer((_, res) => {
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify({ keys: [{ ...privyKey.publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "ES256" }] }))
})
await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", resolve))
jwks.unref()

process.env.SESSION_SECRET = "a-test-secret-that-is-long-enough-for-mainnet"
process.env.WEB_ORIGIN = "https://luckout.test"
process.env.CORS_ORIGINS = "https://www.luckout.test"
process.env.SOLANA_CLUSTER = "localnet"
process.env.PRIVY_APP_ID = APP
process.env.PRIVY_JWKS_URL = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks.json`

const layer = Auth.layer.pipe(Layer.provideMerge(DbMemory))
const run = <A, E>(e: Effect.Effect<A, E, Auth | SqlClient.SqlClient>) => Effect.runPromise(e.pipe(Effect.provide(layer)))

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url")
/** A JWT as Privy signs it (ES256), or as someone else might. */
const jwt = (claims: object, o: { key?: KeyObject; kid?: string; alg?: string } = {}) => {
  const head = `${b64({ alg: o.alg ?? "ES256", typ: "JWT", kid: o.kid ?? "k1" })}.${b64(claims)}`
  return `${head}.${sign("sha256", Buffer.from(head), { key: o.key ?? privyKey.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`
}
const claims = (sub: string, extra: object = {}) => ({ iss: "privy.io", aud: APP, sub, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...extra })
const solanaWallet = (address: string) => ({ type: "wallet", address, chain_type: "solana", wallet_client_type: "privy" })
/** Both tokens for a customer whose Privy wallet is `wallet`, with whatever else they linked. */
const tokens = (wallet: string, linked: ReadonlyArray<object> = [], sub = `did:privy:${wallet}`) => ({
  accessToken: jwt(claims(sub)),
  identityToken: jwt(claims(sub, { linked_accounts: JSON.stringify([solanaWallet(wallet), ...linked]) }))
})

const ALICE = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV"
const DAVE = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"

/** A token as the server mints it, with the same secret. */
const mint = (payload: object) => {
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${p}.${createHmac("sha256", process.env.SESSION_SECRET!).update(p).digest("base64url")}`
}

test("Privy's tokens sign the customer in as their Privy Solana wallet", () =>
  run(Effect.gen(function*() {
    const auth = yield* Auth
    const s = yield* auth.privy(tokens(ALICE, [{ type: "email", address: "alice@example.com" }]))
    assert.equal(s.accountId, ALICE)
    assert.equal(s.linked.email, "alice@example.com")
    assert.equal((yield* auth.authenticate(s.token)).accountId, ALICE)
    // An external wallet (Phantom) is linked too, but the account is still the Privy one.
    const phantom = { type: "wallet", address: DAVE, chain_type: "solana", wallet_client_type: "phantom" }
    assert.equal((yield* auth.privy(tokens(ALICE, [phantom]))).accountId, ALICE)
    // Google's email stands in when there's no email login.
    assert.equal((yield* auth.privy(tokens(ALICE, [{ type: "google_oauth", email: "a@gmail.com" }]))).linked.email, "a@gmail.com")
  })))

test("a token Privy didn't sign, for another app, expired or about someone else is refused", () =>
  run(Effect.gen(function*() {
    const auth = yield* Auth
    const refused = (t: { accessToken: string; identityToken: string }) => Effect.map(Effect.flip(auth.privy(t)), (e) => e.message)
    const ok = tokens(ALICE)
    const stranger = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey
    const me = `did:privy:${ALICE}`
    assert.match(yield* refused({ ...ok, accessToken: jwt(claims(me), { key: stranger }) }), /isn't from Privy/)
    assert.match(yield* refused({ ...ok, accessToken: jwt(claims(me), { key: stranger, kid: "k9" }) }), /isn't from Privy/)
    assert.match(yield* refused({ ...ok, accessToken: jwt(claims(me), { alg: "HS256" }) }), /isn't from Privy/)
    assert.match(yield* refused({ ...ok, accessToken: jwt(claims(me, { aud: "other-app" })) }), /another app/)
    assert.match(yield* refused({ ...ok, accessToken: jwt(claims(me, { iss: "evil" })) }), /another app/)
    assert.match(yield* refused({ ...ok, accessToken: jwt(claims(me, { exp: 1 })) }), /expired/)
    assert.match(yield* refused({ ...ok, accessToken: tokens(DAVE).accessToken }), /two different people/)
    assert.match(yield* refused({ ...ok, identityToken: jwt(claims(me, { linked_accounts: "[]" })) }), /still being made/)
    assert.match(yield* refused({ ...ok, accessToken: "junk" }), /isn't from Privy/)
  })))

test("the Telegram account linked in Privy is the bot's link, and unlinking it there unlinks it here", () =>
  run(Effect.gen(function*() {
    const auth = yield* Auth
    const sql = yield* SqlClient.SqlClient
    const links = sql<{ telegram_user_id: string; account_id: string; chat_id: string; telegram_name: string }>`SELECT * FROM telegram_links`
    yield* auth.privy(tokens(ALICE, [{ type: "telegram", telegram_user_id: "4242", username: "alice_tg" }]))
    assert.deepEqual((yield* links).map((l) => [String(l.telegram_user_id), l.account_id, String(l.chat_id), l.telegram_name]), [["4242", ALICE, "4242", "alice_tg"]])
    // The same Telegram account linked to another customer moves to them.
    yield* auth.privy(tokens(DAVE, [{ type: "telegram", telegram_user_id: 4242, first_name: "Dave" }]))
    assert.deepEqual((yield* links).map((l) => l.account_id), [DAVE])
    yield* auth.privy(tokens(DAVE))
    assert.equal((yield* links).length, 0)
  })))

test("a session works only with the cluster and program it was signed in for: staging and production share mainnet", () =>
  run(Effect.gen(function*() {
    const auth = yield* Auth
    const base = { a: ALICE, e: Date.now() + 60_000, i: Date.now(), w: "solana" }
    const program = IDL_PROGRAM_ID.toBase58()
    assert.equal((yield* auth.authenticate(mint({ ...base, n: "localnet", c: program }))).accountId, ALICE)
    assert.match((yield* Effect.flip(auth.authenticate(mint({ ...base, n: "mainnet", c: program })))).message, /Invalid session/)
    assert.match((yield* Effect.flip(auth.authenticate(mint({ ...base, n: "localnet", c: DAVE })))).message, /Invalid session/)
  })))

test("signing out ends that session only; signing out everywhere ends every earlier one", () =>
  run(Effect.gen(function*() {
    const auth = yield* Auth
    const laptop = yield* auth.privy(tokens(ALICE))
    yield* Effect.sleep("5 millis")
    const phone = yield* auth.privy(tokens(ALICE))
    yield* auth.signOut(laptop.token)
    assert.match((yield* Effect.flip(auth.authenticate(laptop.token))).message, /Signed out/)
    assert.equal((yield* auth.authenticate(phone.token)).accountId, ALICE)
    yield* auth.signOut("not-a-token")
    yield* Effect.sleep("5 millis")
    yield* auth.signOutEverywhere(ALICE)
    assert.match((yield* Effect.flip(auth.authenticate(phone.token))).message, /everywhere/)
    yield* Effect.sleep("5 millis")
    const again = yield* auth.privy(tokens(ALICE))
    assert.equal((yield* auth.authenticate(again.token)).accountId, ALICE)
  })))

// The session as a browser holds it: an HttpOnly cookie that sign-in sets, every call carries, and sign-out
// removes. Served on a real HTTP server behind the same edge as main.ts, with the handlers wired as main.ts
// wires them.

const SessionTestApi = HttpApi.make("session-test").add(AuthApi).add(SessionApi)
const AuthGroup = HttpApiBuilder.group(SessionTestApi, "auth", (handlers) =>
  Effect.gen(function*() {
    const auth = yield* Auth
    return handlers.handleAll({
      privy: ({ payload }) => startSession(auth.privy(payload))
    })
  }))
const SessionGroup = HttpApiBuilder.group(SessionTestApi, "session", (handlers) =>
  Effect.gen(function*() {
    const auth = yield* Auth
    return handlers.handleAll({
      signOut: () => Effect.flatMap(sessionToken, auth.signOut).pipe(Effect.andThen(dropCookie)),
      signOutEverywhere: () => CurrentAccount.use((a) => auth.signOutEverywhere(a.accountId)).pipe(Effect.andThen(dropCookie))
    })
  }))
const SITES = ["https://luckout.test", "https://www.luckout.test"]

const served = <A>(body: (url: string) => Promise<A>) => {
  const node = createServer()
  const app = HttpApiBuilder.layer(SessionTestApi).pipe(Layer.provide([AuthGroup, SessionGroup]), Layer.provide(AuthorizationLive))
  return Effect.runPromise(
    Effect.promise(() => body(`http://127.0.0.1:${(node.address() as AddressInfo).port}`)).pipe(
      Effect.provide(HttpRouter.serve(Layer.mergeAll(app, edge(SITES)), { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provide(NodeHttpServer.layer(() => node, { port: 0, host: "127.0.0.1" })),
        Layer.provide(layer)
      ))
    )
  )
}

test("the session token reaches the browser only as an HttpOnly cookie, which every call carries and sign-out removes", () =>
  served(async (url) => {
    const post = (path: string, headers: Record<string, string> = {}, body?: object) =>
      fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: SITES[0]!, ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const signedIn = await post("/auth/privy", {}, tokens(DAVE))
    assert.equal(signedIn.status, 200)
    const body = await signedIn.json()
    assert.deepEqual(Object.keys(body).sort(), ["accountId", "expiresAt", "wallet"], "no token in the body")
    const setCookie = signedIn.headers.get("set-cookie") ?? ""
    assert.match(setCookie, /^__Host-luckout_session=[\w-]+\.[\w-]+;/)
    for (const part of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", `Expires=${new Date(body.expiresAt).toUTCString()}`]) assert.ok(setCookie.includes(part), `${part} in ${setCookie}`)
    // What a browser asks of a __Host- cookie, or drops it: Secure, Path=/, and no Domain (this host only).
    assert.doesNotMatch(setCookie, /domain=/i)
    const cookie = setCookie.split(";")[0]!
    const token = cookie.slice("__Host-luckout_session=".length)
    assert.equal(await run(Effect.gen(function*() {
      return (yield* (yield* Auth).authenticate(token)).accountId
    })), DAVE)

    // Our site's own calls may carry it, with credentials; another site's may not even ask.
    const preflight = (origin: string) => fetch(`${url}/session/sign-out`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } })
    const ours = await preflight(SITES[1]!)
    assert.equal(ours.headers.get("access-control-allow-origin"), SITES[1])
    assert.equal(ours.headers.get("access-control-allow-credentials"), "true")
    assert.equal((await preflight("https://evil.test")).headers.get("access-control-allow-origin"), null)

    // Only the cookie signs a call in; the token as a bearer header no longer does.
    assert.equal((await post("/session/sign-out")).status, 401)
    assert.equal((await post("/session/sign-out", { authorization: `Bearer ${token}` })).status, 401)
    // A page on a sibling site (same registrable domain, so the browser would attach the cookie) can't use it.
    const sibling = await post("/session/sign-out", { cookie, origin: "https://testnet.luckout.test" })
    assert.equal(sibling.status, 403)

    // Signing out ends the session on the server and tells the browser to drop the cookie.
    const out = await post("/session/sign-out", { cookie })
    assert.equal(out.status, 204)
    assert.match(out.headers.get("set-cookie") ?? "", /^__Host-luckout_session=; Max-Age=0;/)
    assert.equal((await post("/session/sign-out", { cookie })).status, 401, "the old cookie is worth nothing")
  }))
