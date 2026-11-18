import { type AuthAction, authCallIntent, base58Decode, isIntentsSigner, moveInIntent, personalSignature, type SignedIntent, solanaAddress, transferIntent } from "@luckout/api"
import { createPublicKey, verify } from "node:crypto"
import { recoverMessageAddress } from "viem"

// The NEAR Intents payloads EVM and Solana customers sign (ADR-0011), checked before our relayer pays for one.
// Each must be signed by the signed-in account and hold exactly one intent, rebuilt here with the
// same helpers the web app uses: moving USDC into the customer's own Balance, one of our contract
// calls, or sending money to a 1Click swap this server quoted for them (a withdrawal, or a send-back).

export interface IntentRules {
  readonly accountId: string
  readonly intentsId: string
  readonly contractId: string
  readonly usdcId: string
  /** What a 1Click swap we quoted for this account takes (token and base units), if `transfer` pays one. */
  readonly quoted?: { readonly token: string; readonly amount: string } | undefined
  readonly now: Date
}

export interface IntentPayload {
  readonly signer_id: string
  readonly verifying_contract: string
  readonly deadline: string
  readonly nonce: string
  readonly intents: ReadonlyArray<Record<string, unknown>>
}

/** A Top-Up's move-in is signed when the swap starts and sent when it lands, up to a day later. */
const LONGEST_AHEAD_MS = 25 * 60 * 60 * 1000
const AUTH_ACTIONS = ["withdraw", "set_limits", "set_default_mode", "reclaim", "retry_draw"]

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** A move-in message's `mode`: undefined when it names none, null when it isn't "normal" or exactly `{"lucky":n}`. */
const startMode = (msg: unknown): "normal" | { lucky: number } | undefined | null => {
  let mode: unknown
  try {
    mode = (JSON.parse(String(msg)) as { mode?: unknown }).mode
  } catch {
    return null
  }
  if (mode === undefined || mode === "normal") return mode
  const lucky = (mode as { lucky?: unknown } | null)?.lucky
  return typeof mode === "object" && Object.keys(mode!).length === 1 && Number.isInteger(lucky) && (lucky as number) >= 0 &&
      (lucky as number) < 2 ** 32
    ? { lucky: lucky as number }
    : null
}

export const parsePayload = (payload: string): IntentPayload | undefined => {
  try {
    const p = JSON.parse(payload)
    const ok = p && typeof p === "object" && typeof p.signer_id === "string" && typeof p.verifying_contract === "string" &&
      typeof p.deadline === "string" && typeof p.nonce === "string" && Array.isArray(p.intents) &&
      p.intents.every((i: unknown) => i !== null && typeof i === "object" && !Array.isArray(i))
    return ok ? p : undefined
  } catch {
    return undefined
  }
}

/** Why we won't pay for this intent, or undefined if it's one of ours exactly as the app builds it. */
export const intentRefusal = (intent: Record<string, unknown>, r: IntentRules): string | undefined => {
  switch (intent.intent) {
    case "ft_withdraw": {
      const amount = intent.amount
      if (typeof amount !== "string" || !/^[1-9][0-9]{0,15}$/.test(amount) || BigInt(amount) < 1_000_000n) {
        return "Move at least 1 USDC into Luckout."
      }
      // A first move-in may name the Default Mode the account starts with, in the shape the contract reads.
      const mode = startMode(intent.msg)
      if (mode === null) return "Luckout only pays to move USDC into your own Balance."
      return same(intent, moveInIntent({ usdcId: r.usdcId, contractId: r.contractId, account: r.accountId, amount, mode }))
        ? undefined
        : "Luckout only pays to move USDC into your own Balance."
    }
    case "auth_call": {
      let action: unknown
      try {
        action = JSON.parse(String(intent.msg))
      } catch {
        return "Luckout only pays for its own calls."
      }
      const keys = action && typeof action === "object" ? Object.keys(action) : []
      return keys.length === 1 && AUTH_ACTIONS.includes(keys[0]!) && same(intent, authCallIntent(r.contractId, action as AuthAction))
        ? undefined
        : "Luckout only pays for its own calls."
    }
    case "transfer":
      return r.quoted && same(intent, transferIntent({ receiverId: String(intent.receiver_id), ...r.quoted }))
        ? undefined
        : "Luckout only pays to send your money to a 1Click swap it quoted for you."
    default:
      return "Luckout only pays for its own calls: moving USDC in and out, settings and reclaims."
  }
}

/** Why we won't pay for this payload, judged on its text alone (the signature is checked separately). */
export const payloadRefusal = (p: IntentPayload | undefined, r: IntentRules): string | undefined => {
  if (!p) return "That isn't a signed NEAR Intents message."
  if (p.signer_id !== r.accountId || !isIntentsSigner(p.signer_id)) return "This was signed for a different account than the one signed in."
  if (p.verifying_contract !== r.intentsId) return "This was signed for a different NEAR Intents contract."
  const deadline = Date.parse(p.deadline)
  if (!(deadline > r.now.getTime())) return "That approval expired. Try again."
  if (deadline > r.now.getTime() + LONGEST_AHEAD_MS) return "That approval lasts too long. Try again."
  if (Buffer.from(p.nonce, "base64").length !== 32) return "That isn't a signed NEAR Intents message."
  if (p.intents.length !== 1) return "Luckout only pays for one of its own calls at a time."
  return intentRefusal(p.intents[0]!, r)
}

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex")

/** Whether `signature` is the ed25519 key `publicKey` (32 raw bytes) signing exactly `message`. */
export const ed25519Signed = (publicKey: Uint8Array, message: string, signature: Uint8Array) => {
  if (publicKey.length !== 32 || signature.length !== 64) return false
  try {
    return verify(null, Buffer.from(message), createPublicKey({ key: Buffer.concat([SPKI_ED25519, publicKey]), format: "der", type: "spki" }), signature)
  } catch {
    return false
  }
}

/**
 * Whether the payload's signature is `accountId`'s own: an EVM account's personal_sign over its text, or a Solana
 * account's ed25519 signature over its raw bytes by the key the account is named after.
 */
export const signedBy = async (signed: SignedIntent, accountId: string) => {
  if (signed.standard === "raw_ed25519") {
    if (!/^[0-9a-f]{64}$/.test(accountId) || signed.public_key !== `ed25519:${solanaAddress(accountId)}` || !signed.signature.startsWith("ed25519:")) return false
    try {
      return ed25519Signed(base58Decode(signed.public_key.slice(8)), signed.payload, base58Decode(signed.signature.slice(8)))
    } catch {
      return false
    }
  }
  if (!accountId.startsWith("0x")) return false
  const signature = personalSignature(signed.signature)
  if (!signature) return false
  try {
    return (await recoverMessageAddress({ message: signed.payload, signature })).toLowerCase() === accountId
  } catch {
    return false
  }
}
