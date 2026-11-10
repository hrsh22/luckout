// Live check of the relayer (ADR-0008) against a running server on testnet: the customer signs
// each call with a full-access key from ~/.near-credentials, the relayer sends it, and the
// customer's NEAR balance doesn't move.
// Usage: node scripts/relay.ts [customer.testnet]
import { Account, actions, buildDelegateAction, encodeDelegateAction, encodeSignedDelegate, JsonRpcProvider, KeyPair, type KeyPairString, Signature } from "near-api-js"
import { signMessage } from "near-api-js/nep413"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const [customer = "alice.luckout.testnet"] = process.argv.slice(2)
const api = process.env.API_URL ?? "http://localhost:8787"
const app = process.env.LUCKOUT_CONTRACT_ID ?? "app.luckout.testnet"
const usdc = process.env.USDC_CONTRACT_ID ?? "usdc.luckout.testnet"
const rpc = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" })
const secret = JSON.parse(readFileSync(`${homedir()}/.near-credentials/testnet/${customer}.json`, "utf8")).private_key as KeyPairString
const key = KeyPair.fromString(secret)

const req = async (method: string, path: string, body?: unknown, token?: string) => {
  const r = await fetch(api + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  return { status: r.status, json: await r.json().catch(() => null) }
}

const { json: c } = await req("POST", "/auth/challenge", {})
const s = await signMessage({
  signerAccount: new Account(customer, rpc, secret),
  payload: { message: c.message, recipient: c.recipient, nonce: Buffer.from(c.nonce, "base64") }
})
const { json: session } = await req("POST", "/auth/verify", {
  accountId: customer,
  publicKey: s.publicKey.toString(),
  signature: Buffer.from(s.signature).toString("base64"),
  nonce: c.nonce
})
const token = session.token as string

const near = async () => BigInt((await rpc.viewAccount({ accountId: customer, blockQuery: { finality: "optimistic" } })).amount)
const balance = async () => BigInt((await rpc.callFunction({ contractId: app, method: "get_account", args: { account_id: customer } }) as { balance: string }).balance)

// Signs one call the way a wallet's signDelegateActions does, without sending it.
const sign = async (receiverId: string, method: string, args: object, deposit: bigint, tgas = 30n) => {
  const [k, block] = await Promise.all([
    rpc.viewAccessKey({ accountId: customer, publicKey: key.getPublicKey(), finalityQuery: { finality: "optimistic" } }),
    rpc.viewBlock({ finality: "final" })
  ])
  const d = buildDelegateAction({
    senderId: customer,
    receiverId,
    actions: [actions.functionCall(method, args, tgas * 1_000_000_000_000n, deposit)],
    nonce: BigInt(k.nonce) + 1n,
    maxBlockHeight: BigInt(block.header.height) + 120n,
    publicKey: key.getPublicKey()
  })
  const sig = key.sign(createHash("sha256").update(encodeDelegateAction(d)).digest())
  return Buffer.from(encodeSignedDelegate({ delegateAction: d, signature: new Signature({ keyType: 0, data: sig.signature }) } as never)).toString("base64")
}
const relay = (signedDelegate: string) => req("POST", "/relay", { signedDelegate }, token)

assert.deepEqual((await req("GET", "/relay", undefined, token)).json, { available: true })
console.log("✔ the relayer is on for this account")

const nearBefore = await near()
const start = await balance()

const faucet = await relay(await sign(usdc, "faucet", {}, 0n))
assert.equal(faucet.status, 200, JSON.stringify(faucet.json))
const depositSigned = await sign(usdc, "ft_transfer_call", { receiver_id: app, amount: "1000000", msg: "" }, 1n, 100n)
const deposit = await relay(depositSigned)
assert.equal(deposit.status, 200, JSON.stringify(deposit.json))
assert.equal(await balance(), start + 1_000_000n)
console.log(`✔ faucet and a $1 deposit, relayed (${deposit.json.hash})`)

const again = await relay(depositSigned)
assert.equal(again.json?.hash, deposit.json.hash, "the same signature returns the first result")
assert.equal(await balance(), start + 1_000_000n, "and doesn't deposit twice")
console.log("✔ the same signature twice deposits once")

const withdraw = await relay(await sign(app, "withdraw", { amount: "1000000" }, 1n, 60n))
assert.equal(withdraw.status, 200, JSON.stringify(withdraw.json))
assert.equal(await balance(), start)
console.log(`✔ a $1 withdrawal, relayed (${withdraw.json.hash})`)

const tooMuch = await relay(await sign(app, "withdraw", { amount: String(start + 10n ** 12n) }, 1n, 60n))
assert.equal(tooMuch.status, 400)
assert.equal(tooMuch.json._tag, "RelayFailed")
console.log(`✔ a withdrawal the contract refuses comes back as: "${tooMuch.json.message}"`)

const foreign = await relay(await sign(usdc, "ft_transfer", { receiver_id: "luckout.testnet", amount: "1" }, 1n))
assert.equal(foreign.status, 400)
console.log(`✔ a call that isn't ours is refused before sending: "${foreign.json.message}"`)

// A refused call refunds its 1 yoctoNEAR deposit (which the relayer paid) to the customer.
assert.ok(await near() >= nearBefore, "the customer paid no NEAR")
console.log(`✔ ${customer} paid no NEAR: still ${Number(nearBefore) / 1e24} NEAR`)
