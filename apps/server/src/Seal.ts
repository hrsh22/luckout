import { Config, Option, Redacted } from "effect"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

// What we keep secret at rest (Redemption Data, Checkout Emails, Bitrefill logins) is sealed with AES-256-GCM
// under REDEMPTION_KEY and bound to what it belongs to (`aad`), so a sealed value can't be moved to another row.

/** REDEMPTION_KEY as 32 bytes; none if it's unset or not 64 hex characters. */
export const SealKey = Config.option(Config.Redacted("REDEMPTION_KEY")).pipe(
  Config.map((k) => Option.map(k, (v) => Buffer.from(Redacted.value(v), "hex")).pipe(Option.filter((b) => b.length === 32)))
)

export const sealWith = (key: Buffer, aad: string, data: unknown) => {
  const iv = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(aad))
  const body = Buffer.concat([c.update(JSON.stringify(data)), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64")
}

/** Throws if `sealed` was altered, or sealed under another key or `aad`. */
export const unsealWith = (key: Buffer, aad: string, sealed: string): unknown => {
  const b = Buffer.from(sealed, "base64")
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12)).setAAD(Buffer.from(aad)).setAuthTag(b.subarray(12, 28))
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString())
}
