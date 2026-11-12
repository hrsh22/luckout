import assert from "node:assert/strict"
import { test } from "node:test"
import { dollars, tokenAmount, toMicro } from "./format.ts"

test("token amounts read at a sensible precision, rounded the safe way", () => {
  assert.equal(tokenAmount("1.0663783", "USDC", "up"), "1.07", "what you send: never less than leaves the wallet")
  assert.equal(tokenAmount("1.010224", "USDC", "up"), "1.02")
  assert.equal(tokenAmount("1.07", "USDT", "up"), "1.07", "exact stays exact")
  assert.equal(tokenAmount("0.997398", "USDC", "down"), "0.99", "what you get: never more than arrives")
  assert.equal(tokenAmount("0.000530123456789", "ETH", "up"), "0.000530124")
  assert.equal(tokenAmount("0.000530123456789", "ETH", "down"), "0.000530123")
  assert.equal(tokenAmount("12.3456789", "SOL", "up"), "12.3457")
  assert.equal(tokenAmount("abc", "USDC", "up"), "abc", "anything unreadable is shown as given")
})

test("prefills are exact: no rounding over the balance, no dust left behind", () => {
  assert.equal(dollars(5_555_555), "5.555555")
  assert.equal(dollars(5_554_444), "5.554444")
  assert.equal(dollars(25_000_000), "25")
  assert.equal(dollars(1_500_000), "1.5")
  assert.equal(dollars(7), "0.000007")
  assert.equal(dollars(0), "0")
})

test("toMicro(dollars(m)) === m for every safe integer", () => {
  const values = [0, 1, 9, 10, 999_999, 1_000_000, 1_000_001, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1]
  for (let i = 0; i < 20_000; i++) values.push(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER), Math.floor(Math.random() * 1e9))
  for (const m of values) assert.equal(toMicro(dollars(m)), m, String(m))
})

test("toMicro refuses what it can't hold exactly", () => {
  assert.ok(Number.isNaN(toMicro("9007199254.740992")))
  assert.ok(Number.isNaN(toMicro("99999999999999999999")))
  assert.ok(Number.isNaN(toMicro("1.2345678")))
  assert.equal(toMicro("9007199254.740991"), Number.MAX_SAFE_INTEGER)
})
