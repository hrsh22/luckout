import type { Purchase, PurchasePage } from "@luckout/api"

/**
 * How soon to check a purchase again, in milliseconds; false once it has settled. Every 3 s while it's
 * pending, every 5 s while it waits for the float, and once a minute after 15 minutes (stuck). A failed card whose
 * refund is still on its way from our Pay Wallet (ADR-0016) is checked every 30 s, until it lands.
 */
export const purchasePollMs = (p: Pick<Purchase, "status" | "createdAt" | "refund"> | undefined, now = Date.now()): number | false =>
  p?.status === "failed" && p.refund && !p.refund.paidAt
    ? 30_000
    : !p || (p.status !== "pending" && p.status !== "waiting")
    ? false
    : now - new Date(p.createdAt).getTime() > 15 * 60_000
    ? 60_000
    : p.status === "waiting"
    ? 5000
    : 3000

/**
 * The loaded pages with the newest page, read again, folded into the first: its purchases replace their old copies
 * and new ones go on top. The first page keeps the rest of its purchases and its `next`, so it still lines up with
 * the page after it, and a purchase pushed off the newest page by a new one isn't lost.
 */
export const withNewest = (pages: ReadonlyArray<PurchasePage>, newest: PurchasePage): Array<PurchasePage> => {
  const [first, ...older] = pages
  if (!first) return [newest]
  const ids = new Set(newest.items.map((p) => p.id))
  return [{ ...first, items: [...newest.items, ...first.items.filter((p) => !ids.has(p.id))] }, ...older]
}
