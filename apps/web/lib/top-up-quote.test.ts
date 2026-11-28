import assert from "node:assert/strict"
import { test } from "node:test"
import { formatUnits, minimumOf, solanaPayUri, tapsFor, topUpMicro, topUpPicks, withdrawProblem } from "./top-up-quote.ts"

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"

test("the Deposit Address's QR is a Solana Pay link to a USDC transfer", () => {
  assert.equal(solanaPayUri(ADDRESS, USDC_MINT), `solana:${ADDRESS}?spl-token=${USDC_MINT}`)
})

test("base units read exactly, trailing zeros trimmed", () => {
  assert.equal(formatUnits("12500000", 6), "12.5")
  assert.equal(formatUnits("12000000", 6), "12")
  assert.equal(formatUnits("1", 6), "0.000001")
  assert.equal(formatUnits("0", 6), "0")
  assert.equal(formatUnits("7054703313", 11), "0.07054703313")
  assert.equal(formatUnits("123456789012345678901234567890", 18), "123456789012.34567890123456789", "past a JS number, still exact")
})

test("a FLEX_INPUT quote's minimum is shown in the token's units, from the asset's decimals or the quote's own amount", () => {
  const q = { amountIn: "20010000", amountInFormatted: "20.01", minAmountIn: "19909950" }
  assert.equal(minimumOf(q, 6), "19.90995")
  assert.equal(minimumOf(q), "19.90995", "6 decimals, read off 20010000 = 20.01")
  assert.equal(minimumOf({ amountIn: "6000000000000000", amountInFormatted: "0.006", minAmountIn: "5970000000000000" }), "0.00597", "ETH's 18 decimals")
  assert.equal(minimumOf({ ...q, minAmountIn: undefined }), undefined, "1Click gave none")
})

test("a tap is offered for a held token only while it's swapped here, with its worth at the asset's price", () => {
  const usdt = { assetId: "jupiter:usdt", symbol: "USDT", amount: "12500000", decimals: 6 }
  const ore = { assetId: "jupiter:ore", symbol: "ORE", amount: "1000000000", decimals: 11 }
  const assets = [{ assetId: "jupiter:usdt", swap: true, price: 1 }, { assetId: "jupiter:ore", swap: true, price: 70 }]
  assert.deepEqual(tapsFor([usdt, ore], assets).map((t) => [t.held.symbol, t.amount, t.usd?.toFixed(2), t.enough]), [["USDT", "12.5", "12.50", true], ["ORE", "0.01", "0.70", false]], "under $1 of ORE: not enough to swap")
  assert.deepEqual(tapsFor([usdt], [{ assetId: "jupiter:usdt", swap: true }]).map((t) => [t.usd, t.enough]), [[undefined, true]], "no price: the server decides")
  assert.deepEqual(tapsFor([usdt], []), [], "swaps are off")
  assert.deepEqual(tapsFor([usdt], [{ assetId: "jupiter:usdt", price: 1 }]), [], "only a swap-paid asset")
})

test("a Top-Up starts at what the card needs (at least $1, up to the cent), else $20; its picks fit one row", () => {
  assert.equal(topUpMicro(), 20_000_000)
  assert.equal(topUpMicro(4_200_001), 4_210_000)
  assert.equal(topUpMicro(300_000), 1_000_000)
  assert.deepEqual(topUpPicks().map((p) => p.label), ["$10", "$25", "$50"])
  assert.deepEqual(topUpPicks(4_200_001), [{ label: "Exactly $4.21", micro: 4_210_000 }, { label: "$10", micro: 10_000_000 }, { label: "$25", micro: 25_000_000 }])
})

test("a withdrawal goes to a Solana address that isn't the customer's own Deposit Address", () => {
  assert.equal(withdrawProblem(ADDRESS, "someone-else"), undefined)
  assert.match(withdrawProblem(ADDRESS, ADDRESS)!, /your own Deposit Address/)
  assert.match(withdrawProblem("0x1111111111111111111111111111111111111111", undefined)!, /isn't a Solana address/)
  assert.match(withdrawProblem("", undefined)!, /isn't a Solana address/)
})
