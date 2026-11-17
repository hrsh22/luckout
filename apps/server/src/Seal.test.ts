import assert from "node:assert/strict"
import { test } from "node:test"
import { sealWith, unsealWith } from "./Seal.ts"

const key = Buffer.from("11".repeat(32), "hex")

test("a sealed value opens only under its own key and for the row it was sealed for", () => {
  const sealed = sealWith(key, "purchase-1", { code: "ABC-123" })
  assert.deepEqual(unsealWith(key, "purchase-1", sealed), { code: "ABC-123" })
  assert.notEqual(sealWith(key, "purchase-1", { code: "ABC-123" }), sealed, "a fresh nonce every time")
  assert.ok(!Buffer.from(sealed, "base64").toString("latin1").includes("ABC-123"), "not readable as stored")
  // Moved to another row, or opened with another key.
  assert.throws(() => unsealWith(key, "purchase-2", sealed))
  assert.throws(() => unsealWith(Buffer.from("22".repeat(32), "hex"), "purchase-1", sealed))
})

test("a sealed value that was altered or cut short is refused, never opened wrong", () => {
  const b = Buffer.from(sealWith(key, "purchase-1", { code: "ABC-123" }), "base64")
  // One bit flipped in the nonce, the tag, and the body in turn.
  for (const at of [0, 12, 28, b.length - 1]) {
    const altered = Buffer.from(b)
    altered[at]! ^= 1
    assert.throws(() => unsealWith(key, "purchase-1", altered.toString("base64")), `byte ${at}`)
  }
  // Cut inside the tag: a shorter tag must not be accepted in place of the full one.
  assert.throws(() => unsealWith(key, "purchase-1", b.subarray(0, 20).toString("base64")))
  assert.throws(() => unsealWith(key, "purchase-1", ""))
})
