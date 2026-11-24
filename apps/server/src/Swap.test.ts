import { createApproveInstruction, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token"
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js"
import { Effect } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  type Balances,
  JUPITER_PROGRAM,
  jupiterProblem,
  type JupiterQuote,
  outcomeProblem,
  quoteProblem,
  simulationProblem,
  sizeFor,
  slippageFor,
  SOL_USDC_MINT,
  Swap,
  SWAP_TOKENS
} from "./Swap.ts"

const ORE = SWAP_TOKENS[0]!
// 0.07 ORE for 5 USDC: $71.43 an ORE, against a market at $71.50.
const quote = (o: Partial<JupiterQuote> = {}): JupiterQuote => ({
  inputMint: ORE.mint,
  outputMint: SOL_USDC_MINT,
  inAmount: "7000000000",
  outAmount: "5025000",
  otherAmountThreshold: "5000000",
  swapMode: "ExactIn",
  slippageBps: 50,
  priceImpactPct: "0.0036",
  routePlan: [{ swapInfo: { label: "Meteora DLMM" } }],
  ...o
})
const check = (q: JupiterQuote, need = 5_000_000n, usdPrice = 71.5) => quoteProblem(q, { token: ORE, spend: 7_000_000_000n, need, usdPrice })

test("a route is used only when it swaps exactly what was shown, its minimum out covers the USDC, and its price is the market's", () => {
  assert.equal(check(quote()), undefined)
  assert.match(check(quote({ swapMode: "ExactOut" }))!, /different swap/)
  assert.match(check(quote({ inAmount: "7000000001" }))!, /different swap/, "never more of the token than the customer was shown")
  assert.match(check(quote({ outputMint: ORE.mint }))!, /different swap/)
  assert.match(check(quote(), 5_000_001n)!, /price moved/, "a minimum out short of the USDC needed by one unit")
  assert.match(check(quote({ priceImpactPct: "0.0101" }))!, /big swap/)
  assert.match(check(quote({ priceImpactPct: "NaN" }))!, /big swap/)
  assert.match(check(quote(), 5_000_000n, 73)!, /off the market/, "2% under Jupiter's market price")
  assert.equal(check(quote(), 5_000_000n, 72.5), undefined, "1.4% under it is within reach of a route's fees")
  assert.match(check(quote(), 5_000_000n, 0)!, /off the market/, "no market price, no swap")
  assert.match(check(quote({ outAmount: "0" }))!, /off the market/, "a route that gives nothing")
})

test("the amount to swap covers the USDC after our slippage, by a hair", () => {
  // A route that gives 71.25 USDC per ORE (11 decimals).
  const probe = { spend: 100_000_000_000n, out: 71_250_000n }
  for (const need of [1_000_000n, 5_050_832n, 50_508_416n, 2_000_000_000n]) {
    const spend = sizeFor(need, probe)
    const out = (spend * probe.out) / probe.spend
    assert.ok((out * 9_950n) / 10_000n >= need, `${spend} covers ${need} after 0.5%`)
    assert.ok(out <= (need * 10_060n) / 10_000n, `${spend} isn't much more than ${need} needs`)
  }
})

test("slippage is our 0.5% when the route allows, less when the price has moved a little, and no swap past that", () => {
  assert.equal(slippageFor(5_050_000n, 5_000_000n), 50)
  assert.equal(slippageFor(5_015_000n, 5_000_000n), 29)
  assert.equal(slippageFor(5_004_000n, 5_000_000n), undefined, "under 0.1% of room")
  assert.equal(slippageFor(4_999_999n, 5_000_000n), undefined)
  assert.equal(slippageFor(0n, 5_000_000n), undefined)
})

test("from Jupiter, only a compute budget, opening the wallet's own token accounts, and the swap pass: an Approve or anything else is refused", () => {
  const [payer, other, mint] = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey]
  const own = createAssociatedTokenAccountIdempotentInstruction(payer, getAssociatedTokenAddressSync(mint, payer), payer, mint)
  const swap = new TransactionInstruction({ programId: new PublicKey(JUPITER_PROGRAM), keys: [], data: Buffer.from([1]) })
  const ok = {
    budget: [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 })],
    setup: [own],
    swap,
    rest: []
  }
  assert.equal(jupiterProblem(ok, payer), undefined)
  const approve = createApproveInstruction(getAssociatedTokenAddressSync(mint, payer), other, payer, 1n)
  assert.match(jupiterProblem({ ...ok, setup: [own, approve] }, payer)!, /doesn't allow/, "a delegate on the wallet's account leaves today's balances as they are")
  const forOther = createAssociatedTokenAccountIdempotentInstruction(payer, getAssociatedTokenAddressSync(mint, other), other, mint)
  assert.match(jupiterProblem({ ...ok, setup: [forOther] }, payer)!, /doesn't allow/, "an account for someone else, on the wallet's rent")
  assert.match(jupiterProblem({ ...ok, budget: [ComputeBudgetProgram.requestHeapFrame({ bytes: 65_536 })] }, payer)!, /doesn't allow/)
  assert.match(jupiterProblem({ ...ok, swap: approve }, payer)!, /doesn't allow/)
  assert.match(jupiterProblem({ ...ok, rest: [own] }, payer)!, /doesn't allow/, "no cleanup or other instructions")
})

test("a simulated swap is signed only if it pays exactly the USDC needed, takes exactly the token shown, and no more SOL than fees and rent", () => {
  const before: Balances = { lamports: 10_000_000n, token: 9_000_000_000n, usdc: 300n, deposit: 0n }
  const after: Balances = { lamports: 7_900_000n, token: 2_000_000_000n, usdc: 25_300n, deposit: 5_000_000n }
  const expect = { need: 5_000_000n, spend: 7_000_000_000n }
  assert.equal(outcomeProblem(before, after, expect), undefined)
  assert.match(outcomeProblem(before, { ...after, deposit: 4_999_999n }, expect)!, /exactly the USDC/)
  assert.match(outcomeProblem(before, { ...after, token: 1_999_999_999n }, expect)!, /exactly the amount shown/)
  assert.match(outcomeProblem(before, { ...after, usdc: 299n }, expect)!, /take USDC from your wallet/)
  assert.match(outcomeProblem(before, { ...after, lamports: 4_999_999n }, expect)!, /more SOL/)
})

test("a failed simulation is told in the customer's words", () => {
  assert.match(simulationProblem(["Program JUP6… failed: custom program error: 0x1771"], "ORE")!, /ORE's price moved/)
  assert.match(simulationProblem(["Create Account: account Address { address: 9x…, base: None } already in use"], "ORE")!, /already paid/)
  assert.match(simulationProblem(["Program log: Error: insufficient funds"], "ORE")!, /doesn't hold enough ORE/)
  assert.match(simulationProblem(["Transfer: insufficient lamports 100, need 2039280"], "ORE")!, /more SOL/)
  assert.equal(simulationProblem(["Program log: something else"], "ORE"), undefined)
})

// Live: Jupiter's real route for ORE (needs JUPITER_API_KEY; nothing is signed or sent).
const live = { skip: !(process.env.LIVE_TESTS && process.env.JUPITER_API_KEY) && "set LIVE_TESTS=1 and JUPITER_API_KEY to call Jupiter" }

test("sizes a $5 ORE swap within a percent and a half of the market", live, async () => {
  const r = await Effect.runPromise(Effect.gen(function*() {
    const s = yield* Swap
    const [t] = yield* s.tokens
    return { price: t!.price, spend: yield* s.size(ORE, 5_000_000n, true) }
  }).pipe(Effect.provide(Swap.layer)))
  const paying = 5 / (Number(r.spend) / 1e11)
  assert.ok(paying <= r.price && paying >= r.price * 0.985, `${paying} a token against ${r.price}`)
})
