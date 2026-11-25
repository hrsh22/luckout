import assert from "node:assert/strict"
import { test } from "node:test"
import type { Purchase, PurchasePage } from "@luckout/api"
import { firstShelf, onShelf, shelfCounts, withPurchase } from "./used.ts"

const p = (id: string, status: Purchase["status"], usedAt?: string) => ({ id, status, ...(usedAt ? { usedAt } : {}) }) as unknown as Purchase
const ids = (xs: ReadonlyArray<Purchase>) => xs.map((x) => x.id)

test("unused holds the cards still to use and those on their way; used holds the marked ones; all holds everything", () => {
  const list = [p("new", "pending"), p("fresh", "delivered"), p("done", "delivered", "2026-11-20T10:00:00Z"), p("refunded", "failed"), p("cancelled", "rejected"), p("ready", "waiting")]
  const on = (shelf: "unused" | "used" | "all") => ids(list.filter((x) => onShelf(x, shelf)))
  assert.deepEqual(on("unused"), ["new", "fresh", "ready"], "newest first, refunded and unbought left out")
  assert.deepEqual(on("used"), ["done"])
  assert.deepEqual(on("all"), ids(list))
  assert.deepEqual(shelfCounts(list), { unused: 3, used: 1, all: 6 })
  assert.equal(firstShelf(shelfCounts(list)), "unused")
  assert.equal(firstShelf(shelfCounts([p("done", "delivered", "2026-11-20T10:00:00Z"), p("refunded", "failed")])), "all", "nothing left to use: everything, not an empty shelf")
  assert.equal(firstShelf(shelfCounts([])), "all")
})

test("the server's copy of a card replaces the old one in the list's pages and in the card's own query", () => {
  const marked = p("b", "delivered", "2026-11-20T10:00:00Z")
  const pages = { pages: [{ items: [p("c", "delivered"), p("b", "delivered")], next: "b" }, { items: [p("a", "delivered")] }], pageParams: ["", "b"] } as unknown as {
    pages: Array<PurchasePage>
    pageParams: Array<string>
  }
  const after = withPurchase(pages, marked)
  assert.deepEqual(after.pages.map((pg) => pg.items.map((x) => `${x.id}:${x.usedAt ?? "-"}`)), [["c:-", "b:2026-11-20T10:00:00Z"], ["a:-"]])
  assert.equal(after.pages[0]!.next, "b", "paging is untouched")
  assert.equal(after.pages[1]!.items[0], pages.pages[1]!.items[0], "other cards are left as they were")
  assert.equal(withPurchase(p("b", "delivered"), marked), marked)
  const other = p("x", "delivered")
  assert.equal(withPurchase(other, marked), other)
  assert.equal(withPurchase(undefined, marked), undefined)
})
