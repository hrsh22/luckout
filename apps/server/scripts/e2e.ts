// End-to-end check against a running server on testnet. Signs in with full-access keys
// from ~/.near-credentials (NEP-413) and buys the free Bitrefill test card.
// Usage: node scripts/e2e.ts [customer.testnet] [other.testnet]
import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js"
import { signMessage } from "near-api-js/nep413"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const [customer = "alice.luckout.testnet", other = "luckout.testnet"] = process.argv.slice(2)
const api = process.env.API_URL ?? "http://localhost:8787"
const rpc = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" })

const req = async (method: string, path: string, body?: unknown, token?: string) => {
  const r = await fetch(api + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  return { status: r.status, json: await r.json().catch(() => null) }
}

const signed = async (accountId: string) => {
  const key = JSON.parse(readFileSync(`${homedir()}/.near-credentials/testnet/${accountId}.json`, "utf8")).private_key
  const { json: c } = await req("POST", "/auth/challenge", {})
  const s = await signMessage({
    signerAccount: new Account(accountId, rpc, key as KeyPairString),
    payload: { message: c.message, recipient: c.recipient, nonce: Buffer.from(c.nonce, "base64") }
  })
  return { accountId, publicKey: s.publicKey.toString(), signature: Buffer.from(s.signature).toString("base64"), nonce: c.nonce }
}

const signIn = async (accountId: string) => {
  const spoof = await signed(accountId)
  const impostor = await req("POST", "/auth/verify", { ...spoof, accountId: accountId === other ? customer : other })
  assert.equal(impostor.status, 401, "a key can't sign in an account it doesn't belong to")
  const body = await signed(accountId)
  const first = await req("POST", "/auth/verify", body)
  assert.equal(first.status, 200, JSON.stringify(first.json))
  assert.equal((await req("POST", "/auth/verify", body)).status, 401, "a nonce works only once")
  return first.json.token as string
}

const token = await signIn(customer)
console.log("✔ sign-in works; replayed nonce and foreign key refused")

assert.equal((await req("GET", "/purchases")).status, 401)
assert.equal((await req("GET", "/purchases", undefined, "forged.token")).status, 401)
console.log("✔ purchases need a valid session")

const buy = (body: object) => req("POST", "/purchases", body, token)
const idempotencyKey = crypto.randomUUID()
const normal = await buy({ voucherId: "test-gift-card-code", value: "10", mode: "normal", idempotencyKey })
assert.equal(normal.status, 200, JSON.stringify(normal.json))
assert.equal(normal.json.status, "delivered", JSON.stringify(normal.json))
assert.ok(typeof normal.json.redemption?.code === "string")
assert.equal(normal.json.draw, undefined, "Normal has no Draw")
console.log(`✔ Normal purchase delivered (${normal.json.admitTx} → ${normal.json.settleTx})`)

const retry = await buy({ voucherId: "test-gift-card-code", value: "10", mode: "normal", idempotencyKey })
assert.equal(retry.json.id, normal.json.id, "same idempotency key, same purchase")
console.log("✔ retry with the same key returns the same purchase")

// 100 USDC on Jackpot costs up to 150, above the default 50 USDC per-purchase limit.
const over = await buy({ voucherId: "test-gift-card-code", value: "100", mode: { lucky: 2 }, idempotencyKey: crypto.randomUUID() })
assert.equal(over.json.status, "rejected", JSON.stringify(over.json))
assert.match(over.json.error, /spending limit/)
console.log(`✔ the contract enforces Spending Limits: "${over.json.error}"`)

const otherToken = await signIn(other)
assert.equal((await req("GET", `/purchases/${normal.json.id}`, undefined, otherToken)).status, 404)
console.log("✔ another account can't read this purchase or its code")
