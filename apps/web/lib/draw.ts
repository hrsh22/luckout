// The Draw Proof's math lives in @luckout/api, so the server's MCP tools recompute Draws with the same code. The checks
// that tie a Draw to its Checkout and to ORAO's request are here: they need Solana's address math, from @solana/kit.
import type { CardDrawProof } from "@luckout/api"
import { type Check, hex, unhex, verifyCard } from "@luckout/api/draw"
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit"

export * from "@luckout/api/draw"

/** ORAO's VRF program: it owns every randomness request and lets only its oracles fill one in. */
export const ORAO_VRF = "VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y"

/** sha256("luckout-draw" ‖ the Checkout's address ‖ the round), as the program's `draw_seed`. */
export async function drawSeed(checkout: string, round: number) {
  const tag = new TextEncoder().encode("luckout-draw")
  const input = new Uint8Array([...tag, ...getAddressEncoder().encode(address(checkout)), round])
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", input)))
}

/** The address of ORAO's request account for a seed: only that account can hold the seed's randomness. */
export const oraoRequest = async (seedHex: string) =>
  (await getProgramDerivedAddress({ programAddress: address(ORAO_VRF), seeds: ["orao-vrf-randomness-request", unhex(seedHex)] }))[0]

const row = (label: string, expected: string, recomputed: string): Check => ({ label, expected, recomputed, ok: expected === recomputed })

/**
 * Every step of one card's Draw, recomputed in this browser and compared with what the program recorded: the seed
 * from the Checkout and round, ORAO's request from the seed, the randomness in that request, then the card's random
 * value, roll, outcome, Final Price and Cashback.
 */
export async function proofChecks(d: CardDrawProof): Promise<Array<Check>> {
  const seed = await drawSeed(d.checkout, d.round)
  return [
    row("Seed", d.seed, seed),
    row("ORAO request", d.request.address, await oraoRequest(seed)),
    row("ORAO's randomness", d.randomness, d.request.value ?? "not filled in"),
    ...(await verifyCard({
      card: d.card,
      game_version: d.gameVersion,
      reference_price: String(d.referencePrice),
      lucky_amount: String(d.luckyAmount),
      max_price: String(d.maxPrice),
      randomness: d.randomness,
      random: d.random,
      roll: d.roll,
      final_bps: d.finalBps,
      final_price: String(d.finalPrice),
      cashback: String(d.cashback)
    }, {
      name: d.version.name,
      premium_bps: d.version.premiumBps,
      outcomes: d.version.outcomes.map((o) => ({ final_bps: o.finalBps, chance_bps: o.chanceBps }))
    }))
  ]
}
