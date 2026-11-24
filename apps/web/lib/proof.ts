import type { DrawEvent, GameVersion } from "./draw"
import { blockTime, contractId, NotOnChain, txEvents, view } from "./chain"

/** A NEAR transaction hash: base58, 32 bytes. */
export const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/

/**
 * Loads one Draw from its transaction plus the Game Version it was played on. A cart's settlement runs several Draws
 * (ADR-0013): `purchaseId` picks one, else the first. The Game Versions don't depend on the transaction, so they're
 * read alongside the config instead of after it. A transaction NEAR doesn't have, or one that ran no Draw, is
 * NotOnChain (a 404); NEAR not answering stays a plain error, to try again.
 * ponytail: asks for the tx as sent by the operator. RPC uses the sender only to find the shard, so a
 * retry_draw (sent by the customer or the relayer) on another shard may not be found; pass its signer
 * if Purchase or the link ever carries it.
 */
export async function loadDraw(tx: string, purchaseId?: number) {
  const [config, versions] = await Promise.all([
    view<{ operator: string }>(contractId, "get_config"),
    view<Array<GameVersion>>(contractId, "get_game_versions")
  ])
  const { events, blockHash } = await txEvents(tx, config.operator)
  const draw = events.find((e) => e.event === "draw" && (purchaseId === undefined || Number((e.data[0] as DrawEvent).purchase_id) === purchaseId))
    ?.data[0] as DrawEvent | undefined
  if (!draw) throw new NotOnChain("This transaction has no Draw")
  const version = versions[draw.game_version]
  if (!version) throw new Error(`Unknown Game Version ${draw.game_version}`)
  return { draw, version, blockHash }
}

/** The Draw and when its block was produced, for the page; the browser's own check doesn't need the time. */
export const loadDrawAt = async (tx: string, purchaseId?: number) => {
  const d = await loadDraw(tx, purchaseId)
  return { ...d, time: await blockTime(d.blockHash) }
}
