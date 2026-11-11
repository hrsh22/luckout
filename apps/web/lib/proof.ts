import type { DrawEvent, GameVersion } from "./draw"
import { contractId, txEvents, view } from "./chain"

/** A NEAR transaction hash: base58, 32 bytes. */
export const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/

/**
 * Loads one Draw from its transaction plus the Game Version it was played on.
 * ponytail: asks for the tx as sent by the operator. RPC uses the sender only to find the shard, so a
 * retry_draw (sent by the customer or the relayer) on another shard may not be found; pass its signer
 * if Purchase or the link ever carries it.
 */
export async function loadDraw(tx: string) {
  const config = await view<{ operator: string }>(contractId, "get_config")
  const { events, time } = await txEvents(tx, config.operator)
  const draw = events.find((e) => e.event === "draw")?.data[0] as DrawEvent | undefined
  if (!draw) throw new Error("This transaction has no Draw")
  const versions = await view<Array<GameVersion>>(contractId, "get_game_versions")
  const version = versions[draw.game_version]
  if (!version) throw new Error(`Unknown Game Version ${draw.game_version}`)
  return { draw, version, time }
}
