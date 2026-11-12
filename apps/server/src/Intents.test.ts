import { authCallIntent, intentPayload, intentSignature, moveInIntent, transferIntent } from "@luckout/api"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { test } from "node:test"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { type IntentRules, parsePayload, payloadRefusal, signedBy } from "./Intents.ts"

// The relayer pays only for EVM customers' own intents, exactly as the web app builds them (ADR-0011).

const me = privateKeyToAccount(generatePrivateKey())
const ME = me.address.toLowerCase()
const ids = { intentsId: "intents.test", contractId: "app.test", usdcId: "usdc.test" }
const USDC = `nep141:${ids.usdcId}`
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"
const rules = (o: Partial<IntentRules> = {}): IntentRules => ({ accountId: ME, ...ids, now: new Date(), ...o })
const payload = (intents: Array<object>, o: { signer?: string; deadline?: Date; nonce?: string; intentsId?: string } = {}) =>
  intentPayload({
    signer: o.signer ?? ME,
    intentsId: o.intentsId ?? ids.intentsId,
    deadline: o.deadline ?? new Date(Date.now() + 10 * 60_000),
    nonce: o.nonce ?? randomBytes(32).toString("base64"),
    intents
  })
const refusal = (text: string, o: Partial<IntentRules> = {}) => payloadRefusal(parsePayload(text), rules(o))
const moveIn = (amount = "5000000", account = ME) => moveInIntent({ usdcId: ids.usdcId, contractId: ids.contractId, account, amount })

test("our own intents, built by the web app's helpers, are paid for", () => {
  const ok = [
    moveIn(),
    authCallIntent(ids.contractId, { withdraw: { amount: "1000000" } }),
    authCallIntent(ids.contractId, { set_limits: { per_purchase: "1", daily: "2" } }),
    authCallIntent(ids.contractId, { set_default_mode: { mode: { lucky: 1 } } }),
    authCallIntent(ids.contractId, { reclaim: { purchase_id: 3 } }),
    authCallIntent(ids.contractId, { retry_draw: { purchase_id: 3 } })
  ]
  for (const i of ok) assert.equal(refusal(payload([i])), undefined, JSON.stringify(i))
  const exit = transferIntent({ receiverId: "a".repeat(64), token: USDC, amount: "2000000" })
  assert.equal(refusal(payload([exit]), { quoted: { token: USDC, amount: "2000000" } }), undefined, "a withdrawal we quoted")
  const back = transferIntent({ receiverId: "a".repeat(64), token: BASE_USDC, amount: "120132" })
  assert.equal(refusal(payload([back]), { quoted: { token: BASE_USDC, amount: "120132" } }), undefined, "a send-back we quoted")
})

test("anything else, or ours with one thing changed, is refused", () => {
  const withdraw = authCallIntent(ids.contractId, { withdraw: { amount: "1000000" } })
  const no: Array<[string, string, Partial<IntentRules>?]> = [
    ["someone else's account", payload([moveIn()], { signer: "0x" + "1".repeat(40) })],
    ["a NEAR account", payload([moveIn("5000000", "alice.near")], { signer: "alice.near" }), { accountId: "alice.near" }],
    ["another Intents contract", payload([moveIn()], { intentsId: "intents.near" })],
    ["expired", payload([moveIn()], { deadline: new Date(Date.now() - 1000) })],
    ["valid for days", payload([moveIn()], { deadline: new Date(Date.now() + 3 * 86_400_000) })],
    ["a short nonce", payload([moveIn()], { nonce: "AAAA" })],
    ["two intents", payload([moveIn(), withdraw])],
    ["no intents", payload([])],
    ["crediting someone else", payload([moveIn("5000000", "0x" + "2".repeat(40))])],
    ["under 1 USDC", payload([moveIn("999999")])],
    ["to another contract", payload([{ ...moveIn(), receiver_id: "evil.test" }])],
    ["another token", payload([{ ...moveIn(), token: "fake-usdc.test" }])],
    ["a storage deposit", payload([{ ...moveIn(), storage_deposit: "1250000000000000000000" }])],
    ["an AuthCall to another contract", payload([authCallIntent("evil.test", { withdraw: { amount: "1" } })])],
    ["an AuthCall with a deposit", payload([{ ...withdraw, attached_deposit: "1" }])],
    ["an AuthCall with less gas", payload([{ ...withdraw, min_gas: "1" }])],
    ["an unknown action", payload([{ ...withdraw, msg: JSON.stringify({ purchase: { amount: "1" } }) }])],
    ["two actions", payload([{ ...withdraw, msg: JSON.stringify({ withdraw: { amount: "1" }, reclaim: { purchase_id: 1 } }) }])],
    ["a transfer we never quoted", payload([transferIntent({ receiverId: "b".repeat(64), token: USDC, amount: "2000000" })])],
    ["a transfer for more than the quote", payload([transferIntent({ receiverId: "b".repeat(64), token: USDC, amount: "3000000" })]), { quoted: { token: USDC, amount: "2000000" } }],
    ["another token than the quote's", payload([transferIntent({ receiverId: "b".repeat(64), token: USDC, amount: "120132" })]), { quoted: { token: BASE_USDC, amount: "120132" } }],
    ["two tokens", payload([{ ...transferIntent({ receiverId: "b".repeat(64), token: BASE_USDC, amount: "120132" }), tokens: { [BASE_USDC]: "120132", [USDC]: "1" } }]), { quoted: { token: BASE_USDC, amount: "120132" } }],
    ["a swap", payload([{ intent: "token_diff", diff: { "nep141:usdc.test": "-1" } }])],
    ["not JSON", "hello"]
  ]
  for (const [name, text, o] of no) assert.ok(refusal(text, o), name)
})

test("the signature must be the signed-in account's own personal_sign over the text", async () => {
  const text = payload([moveIn()])
  const signed = { standard: "erc191" as const, payload: text, signature: intentSignature(await me.signMessage({ message: text })) }
  assert.match(signed.signature, /^secp256k1:/)
  assert.equal(await signedBy(signed, ME), true)
  const other = privateKeyToAccount(generatePrivateKey())
  assert.equal(await signedBy({ ...signed, signature: intentSignature(await other.signMessage({ message: text })) }, ME), false)
  assert.equal(await signedBy({ ...signed, payload: text.replace("5000000", "6000000") }, ME), false)
  assert.equal(await signedBy({ ...signed, signature: "secp256k1:abc" }, ME), false)
})
