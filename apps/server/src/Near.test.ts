import { Effect } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { failover, isDeadTx, isUnknownTx, otherNetworkAccounts, transportTrouble } from "./Near.ts"

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
})
