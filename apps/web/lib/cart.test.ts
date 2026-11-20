import assert from "node:assert/strict"
import { test } from "node:test"
import { addToCart, type CartCard, type CartLine, cartCount, cartRoom, cartUnits, claimCart, releaseCart, withAdded, withMode, withQuantity } from "./cart.ts"

const swiggy: CartCard = { voucherId: "swiggy-money-india", value: "50", mode: { lucky: 1 }, name: "Swiggy", currency: "INR" }
const amazon: CartCard = { voucherId: "amazon-in", value: "100", mode: "normal", name: "Amazon", currency: "INR" }

test("the same card, amount and mode is one line with a quantity; each copy has its own key", () => {
  let lines: ReadonlyArray<CartLine> = []
  lines = withAdded(lines, swiggy, 3)
  lines = withAdded(lines, amazon, 1)
  lines = withAdded(lines, swiggy, 2)
  assert.equal(lines.length, 2)
  assert.equal(lines[0]!.keys.length, 5)
  assert.equal(new Set(cartUnits(lines).map((u) => u.key)).size, 6, "one key per card")
  assert.deepEqual(cartUnits(lines).map((u) => u.line.name), ["Swiggy", "Swiggy", "Swiggy", "Swiggy", "Swiggy", "Amazon"])
  // Another mode is another line.
  assert.equal(withAdded(lines, { ...swiggy, mode: "normal" }, 1).length, 3)
})

test("a cart holds 15 cards: adding past that changes nothing, and a quantity stops at the room left", () => {
  let lines = withAdded([], swiggy, 10)
  assert.equal(cartRoom(lines), 5)
  assert.equal(withAdded(lines, amazon, 6), lines, "6 don't fit: nothing added")
  lines = withAdded(lines, amazon, 2)
  lines = withQuantity(lines, lines[0]!.id, 20)
  assert.equal(cartCount(lines), 15)
  assert.equal(lines[0]!.keys.length, 13)
})

test("fewer keeps the first keys, more adds new ones, and none removes the line", () => {
  const lines = withAdded([], swiggy, 3)
  const kept = lines[0]!.keys
  const fewer = withQuantity(lines, lines[0]!.id, 2)
  assert.deepEqual(fewer[0]!.keys, kept.slice(0, 2))
  const more = withQuantity(fewer, lines[0]!.id, 4)
  assert.deepEqual(more[0]!.keys.slice(0, 2), kept.slice(0, 2))
  assert.equal(new Set(more[0]!.keys).size, 4)
  assert.deepEqual(withQuantity(lines, lines[0]!.id, 0), [])
})

test("another mode is another purchase: new keys, and it joins that mode's line if there is one", () => {
  let lines = withAdded(withAdded([], swiggy, 2), { ...swiggy, mode: "normal" }, 1)
  const before = lines[0]!.keys
  lines = withMode(lines, lines[0]!.id, "normal")
  assert.equal(lines.length, 1, "joined the Normal line")
  assert.equal(lines[0]!.keys.length, 3)
  assert.ok(before.every((k) => !lines[0]!.keys.includes(k)), "no old key buys the new mode")
})

test("the Cart belongs to one account: another account or a sign-out empties it, a guest Cart carries over", () => {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) }
  })
  const count = () => cartCount(JSON.parse(store.get("luckout.cart") ?? "[]"))
  addToCart(swiggy, 2)
  claimCart("alice.near")
  assert.equal(count(), 2, "a guest Cart carries over to whoever signs in")
  claimCart("alice.near")
  assert.equal(count(), 2, "the same account again keeps it")
  claimCart("0xb0b")
  assert.equal(count(), 0, "someone else starts empty")
  addToCart(amazon, 1)
  releaseCart()
  assert.equal(count(), 0, "signing out empties it")
  addToCart(amazon, 1)
  claimCart("alice.near")
  assert.equal(count(), 1, "after a sign-out, a guest Cart is no one's yet")
})
