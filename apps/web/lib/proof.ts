import type { DrawProof } from "@luckout/api"
import { api, isNotFound } from "./api.ts"

/** A Solana transaction signature: base58, 64 bytes. */
export const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/

/** No such transaction, or one that ran no Draw: a page about it is a 404, not an outage. */
export class NotOnChain extends Error {}

/**
 * The Draws a `finish_draw` transaction recorded, with ORAO's request and each Game Version's table (ADR-0005,
 * ADR-0015). Our server reads them from Solana, so no RPC key reaches the browser, and keeps them, since a landed
 * transaction never changes. The browser recomputes every step itself (proofChecks in lib/draw.ts).
 */
export const loadProof = (signature: string): Promise<DrawProof> =>
  api((c) => c.drawProof({ params: { signature }, query: {} }), undefined, "20 seconds").catch((e: unknown) => {
    throw isNotFound(e) ? new NotOnChain("No Draw in this transaction") : e
  })

/** The card a Draw Proof link names (`?card=`), or the transaction's first Draw. */
export const pickDraw = (proof: DrawProof, card: number | undefined) =>
  proof.draws.find((d) => d.card === card) ?? (card === undefined ? proof.draws[0] : undefined)
