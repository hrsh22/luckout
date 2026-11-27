import type { DrawEvent, GameVersion } from "./draw"

// TODO(phase3-proof): Draws are on Solana now (ADR-0015): load the Draw event, ORAO's filled randomness and the Game
// Version from the program. Until then every Draw Proof page is a 404. The NEAR version is at
// `git show 9313693:apps/web/lib/proof.ts`.

/** A NEAR transaction hash: base58, 32 bytes. */
export const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/

/** No such transaction, or one that ran no Draw: a page about it is a 404, not an outage. */
export class NotOnChain extends Error {}

/** One Draw from its transaction plus the Game Version it was played on (ADR-0005). */
export async function loadDraw(_tx: string, _purchaseId?: number): Promise<{ draw: DrawEvent; version: GameVersion; blockHash: string }> {
  throw new NotOnChain("Draw Proofs are being rebuilt for Solana")
}

/** The Draw and when it was settled, for the page; the browser's own check doesn't need the time. */
export const loadDrawAt = async (tx: string, purchaseId?: number) => ({ ...(await loadDraw(tx, purchaseId)), time: new Date(0) })
