import type { DrawEvent, GameVersion } from "./draw"
import { contractId, txEvents, view } from "./near"

/** Loads one Draw from its transaction plus the Game Version it was played on. */
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
