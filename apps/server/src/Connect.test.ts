import { ConfigProvider, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { Bitrefill } from "./Bitrefill.ts"
import { Connect } from "./Connect.ts"
import { DbMemory } from "./Db.ts"
import { sealWith } from "./Seal.ts"
import { fakeBitrefill, fakeBitrefillOAuth } from "./testing.ts"

// Connect Bitrefill's OAuth login, with Bitrefill's token endpoint faked at fetch.
const KEY = "22".repeat(32)
const ISS = "https://api.bitrefill.com/oauth/mcp"
const env = {
  REDEMPTION_KEY: KEY,
  BITREFILL_CLIENT_ID: "luckout-client",
  BITREFILL_CLIENT_SECRET: "client-secret",
  BITREFILL_REDIRECT_URI: "https://api.luckout.test/bitrefill/callback",
  WEB_ORIGIN: "https://luckout.test"
}
const run = <A, E>(oauth: ReturnType<typeof fakeBitrefillOAuth>, e: Effect.Effect<A, E, Connect | SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.scoped(e).pipe(Effect.provide(Connect.layer.pipe(
    Layer.provideMerge(DbMemory),
    Layer.provide(Layer.succeed(Bitrefill, fakeBitrefill({ guest: true }))),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, oauth.fetch)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))
  ))))

test("connecting exchanges the code with PKCE and saves the login sealed", async () => {
  const oauth = fakeBitrefillOAuth()
  const r = await run(oauth, Effect.gen(function*() {
    const connect = yield* Connect
    const url = new URL(yield* connect.url("alice.test"))
    const back = yield* connect.callback(new URLSearchParams({ code: "the-code", state: url.searchParams.get("state")!, iss: ISS }))
    const exchangedBefore = oauth.calls.length
    const q = new URL(back).searchParams
    yield* connect.finish("alice.test", q.get("code")!, q.get("state")!)
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ tokens: string }>`SELECT tokens FROM bitrefill_connections WHERE account_id = 'alice.test'`
    return { url, back, exchangedBefore, tokens: row!.tokens, connected: yield* connect.connected("alice.test"), token: yield* connect.token("alice.test") }
  }))
  assert.equal(`${r.url.origin}${r.url.pathname}`, "https://api.bitrefill.com/oauth/mcp/authorize")
  const asked = Object.fromEntries(r.url.searchParams)
  assert.deepEqual(
    { ...asked, state: undefined, code_challenge: undefined },
    {
      response_type: "code",
      client_id: "luckout-client",
      redirect_uri: env.BITREFILL_REDIRECT_URI,
      scope: "mcp",
      resource: "https://api.bitrefill.com/mcp",
      code_challenge_method: "S256",
      state: undefined,
      code_challenge: undefined
    }
  )
  assert.match(asked.state!, /^[\w-]+$/, "a URL-safe state")
  assert.ok(!r.url.href.includes("client-secret"))
  const back = new URL(r.back)
  assert.equal(`${back.origin}${back.pathname}`, "https://luckout.test/wallet")
  assert.deepEqual([back.searchParams.get("bitrefill"), back.searchParams.get("code"), back.searchParams.get("state")], ["finish", "the-code", asked.state])
  assert.equal(r.exchangedBefore, 0, "the callback has no session, so it exchanges nothing")
  const exchange = oauth.grants("authorization_code")[0]!.params
  assert.equal(exchange.get("code"), "the-code")
  assert.equal(exchange.get("redirect_uri"), env.BITREFILL_REDIRECT_URI)
  assert.equal(exchange.get("resource"), "https://api.bitrefill.com/mcp")
  assert.equal(exchange.get("client_secret"), "client-secret", "client_secret_post")
  assert.equal(createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url"), asked.code_challenge, "the verifier sealed in the state")
  assert.ok(!/access-1|refresh-1/.test(r.tokens), "sealed at rest")
  assert.equal(r.connected, true)
  assert.equal(r.token, "access-1")
})

test("the callback refuses a state that's altered or expired, a reply not from Bitrefill, and a declined login", async () => {
  const oauth = fakeBitrefillOAuth()
  const r = await run(oauth, Effect.gen(function*() {
    const connect = yield* Connect
    const state = new URL(yield* connect.url("alice.test")).searchParams.get("state")!
    const back = (q: Record<string, string>) => connect.callback(new URLSearchParams(q))
    return {
      altered: yield* back({ code: "c", state: state.slice(0, 20) + (state[20] === "A" ? "B" : "A") + state.slice(21), iss: ISS }),
      // Sealed with our own key, as nobody else could, but its 10 minutes are up.
      expired: yield* back({ code: "c", state: sealWith(Buffer.from(KEY, "hex"), "bitrefill-state", { account: "alice.test", verifier: "v", until: Date.now() - 1 }), iss: ISS }),
      missing: yield* back({ code: "c", iss: ISS }),
      otherIssuer: yield* back({ code: "c", state, iss: "https://evil.example/oauth/mcp" }),
      noIssuer: yield* back({ code: "c", state }),
      declined: yield* back({ error: "access_denied", state, iss: ISS }),
      connected: yield* connect.connected("alice.test")
    }
  }))
  const { connected, ...backs } = r
  for (const [what, to] of Object.entries(backs)) assert.equal(to, "https://luckout.test/wallet?bitrefill=failed", what)
  assert.deepEqual(oauth.calls, [], "no code exchanged")
  assert.equal(connected, false)
})

test("two orders renewing one customer's login at once take turns: one refresh, both get the new token, still connected", async () => {
  // The first access token lasts a minute, so both need it renewed; a refresh token works once.
  const oauth = fakeBitrefillOAuth(60)
  const r = await run(oauth, Effect.gen(function*() {
    const connect = yield* Connect
    const state = new URL(yield* connect.url("alice.test")).searchParams.get("state")!
    yield* connect.finish("alice.test", "the-code", state)
    const tokens = yield* Effect.all([connect.token("alice.test"), connect.token("alice.test")], { concurrency: 2 })
    return { tokens, connected: yield* connect.connected("alice.test") }
  }))
  assert.deepEqual(r.tokens, ["access-2", "access-2"])
  assert.equal(oauth.grants("refresh_token").length, 1, "the second waited and found the renewed token")
  assert.equal(r.connected, true, "never taken for a lapsed login")
})

test("disconnecting revokes the login at Bitrefill and forgets it", async () => {
  const oauth = fakeBitrefillOAuth()
  const r = await run(oauth, Effect.gen(function*() {
    const connect = yield* Connect
    const state = new URL(yield* connect.url("alice.test")).searchParams.get("state")!
    yield* connect.finish("alice.test", "the-code", state)
    yield* connect.disconnect("alice.test")
    return { connected: yield* connect.connected("alice.test"), token: yield* connect.token("alice.test") }
  }))
  const revoke = oauth.calls.find((c) => c.path === "/oauth/mcp/revoke")!.params
  assert.deepEqual([revoke.get("token"), revoke.get("token_type_hint")], ["refresh-1", "refresh_token"])
  assert.deepEqual(r, { connected: false, token: undefined })
})

test("a login started from another Luckout account is refused when finished here, so nobody can attach their Bitrefill login to ours", async () => {
  const oauth = fakeBitrefillOAuth()
  const r = await run(oauth, Effect.gen(function*() {
    const connect = yield* Connect
    // Mallory starts connecting, then gets Alice to finish the Bitrefill login: Alice's browser lands on our Wallet page.
    const state = new URL(yield* connect.url("mallory.test")).searchParams.get("state")!
    const back = new URL(yield* connect.callback(new URLSearchParams({ code: "alices-code", state, iss: ISS }))).searchParams
    const refused = yield* connect.finish("alice.test", back.get("code")!, back.get("state")!).pipe(Effect.flip)
    const expired = yield* connect.finish("alice.test", "c", sealWith(Buffer.from(KEY, "hex"), "bitrefill-state", { account: "alice.test", verifier: "v", until: Date.now() - 1 })).pipe(Effect.flip)
    return { refused: refused.message, expired: expired.message, alice: yield* connect.connected("alice.test"), mallory: yield* connect.connected("mallory.test") }
  }))
  assert.match(r.refused, /started from another Luckout account/)
  assert.match(r.expired, /took too long/)
  assert.deepEqual([r.alice, r.mallory], [false, false])
  assert.deepEqual(oauth.calls, [], "no code exchanged")
})
