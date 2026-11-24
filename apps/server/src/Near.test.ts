import { Cause, Effect, Exit } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  type AccessKey,
  checkOperatorKey,
  failover,
  isBrokeTx,
  isDeadTx,
  isUnknownTx,
  Near,
  NearUnavailable,
  otherNetworkAccounts,
  RELAY_GAS,
  transportTrouble,
  upfront
} from "./Near.ts"
import { fakeNear } from "./testing.ts"

// A server refuses to start when its .env names accounts from the other network.

test("a mainnet .env with a testnet account is caught, and the reverse", () => {
  assert.deepEqual(
    otherNetworkAccounts("mainnet", {
      LUCKOUT_CONTRACT_ID: "app.luckout.near",
      USDC_CONTRACT_ID: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      TREASURY_ACCOUNT_ID: "treasury.luckout.testnet",
      ADMIN_ACCOUNTS: "boss.near, luckout.testnet"
    }),
    ["TREASURY_ACCOUNT_ID=treasury.luckout.testnet", "ADMIN_ACCOUNTS=luckout.testnet"]
  )
  assert.deepEqual(otherNetworkAccounts("testnet", { OPERATOR_ACCOUNT_ID: "server.luckout.near" }), ["OPERATOR_ACCOUNT_ID=server.luckout.near"])
  assert.deepEqual(otherNetworkAccounts("testnet", { LUCKOUT_CONTRACT_ID: "app.luckout.testnet", RELAYER_ACCOUNT_ID: undefined }), [])
})

// A server refuses to start when its operator key can't send what purchases send: NEAR would refuse every
// admission and settlement, and each purchase would wait hours before going stuck.

const keyCheck = (answer: Effect.Effect<AccessKey | undefined, NearUnavailable>) => {
  const asked: Array<string> = []
  const near = fakeNear({
    contractId: "app.luckout.near",
    operatorId: "server.luckout.near",
    operatorPublicKey: "ed25519:operator",
    accessKey: (accountId, publicKey) => (asked.push(`${accountId} ${publicKey}`), answer)
  })
  return Effect.runPromiseExit(Effect.provideService(checkOperatorKey, Near, near)).then((exit) => ({ exit, asked }))
}
const why = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "started")
const fc = (receiverId: string, methodNames: Array<string>): AccessKey => ({ nonce: 1n, fullAccess: false, calls: { receiverId, methodNames } })

test("the operator key passes when it may call purchase_many and settle on the contract", async () => {
  const first = await keyCheck(Effect.succeed(fc("app.luckout.near", ["purchase", "confirm_delivery", "fail_purchase", "purchase_many", "settle"])))
  assert.equal(why(first.exit), "started")
  assert.deepEqual(first.asked, ["server.luckout.near ed25519:operator"], "it reads the operator's own key")
  assert.equal(why((await keyCheck(Effect.succeed(fc("app.luckout.near", [])))).exit), "started", "an empty method list allows every method")
  assert.equal(why((await keyCheck(Effect.succeed({ nonce: 1n, fullAccess: true }))).exit), "started", "a full-access key may call anything")
})

test("the operator key is refused when it can't call them, isn't on chain, or the chain can't be asked", async () => {
  // Production's key before the cart release: the three single-purchase methods only.
  assert.match(why((await keyCheck(Effect.succeed(fc("app.luckout.near", ["purchase", "confirm_delivery", "fail_purchase"])))).exit), /can't call purchase_many, settle/)
  assert.match(why((await keyCheck(Effect.succeed(fc("app.staging.luckout.near", ["purchase_many", "settle"])))).exit), /for app\.staging\.luckout\.near, not app\.luckout\.near/)
  assert.match(why((await keyCheck(Effect.succeed(undefined))).exit), /server\.luckout\.near has no such key/)
  assert.match(why((await keyCheck(Effect.fail(new NearUnavailable({ message: "access key: fetch failed" })))).exit), /couldn't read .*fetch failed/)
})

test("a server without an operator key has nothing to check", async () => {
  const near = fakeNear({ operatorId: undefined, operatorPublicKey: undefined })
  assert.equal(why(await Effect.runPromiseExit(Effect.provideService(checkOperatorKey, Near, near))), "started")
})

// Real error texts: a rate limit or outage moves to the next endpoint; an answer from the chain doesn't.
const RATE_LIMITED = `Error: {"jsonrpc": "2.0", "error": {"code": -429, "message": "Rate limits exceeded. For higher rate limits get a subscription at https://fastnear.com"}, "id": "1"}`
const UNKNOWN_TX = `Error: {"name":"HANDLER_ERROR","cause":{"name":"UNKNOWN_TRANSACTION"},"code":-32000,"message":"Server error"}`

test("only transport trouble counts as a reason to try another endpoint", () => {
  for (const m of [RATE_LIMITED, "Error: https://near.drpc.org unavailable", "Exceeded 10 attempts for https://x.", "TypeError: fetch failed", "send: timed out"]) {
    assert.ok(transportTrouble(m), m)
  }
  for (const m of [UNKNOWN_TX, "InvalidNonce", "Smart contract panicked: Exceeds proceeds", `{"cause":{"name":"UNKNOWN_ACCOUNT"},"message":"Server error"}`]) {
    assert.ok(!transportTrouble(m), m)
  }
})

test("a rate-limited endpoint hands over to the next one and stays switched; the chain's answers come back unchanged", async () => {
  const calls: Array<string> = []
  const endpoint = (name: string, answer: () => string) => ({ name, call: async () => (calls.push(name), answer()) })
  const fail = (m: string) => () => { throw new Error(m) }
  const at = { i: 0 }
  const providers = [endpoint("fastnear", fail(RATE_LIMITED)), endpoint("drpc", () => "block 1"), endpoint("intea", () => "block 2")]
  const run = <A>(e: Effect.Effect<A, unknown>) => Effect.runPromise(Effect.result(e))

  const first = await run(failover(providers, at, "block", (p) => p.call()))
  assert.equal(first._tag, "Success")
  assert.equal((first as { success: string }).success, "block 1")
  assert.equal(at.i, 1, "it stays on the endpoint that answered")
  assert.deepEqual(calls, ["fastnear", "drpc"])

  calls.length = 0
  providers[1] = endpoint("drpc", fail(UNKNOWN_TX))
  const unknown = await run(failover(providers, at, "tx status", (p) => p.call()))
  assert.equal(unknown._tag, "Failure")
  assert.match(String((unknown as { failure: { message: string } }).failure.message), /^tx status: .*UNKNOWN_TRANSACTION/)
  assert.deepEqual(calls, ["drpc"], "an answer from the chain isn't asked again elsewhere")

  calls.length = 0
  const down = [endpoint("a", fail("Error: https://a unavailable")), endpoint("b", fail(RATE_LIMITED))]
  const none = await run(failover(down, { i: 0 }, "block", (p) => p.call()))
  assert.equal(none._tag, "Failure")
  assert.deepEqual(calls, ["a", "b"], "each endpoint is tried once, then it gives up")
})

test("resuming a saved transaction reads near-api-js 7's errors right", () => {
  // As the RPC wrapper words them: `${what}: ${error}`.
  assert.ok(isUnknownTx("tx status: UnknownTransactionError: Unknown transaction 11111111111111111111111111111111"), "never seen: send the same bytes again")
  assert.ok(isUnknownTx(`tx status: Error: {"cause":{"name":"UNKNOWN_TRANSACTION"}}`))
  assert.ok(isDeadTx("resend: TransactionExpiredError: Transaction expired"), "expired: sign afresh")
  assert.ok(isDeadTx("resend: InvalidNonceError: Invalid nonce (ak: 5, tx: 4)"))
  assert.ok(!isUnknownTx("tx status: Error: https://x unavailable") && !isDeadTx("resend: TypeError: fetch failed"), "an outage is neither")
  // Seen live 2026-11-18: NEAR refused a 300 Tgas relay from an account holding 0.149 NEAR.
  const broke = "send: NotEnoughBalanceError: Not enough balance for relayer.staging.luckout.near (balance: 148931856932293899999998, cost: 300923390231353000000000)"
  assert.ok(isBrokeTx(broke) && !transportTrouble(broke) && !isDeadTx(broke), "our fee: an answer, not an outage, nor a dead nonce")
  assert.ok(upfront(300n * 10n ** 12n) <= 300923390231353000000000n && upfront(RELAY_GAS) < 148931856932293899999998n, "that account can send our intents at 120 Tgas")
})
