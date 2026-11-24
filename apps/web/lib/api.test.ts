import { BitrefillUnavailable, NotFound } from "@luckout/api"
import assert from "node:assert/strict"
import { test } from "node:test"
import { isNotFound } from "./api.ts"

test("only the server's 'no such thing' is a missing page; an outage still says try again", () => {
  assert.equal(isNotFound(new NotFound()), true, "a NotFound the endpoint declares")
  assert.equal(isNotFound({ _tag: "HttpClientError", response: { status: 404 } }), true, "a 404 the endpoint doesn't declare")
  assert.equal(isNotFound(new BitrefillUnavailable({ message: "Bitrefill isn't answering right now. Try again in a moment." })), false)
  assert.equal(isNotFound({ _tag: "HttpClientError", response: { status: 503 } }), false)
  assert.equal(isNotFound(new TypeError("Failed to fetch")), false, "no connection is not a missing card")
  assert.equal(isNotFound(undefined), false)
  assert.equal(isNotFound(null), false)
})
