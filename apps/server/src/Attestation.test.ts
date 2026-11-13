import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { privateKeyToAccount } from "viem/accounts"
import { type Attested, bindsKeyAndNonce, composeMatches, gpusOk, makeAttestation, replySigned } from "./Attestation.ts"

const nonce = "ab".repeat(32)
const sha = (s: string) => createHash("sha256").update(s).digest("hex")
const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`

test("the TDX report must hold the enclave's own key and our nonce", () => {
  const key = "0xfe0071895500a9755c18044948ab4f4e1a7f337e"
  const reportData = `${key.slice(2)}${"0".repeat(24)}${nonce}`
  assert.ok(bindsKeyAndNonce(reportData, key, nonce))
  assert.ok(!bindsKeyAndNonce(reportData, "0x" + "11".repeat(20), nonce), "another key")
  assert.ok(!bindsKeyAndNonce(reportData, key, "cd".repeat(32)), "a replayed report")
})

test("mr_config must commit to the app-compose the enclave reports", () => {
  const compose = '{"name":"cloud-api"}'
  assert.ok(composeMatches(compose, `01${sha(compose)}0000`))
  assert.ok(!composeMatches('{"name":"other"}', `01${sha(compose)}0000`))
})

test("every GPU must pass NVIDIA's checks for our nonce", () => {
  const gpu = { secboot: true, dbgstat: "disabled", measres: "success", "x-nvidia-gpu-attestation-report-nonce-match": true, "x-nvidia-gpu-driver-rim-signature-verified": true }
  const nras = (overall: object, ...gpus: Array<object>) => [["JWT", jwt({ "x-nvidia-overall-att-result": true, eat_nonce: nonce, exp: 2e9, ...overall })], Object.fromEntries(gpus.map((g, i) => [`GPU-${i}`, jwt(g)]))]
  const now = 1.9e12
  assert.ok(gpusOk(nras({}, gpu, gpu), nonce, now))
  assert.ok(!gpusOk(nras({ eat_nonce: "cd".repeat(32) }, gpu), nonce, now), "an old attestation")
  assert.ok(!gpusOk(nras({ exp: 1e9 }, gpu), nonce, now), "an expired token")
  assert.ok(!gpusOk(nras({}, gpu, { ...gpu, dbgstat: "enabled" }), nonce, now), "one GPU in debug mode")
  assert.ok(!gpusOk(nras({}, { ...gpu, "x-nvidia-gpu-driver-rim-signature-verified": false }), nonce, now), "an unverified driver")
  assert.ok(!gpusOk(nras({}), nonce, now), "no GPUs at all")
})

test("a reply counts only if an attested key signed exactly what we sent and got", async () => {
  const node = privateKeyToAccount(`0x${"11".repeat(32)}`)
  const gateway = privateKeyToAccount(`0x${"22".repeat(32)}`)
  const stranger = privateKeyToAccount(`0x${"33".repeat(32)}`)
  const a = { model: "m/x", modelKeys: [node.address.toLowerCase()], gatewayKey: gateway.address.toLowerCase() }
  const request = '{"model":"m/x"}', response = '{"id":"c1"}'
  const signed = async (who: typeof node, text: string) => ({ text, signature: await who.signMessage({ message: text }) })
  const byModel = `m/x:${sha(request)}:${sha(response)}`
  assert.ok(await replySigned(await signed(node, byModel), request, response, a))
  assert.ok(await replySigned(await signed(gateway, `${sha(request)}:${sha(response)}`), request, response, a), "the gateway's signature")
  assert.ok(!await replySigned(await signed(stranger, byModel), request, response, a), "a key outside the TEE")
  assert.ok(!await replySigned(await signed(gateway, byModel), request, response, a), "the gateway's key can't stand in for the model's")
  assert.ok(!await replySigned(await signed(node, byModel), request, '{"id":"c2"}', a), "a different response")
  assert.ok(!await replySigned(await signed(node, `other:${sha(request)}:${sha(response)}`), request, response, a), "another model")
})

test("the Agent chats only while a passing check from the last two hours is on file", async () => {
  const now = Date.now()
  const result = (ok: boolean, checkedAt = now): Attested => ({ model: "m", ok, checkedAt, nonce, modelKeys: [], gatewayKey: "", checks: [{ name: "x", ok }] })
  const alerts: Array<string> = []
  let next: () => Promise<Attested> = async () => result(false)
  const tee = makeAttestation({ baseURL: "", apiKey: "", model: "m" }, (m) => alerts.push(m), () => next())
  assert.equal(await tee.ready(), false, "a failed check")
  assert.match(alerts[0]!, /attestation failed \(x\)/)
  next = async () => result(true, now - 3 * 60 * 60_000)
  assert.equal(await tee.ready(), false, "a passing check that's too old")
  next = async () => result(true)
  assert.equal(await tee.ready(), true)
  next = async () => Promise.reject(new Error("NRAS down"))
  await tee.refresh()
  assert.equal(await tee.ready(), true, "an outage keeps the last passing check")
  assert.match(alerts.at(-1)!, /NRAS down/)
})
