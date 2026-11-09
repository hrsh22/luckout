// Draw Proof (ADR-0005): fetch a Draw from its transaction and recompute it here,
// from the seed, the purchase id and the immutable Game Version table, without our server.
// Mirrors draw_random / roll_from_random / final_bps_for_roll / final_price in contract/src/lib.rs.

export interface DrawEvent {
  purchase_id: number
  customer: string
  game_version: number
  reference_price: string
  lucky_amount: string
  max_price: string
  seed: string
  random: string
  roll: number
  final_bps: number
  final_price: string
  refund: string
}

export interface GameVersion {
  name: string
  premium_bps: number
  outcomes: Array<{ final_bps: number; chance_bps: number }>
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16))

/** sha256(seed || purchase_id as little-endian u64) */
export async function drawRandom(seedHex: string, purchaseId: number): Promise<string> {
  const input = new Uint8Array(40)
  input.set(unhex(seedHex))
  new DataView(input.buffer).setBigUint64(32, BigInt(purchaseId), true)
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", input)))
}

/** First 8 bytes as a little-endian u64, modulo 10,000. */
export const rollFrom = (randomHex: string) =>
  Number(new DataView(unhex(randomHex).buffer).getBigUint64(0, true) % 10_000n)

export function finalBpsFor(outcomes: GameVersion["outcomes"], roll: number) {
  let cumulative = 0
  for (const o of outcomes) {
    cumulative += o.chance_bps
    if (roll < cumulative) return o.final_bps
  }
  throw new Error("Roll outside table")
}

/** The unlucky part at Reference Price plus the drawn share of the Lucky Amount, rounded up, capped at Maximum Price. */
export function finalPrice(reference: bigint, lucky: bigint, max: bigint, finalBps: number) {
  const luckyPaid = (lucky * BigInt(finalBps) + 9_999n) / 10_000n
  const price = reference - lucky + luckyPaid
  return price < max ? price : max
}

export interface Check {
  label: string
  expected: string
  recomputed: string
  ok: boolean
}

/** Every step of the Draw recomputed and compared with what the contract logged. */
export async function verify(e: DrawEvent, version: GameVersion): Promise<Array<Check>> {
  const random = await drawRandom(e.seed, e.purchase_id)
  const roll = rollFrom(random)
  const bps = finalBpsFor(version.outcomes, roll)
  const price = finalPrice(BigInt(e.reference_price), BigInt(e.lucky_amount), BigInt(e.max_price), bps)
  const refund = BigInt(e.max_price) - price
  const row = (label: string, expected: string | number | bigint, recomputed: string | number | bigint) => ({
    label,
    expected: String(expected),
    recomputed: String(recomputed),
    ok: String(expected) === String(recomputed)
  })
  return [
    row("Random value", e.random, random),
    row("Roll", e.roll, roll),
    row("Final Price share", e.final_bps, bps),
    row("Final Price", e.final_price, price),
    row("Cashback", e.refund, refund)
  ]
}
