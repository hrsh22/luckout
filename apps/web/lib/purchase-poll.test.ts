import assert from "node:assert/strict"
import { test } from "node:test"
import { purchasePollMs } from "./purchase-poll.ts"

test("a purchase is checked until it settles: fast while pending, slower while waiting or stuck", () => {
  const now = Date.parse("2026-11-16T12:00:00Z")
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()
  assert.equal(purchasePollMs({ status: "pending", createdAt: at(0) }, now), 3000)
  assert.equal(purchasePollMs({ status: "waiting", createdAt: at(1) }, now), 5000)
  assert.equal(purchasePollMs({ status: "pending", createdAt: at(16) }, now), 60_000)
  assert.equal(purchasePollMs({ status: "waiting", createdAt: at(16) }, now), 60_000)
  for (const status of ["delivered", "failed", "rejected"] as const) assert.equal(purchasePollMs({ status, createdAt: at(0) }, now), false)
  assert.equal(purchasePollMs(undefined, now), false)
})
