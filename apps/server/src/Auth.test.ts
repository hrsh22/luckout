import { evmSignInMessage, SignedChallenge, SignedEvmChallenge } from "@luckout/api"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { createSiweMessage } from "viem/siwe"
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
// Our sites: the main one, and one more that may call the server.
process.env.WEB_ORIGIN = "https://luckout.test"
process.env.CORS_ORIGINS = "https://www.luckout.test"

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

/** What the Web App sends after an EVM wallet signed in on `uri`. */
const evmSignIn = (c: { message: string; nonce: string }, by: ReturnType<typeof privateKeyToAccount>, uri = "https://luckout.test", address = by.address) => {
  const site = { uri, chainId: 8453, issuedAt: new Date().toISOString() }
  return Effect.map(Effect.promise(() => by.signMessage({ message: evmSignInMessage({ challenge: c, address, ...site }) })), (signature) =>
    new SignedEvmChallenge({ address, signature, nonce: c.nonce, ...site }))
}

test("an EVM wallet signs in as its lowercase address, once per challenge, and only with its own key", () =>
  run(Effect.gen(function*() {
    const auth = yield* Auth
    const wallet = privateKeyToAccount(generatePrivateKey())
    const c = yield* auth.challenge
    const signedIn = yield* evmSignIn(c, wallet)
    const s = yield* auth.verifyEvm(signedIn)
    assert.equal(s.accountId, wallet.address.toLowerCase())
    assert.equal(yield* auth.authenticate(s.token), wallet.address.toLowerCase())

    const again = yield* auth.verifyEvm(signedIn).pipe(Effect.flip)
    assert.match(again.message, /expired/, "a challenge signs in once")
    const c2 = yield* auth.challenge
    const someoneElse = yield* evmSignIn(c2, privateKeyToAccount(generatePrivateKey()), "https://luckout.test", wallet.address)
    const forged = yield* auth.verifyEvm(someoneElse).pipe(Effect.flip)
    assert.equal(forged._tag, "Unauthorized")
  })))

test("the EVM sign-in text is a Sign-In with Ethereum message naming our site, and one made on another site signs nobody in", () =>
  run(Effect.gen(function*() {
    const auth = yield* Auth
    const wallet = privateKeyToAccount(generatePrivateKey())
    const c = yield* auth.challenge
    // Exactly what the standard's own builder writes, so wallets recognise it and compare its site with the page.
    const issuedAt = new Date()
    const text = evmSignInMessage({ challenge: c, address: wallet.address, uri: "https://luckout.test", chainId: 8453, issuedAt: issuedAt.toISOString() })
    assert.equal(text, createSiweMessage({
      address: wallet.address,
      domain: "luckout.test",
      uri: "https://luckout.test",
      chainId: 8453,
      version: "1",
      nonce: c.nonce.replace(/[^A-Za-z0-9]/g, ""),
      issuedAt,
      statement: "Sign in to Luckout (testnet). This signature moves no money. While signed in, you can buy gift cards from your Luckout balance, within your Spending Limits."
    }))
    assert.match(text, /^luckout\.test wants you to sign in with your Ethereum account:\n/)

    // Signed on a look-alike site: the wallet showed that site's name, and we refuse it.
    const phished = yield* auth.verifyEvm(yield* evmSignIn(c, wallet, "https://luckout.example")).pipe(Effect.flip)
    assert.match(phished.message, /Luckout's own site/)
    // Signed on a look-alike site, then sent in as if it were ours: the text we rebuild isn't the one that was signed.
    const c2 = yield* auth.challenge
    const there = yield* evmSignIn(c2, wallet, "https://luckout.example")
    const relabelled = yield* auth.verifyEvm(new SignedEvmChallenge({ ...there, uri: "https://luckout.test" })).pipe(Effect.flip)
    assert.equal(relabelled._tag, "Unauthorized")
    // Our other site is as good as the main one.
    const c3 = yield* auth.challenge
    const s = yield* auth.verifyEvm(yield* evmSignIn(c3, wallet, "https://www.luckout.test"))
    assert.equal(s.accountId, wallet.address.toLowerCase())
  })))

test("a NEAR wallet is shown our site's host as the recipient", () =>
  run(Effect.gen(function*() {
    const auth = yield* Auth
    assert.equal((yield* auth.challenge).recipient, "luckout.test")
  })))

test("signing out ends that session only, at once; the same account's other session goes on", () =>
  run(Effect.gen(function*() {
    const auth = yield* Auth
    const signIn = Effect.flatMap(auth.challenge, (c) =>
      auth.verify(new SignedChallenge({ accountId: "carol.testnet", publicKey: "ed25519:x", signature: "", nonce: c.nonce })))
    const laptop = yield* signIn
    yield* Effect.sleep("5 millis")
    const phone = yield* signIn
    yield* auth.signOut(laptop.token)
    const ended = yield* auth.authenticate(laptop.token).pipe(Effect.flip)
    assert.match(ended.message, /Signed out/)
    assert.equal(yield* auth.authenticate(phone.token), "carol.testnet")
    // Junk is ignored rather than stored.
    yield* auth.signOut("not-a-token")
    yield* auth.signOut("")
  })))
