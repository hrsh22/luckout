import assert from "node:assert/strict"
import { test } from "node:test"
import { txFailure } from "./chain.ts"

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
