// NEAR Intents payloads an EVM wallet signs (ADR-0011). The web app builds them with these helpers
// and the server rebuilds each one to check it, so the relayer only pays for intents exactly as the
// app makes them.

/** An EVM customer: their address in lowercase, which is also their NEAR Intents account. */
export const isEvmAccount = (id: string) => /^0x[0-9a-f]{40}$/.test(id)

/** The Luckout calls an EVM customer signs through NEAR Intents' AuthCall (the contract's `AuthAction`). */
export type AuthAction =
  | { readonly withdraw: { readonly amount: string } }
  | { readonly set_limits: { readonly per_purchase: string; readonly daily: string } }
  | { readonly set_default_mode: { readonly mode: "normal" | { readonly lucky: number } } }
  | { readonly reclaim: { readonly purchase_id: number } }
  | { readonly retry_draw: { readonly purchase_id: number } }

/** Gas `intents.near` must give `on_auth`, whoever submits it: a withdrawal's transfer into Intents and our callback. */
export const AUTH_CALL_GAS = "80000000000000"

/** Moves `amount` USDC from the customer's NEAR Intents account into their Luckout Balance. */
export const moveInIntent = (o: { usdcId: string; contractId: string; account: string; amount: string }) => ({
  intent: "ft_withdraw",
  token: o.usdcId,
  receiver_id: o.contractId,
  amount: o.amount,
  msg: JSON.stringify({ for: o.account })
})

/** Has `intents.near` call our contract's `on_auth` as the signer. */
export const authCallIntent = (contractId: string, action: AuthAction) => ({
  intent: "auth_call",
  contract_id: contractId,
  msg: JSON.stringify(action),
  min_gas: AUTH_CALL_GAS
})

/** Sends `amount` USDC from the customer's NEAR Intents account to `receiverId` (a 1Click deposit address). */
export const transferIntent = (o: { receiverId: string; usdcId: string; amount: string }) => ({
  intent: "transfer",
  receiver_id: o.receiverId,
  tokens: { [`nep141:${o.usdcId}`]: o.amount }
})

/** The text the wallet signs; `intents.near` reads it as JSON. `nonce`: 32 random bytes, base64. */
export const intentPayload = (o: { signer: string; intentsId: string; deadline: Date; nonce: string; intents: ReadonlyArray<object> }) =>
  JSON.stringify({
    signer_id: o.signer,
    verifying_contract: o.intentsId,
    deadline: o.deadline.toISOString(),
    nonce: o.nonce,
    intents: o.intents
  })

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

export const base58Encode = (bytes: Uint8Array) => {
  let n = bytes.reduce((acc, b) => (acc << 8n) + BigInt(b), 0n)
  let out = ""
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = "1" + out
  }
  return out
}

export const base58Decode = (text: string) => {
  let n = 0n
  for (const c of text) {
    const i = ALPHABET.indexOf(c)
    if (i < 0) throw new Error("not base58")
    n = n * 58n + BigInt(i)
  }
  const bytes: Array<number> = []
  while (n > 0n) {
    bytes.unshift(Number(n & 255n))
    n >>= 8n
  }
  for (const c of text) {
    if (c !== "1") break
    bytes.unshift(0)
  }
  return Uint8Array.from(bytes)
}

/** A personal_sign signature (0x hex, 65 bytes, v 27/28) as `intents.near` takes it: `secp256k1:<base58>` with v as 0/1. */
export const intentSignature = (hex: string) => {
  const bytes = Uint8Array.from((hex.replace(/^0x/, "").match(/../g) ?? []).map((b) => parseInt(b, 16)))
  if (bytes.length !== 65) throw new Error("Expected a 65-byte signature")
  if (bytes[64]! >= 27) bytes[64] = bytes[64]! - 27
  return `secp256k1:${base58Encode(bytes)}`
}

/** The other way round, for checking: `secp256k1:<base58>` back to 0x hex with v as 27/28. */
export const personalSignature = (signature: string) => {
  const bytes = base58Decode(signature.replace(/^secp256k1:/, ""))
  if (!signature.startsWith("secp256k1:") || bytes.length !== 65 || bytes[64]! > 1) return undefined
  bytes[64] = bytes[64]! + 27
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`
}
