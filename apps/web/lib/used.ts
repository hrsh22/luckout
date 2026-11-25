import type { Purchase, PurchasePage } from "@luckout/api"
import type { InfiniteData } from "@tanstack/react-query"

/** The Purchases page's views: cards still to use, cards marked used, or everything. */
export type Shelf = "unused" | "used" | "all"

/**
 * Still to use: delivered and not marked used, or on its way. A refunded or unbought purchase was never a card to use,
 * so only All shows it; a used card is always a delivered one (the server marks no other).
 */
const toUse = (p: Purchase) => !p.usedAt && (p.status === "delivered" || p.status === "pending" || p.status === "waiting")

export const onShelf = (p: Purchase, shelf: Shelf) => shelf === "all" || (shelf === "used" ? !!p.usedAt : toUse(p))

export const shelfCounts = (purchases: ReadonlyArray<Purchase>): Record<Shelf, number> => ({
  unused: purchases.filter(toUse).length,
  used: purchases.filter((p) => p.usedAt).length,
  all: purchases.length
})

/** Opens on the cards still to use; with none, on everything rather than an empty shelf. */
export const firstShelf = (counts: Record<Shelf, number>): Shelf => (counts.unused > 0 ? "unused" : "all")

/** The server's copy of one purchase, in place of the old one wherever it's cached: the list's pages, or the card itself. */
export const withPurchase = <D extends InfiniteData<PurchasePage, unknown> | Purchase | undefined>(data: D, p: Purchase): D =>
  !data
    ? data
    : "pages" in data
    ? { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.map((x) => (x.id === p.id ? p : x)) })) }
    : data.id === p.id
    ? (p as D)
    : data
