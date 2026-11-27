import { NodeHttpServer } from "@effect/platform-node"
import { AuthApi, Session, Unauthorized } from "@luckout/api"
import { ByteSize, Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { Bitrefill } from "./Bitrefill.ts"
import { edge, MAX_BODY } from "./Edge.ts"
import { McpRoute } from "./Mcp.ts"
import { Purchases } from "./Purchases.ts"
import { Solana } from "./Solana.ts"
import { Telegram } from "./Telegram.ts"
import { fakeBitrefill } from "./testing.ts"

// The edge exactly as main.ts serves it, on a real HTTP server at a throwaway port. Behind it: the real
// sign-in endpoints with their handlers faked, and the real /mcp route (its tools are never called here).

const signedIn: Array<string> = []
const Api = HttpApi.make("edge-test").add(AuthApi)
const AuthHandlers = HttpApiBuilder.group(Api, "auth", (handlers) =>
  handlers.handleAll({
    privy: ({ payload }) =>
      payload.accessToken === "refused"
        ? Effect.fail(new Unauthorized({ message: "refused in this test" }))
        : Effect.sync(() => (signedIn.push(payload.accessToken), new Session({ accountId: payload.accessToken, wallet: "solana", expiresAt: 0 })))
  }))
const Routes = Layer.mergeAll(
  HttpApiBuilder.layer(Api).pipe(Layer.provide(AuthHandlers)),
  McpRoute.pipe(Layer.provide([
    Layer.succeed(Bitrefill, fakeBitrefill()),
    Layer.succeed(Solana, {} as Solana["Service"]),
    Layer.succeed(Purchases, {} as Purchases["Service"]),
    Layer.succeed(Telegram, {} as Telegram["Service"])
  ]))
)

/** Runs `body` against the served edge; `url` is where it listens. */
const served = <A>(body: (url: string) => Promise<A>) => {
  const node = createServer()
  return Effect.runPromise(
    Effect.promise(() => body(`http://127.0.0.1:${(node.address() as AddressInfo).port}`)).pipe(
      Effect.provide(HttpRouter.serve(Layer.mergeAll(Routes, edge(["https://luckout.test"])), { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provide(NodeHttpServer.layer(() => node, { port: 0, host: "127.0.0.1" }))
      ))
    )
  )
}

const post = (url: string, body: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body })
/** Valid JSON of about `bytes` bytes: what is asked for, plus padding a handler would ignore. */
const padded = (message: object, bytes: number) => JSON.stringify({ ...message, pad: "x".repeat(bytes) })

test("a request body over the limit never reaches a handler; one under it is served as before", () =>
  served(async (url) => {
    const limit = ByteSize.toNumberUnsafe(MAX_BODY)
    const signIn = { accessToken: "alice", identityToken: "id" }
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" }

    // The biggest thing a customer sends is a signed delegate of at most 8,192 characters: far under the limit.
    assert.ok(JSON.stringify({ signedDelegate: "A".repeat(8192) }).length * 4 < limit)
    assert.equal((await post(`${url}/auth/privy`, padded(signIn, limit - 1024))).status, 200)
    assert.deepEqual(await (await post(`${url}/mcp`, padded(ping, limit - 1024))).json(), { jsonrpc: "2.0", id: 1, result: {} })
    assert.deepEqual(signedIn, ["alice"])

    // The same messages padded past the limit: well-formed, so only their size can refuse them.
    const refused = await post(`${url}/auth/privy`, padded(signIn, limit))
    assert.equal(refused.status, 413)
    assert.deepEqual(signedIn, ["alice"], "the handler never saw the second sign-in")
    const mcp = await post(`${url}/mcp`, padded(ping, 8 * 1024 * 1024))
    assert.equal(mcp.status, 400)
    assert.equal((await mcp.json()).error.message, "Parse error")
  }))

test("no API answer may be stored by a browser or a proxy: not a session, not a refusal, not a rate limit", () =>
  served(async (url) => {
    const signIn = JSON.stringify({ accessToken: "bob", identityToken: "id" })
    const session = await post(`${url}/auth/privy`, signIn)
    assert.equal(session.status, 200)
    assert.equal(session.headers.get("cache-control"), "no-store", "a sign-in answer carries the session token")
    const refused = await post(`${url}/auth/privy`, JSON.stringify({ accessToken: "refused", identityToken: "id" }))
    assert.equal(refused.status, 401)
    assert.equal(refused.headers.get("cache-control"), "no-store")
    const mcp = await post(`${url}/mcp`, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }))
    assert.equal(mcp.headers.get("cache-control"), "no-store")
    let limited: Response | undefined
    for (let i = 0; i < 25 && limited?.status !== 429; i++) limited = await post(`${url}/auth/privy`, signIn)
    assert.equal(limited?.status, 429)
    assert.equal(limited?.headers.get("cache-control"), "no-store")
  }))
