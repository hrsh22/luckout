// Draw Proof (ADR-0005, ADR-0015): recompute a card's Draw from ORAO's randomness, the card's place in its Checkout and
// the immutable Game Version table. The web app runs it in the browser; the server's MCP verify_draw tool runs the same
// code. Mirrors card_random / roll_from_random / final_bps_for_roll / final_price in the program's game.rs.

export interface GameVersion {
  name: string
  premium_bps: number
  outcomes: ReadonlyArray<{ final_bps: number; chance_bps: number }>
}

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
export const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16))

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
  /** What the raw numbers are in (basis points of the price, or micro-USDC), so they can also be read plainly. */
  unit?: "bps" | "usdc"
}

/** "11000" bps → "110% of the price"; "605000" micro-USDC → "$0.605". */
export const plainly = (value: string, unit: NonNullable<Check["unit"]>) =>
  unit === "bps"
    ? `${Number(value) / 100}% of the price`
    : `$${(Number(value) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`

/**
 * One card's Draw as the Solana program records it (ADR-0015): byte fields as hex, amounts as integer strings.
 * `randomness` is ORAO's filled-in value (64 bytes).
 */
export interface CardDraw {
  card: number
  game_version: number
  reference_price: string
  lucky_amount: string
  max_price: string
  randomness: string
  random: string
  roll: number
  final_bps: number
  final_price: string
  cashback: string
}

/** sha256(ORAO's value ‖ the card's index as one byte), as the program's `card_random`. */
export async function cardRandom(randomnessHex: string, card: number): Promise<string> {
  const input = new Uint8Array(65)
  input.set(unhex(randomnessHex))
  input[64] = card
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", input)))
}

/** Every step of a card's Draw on Solana recomputed and compared with what the program recorded. */
export async function verifyCard(e: CardDraw, version: GameVersion): Promise<Array<Check>> {
  return checksFrom(e, await cardRandom(e.randomness, e.card), version)
}

function checksFrom(e: CardDraw, random: string, version: GameVersion): Array<Check> {
  const roll = rollFrom(random)
  const bps = finalBpsFor(version.outcomes, roll)
  const price = finalPrice(BigInt(e.reference_price), BigInt(e.lucky_amount), BigInt(e.max_price), bps)
  const cashback = BigInt(e.max_price) - price
  const row = (label: string, expected: string | number | bigint, recomputed: string | number | bigint, unit?: Check["unit"]) => ({
    label,
    expected: String(expected),
    recomputed: String(recomputed),
    ok: String(expected) === String(recomputed),
    ...(unit ? { unit } : {})
  })
  return [
    row("Random value", e.random, random),
    row("Roll", e.roll, roll),
    row("Final Price share", e.final_bps, bps, "bps"),
    row("Final Price", e.final_price, price, "usdc"),
    row("Cashback", e.cashback, cashback, "usdc")
  ]
}
