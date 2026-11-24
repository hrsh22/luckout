import { NodeHttpServer } from "@effect/platform-node"
import { AuthApi, base58Encode, CurrentAccount, evmSignInMessage, SessionApi, SignedChallenge, SignedEvmChallenge, SignedSolanaChallenge, solanaSignInMessage } from "@luckout/api"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { createSiweMessage } from "viem/siwe"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import assert from "node:assert/strict"
import { createHmac, generateKeyPairSync, sign } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { Auth, AuthorizationLive, dropCookie, sessionToken, startSession } from "./Auth.ts"
import { DbMemory } from "./Db.ts"
import { edge } from "./Edge.ts"
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
    assert.equal((yield* auth.authenticate(s.token)).accountId, "alice.testnet")

    const e = Date.now() + 60_000
    const mainnet = yield* auth.authenticate(mint({ a: "alice.near", e, n: "mainnet", c: "app.test", i: Date.now() })).pipe(Effect.flip)
    assert.equal(mainnet._tag, "Unauthorized")
    const unbound = yield* auth.authenticate(mint({ a: "alice.testnet", e })).pipe(Effect.flip)
    assert.equal(unbound._tag, "Unauthorized", "tokens from before sessions named their network")
  })))

test("a session works only with the contract it was signed in for: staging and production share mainnet", () =>
  run(Effect.gen(function*() {
    const auth = yield* Auth
    const c = yield* auth.challenge
    const s = yield* auth.verify(new SignedChallenge({ accountId: "erin.testnet", publicKey: "ed25519:x", signature: "", nonce: c.nonce }))
    assert.equal(JSON.parse(Buffer.from(s.token.split(".")[0]!, "base64url").toString()).c, "app.test", "the token names this server's contract")
    const e = Date.now() + 60_000
    const session = { a: "erin.testnet", e, n: "testnet", i: Date.now() }
    assert.equal((yield* auth.authenticate(mint({ ...session, c: "app.test" }))).accountId, "erin.testnet")
    const elsewhere = yield* auth.authenticate(mint({ ...session, c: "staging.app.test" })).pipe(Effect.flip)
    assert.equal(elsewhere._tag, "Unauthorized", "the same secret on another deployment signs nobody in here")
    const unnamed = yield* auth.authenticate(mint(session)).pipe(Effect.flip)
    assert.equal(unnamed._tag, "Unauthorized", "tokens from before sessions named their contract")
  })))

test("signing out everywhere ends every earlier session; a new sign-in works", () =>
  run(Effect.gen(function*() {
    const auth = yield* Auth
    const signIn = Effect.flatMap(auth.challenge, (c) =>
      auth.verify(new SignedChallenge({ accountId: "bob.testnet", publicKey: "ed25519:x", signature: "", nonce: c.nonce })))
    const before = yield* signIn
    assert.equal((yield* auth.authenticate(before.token)).accountId, "bob.testnet")
    yield* auth.signOutEverywhere("bob.testnet")
    const ended = yield* auth.authenticate(before.token).pipe(Effect.flip)
    assert.equal(ended._tag, "Unauthorized")
    yield* Effect.sleep("5 millis")
    const after = yield* signIn
    assert.equal((yield* auth.authenticate(after.token)).accountId, "bob.testnet")
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
    assert.equal((yield* auth.authenticate(s.token)).accountId, wallet.address.toLowerCase())

    const again = yield* auth.verifyEvm(signedIn).pipe(Effect.flip)
    assert.match(again.message, /expired/, "a challenge signs in once")
    const c2 = yield* auth.challenge
    const someoneElse = yield* evmSignIn(c2, privateKeyToAccount(generatePrivateKey()), "https://luckout.test", wallet.address)
    const forged = yield* auth.verifyEvm(someoneElse).pipe(Effect.flip)
    assert.equal(forged._tag, "Unauthorized")
    // 65 bytes, but a recovery byte no key makes: viem throws on it, and that is a refusal, never a server error.
    const broken = yield* auth.verifyEvm(new SignedEvmChallenge({ ...someoneElse, signature: `0x${"11".repeat(64)}05`, nonce: (yield* auth.challenge).nonce })).pipe(Effect.flip)
    assert.equal(broken._tag, "Unauthorized")
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

/** A Solana key: its address, its NEAR Intents account (the key in hex), and what the Web App sends after it signs in on `uri`. */
const solanaWallet = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32)
  const address = base58Encode(raw)
  const signIn = (c: { message: string; nonce: string }, uri = "https://luckout.test", as = address) => {
    const site = { uri, issuedAt: new Date().toISOString() }
    const signature = sign(null, Buffer.from(solanaSignInMessage({ challenge: c, address: as, ...site })), privateKey).toString("base64")
    return new SignedSolanaChallenge({ address: as, signature, nonce: c.nonce, ...site })
  }
  return { address, accountId: raw.toString("hex"), signIn }
}

test("a Solana wallet signs in as its key in hex, only with its own key, and only on our site", () =>
  run(Effect.gen(function*() {
    const auth = yield* Auth
    const wallet = solanaWallet()
    const c = yield* auth.challenge
    const text = solanaSignInMessage({ challenge: c, address: wallet.address, uri: "https://luckout.test", issuedAt: "2026-11-18T12:00:00.000Z" })
    assert.match(text, new RegExp(`^luckout\\.test wants you to sign in with your Solana account:\n${wallet.address}\n\nSign in to Luckout \\(testnet\\)\\.`))
    const s = yield* auth.verifySolana(wallet.signIn(c))
    assert.deepEqual([s.accountId, s.wallet], [wallet.accountId, "solana"])
    assert.deepEqual(yield* auth.authenticate(s.token), { accountId: wallet.accountId, wallet: "solana" })

    // Someone else's key, claiming this address.
    const forged = yield* auth.verifySolana(solanaWallet().signIn(yield* auth.challenge, "https://luckout.test", wallet.address)).pipe(Effect.flip)
    assert.match(forged.message, /isn't from this Solana address/)
    const phished = yield* auth.verifySolana(wallet.signIn(yield* auth.challenge, "https://luckout.example")).pipe(Effect.flip)
    assert.match(phished.message, /Luckout's own site/)
    const notAKey = yield* auth.verifySolana(new SignedSolanaChallenge({ ...wallet.signIn(yield* auth.challenge), address: "abc" })).pipe(Effect.flip)
    assert.match(notAKey.message, /isn't a Solana signature/)
  })))

test("a session names the wallet it signed in with; one from before that is read from its account", () =>
  run(Effect.gen(function*() {
    const auth = yield* Auth
    const e = Date.now() + 60_000
    const evm = "0x53a19a03679e8d5e9253a998dcde6c71dbb002a2"
    assert.deepEqual(yield* auth.authenticate(mint({ a: evm, e, n: "testnet", c: "app.test", i: Date.now() })), { accountId: evm, wallet: "evm" })
    const implicit = "ad".repeat(32)
    assert.deepEqual(yield* auth.authenticate(mint({ a: implicit, e, n: "testnet", c: "app.test", i: Date.now() })), { accountId: implicit, wallet: "near" })
    assert.deepEqual(yield* auth.authenticate(mint({ a: implicit, e, n: "testnet", c: "app.test", i: Date.now(), w: "solana" })), { accountId: implicit, wallet: "solana" })
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
    assert.equal((yield* auth.authenticate(phone.token)).accountId, "carol.testnet")
    // Junk is ignored rather than stored.
    yield* auth.signOut("not-a-token")
    yield* auth.signOut("")
  })))

// The session as a browser holds it: an HttpOnly cookie that sign-in sets, every call carries, and sign-out
// removes. Served on a real HTTP server behind the same edge as main.ts, with the handlers wired as main.ts
// wires them.

const SessionTestApi = HttpApi.make("session-test").add(AuthApi).add(SessionApi)
const AuthGroup = HttpApiBuilder.group(SessionTestApi, "auth", (handlers) =>
  Effect.gen(function*() {
    const auth = yield* Auth
    return handlers.handleAll({
      challenge: () => auth.challenge,
      verify: ({ payload }) => startSession(auth.verify(payload)),
      verifyEvm: ({ payload }) => startSession(auth.verifyEvm(payload)),
      verifySolana: ({ payload }) => startSession(auth.verifySolana(payload))
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
    const c = await (await post("/auth/challenge")).json()
    const signedIn = await post("/auth/verify", {}, { accountId: "dave.testnet", publicKey: "ed25519:x", signature: "", nonce: c.nonce })
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
    })), "dave.testnet")

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

test("an EVM sign-in whose time or chain isn't one is refused before it reaches the sign-in check", () =>
  served(async (url) => {
    const signIn = (fields: object) =>
      fetch(`${url}/auth/verify-evm`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: SITES[0]! },
        body: JSON.stringify({ address: `0x${"ab".repeat(20)}`, signature: `0x${"11".repeat(65)}`, nonce: "n", uri: SITES[0], chainId: 8453, issuedAt: new Date().toISOString(), ...fields })
      })
    // A well-formed one reaches the check (and is refused there: no such challenge), so a 400 is the field's doing.
    assert.equal((await signIn({})).status, 401)
    // The time is written into the text the wallet signed: it can't add a line of its own.
    assert.equal((await signIn({ issuedAt: "x\ninjected" })).status, 400)
    assert.equal((await signIn({ chainId: 0 })).status, 400)
  }))
