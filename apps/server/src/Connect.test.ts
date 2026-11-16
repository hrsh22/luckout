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
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ tokens: string }>`SELECT tokens FROM bitrefill_connections WHERE account_id = 'alice.test'`
    return { url, back, tokens: row!.tokens, connected: yield* connect.connected("alice.test"), token: yield* connect.token("alice.test") }
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
  assert.equal(r.back, "https://luckout.test/wallet?bitrefill=connected")
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

test("disconnecting revokes the login at Bitrefill and forgets it", async () => {
  const oauth = fakeBitrefillOAuth()
  const r = await run(oauth, Effect.gen(function*() {
    const connect = yield* Connect
    const state = new URL(yield* connect.url("alice.test")).searchParams.get("state")!
    yield* connect.callback(new URLSearchParams({ code: "the-code", state, iss: ISS }))
    yield* connect.disconnect("alice.test")
    return { connected: yield* connect.connected("alice.test"), token: yield* connect.token("alice.test") }
  }))
  const revoke = oauth.calls.find((c) => c.path === "/oauth/mcp/revoke")!.params
  assert.deepEqual([revoke.get("token"), revoke.get("token_type_hint")], ["refresh-1", "refresh_token"])
  assert.deepEqual(r, { connected: false, token: undefined })
})
