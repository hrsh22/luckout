import assert from "node:assert/strict"
import { test } from "node:test"
import { matchHoldings, maxTopUp } from "./holdings.ts"

// Shaped like Reown's balance lookup for the test wallet on Base (2026-11-12): the chain's own coin has no address key.
const balances = [
  { symbol: "ETH", chainId: "eip155:8453", value: 0.49, quantity: { numeric: "0.000245" } },
  { symbol: "USDC", chainId: "eip155:8453", address: "eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", value: 47.1, quantity: { numeric: "47.12" } },
  { symbol: "USDC", chainId: "eip155:10", address: "eip155:10:0x0b2c639c533813f4aa9d7837caf62653d097ff85", value: 9, quantity: { numeric: "9" } }
]
const asset = (assetId: string, symbol: string, chain: string, contract?: string) => ({ assetId, symbol, chain, ...(contract ? { contract } : {}) }) as never

test("a wallet's balances match the tokens we take, by chain and contract; the chain's own coin also pays fees", () => {
  const assets = [
    asset("base-usdc", "USDC", "base", "0x833589FCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    asset("base-eth", "ETH", "base"),
    asset("arb-usdc", "USDC", "arb", "0xaf88d065e77c8cc2239327c5edb3a432268e5831")
  ]
  const { holdings, gas } = matchHoldings(assets, balances)
  assert.deepEqual([...holdings].map(([id, h]) => [id, h.amount]), [["base-usdc", 47.12], ["base-eth", 0.000245]], "contract case doesn't matter; Optimism isn't one of ours")
  assert.deepEqual([...gas], ["base"])
})

test("a Solana wallet's holdings, read from Solana without dollar values, are valued at 1Click's price; SOL pays its fees", () => {
  const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
  const assets = [
    { assetId: "sol-usdc", symbol: "USDC", chain: "sol", contract: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", price: 1 },
    { assetId: "sol", symbol: "SOL", chain: "sol", price: 150 },
    { assetId: "sol-usdt", symbol: "USDT", chain: "sol", contract: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", price: 1 }
  ]
  const { holdings, gas } = matchHoldings(assets, [
    { symbol: "SOL", chainId: SOL, address: null, quantity: { numeric: "0.02" } },
    { symbol: "", chainId: SOL, address: `${SOL}:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, quantity: { numeric: "12.5" } }
  ])
  assert.deepEqual([...holdings].map(([id, h]) => [id, h.amount, h.usd]), [["sol-usdc", 12.5, 12.5], ["sol", 0.02, 3]], "the mint's case is kept by Solana and matched as is")
  assert.deepEqual([...gas], ["sol"])
  // 0.0007 SOL (the test wallet after its Top-Ups) can't pay a token account's rent: no fee coin for a token send.
  assert.deepEqual([...matchHoldings(assets, [{ symbol: "SOL", chainId: SOL, address: null, quantity: { numeric: "0.0007" } }]).gas], [])
})

test("Max leaves room for 1Click's spread, and gas when paying with the chain's own coin", () => {
  assert.equal(maxTopUp({ symbol: "USDC", chain: "base" }, { amount: 47.12, usd: 47.1 }), 46.39)
  assert.equal(maxTopUp({ symbol: "ETH", chain: "base" }, { amount: 0.01, usd: 20 }), 19.65)
  assert.equal(maxTopUp({ symbol: "ETH", chain: "eth" }, { amount: 0.001, usd: 2 }), 0, "Ethereum's gas would eat it")
  // The staging wallet: 0.025507 SOL at $75.12. Max keeps 0.001 SOL ($0.08), not $0.05.
  assert.equal(maxTopUp({ symbol: "SOL", chain: "sol" }, { amount: 0.025507, usd: 1.916 }), 1.81)
})
