// End-to-end check of EVM wallets (ADR-0011) against a running server on testnet. A fresh EVM key
// signs in, gets test USDC in its NEAR Intents account (faucet → intents.luckout.testnet, paid by
// the funder's key from ~/.near-credentials), moves it into Luckout, changes settings, buys the free
// Bitrefill test card, and withdraws back to its Intents account, all through signed intents our
// relayer sends. Then it checks what must be refused.
// Usage: node scripts/e2e-evm.ts [funder.testnet]
import {
  type AuthAction,
  authCallIntent,
  evmSignInMessage,
  intentPayload,
  intentSignature,
  moveInIntent,
  type SignedIntent
} from "@luckout/api"
import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"

const [funder = "alice.luckout.testnet"] = process.argv.slice(2)
const api = process.env.API_URL ?? "http://localhost:8787"
const APP = "app.luckout.testnet"
const USDC = "usdc.luckout.testnet"
const INTENTS = "intents.luckout.testnet"
const rpc = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" })
const view = async <A>(contractId: string, method: string, args: Record<string, unknown>) => (await rpc.callFunction({ contractId, method, args })) as A

const req = async (method: string, path: string, body?: unknown, token?: string) => {
  const r = await fetch(api + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  return { status: r.status, json: await r.json().catch(() => null) }
}

const wallet = privateKeyToAccount(generatePrivateKey())
const ME = wallet.address.toLowerCase()
const stranger = privateKeyToAccount(generatePrivateKey())

const sign = async (intents: Array<object>, by = wallet, signer = ME): Promise<SignedIntent> => {
  const payload = intentPayload({
    signer,
    intentsId: INTENTS,
    deadline: new Date(Date.now() + 10 * 60_000),
    nonce: randomBytes(32).toString("base64"),
    intents
  })
  return { standard: "erc191", payload, signature: intentSignature(await by.signMessage({ message: payload })) }
}
const auth = (action: AuthAction) => authCallIntent(APP, action)
const intentsUsdc = async () => BigInt(await view<string>(INTENTS, "mt_balance_of", { account_id: ME, token_id: `nep141:${USDC}` }))
const balance = async () => BigInt((await view<{ balance: string } | null>(APP, "get_account", { account_id: ME }))?.balance ?? "0")

// Sign in: a personal_sign of the challenge, once, by the address's own key.
const { json: c } = await req("POST", "/auth/challenge", {})
const signature = await wallet.signMessage({ message: evmSignInMessage(c) })
const forged = await req("POST", "/auth/verify-evm", { address: ME, signature: await stranger.signMessage({ message: evmSignInMessage(c) }), nonce: c.nonce })
assert.equal(forged.status, 401, "another key can't sign in this address")
const { json: c2 } = await req("POST", "/auth/challenge", {})
const s2 = await wallet.signMessage({ message: evmSignInMessage(c2) })
const session = await req("POST", "/auth/verify-evm", { address: wallet.address, signature: s2, nonce: c2.nonce })
assert.equal(session.status, 200, JSON.stringify(session.json))
assert.equal(session.json.accountId, ME)
assert.equal((await req("POST", "/auth/verify-evm", { address: wallet.address, signature: s2, nonce: c2.nonce })).status, 401, "once")
void signature
const token = session.json.token as string
console.log(`✔ ${ME} signs in; another key and a replay are refused`)

// Test USDC into its NEAR Intents account, as 1Click would deliver it on mainnet.
const key = JSON.parse(readFileSync(`${homedir()}/.near-credentials/testnet/${funder}.json`, "utf8")).private_key as KeyPairString
const funding = new Account(funder, rpc, key)
await funding.callFunction({ contractId: USDC, methodName: "faucet", args: {}, gas: 30_000_000_000_000n })
await funding.callFunction({
  contractId: USDC,
  methodName: "ft_transfer_call",
  args: { receiver_id: INTENTS, amount: "20000000", msg: ME },
  deposit: 1n,
  gas: 100_000_000_000_000n
})
assert.equal(await intentsUsdc(), 20_000_000n)
console.log("✔ 20 test USDC in its NEAR Intents account")

const relay = (signed: SignedIntent) => req("POST", "/relay/intent", { signed }, token)

// Move 15 into Luckout.
const moved = await relay(await sign([moveInIntent({ usdcId: USDC, contractId: APP, account: ME, amount: "15000000" })]))
assert.equal(moved.status, 200, JSON.stringify(moved.json))
assert.equal(await balance(), 15_000_000n)
assert.equal(await intentsUsdc(), 5_000_000n)
console.log(`✔ 15 USDC moved into Luckout (${moved.json.hash}), gas on the relayer`)

// Settings through AuthCall.
for (const action of [{ set_default_mode: { mode: { lucky: 1 } } }, { set_limits: { per_purchase: "13000000", daily: "14000000" } }] as const) {
  const r = await relay(await sign([auth(action)]))
  assert.equal(r.status, 200, JSON.stringify(r.json))
}
const account = await view<{ default_mode: unknown; per_purchase_limit: string; daily_limit: string }>(APP, "get_account", { account_id: ME })
assert.deepEqual([account.default_mode, account.per_purchase_limit, account.daily_limit], [{ lucky: 1 }, "13000000", "14000000"])
console.log("✔ Default Mode and Spending Limits set by signed intents")

// A Lucky Buy of the free test card, like any customer (Bitrefill test card; needs the server's keys).
const { json: q } = await req("GET", "/quote?voucherId=test-gift-card-code&value=10&game=1")
const lucky = await req("POST", "/purchases", {
  voucherId: "test-gift-card-code",
  value: "10",
  mode: { lucky: 1 },
  maxPrice: q.maxPrice,
  idempotencyKey: crypto.randomUUID()
}, token)
assert.equal(lucky.status, 200, JSON.stringify(lucky.json))
assert.equal(lucky.json.status, "delivered", JSON.stringify(lucky.json))
assert.ok(lucky.json.draw, "a Lucky Buy has a Draw")
console.log(`✔ Lucky Buy delivered, Cashback ${lucky.json.draw.cashback}`)

// Withdraw 2 back to its own NEAR Intents account.
const [beforeIntents, beforeBalance] = [await intentsUsdc(), await balance()]
const out = await relay(await sign([auth({ withdraw: { amount: "2000000" } })]))
assert.equal(out.status, 200, JSON.stringify(out.json))
assert.equal(await intentsUsdc(), beforeIntents + 2_000_000n)
assert.equal(await balance(), beforeBalance - 2_000_000n)
console.log("✔ 2 USDC withdrawn to its own NEAR Intents account")

// What must be refused, before anyone pays.
const refused: Array<[string, SignedIntent]> = [
  ["crediting someone else", await sign([moveInIntent({ usdcId: USDC, contractId: APP, account: "0x" + "1".repeat(40), amount: "1000000" })])],
  ["signed by another key", await sign([auth({ withdraw: { amount: "1000000" } })], stranger)],
  ["for another account", await sign([auth({ withdraw: { amount: "1000000" } })], stranger, stranger.address.toLowerCase())],
  ["a swap", await sign([{ intent: "token_diff", diff: { [`nep141:${USDC}`]: "-1000000" } }])],
  ["an unquoted transfer", await sign([{ intent: "transfer", receiver_id: "f".repeat(64), tokens: { [`nep141:${USDC}`]: "1000000" } }])]
]
for (const [name, s] of refused) assert.equal((await relay(s)).status, 400, name)
const tooMuch = await relay(await sign([auth({ withdraw: { amount: "999000000" } })]))
assert.equal(tooMuch.status, 400, "more than the balance is refused, by the relayer's free check before the contract")
assert.match(tooMuch.json.message, /balance is lower|Insufficient balance/)
console.log("✔ someone else's credit, a forged or foreign signature, swaps, unquoted transfers and overdrafts are refused")
