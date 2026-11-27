import type { AdminOverview } from "@luckout/api"
import { usd } from "./format.ts"
import { percent } from "./modes.ts"

type Cap = AdminOverview["reserve"]["cashbackCap"]

/** max_cashback_at in the program: the lower of the cap's limits at this Free Reserve, the share rounded down as there. */
export const maxCashbackAt = (cap: Cap, free: number) => Math.min(cap.fixed ?? Infinity, Number((BigInt(free) * BigInt(cap.reserveBps)) / 10_000n))

/** "the lower of $50.00 and 20% of free reserve" */
export const capText = (cap: Cap) => {
  const share = `${percent(cap.reserveBps)} of free reserve`
  return cap.fixed === null ? share : `the lower of ${usd(cap.fixed)} and ${share}`
}
