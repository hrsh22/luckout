import assert from "node:assert/strict"
import { test } from "node:test"
import type { Purchase, PurchasePage } from "@luckout/api"
import { purchasePollMs, withNewest } from "./purchase-poll.ts"

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

test("the newest page, read again, updates the list without losing a purchase or breaking the older pages", () => {
  const p = (id: string, status: "pending" | "delivered" = "delivered") => ({ id, status }) as unknown as Purchase
  // Pages of 3: the first ends at "c", the second is older history.
  const older = { items: [p("b"), p("a")] }
  const pages = [{ items: [p("e", "pending"), p("d"), p("c")], next: "c" }, older] as unknown as Array<PurchasePage>
  // Meanwhile "e" was delivered and a new purchase "f" pushed "c" off the newest page.
  const newest = { items: [p("f", "pending"), p("e"), p("d")], next: "d" } as unknown as PurchasePage
  const [first, ...rest] = withNewest(pages, newest)
  assert.deepEqual(first!.items.map((x) => `${x.id}:${x.status}`), ["f:pending", "e:delivered", "d:delivered", "c:delivered"])
  assert.equal(first!.next, "c", "the first page still leads to the second")
  assert.equal(rest[0], older, "older pages are history, left as they are")
  assert.deepEqual(withNewest([], newest), [newest])
})
