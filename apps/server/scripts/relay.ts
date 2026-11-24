// Live check of the relayer (ADR-0008) against a running server: the customer signs
// each call with a full-access key from ~/.near-credentials, the relayer sends it, and the
// customer's NEAR balance doesn't move.
// Usage: node scripts/relay.ts [--network mainnet] [--contract app.luckout.near] [customer]
// On mainnet the customer needs $1 of USDC already (there's no faucet); it's deposited and withdrawn again.
import { Account, actions, buildDelegateAction, encodeDelegateAction, encodeSignedDelegate, JsonRpcProvider, KeyPair, Signature } from "near-api-js"
import { signMessage } from "near-api-js/nep413"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { args, contract as app, keyOf, network, rpcUrl, usdc } from "./net.ts"

const [customer = "alice.luckout.testnet"] = args
const api = process.env.API_URL ?? "http://localhost:8787"
const rpc = new JsonRpcProvider({ url: rpcUrl })
const secret = keyOf(customer)
const key = KeyPair.fromString(secret)

const req = async (method: string, path: string, body?: unknown, session?: string) => {
  const r = await fetch(api + path, {
    method,
    headers: { "content-type": "application/json", ...(session ? { cookie: session } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  // A sign-in's session comes back only as a cookie: kept as the "name=value" to send back in `cookie`.
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith("__Host-luckout_session="))?.split(";")[0]
  return { status: r.status, json: await r.json().catch(() => null), session: cookie }
}

const { json: c } = await req("POST", "/auth/challenge", {})
const s = await signMessage({
  signerAccount: new Account(customer, rpc, secret),
  payload: { message: c.message, recipient: c.recipient, nonce: Buffer.from(c.nonce, "base64") }
})
const { session } = await req("POST", "/auth/verify", {
  accountId: customer,
  publicKey: s.publicKey.toString(),
  signature: Buffer.from(s.signature).toString("base64"),
  nonce: c.nonce
})
const token = session!

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

if (network === "testnet") {
  const faucet = await relay(await sign(usdc, "faucet", {}, 0n))
  assert.equal(faucet.status, 200, JSON.stringify(faucet.json))
}
const depositSigned = await sign(usdc, "ft_transfer_call", { receiver_id: app, amount: "1000000", msg: "" }, 1n, 100n)
const deposit = await relay(depositSigned)
assert.equal(deposit.status, 200, JSON.stringify(deposit.json))
assert.equal(await balance(), start + 1_000_000n)
console.log(`✔ a $1 deposit, relayed (${deposit.json.hash})`)

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
