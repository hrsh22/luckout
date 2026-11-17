import assert from "node:assert/strict"
import { test } from "node:test"
import { dollars, limitsText, safeLink, tokenAmount, toMicro, toYocto, typedAmount, usd, usdDown, usdUp } from "./format.ts"

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

test("a limit that's off is named, never shown in dollars", () => {
  const off = "340282366920938463463374607431768211455" // u128::MAX, the contract's "no limit"
  assert.equal(limitsText(off, off), "No limits")
  assert.equal(limitsText(200_000_000, off), "$200.00 a purchase, no daily limit")
  assert.equal(limitsText(off, 1_000_000_000), "No per-purchase limit, $1,000.00 a day")
  assert.equal(limitsText(200_000_000, 1_000_000_000), "$200.00 a purchase, $1,000.00 a day")
})

test("what a customer pays rounds up to the cent, what they hold rounds down, and plain amounts round to the nearest", () => {
  assert.equal(usdUp(5_520_001), "$5.53", "a price a millionth over a cent is shown as the next cent: never less than leaves the balance")
  assert.equal(usdUp(5_520_000), "$5.52", "an exact price stays exact")
  assert.equal(usdUp("5520001"), "$5.53", "the contract's strings read the same as numbers")
  assert.equal(usdDown(5_529_999), "$5.52", "a balance is never shown as more than is there")
  assert.equal(usdDown(5_520_000), "$5.52")
  assert.equal(usdDown("5529999"), "$5.52")
  assert.equal(usd(5_526_000), "$5.53")
  assert.equal(usd(5_524_000), "$5.52")
  assert.equal(usd(0), "$0.00")
  assert.equal(usd(1_234_567_890_000), "$1,234,567.89", "thousands are grouped")
  assert.equal(usdUp(1), "$0.01", "the smallest price is never shown as free")
  assert.equal(usdDown(9_999), "$0.00", "less than a cent held is shown as nothing, not a cent")
})

test("only plain https links from Redemption Data become clickable", () => {
  assert.equal(safeLink("https://www.amazon.com/gc/redeem?claimCode=ABCD"), "https://www.amazon.com/gc/redeem?claimCode=ABCD")
  assert.equal(safeLink("HTTPS://EXAMPLE.COM/x"), "HTTPS://EXAMPLE.COM/x", "the scheme's case doesn't matter; the link is kept as sent")
  for (const bad of ["http://example.com", "javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "//example.com", "example.com", "not a link", ""]) {
    assert.equal(safeLink(bad), undefined, bad)
  }
  assert.equal(safeLink(undefined), undefined)
})

test("a typed amount keeps a decimal comma as the decimal point, and never guesses thousands separators", () => {
  assert.equal(typedAmount("12,5"), "12.5", "a phone set to a comma-decimal region types 12,5")
  assert.equal(typedAmount("50,00"), "50.00", "fifty, not five thousand")
  assert.equal(typedAmount("12,"), "12.", "the comma is typed before the cents")
  assert.equal(typedAmount("12.5"), "12.5")
  assert.equal(typedAmount("$ 1 250"), "1250", "anything but digits and separators is dropped, as before")
  assert.equal(typedAmount(""), "")
  // With more than one separator nothing is guessed: the field keeps it as typed and toMicro refuses it, so the
  // customer corrects it instead of saving an amount a thousand times off.
  for (const both of ["1.250,00", "1,250.00", "1,250,000", "12.5,"]) {
    assert.equal(typedAmount(both), both)
    assert.ok(Number.isNaN(toMicro(typedAmount(both))), both)
  }
  assert.equal(toMicro(typedAmount("12,5")), 12_500_000)
  assert.equal(toMicro(typedAmount("50,00")), 50_000_000)
})

test("NEAR typed by an admin becomes exact yoctoNEAR, and anything else is refused", () => {
  assert.equal(toYocto("1"), 10n ** 24n)
  assert.equal(toYocto("1.5"), 15n * 10n ** 23n)
  assert.equal(toYocto("0.000000000000000000000001"), 1n, "one yoctoNEAR: 24 decimals are exact")
  assert.equal(toYocto(" 2 "), 2n * 10n ** 24n)
  assert.equal(toYocto("1."), 10n ** 24n)
  assert.equal(toYocto("1.1234567890123456789012345"), undefined, "25 or more decimals can't be sent exactly")
  assert.equal(toYocto("0.0000000000000000000000001"), undefined)
  for (const bad of ["", ".5", "1,5", "1.2.3", "-1", "abc"]) assert.equal(toYocto(bad), undefined, bad)
  assert.equal(toYocto("12345678901234567890"), 12345678901234567890n * 10n ** 24n, "no floating point, however large")
})
