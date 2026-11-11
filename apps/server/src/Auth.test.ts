import { evmSignInMessage, SignedChallenge, SignedEvmChallenge } from "@luckout/api"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { Effect, Layer } from "effect"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { test } from "node:test"
import { Auth } from "./Auth.ts"
import { DbMemory } from "./Db.ts"
import { Near } from "./Near.ts"
import { fakeNear } from "./testing.ts"

// Sessions on an in-memory database, with the wallet signature check faked.
process.env.NEAR_NETWORK = "testnet"
process.env.SESSION_SECRET = "a-test-secret-that-is-long-enough-for-mainnet"

const signed: Array<string> = []
const near = fakeNear({ verifySignIn: (input) => Effect.sync(() => (signed.push(input.message), true)) })
const layer = Auth.layer.pipe(Layer.provide(Layer.succeed(Near, near)), Layer.provide(DbMemory))
const run = <A, E>(e: Effect.Effect<A, E, Auth>) => Effect.runPromise(e.pipe(Effect.provide(layer)))

/** A token as the server mints it, with the same secret. */
const mint = (payload: object) => {
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${p}.${createHmac("sha256", process.env.SESSION_SECRET!).update(p).digest("base64url")}`
}

test("the sign-in message names the network, and a session works only on its own network", () =>
  run(Effect.gen(function*() {
    const auth = yield* Auth
    const c = yield* auth.challenge
    assert.equal(c.message, "Sign in to Luckout (testnet)")
    const s = yield* auth.verify(new SignedChallenge({ accountId: "alice.testnet", publicKey: "ed25519:x", signature: "", nonce: c.nonce }))
    assert.deepEqual(signed, ["Sign in to Luckout (testnet)"])
    assert.equal(yield* auth.authenticate(s.token), "alice.testnet")

    const e = Date.now() + 60_000
    const mainnet = yield* auth.authenticate(mint({ a: "alice.near", e, n: "mainnet" })).pipe(Effect.flip)
    assert.equal(mainnet._tag, "Unauthorized")
    const unbound = yield* auth.authenticate(mint({ a: "alice.testnet", e })).pipe(Effect.flip)
    assert.equal(unbound._tag, "Unauthorized", "tokens from before sessions named their network")
  })))

test("signing out everywhere ends every earlier session; a new sign-in works", () =>
  run(Effect.gen(function*() {
    const auth = yield* Auth
    const signIn = Effect.flatMap(auth.challenge, (c) =>
      auth.verify(new SignedChallenge({ accountId: "bob.testnet", publicKey: "ed25519:x", signature: "", nonce: c.nonce })))
    const before = yield* signIn
    assert.equal(yield* auth.authenticate(before.token), "bob.testnet")
    yield* auth.signOutEverywhere("bob.testnet")
    const ended = yield* auth.authenticate(before.token).pipe(Effect.flip)
    assert.equal(ended._tag, "Unauthorized")
    yield* Effect.sleep("5 millis")
    const after = yield* signIn
    assert.equal(yield* auth.authenticate(after.token), "bob.testnet")
  })))

test("an EVM wallet signs in as its lowercase address, once per challenge, and only with its own key", () =>
  run(Effect.gen(function*() {
    const auth = yield* Auth
    const wallet = privateKeyToAccount(generatePrivateKey())
    const sign = (c: { message: string; nonce: string }, by = wallet) => Effect.promise(() => by.signMessage({ message: evmSignInMessage(c) }))
    const c = yield* auth.challenge
    const signature = yield* sign(c)
    const s = yield* auth.verifyEvm(new SignedEvmChallenge({ address: wallet.address, signature, nonce: c.nonce }))
    assert.equal(s.accountId, wallet.address.toLowerCase())
    assert.equal(yield* auth.authenticate(s.token), wallet.address.toLowerCase())

    const again = yield* auth.verifyEvm(new SignedEvmChallenge({ address: wallet.address, signature, nonce: c.nonce })).pipe(Effect.flip)
    assert.match(again.message, /expired/, "a challenge signs in once")
    const c2 = yield* auth.challenge
    const someoneElse = yield* sign(c2, privateKeyToAccount(generatePrivateKey()))
    const forged = yield* auth.verifyEvm(new SignedEvmChallenge({ address: wallet.address, signature: someoneElse, nonce: c2.nonce })).pipe(Effect.flip)
    assert.equal(forged._tag, "Unauthorized")
  })))
