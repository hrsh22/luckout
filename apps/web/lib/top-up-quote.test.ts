import assert from "node:assert/strict"
import { test } from "node:test"
import { pricedAsShown, transferFor } from "./top-up-quote.ts"

const usdcBase = { symbol: "USDC", chain: "base", contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 }
const ethBase = { symbol: "ETH", chain: "base" }
const quote = { symbol: "USDC", chain: "base", depositAddress: "0x1111111111111111111111111111111111111111", amountIn: "20010000", amountInFormatted: "20.01", usdcOut: 20_000_000 }

test("a Top-Up transfer takes its token from the asset that was quoted, and everything else from the quote", () => {
  assert.deepEqual(transferFor(usdcBase, quote), { chain: "base", contract: usdcBase.contract, decimals: 6, to: quote.depositAddress, amount: "20010000" })
  // The chain's own coin has no contract: it is sent as a plain transfer.
  const eth = { ...quote, symbol: "ETH", amountIn: "6000000000000000", amountInFormatted: "0.006" }
  assert.deepEqual(transferFor(ethBase, eth), { chain: "base", contract: undefined, decimals: undefined, to: quote.depositAddress, amount: "6000000000000000" })
  // A Solana token is sent by its mint, with its decimals (an SPL transfer states them).
  const usdcSol = { symbol: "USDC", chain: "sol", contract: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 }
  const sol = { ...quote, chain: "sol", depositAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" }
  assert.deepEqual(transferFor(usdcSol, sol), { chain: "sol", contract: usdcSol.contract, decimals: 6, to: sol.depositAddress, amount: "20010000" })
})

test("a quote is never sent with another token than the one it was asked for", () => {
  assert.throws(() => transferFor(ethBase, quote), /another token/, "same chain, other token: 20010000 wei of ETH must not go to a USDC deposit address")
  assert.throws(() => transferFor({ ...usdcBase, chain: "arb" }, quote), /another token/, "same token, other chain")
  assert.throws(() => transferFor({ symbol: "USDT", chain: "base", contract: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" }, quote), /another token/)
})

test("a real quote is sent without asking again only when it is the price that was shown", () => {
  assert.equal(pricedAsShown(quote, quote), true)
  assert.equal(pricedAsShown(quote, { ...quote, amountInFormatted: "20.11" }), true, "within half a percent")
  assert.equal(pricedAsShown(quote, { ...quote, amountInFormatted: "19.5" }), true, "cheaper is fine")
  assert.equal(pricedAsShown(quote, { ...quote, amountInFormatted: "20.12" }), false, "more than half a percent dearer: ask again")
  assert.equal(pricedAsShown(undefined, quote), false, "no price was shown")
  // The price shown was for another token: 0.006 ETH is "less" than 20.01 USDC only as bare numbers.
  assert.equal(pricedAsShown(quote, { ...quote, symbol: "ETH", amountInFormatted: "0.006" }), false)
  assert.equal(pricedAsShown(quote, { ...quote, chain: "arb" }), false)
})
