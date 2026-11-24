import assert from "node:assert/strict"
import { test } from "node:test"
import { NotOnChain, txEvents, txFailure } from "./chain.ts"

test("a transaction NEAR has no record of is not on chain (a 404); NEAR not answering is not that", async () => {
  const realFetch = globalThis.fetch
  // What each RPC endpoint answers, in the order they're tried: the archival node last.
  const answers = (...replies: Array<() => Response>) => {
    let i = 0
    globalThis.fetch = (async () => replies[Math.min(i++, replies.length - 1)]!()) as typeof fetch
  }
  const rpcError = (name: string, cause: string, status = 200) => () => Response.json({ jsonrpc: "2.0", id: 1, error: { name, cause: { name: cause }, code: -32000 } }, { status })
  const unknown = rpcError("HANDLER_ERROR", "UNKNOWN_TRANSACTION")
  const down = () => new Response("Bad Gateway", { status: 502 })
  const read = () => txEvents("4HWu4u4VAKfZZgezdYYLBYctgTdTuWbFEJ5wW6xPoSV2", "app.luckout.near")
  try {
    answers(unknown, unknown, unknown)
    await assert.rejects(read(), NotOnChain, "every endpoint, the archival node too, has no record of it")
    // A hash that can't be one (it decodes to more than 32 bytes): FastNEAR refuses it with a 400.
    answers(rpcError("REQUEST_VALIDATION_ERROR", "PARSE_ERROR", 400))
    await assert.rejects(read(), NotOnChain)
    // Only the archival node keeps old transactions: when it doesn't answer, nobody has said it isn't there.
    answers(unknown, unknown, down)
    await assert.rejects(read(), (e: Error) => !(e instanceof NotOnChain) && /couldn't answer/.test(e.message))
    answers(down)
    await assert.rejects(read(), (e: Error) => !(e instanceof NotOnChain) && /Can't reach NEAR/.test(e.message))
  } finally {
    globalThis.fetch = realFetch
  }
})

test("a call the contract refused is a failure, with the contract's reason", () => {
  // The outcome a wallet handed back for set_cashback_cap signed by a non-owner (testnet tx 4HWu4u4V…).
  const refused = { status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: Only the owner" } } } } }, transaction: { hash: "4HWu4u4VAKfZZgezdYYLBYctgTdTuWbFEJ5wW6xPoSV1" } }
  assert.equal(txFailure(refused), "Only the owner")
  assert.equal(txFailure({ status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Exceeded the prepaid gas." } } } } } }), "Exceeded the prepaid gas.")
  assert.equal(txFailure({ status: { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: "x.testnet" } } } } } }), "The transaction failed on chain.")
})

test("a call that went through, or a wallet that returns no outcome, isn't a failure", () => {
  assert.equal(txFailure({ status: { SuccessValue: "" }, transaction: { hash: "h" } }), undefined)
  assert.equal(txFailure(undefined), undefined)
  assert.equal(txFailure("hash"), undefined)
})
