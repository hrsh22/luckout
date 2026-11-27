import assert from "node:assert/strict"
import { test } from "node:test"
import { backText, cartCents, centsUp, dollars, limitsText, receivedAmount, safeLink, shownOutcomes, tokenAmount, toMicro, toYocto, typedAmount, usd, usdDown, usdUp } from "./format.ts"
import { type ModeInfo, MODES, pricedOutcomes, simpleQuote } from "./modes.ts"

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
  const off = "18446744073709551615" // u64::MAX, the program's "no limit"
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

test("a Draw's Cashback reads in whole cents rounded down, and one under a cent says so instead of $0.00 back", () => {
  assert.equal(backText(25_000), "$0.02 back", "never more than was credited")
  assert.equal(backText(10_000), "$0.01 back")
  assert.equal(backText(9_999), "Under $0.01 back")
  assert.equal(backText(1), "Under $0.01 back")
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
  assert.equal(typedAmount("12\u066B5"), "12.5", "the Arabic decimal mark is a decimal point, not dropped")
  assert.equal(typedAmount("12\uFF0C5"), "12.5", "so is a full-width comma")
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

const [, lite, classic, jackpot] = MODES as [ModeInfo, ModeInfo, ModeInfo, ModeInfo]

test("cents round up with integers only, like every price", () => {
  assert.equal(centsUp(5_520_001), 553)
  assert.equal(centsUp(5_520_000), 552)
  assert.equal(centsUp(1), 1)
  assert.equal(centsUp(0), 0)
  assert.equal(centsUp(Number.MAX_SAFE_INTEGER), 900_719_925_475, "no floating point, however large")
})

test("the outcome list adds up, never promises more Cashback than comes back, and rows that read the same are one", () => {
  // Jackpot on a $57.56 card while the Cashback Cap ($0.059999) lets only cents of it play: every exact amount has a
  // fraction of a cent. Shown each on its own, two rows read "you pay $57.56" with different Cashback.
  const q = simpleQuote(jackpot, 57_560_000, { free: 1_000_000_000, max_cashback: 59_999 })
  const rows = shownOutcomes(q.maxPrice, pricedOutcomes(jackpot, q))
  const now = centsUp(q.maxPrice)
  assert.equal(now, 5_758, "pay now: $57.58")
  for (const r of rows) assert.equal(now - r.cashback, r.price, `${now} - ${r.cashback} is ${r.price}`)
  assert.equal(rows.reduce((s, r) => s + r.chanceBps, 0), 10_000, "merged rows keep every chance")
  assert.deepEqual(rows.map((r) => [r.price, r.cashback, r.chanceBps]), [[5_758, 0, 4_400], [5_756, 2, 4_600], [5_753, 5, 1_000]], "$0.059999 back reads $0.05")

  // Lite on a $0.56 card, the same way: 10% back is $0.006, under a cent, so it reads as no Cashback.
  const l = simpleQuote(lite, 560_000, { free: 1_000_000_000, max_cashback: 59_999 })
  assert.deepEqual(shownOutcomes(l.maxPrice, pricedOutcomes(lite, l)).map((r) => [r.price, r.cashback, r.chanceBps]), [[57, 0, 9_500], [56, 1, 300], [55, 2, 100], [52, 5, 100]])
})

test("100% off keeps its own row at no price, whatever the cents of what was paid", () => {
  // Lite on a $0.56 card with the whole price playing: pay $0.616 now (shown $0.62), all of it back.
  const q = simpleQuote(lite, 560_000, { free: 1_000_000_000_000, max_cashback: 1_000_000_000_000 })
  const free = shownOutcomes(q.maxPrice, pricedOutcomes(lite, q)).at(-1)!
  assert.deepEqual([free.free, free.price, free.cashback], [true, 0, 61], "the Cashback itself still rounds down")
})

test("a whole-price outcome list in whole cents: one row per slab, its percentage kept", () => {
  const q = simpleQuote(classic, 20_000_000, { free: 1_000_000_000_000, max_cashback: 1_000_000_000_000 })
  assert.deepEqual(shownOutcomes(q.maxPrice, pricedOutcomes(classic, q)).map((r) => [r.price, r.cashback, r.pct, r.samePct, r.chanceBps]), [
    [2_400, 0, 0, true, 6_000],
    [1_920, 480, 20, true, 2_400],
    [1_680, 720, 30, true, 700],
    [1_440, 960, 40, true, 400],
    [1_200, 1_200, 50, true, 300],
    [0, 2_400, 100, true, 200]
  ])
})

test("whatever the price and reserve, no shown price is below the real one and no shown Cashback above it", () => {
  for (let i = 0; i < 5_000; i++) {
    const m = [lite, classic, jackpot][i % 3]!
    const reference = 1 + Math.floor(Math.random() * 200_000_000)
    const reserve = { free: Math.floor(Math.random() * 2_000_000_000), max_cashback: Math.floor(Math.random() * (i % 2 ? 100_000 : 60_000_000)) }
    const q = simpleQuote(m, reference, reserve)
    const outcomes = pricedOutcomes(m, q)
    const rows = shownOutcomes(q.maxPrice, outcomes)
    const now = centsUp(q.maxPrice)
    const at = `${m.name} ${reference} ${JSON.stringify(reserve)}`
    assert.equal(new Set(rows.map((r) => r.price)).size, rows.length, `no two rows read the same: ${at}`)
    assert.equal(rows.reduce((s, r) => s + r.chanceBps, 0), 10_000, at)
    for (const r of rows) if (!r.free) assert.equal(now - r.cashback, r.price, `adds up: ${at}`)
    for (const o of outcomes) {
      const back = q.maxPrice - o.price
      const r = rows.find((x) => (o.price === 0 ? x.free : !x.free && x.price === now - Math.floor(back / 10_000)))
      assert.ok(r, `every outcome has its row: ${at}`)
      assert.ok(r.price * 10_000 >= o.price, `shown price ${r.price}c not below ${o.price}: ${at}`)
      assert.ok(r.cashback * 10_000 <= back, `shown Cashback ${r.cashback}c not above ${back}: ${at}`)
    }
  }
})

test("cart lines add up to the total shown, and 'each' shows only where it multiplies out", () => {
  // From staging: 2 Lite Swiggy at $0.565, 2 Jackpot Steam at $1.5125, 1 Classic Myntra at $2.815; $6.97 in all.
  const lines = cartCents([{ total: 1_130_000, count: 2, each: 565_000 }, { total: 3_025_000, count: 2, each: 1_512_500 }, { total: 2_815_000, count: 1 }])
  assert.equal(lines.reduce((s, l) => s + l.cents, 0), centsUp(1_130_000 + 3_025_000 + 2_815_000), "the lines sum to the $6.97 shown")
  assert.deepEqual(lines.map((l) => l.cents), [113, 302, 282], "each line within a cent of its exact amount")
  assert.deepEqual(lines.map((l) => l.each), [undefined, undefined, undefined], "2 x $0.57 isn't $1.13, so no 'each'")

  const even = cartCents([{ total: 1_120_000, count: 2, each: 560_000 }, { total: 2_810_000, count: 1 }])
  assert.deepEqual(even.map((l) => [l.cents, l.each]), [[112, 56], [281, undefined]], "2 x $0.56 is $1.12: 'each' is shown")

  for (let i = 0; i < 2_000; i++) {
    const totals = Array.from({ length: 1 + (i % 15) }, () => Math.floor(Math.random() * 200_000_000))
    const cents = cartCents(totals.map((total) => ({ total, count: 1 }))).map((l) => l.cents)
    assert.equal(cents.reduce((s, c) => s + c, 0), centsUp(totals.reduce((s, t) => s + t, 0)), String(totals))
    cents.forEach((c, j) => assert.ok(c === centsUp(totals[j]!) || c === centsUp(totals[j]!) - 1, String(totals)))
  }
})

test("what arrives below a stablecoin's cent says so instead of reading 0.00", () => {
  assert.equal(receivedAmount("0.007697", "USDC"), "under 0.01")
  assert.equal(receivedAmount("0.997398", "USDC"), "0.99", "never more than arrives")
  assert.equal(receivedAmount("0.000530123456789", "ETH"), "0.000530123")
  assert.equal(receivedAmount("0", "USDC"), "0")
})
