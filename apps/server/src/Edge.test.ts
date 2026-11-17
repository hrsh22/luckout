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
import { Near } from "./Near.ts"
import { Purchases } from "./Purchases.ts"
import { Telegram } from "./Telegram.ts"
import { fakeBitrefill, fakeNear } from "./testing.ts"

// The edge exactly as main.ts serves it, on a real HTTP server at a throwaway port. Behind it: the real
// sign-in endpoints with their handlers faked, and the real /mcp route (its tools are never called here).

const signedIn: Array<string> = []
const Api = HttpApi.make("edge-test").add(AuthApi)
const AuthHandlers = HttpApiBuilder.group(Api, "auth", (handlers) =>
  handlers.handleAll({
    challenge: () => Effect.die("not used in this test"),
    verify: ({ payload }) => Effect.sync(() => (signedIn.push(payload.accountId), new Session({ accountId: payload.accountId, token: "t", expiresAt: 0 }))),
    verifyEvm: () => Effect.fail(new Unauthorized({ message: "not used in this test" }))
  }))
const Routes = Layer.mergeAll(
  HttpApiBuilder.layer(Api).pipe(Layer.provide(AuthHandlers)),
  McpRoute.pipe(Layer.provide([
    Layer.succeed(Bitrefill, fakeBitrefill()),
    Layer.succeed(Near, fakeNear()),
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
    const signIn = { accountId: "alice.testnet", publicKey: "ed25519:x", signature: "", nonce: "n" }
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" }

    // The biggest thing a customer sends is a signed delegate of at most 8,192 characters: far under the limit.
    assert.ok(JSON.stringify({ signedDelegate: "A".repeat(8192) }).length * 4 < limit)
    assert.equal((await post(`${url}/auth/verify`, padded(signIn, limit - 1024))).status, 200)
    assert.deepEqual(await (await post(`${url}/mcp`, padded(ping, limit - 1024))).json(), { jsonrpc: "2.0", id: 1, result: {} })
    assert.deepEqual(signedIn, ["alice.testnet"])

    // The same messages padded past the limit: well-formed, so only their size can refuse them.
    const refused = await post(`${url}/auth/verify`, padded(signIn, limit))
    assert.equal(refused.status, 413)
    assert.deepEqual(signedIn, ["alice.testnet"], "the handler never saw the second sign-in")
    const mcp = await post(`${url}/mcp`, padded(ping, 8 * 1024 * 1024))
    assert.equal(mcp.status, 400)
    assert.equal((await mcp.json()).error.message, "Parse error")
  }))
