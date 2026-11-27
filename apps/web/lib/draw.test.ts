import assert from "node:assert/strict"
import { test } from "node:test"
import { plainly, proofChecks } from "./draw.ts"

// A real Draw: card 9 of the 15-card Classic Checkout finished on devnet on 2026-11-27 (program
// 4Tziwbh1vEDremxPViXgEa91FP3Nv4hUyNmLXMzRK2Z3, transaction 2dgQpYiNzc8m7fVa…), as GET /draws/:signature answers it.
const card9 = {
  checkout: "rDd4jKBhjfBDLcR83boXaFHaWUjwVCAe6A93y57tLUn",
  customer: "5ZNr8ZE8NpwiCyGqHLUYMRVoCRw9RwC5fu2XZp9Kat6D",
  card: 9,
  round: 0,
  seed: "71cb3c0cc72f6b6784bcd6803c173190e6d341fa149e362f36a9b01353c692b1",
  randomness: "fbcf3f27b76af47a27e9dec26291cfc3405b6f0136ac26ecf95c87c0e24978d67036920084bc8d2a6554c45f5c93eac939a31876fffd2572c935b1645ae82f03",
  random: "1cb9ae2a48abdd4a9ae7980f3a0d5897c0b26b8ed8fd1739e63c8f7662099327",
  roll: 972,
  gameVersion: 1,
  referencePrice: 6_000_000,
  luckyAmount: 6_000_000,
  maxPrice: 7_200_000,
  finalBps: 8_400,
  finalPrice: 5_040_000,
  cashback: 2_160_000,
  request: {
    address: "HXS4HypiKKp1VUsX8SB5atpD7kXw9UG6YFQ1zb3qqGyK",
    value: "fbcf3f27b76af47a27e9dec26291cfc3405b6f0136ac26ecf95c87c0e24978d67036920084bc8d2a6554c45f5c93eac939a31876fffd2572c935b1645ae82f03",
    filledBy: []
  },
  version: {
    name: "Classic",
    premiumBps: 2_000,
    outcomes: [
      { finalBps: 0, chanceBps: 200 },
      { finalBps: 6_000, chanceBps: 300 },
      { finalBps: 7_200, chanceBps: 400 },
      { finalBps: 8_400, chanceBps: 700 },
      { finalBps: 9_600, chanceBps: 2_400 },
      { finalBps: 12_000, chanceBps: 6_000 }
    ]
  }
}

const failing = async (d: typeof card9) => (await proofChecks(d)).filter((c) => !c.ok).map((c) => c.label)

test("a real devnet Draw recomputes exactly, from its Checkout to its Cashback", async () => {
  const checks = await proofChecks(card9)
  assert.deepEqual(checks.map((c) => c.label), ["Seed", "ORAO request", "ORAO's randomness", "Random value", "Roll", "Final Price share", "Final Price", "Cashback"])
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks))
})

test("the raw numbers also read plainly", () => {
  assert.equal(plainly("11000", "bps"), "110% of the price")
  assert.equal(plainly("605000", "usdc"), "$0.605")
  assert.equal(plainly("0", "usdc"), "$0.00")
  assert.equal(plainly("9000000", "usdc"), "$9.00")
})

test("a tampered outcome is caught", async () => {
  assert.deepEqual(await failing({ ...card9, roll: 12, finalPrice: 0, cashback: 7_200_000 }), ["Roll", "Final Price", "Cashback"])
  assert.deepEqual(await failing({ ...card9, card: 6 }), ["Random value", "Roll", "Final Price share", "Final Price", "Cashback"], "another card's draw")
})

test("a Draw tied to another Checkout or round, or to randomness ORAO's request doesn't hold, is caught", async () => {
  assert.deepEqual(await failing({ ...card9, round: 1 }), ["Seed", "ORAO request"])
  assert.deepEqual(await failing({ ...card9, checkout: card9.customer }), ["Seed", "ORAO request"])
  assert.deepEqual(await failing({ ...card9, request: { ...card9.request, address: card9.checkout } }), ["ORAO request"])
  assert.deepEqual(await failing({ ...card9, request: { ...card9.request, value: "00".repeat(64) } }), ["ORAO's randomness"])
  assert.deepEqual(await failing({ ...card9, request: { ...card9.request, value: null } as never }), ["ORAO's randomness"], "never filled in")
})
