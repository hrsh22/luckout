import { js_get_collateral, js_verify } from "@phala/dcap-qvl-node"
import { createHash, randomBytes } from "node:crypto"
import { recoverMessageAddress } from "viem"

// The Agent's model runs privately on NEAR AI Cloud inside a TEE. We don't take that on trust: every
// hour, with a fresh nonce, we check the whole chain NEAR documents (docs.near.ai/cloud/verification):
//   NVIDIA GPUs (NRAS) → Intel TDX quote → the signing key and our nonce bound in the TDX report
//   → the container config the enclave runs → every reply's signature, recovered to that key.
// The Agent chats only while a passing check is on file, and a reply whose signature doesn't
// verify is never shown (Agent.ts).

const INTEL_PCCS = "https://api.trustedservices.intel.com/tdx/certification/v4"
const NRAS = "https://nras.attestation.nvidia.com/v3/attest/gpu"
/** Intel calls a platform below its latest advisory baseline OutOfDate; the quote itself still verifies. */
const TDX_OK = new Set(["UpToDate", "OutOfDate"])
/** One passing check covers this long. Checks run hourly, so one failed run doesn't stop the Agent. */
const FRESH_MS = 2 * 60 * 60_000

export interface Check {
  readonly name: string
  readonly ok: boolean
}

export interface Attested {
  readonly model: string
  readonly ok: boolean
  readonly checkedAt: number
  readonly nonce: string
  /** Signing keys of the TEE nodes serving the model (lowercase). */
  readonly modelKeys: ReadonlyArray<string>
  /** Signing key of NEAR AI's gateway TEE (lowercase). */
  readonly gatewayKey: string
  readonly checks: ReadonlyArray<Check>
}

interface Enclave {
  readonly signing_address: string
  readonly intel_quote: string
  readonly request_nonce?: string
  readonly nvidia_payload?: string
  readonly info: { readonly tcb_info: string | { readonly app_compose: string } }
}

export interface NearAi {
  readonly baseURL: string
  readonly apiKey: string
  readonly model: string
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex")
const json = async (url: string, init: RequestInit = {}) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`)
  return res.json() as Promise<unknown>
}

/** The TDX report data holds the enclave's signing key (32 bytes, zero-padded) and then our nonce. */
export const bindsKeyAndNonce = (reportData: string, signingAddress: string, nonce: string) => {
  const key = Buffer.from(signingAddress.replace(/^0x/i, ""), "hex")
  const want = Buffer.concat([key, Buffer.alloc(32 - key.length), Buffer.from(nonce, "hex")])
  return Buffer.from(reportData.replace(/^0x/i, ""), "hex").equals(want)
}

/** mr_config in the verified quote commits to the exact app-compose the enclave booted. */
export const composeMatches = (appCompose: string, mrConfig: string) => mrConfig.toLowerCase().startsWith(`01${sha256(appCompose)}`)

// NRAS tokens come straight from NVIDIA over TLS; like NEAR's own verifiers we read their claims.
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString()) as Record<string, unknown>

/** NVIDIA's verdict on every GPU: genuine, measured, secure boot on, debug off, and answering our nonce. */
export const gpusOk = (nras: unknown, nonce: string, now: number) => {
  const [[, overallJwt], perGpu] = nras as [[string, string], Record<string, string>]
  const overall = claims(overallJwt)
  const gpus = Object.values(perGpu).map(claims)
  return overall["x-nvidia-overall-att-result"] === true && overall.eat_nonce === nonce && Number(overall.exp) * 1000 > now &&
    gpus.length > 0 &&
    gpus.every((g) =>
      g.secboot === true && g.dbgstat === "disabled" && g.measres === "success" &&
      g["x-nvidia-gpu-attestation-report-nonce-match"] === true && (g.eat_nonce === undefined || g.eat_nonce === nonce) &&
      Object.entries(g).filter(([k]) => k.endsWith("-verified")).every(([, v]) => v === true)
    )
}

const enclave = async (who: string, e: Enclave, nonce: string, now: number): Promise<Array<Check>> => {
  const quote = Buffer.from(e.intel_quote, "hex")
  const tdx = js_verify(quote, await js_get_collateral(INTEL_PCCS, quote), BigInt(Math.floor(now / 1000))) as {
    status?: string
    report?: { TD10?: { report_data: string; mr_config_id: string }; TD15?: { report_data: string; mr_config_id: string } }
  }
  const td = tdx.report?.TD10 ?? tdx.report?.TD15
  const tcb = typeof e.info.tcb_info === "string" ? JSON.parse(e.info.tcb_info) as { app_compose: string } : e.info.tcb_info
  const checks = [
    { name: `${who}: answered with our fresh nonce`, ok: e.request_nonce === nonce },
    { name: `${who}: Intel TDX quote verified`, ok: TDX_OK.has(tdx.status ?? "") },
    { name: `${who}: its signing key and our nonce are in the TDX report`, ok: !!td && bindsKeyAndNonce(td.report_data, e.signing_address, nonce) },
    { name: `${who}: runs the container config it attests`, ok: !!td && composeMatches(tcb.app_compose, td.mr_config_id) }
  ]
  if (!e.nvidia_payload) return checks
  const gpu = JSON.parse(e.nvidia_payload) as { nonce: string }
  const nras = await json(NRAS, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(gpu) })
  return [...checks, { name: `${who}: NVIDIA verified its GPUs`, ok: gpu.nonce === nonce && gpusOk(nras, nonce, now) }]
}

/** One full check, with a nonce no one has seen before. Throws only when a service can't be reached. */
export const attest = async (ai: NearAi, now = Date.now()): Promise<Attested> => {
  const nonce = randomBytes(32).toString("hex")
  const report = await json(
    `${ai.baseURL}/attestation/report?model=${encodeURIComponent(ai.model)}&signing_algo=ecdsa&nonce=${nonce}`,
    { headers: { authorization: `Bearer ${ai.apiKey}` } }
  ) as { gateway_attestation: Enclave; model_attestations?: Array<Enclave> }
  const nodes = report.model_attestations ?? []
  const checks = [
    { name: "The model runs on at least one attested TEE node", ok: nodes.length > 0 },
    ...await enclave("Gateway", report.gateway_attestation, nonce, now),
    ...(await Promise.all(nodes.map((n, i) => enclave(`Model node ${i + 1}`, n, nonce, now)))).flat()
  ]
  return {
    model: ai.model,
    ok: checks.every((c) => c.ok),
    checkedAt: now,
    nonce,
    modelKeys: nodes.map((n) => n.signing_address.toLowerCase()),
    gatewayKey: report.gateway_attestation.signing_address.toLowerCase(),
    checks
  }
}

export interface Signature {
  readonly text: string
  readonly signature: `0x${string}`
}

/**
 * Whether NEAR AI signed exactly this request and response with an attested key. The model's TEE
 * signs "model:request-hash:response-hash"; when the gateway rewrites the bytes, it signs without the model.
 */
export const replySigned = async (sig: Signature, request: string, response: string, a: Pick<Attested, "model" | "modelKeys" | "gatewayKey">) => {
  const hashes = `${sha256(request)}:${sha256(response)}`
  const byModel = sig.text === `${a.model}:${hashes}`
  if (!byModel && sig.text !== hashes) return false
  const signer = (await recoverMessageAddress({ message: sig.text, signature: sig.signature })).toLowerCase()
  return byModel ? a.modelKeys.includes(signer) : signer === a.gatewayKey
}

/** A reply's signature lives on the node that served it, so a lookup can miss once or twice. */
const signatureOf = async (ai: NearAi, chatId: string): Promise<Signature> => {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${ai.baseURL}/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(ai.model)}&signing_algo=ecdsa`, {
      headers: { authorization: `Bearer ${ai.apiKey}` },
      signal: AbortSignal.timeout(15_000)
    })
    if (res.ok) return res.json() as Promise<Signature>
    if (res.status !== 404 || attempt === 5) throw new Error(`NEAR AI signature lookup answered ${res.status}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

/** Keeps the latest check, says whether the Agent may chat, and verifies each reply against it. */
export const makeAttestation = (ai: NearAi, alert: (message: string) => void, check = attest) => {
  let latest: Attested | undefined
  let running: Promise<Attested | undefined> | undefined
  const replies = { verified: 0, refused: 0 }

  const refresh = () =>
    running ??= check(ai)
      .then((a) => {
        latest = a
        if (!a.ok) alert(`NEAR AI attestation failed (${a.checks.filter((c) => !c.ok).map((c) => c.name).join("; ")}): the Agent is off until it passes`)
        return a
      }, (e: unknown) => {
        alert(`Couldn't check NEAR AI's attestation (${e instanceof Error ? e.message : String(e)}); the Agent stops if this lasts 2 hours`)
        return latest
      })
      .finally(() => (running = undefined))

  const passing = (a = latest) => !!a?.ok && a.checkedAt > Date.now() - FRESH_MS

  return {
    refresh,
    latest: () => latest && { ...latest, replies: { ...replies } },
    /** Whether the Agent may chat: a passing check is on file, or one passes now. */
    ready: async () => passing() || passing(await refresh()),
    /** Whether this exact completion was signed inside the attested TEE; a key we haven't seen gets one fresh check. */
    verify: async (request: string, response: string, chatId: string) => {
      const ok = await signatureOf(ai, chatId)
        .then(async (sig) => {
          if (passing() && await replySigned(sig, request, response, latest!)) return true
          const again = await refresh()
          return passing(again) && replySigned(sig, request, response, again!)
        })
        .catch((e: unknown) => (console.error("reply signature check failed:", e instanceof Error ? e.message : e), false))
      if (ok) replies.verified++
      else {
        replies.refused++
        alert("A NEAR AI reply didn't verify against the attested TEE keys, so the Agent withheld it")
      }
      return ok
    }
  }
}
