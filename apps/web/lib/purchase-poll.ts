import type { Purchase } from "@luckout/api"

/**
 * How soon to check a purchase again, in milliseconds; false once it has settled. Every 3 s while it's
 * pending, every 5 s while it waits for the float, and once a minute after 15 minutes (stuck).
 */
export const purchasePollMs = (p: Pick<Purchase, "status" | "createdAt"> | undefined, now = Date.now()): number | false =>
  !p || (p.status !== "pending" && p.status !== "waiting")
    ? false
    : now - new Date(p.createdAt).getTime() > 15 * 60_000
    ? 60_000
    : p.status === "waiting"
    ? 5000
    : 3000
