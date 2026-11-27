// What the admin's Purchases and Users pages work out from what they loaded. No imports, so `node --test` can load it.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The purchase id typed or pasted into the Purchases filter, if that is what it is: the page then asks the server
 * for that one purchase, which may be older than the latest 300 the list holds (an id from an alert often is).
 */
export const purchaseIdIn = (filter: string) => {
  const t = filter.trim().toLowerCase()
  return UUID.test(t) ? t : undefined
}

/**
 * What the listed customers hold in all. A balance Solana didn't answer for is missing, so the sum is then only
 * a floor: `partial` says so.
 */
export const heldByAll = (users: ReadonlyArray<{ readonly balance?: number | undefined }>) => ({
  micro: users.reduce((sum, u) => sum + (u.balance ?? 0), 0),
  partial: users.some((u) => u.balance === undefined)
})
