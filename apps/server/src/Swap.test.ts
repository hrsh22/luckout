import { base58Encode } from "@luckout/api"
import {
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createApproveInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token"
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction } from "@solana/web3.js"
import { ConfigProvider, Effect, Layer } from "effect"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import {
  type Balances,
  JUPITER_PROGRAM,
  jupiterProblem,
  type JupiterQuote,
  MAX_PRIORITY_LAMPORTS,
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
  const authorities = ["- -", "- -", "- -", "- -"]
  // The wallet's own token accounts (its token, its USDC, the other one): its USDC account is opened by the swap.
  const before: Balances = { lamports: 10_000_000n, token: 9_000_000_000n, usdc: 0n, deposit: 0n, others: [40n], authorities, owners: ["Payer", undefined, "Payer"] }
  const after: Balances = { lamports: 7_900_000n, token: 2_000_000_000n, usdc: 25_000n, deposit: 5_000_000n, others: [40n], authorities, owners: ["Payer", "Payer", "Payer"] }
  const expect = { need: 5_000_000n, spend: 7_000_000_000n, payer: "Payer" }
  assert.equal(outcomeProblem(before, after, expect), undefined)
  assert.equal(outcomeProblem(before, { ...after, others: [41n] }, expect), undefined, "a token it routes through may come out ahead")
  assert.match(outcomeProblem(before, { ...after, owners: ["Payer", "Payer", undefined] }, expect)!, /close one of your wallet's token accounts/, "closing it sends its rent elsewhere")
  assert.match(outcomeProblem(before, { ...after, token: 0n, owners: [undefined, "Payer", "Payer"] }, { ...expect, spend: 9_000_000_000n })!, /close/, "the token's own, spent whole")
  assert.match(outcomeProblem(before, { ...after, owners: ["Mallory", "Payer", "Payer"] }, expect)!, /to someone else/)
  assert.match(outcomeProblem(before, { ...after, owners: ["Payer", "Payer", "Mallory"] }, expect)!, /to someone else/)
  assert.match(outcomeProblem(before, { ...after, deposit: 4_999_999n }, expect)!, /exactly the USDC/)
  assert.match(outcomeProblem(before, { ...after, token: 1_999_999_999n }, expect)!, /exactly the amount shown/)
  assert.match(outcomeProblem({ ...before, usdc: 300n }, { ...after, usdc: 299n }, expect)!, /take USDC from your wallet/)
  assert.match(outcomeProblem(before, { ...after, others: [39n] }, expect)!, /another token/)
  assert.match(outcomeProblem(before, { ...after, authorities: ["- -", "Mallory -", "- -", "- -"] }, expect)!, /someone else spend/)
  assert.equal(outcomeProblem(before, { ...after, lamports: 3_800_000n }, expect), undefined, "rent for three token accounts (a route through another token) is within reach")
  assert.match(outcomeProblem(before, { ...after, lamports: 2_999_999n }, expect)!, /more SOL/)
})

test("a failed simulation is told in the customer's words", () => {
  assert.match(simulationProblem(["Program JUP6… failed: custom program error: 0x1771"], "ORE")!, /ORE's price moved/)
  assert.match(simulationProblem(["Create Account: account Address { address: 9x…, base: None } already in use"], "ORE")!, /already paid/)
  assert.match(simulationProblem(["Program log: Error: insufficient funds"], "ORE")!, /doesn't hold enough ORE/)
  assert.match(simulationProblem(["Transfer: insufficient lamports 100, need 2039280"], "ORE")!, /more SOL/)
  assert.equal(simulationProblem(["Program log: something else"], "ORE"), undefined)
})

// ---------- the whole build, against Jupiter and Solana faked on a local port ----------
// Swap.layer as it runs, with JUPITER_API_URL and SOLANA_RPC_URL pointed at one fake that answers both. Nothing
// leaves this machine.

const PAYER = Keypair.generate().publicKey
const DEPOSIT = Keypair.generate().publicKey
const USDC_MINT = new PublicKey(SOL_USDC_MINT)
const SOURCE = getAssociatedTokenAddressSync(new PublicKey(ORE.mint), PAYER)
const WALLET_USDC = getAssociatedTokenAddressSync(USDC_MINT, PAYER)
const DEPOSIT_USDC = getAssociatedTokenAddressSync(USDC_MINT, DEPOSIT, true)
/** Another token the wallet holds, which the route passes through; and a pool's vault, which isn't the wallet's. */
const HELD = getAssociatedTokenAddressSync(Keypair.generate().publicKey, PAYER)
const VAULT = Keypair.generate().publicKey
const BLOCKHASH = Keypair.generate().publicKey.toBase58()
const NEED = 5_000_000n
/** 0.073 ORE: at the fake's $70 less 0.3%, 5.09467 USDC, so our usual 0.5% of room covers the 5 USDC. */
const SPEND = 7_300_000_000n
const OUT = (SPEND * 70n * 997n) / 100_000_000n

type Held = { lamports: number; owner: PublicKey; data: Buffer }
const tokenData = (mint: PublicKey, owner: PublicKey, amount: bigint, delegate?: PublicKey) => {
  const b = Buffer.alloc(AccountLayout.span)
  AccountLayout.encode({
    mint, owner, amount, delegateOption: delegate ? 1 : 0, delegate: delegate ?? PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n,
    delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default
  }, b)
  return b
}
const tokenAt = (mint: PublicKey, owner: PublicKey, amount: bigint, delegate?: PublicKey): Held => ({ lamports: 2_039_280, owner: TOKEN_PROGRAM_ID, data: tokenData(mint, owner, amount, delegate) })
const BEFORE: Record<string, Held> = {
  [PAYER.toBase58()]: { lamports: 50_000_000, owner: SystemProgram.programId, data: Buffer.alloc(0) },
  [SOURCE.toBase58()]: tokenAt(new PublicKey(ORE.mint), PAYER, 10_000_000_000n),
  [WALLET_USDC.toBase58()]: tokenAt(USDC_MINT, PAYER, 300n),
  [HELD.toBase58()]: tokenAt(VAULT, PAYER, 1_000n),
  [VAULT.toBase58()]: tokenAt(VAULT, VAULT, 10n ** 12n)
}
/** What an honest swap leaves: the ORE shown gone, exactly the USDC needed at the deposit address, the rest in the wallet. */
const HONEST: Record<string, Held> = {
  ...BEFORE,
  [PAYER.toBase58()]: { ...BEFORE[PAYER.toBase58()]!, lamports: 50_000_000 - 2_039_280 - 105_000 },
  [SOURCE.toBase58()]: tokenAt(new PublicKey(ORE.mint), PAYER, 10_000_000_000n - SPEND),
  [WALLET_USDC.toBase58()]: tokenAt(USDC_MINT, PAYER, 300n + OUT - NEED),
  [DEPOSIT_USDC.toBase58()]: tokenAt(USDC_MINT, DEPOSIT, NEED)
}
const asJson = (i: TransactionInstruction) => ({
  programId: i.programId.toBase58(),
  accounts: i.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: Buffer.from(i.data).toString("base64")
})
const swapIx = new TransactionInstruction({
  programId: new PublicKey(JUPITER_PROGRAM),
  keys: [PAYER, SOURCE, WALLET_USDC, HELD, VAULT].map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: i > 0 })),
  data: Buffer.from([7, 7, 7])
})
const INSTRUCTIONS = {
  computeBudgetInstructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 400_000 })].map(asJson),
  setupInstructions: [asJson(createAssociatedTokenAccountIdempotentInstruction(PAYER, WALLET_USDC, PAYER, USDC_MINT))],
  swapInstruction: asJson(swapIx),
  cleanupInstruction: null,
  otherInstructions: [],
  addressLookupTableAddresses: []
}

/** A transaction that changed the deposit address's USDC from `pre` to `post`, as getTransaction answers it. */
type Seen = { signature: string; err?: object; pre: bigint; post: bigint }
const balanceOf = (amount: bigint) => ({ accountIndex: 1, mint: SOL_USDC_MINT, owner: DEPOSIT.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: { amount: String(amount), decimals: 6, uiAmount: null } })

const fake = (o: {
  instructions?: object
  /** What each simulation (in order) answers: the accounts it leaves, or an error with its logs. */
  simulations?: Array<{ after?: Record<string, Held>; err?: object; logs?: Array<string> }>
  /** Quote calls answered "busy" before Jupiter answers. */
  busy?: number
  /** Price calls answered "busy" before Jupiter answers. */
  busyPrice?: number
  /** The chain before the swap (BEFORE by default). */
  before?: Record<string, Held>
  /** Payments to the deposit address's USDC account, oldest first. */
  seen?: Array<Seen>
} = {}) => {
  const calls: Array<{ to: string; params?: unknown }> = []
  let busy = o.busy ?? 0
  let busyPrice = o.busyPrice ?? 0
  const chain = o.before ?? BEFORE
  let simulated = 0
  const reply = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
  const rpcAccount = (a: Held | undefined) =>
    a ? { data: [a.data.toString("base64"), "base64"], executable: false, lamports: a.lamports, owner: a.owner.toBase58(), rentEpoch: 0, space: a.data.length } : null
  const node = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c)).on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake")
      if (url.pathname === "/price/v3") {
        calls.push({ to: "price" })
        return busyPrice-- > 0 ? reply(res, 429, { error: "Rate limit exceeded" }) : reply(res, 200, { [ORE.mint]: { usdPrice: 70 } })
      }
      if (url.pathname === "/swap/v1/quote") {
        const p = Object.fromEntries(url.searchParams)
        calls.push({ to: "quote", params: p })
        if (busy-- > 0) return reply(res, 429, { error: "Rate limit exceeded" })
        const inAmount = BigInt(p.amount!)
        const out = (inAmount * 70n * 997n) / 100_000_000n
        return reply(res, 200, {
          inputMint: p.inputMint, outputMint: p.outputMint, inAmount: String(inAmount), outAmount: String(out),
          otherAmountThreshold: String((out * (10_000n - BigInt(p.slippageBps!))) / 10_000n), swapMode: "ExactIn", slippageBps: Number(p.slippageBps),
          priceImpactPct: "0.001", routePlan: [{ swapInfo: { label: "FakeDex" } }]
        })
      }
      if (url.pathname === "/swap/v1/swap-instructions") return calls.push({ to: "swap-instructions" }), reply(res, 200, o.instructions ?? INSTRUCTIONS)
      const { id, method, params } = JSON.parse(body) as { id: string; method: string; params: Array<any> }
      calls.push({ to: method, params })
      const ok = (result: unknown) => reply(res, 200, { jsonrpc: "2.0", id, result })
      const context = { slot: 100 }
      switch (method) {
        case "getMultipleAccounts":
          return ok({ context, value: (params[0] as Array<string>).map((k) => rpcAccount(chain[k])) })
        case "getLatestBlockhash":
          return ok({ context, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1_150 } })
        case "simulateTransaction": {
          const s = o.simulations?.[simulated++] ?? {}
          const after = s.after ?? HONEST
          return ok({
            context,
            value: { err: s.err ?? null, logs: s.logs ?? [], accounts: s.err ? null : (params[1].accounts.addresses as Array<string>).map((k) => rpcAccount(after[k])), unitsConsumed: 1, returnData: null }
          })
        }
        case "getSignaturesForAddress":
          return ok([...(o.seen ?? [])].reverse().map((s) => ({ signature: s.signature, slot: 90, err: s.err ?? null, memo: null, blockTime: null })))
        case "getTransaction": {
          const s = o.seen?.find((x) => x.signature === params[0])!
          return ok({
            slot: 90, blockTime: null, version: 0,
            transaction: {
              signatures: [s.signature],
              message: { accountKeys: [PAYER, DEPOSIT_USDC, TOKEN_PROGRAM_ID].map(String), header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 }, instructions: [], recentBlockhash: BLOCKHASH, addressTableLookups: [] }
            },
            meta: { err: s.err ?? null, fee: 5_000, innerInstructions: [], preBalances: [0, 0, 0], postBalances: [0, 0, 0], logMessages: [], preTokenBalances: [balanceOf(s.pre)], postTokenBalances: [balanceOf(s.post)], loadedAddresses: { writable: [], readonly: [] } }
          })
        }
        default:
          return reply(res, 500, { jsonrpc: "2.0", id, error: { code: -32601, message: `not faked: ${method}` } })
      }
    })
  })
  const run = <A, E>(f: (s: Swap["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.acquireUseRelease(
      Effect.promise(() => new Promise<string>((ok) => node.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(node.address() as AddressInfo).port}`)))),
      (url) =>
        Swap.use(f).pipe(Effect.provide(Swap.layer.pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { JUPITER_API_KEY: "test", JUPITER_API_URL: url, SOLANA_RPC_URL: url } })))
        ))),
      () => Effect.promise(() => new Promise<void>((ok) => node.close(() => ok())))
    ))
  const order = { token: ORE, payer: PAYER.toBase58(), depositAddress: DEPOSIT.toBase58(), need: NEED, spend: SPEND, retryBusy: false }
  const build = (o: Partial<typeof order> = {}) => run((s) => s.transaction({ ...order, ...o }))
  const refused = (o: Partial<typeof order> = {}) => run((s) => Effect.flip(s.transaction({ ...order, ...o })))
  const refusal = (o: Partial<typeof order> = {}) => refused(o).then((e) => e.message)
  const jupiter = () => calls.filter((c) => ["price", "quote", "swap-instructions"].includes(c.to)).length
  return { calls, run, build, refused, refusal, jupiter, to: (what: string) => calls.filter((c) => c.to === what) }
}

const decoded = (base64: string) => {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64, "base64"))
  const keys = tx.message.staticAccountKeys
  return tx.message.compiledInstructions.map((i) => ({ program: keys[i.programIdIndex]!, data: Buffer.from(i.data), accounts: i.accountKeyIndexes.map((k) => keys[k]!) }))
}

test("a swap is built from a fresh route, watched where it could take anything, and handed out only as simulated", async () => {
  const f = fake()
  const tx = await f.build()
  const ixs = decoded(tx.transaction)
  assert.equal(tx.lastValidBlockHeight, 1_150)
  assert.deepEqual(f.to("quote").map((c) => (c.params as Record<string, string>).amount), [String(SPEND)], "one route, for exactly the ORE shown")
  // Jupiter's budget with room for our two instructions; then its setup, its swap, our deposit account and transfer.
  const limit = ixs.find((i) => i.program.equals(ComputeBudgetProgram.programId) && i.data[0] === 2)!
  assert.equal(limit.data.readUInt32LE(1), 310_000)
  const [create, transfer] = ixs.slice(-2)
  assert.ok(create!.program.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && create!.data.length === 0 && create!.accounts[1]!.equals(DEPOSIT_USDC), "opened, not idempotently")
  assert.ok(transfer!.program.equals(TOKEN_PROGRAM_ID) && transfer!.data[0] === 12, "transferChecked")
  assert.deepEqual([transfer!.data.readBigUInt64LE(1), transfer!.data[9]], [NEED, 6], "exactly what 1Click needs, as USDC")
  // The simulation reads back the wallet's other token account the swap is handed, not the pool's.
  const watched = (f.to("simulateTransaction")[0]!.params as Array<any>)[1].accounts.addresses as Array<string>
  assert.deepEqual(watched, [PAYER, SOURCE, WALLET_USDC, DEPOSIT_USDC, HELD].map(String))
})

test("an instruction from Jupiter we don't allow is refused before anything is simulated", async () => {
  const approve = asJson(createApproveInstruction(SOURCE, Keypair.generate().publicKey, PAYER, 1n))
  const f = fake({ instructions: { ...INSTRUCTIONS, otherInstructions: [approve] } })
  assert.match(await f.refusal(), /doesn't allow/)
  assert.equal(f.to("simulateTransaction").length, 0)
})

test("a simulation that takes more than it says is refused: short USDC, another token of the wallet's, or a delegate on its account", async () => {
  const leaves = (changes: Record<string, Held>) => fake({ simulations: [{ after: { ...HONEST, ...changes } }] }).refusal()
  assert.match(await leaves({ [DEPOSIT_USDC.toBase58()]: tokenAt(USDC_MINT, DEPOSIT, NEED - 1n) }), /exactly the USDC/)
  assert.match(await leaves({ [HELD.toBase58()]: tokenAt(VAULT, PAYER, 999n) }), /another token/)
  assert.match(await leaves({ [SOURCE.toBase58()]: tokenAt(new PublicKey(ORE.mint), PAYER, 10_000_000_000n - SPEND, Keypair.generate().publicKey) }), /someone else spend/)
})

test("a wallet token account the swap is given read-only is watched too: another instruction may make it writable for the whole transaction", async () => {
  const mint = Keypair.generate().publicKey
  const other = getAssociatedTokenAddressSync(mint, PAYER)
  const swap = new TransactionInstruction({
    programId: new PublicKey(JUPITER_PROGRAM),
    keys: [PAYER, SOURCE, WALLET_USDC, other, VAULT].map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: i > 0 && pubkey !== other })),
    data: Buffer.from([7, 7, 7])
  })
  // Opening its account (a no-op, it exists) makes it writable for every instruction, the swap's included.
  const instructions = {
    ...INSTRUCTIONS,
    setupInstructions: [...INSTRUCTIONS.setupInstructions, asJson(createAssociatedTokenAccountIdempotentInstruction(PAYER, other, PAYER, mint))],
    swapInstruction: asJson(swap)
  }
  const f = fake({
    instructions,
    before: { ...BEFORE, [other.toBase58()]: tokenAt(mint, PAYER, 1_000n) },
    simulations: [{ after: { ...HONEST, [other.toBase58()]: tokenAt(mint, PAYER, 0n) } }]
  })
  assert.match(await f.refusal(), /another token/)
  assert.ok(((f.to("simulateTransaction")[0]!.params as Array<any>)[1].accounts.addresses as Array<string>).includes(other.toBase58()))
})

test("a swap that hands one of the wallet's token accounts to someone else is refused; an account it opens for the wallet passes", async () => {
  const thief = Keypair.generate().publicKey
  const handed = (account: PublicKey, held: Held) => fake({ simulations: [{ after: { ...HONEST, [account.toBase58()]: held } }] }).refusal()
  assert.match(await handed(SOURCE, tokenAt(new PublicKey(ORE.mint), thief, 10_000_000_000n - SPEND)), /to someone else/)
  assert.match(await handed(HELD, tokenAt(VAULT, thief, 1_000n)), /to someone else/)
  // No USDC account yet: Jupiter's setup opens the wallet's, owned by the wallet; the deposit address's is 1Click's.
  const { [WALLET_USDC.toBase58()]: _, ...noUsdc } = BEFORE
  await fake({ before: noUsdc, simulations: [{ after: { ...HONEST, [WALLET_USDC.toBase58()]: tokenAt(USDC_MINT, PAYER, OUT - NEED) } }] }).build()
})

/** Jupiter's swap, given one more account of the wallet's (`extra`) besides its token, its USDC and a pool's vault. */
const swapWith = (extra: PublicKey, isWritable = true) =>
  asJson(new TransactionInstruction({
    programId: new PublicKey(JUPITER_PROGRAM),
    keys: [
      { pubkey: PAYER, isSigner: true, isWritable: false },
      { pubkey: SOURCE, isSigner: false, isWritable: true },
      { pubkey: WALLET_USDC, isSigner: false, isWritable: true },
      { pubkey: extra, isSigner: false, isWritable },
      { pubkey: VAULT, isSigner: false, isWritable: true }
    ],
    data: Buffer.from([7, 7, 7])
  }))
/** The chain as an honest swap leaves it, but with `account` gone. */
const without = (account: PublicKey, chain: Record<string, Held> = HONEST) => Object.fromEntries(Object.entries(chain).filter(([k]) => k !== account.toBase58()))

test("a swap that closes one of the wallet's token accounts is refused, empty or spent whole: its rent would go elsewhere", async () => {
  const mint = Keypair.generate().publicKey
  const empty = getAssociatedTokenAddressSync(mint, PAYER)
  const closesEmpty = fake({
    instructions: { ...INSTRUCTIONS, swapInstruction: swapWith(empty) },
    before: { ...BEFORE, [empty.toBase58()]: tokenAt(mint, PAYER, 0n) },
    simulations: [{ after: without(empty) }]
  })
  assert.match(await closesEmpty.refusal(), /close one of your wallet's token accounts/)
  // All of its ORE swapped, and its ORE account closed with it.
  const spend = 10_000_000_000n
  const out = (spend * 70n * 997n) / 100_000_000n
  const closesSource = fake({ simulations: [{ after: { ...without(SOURCE), [WALLET_USDC.toBase58()]: tokenAt(USDC_MINT, PAYER, 300n + out - NEED) } }] })
  assert.match(await closesSource.refusal({ spend }), /close one of your wallet's token accounts/)
})

test("a token account Jupiter's setup opens for the wallet and hands to the swap is watched: it must end up the wallet's alone", async () => {
  const mint = Keypair.generate().publicKey
  const opened = getAssociatedTokenAddressSync(mint, PAYER)
  const thief = Keypair.generate().publicKey
  const instructions = {
    ...INSTRUCTIONS,
    setupInstructions: [...INSTRUCTIONS.setupInstructions, asJson(createAssociatedTokenAccountIdempotentInstruction(PAYER, opened, PAYER, mint))],
    swapInstruction: swapWith(opened)
  }
  const leaves = (held: Held) => fake({ instructions, simulations: [{ after: { ...HONEST, [opened.toBase58()]: held } }] })
  const owner = leaves(tokenAt(mint, thief, 0n))
  assert.match(await owner.refusal(), /to someone else/)
  assert.ok(((owner.to("simulateTransaction")[0]!.params as Array<any>)[1].accounts.addresses as Array<string>).includes(opened.toBase58()))
  assert.match(await leaves(tokenAt(mint, PAYER, 0n, thief)).refusal(), /someone else spend/)
  // Opened for the wallet and left as it should be: built.
  await leaves(tokenAt(mint, PAYER, 0n)).build()
})

test("a refusal that comes before Jupiter is asked says so, so trying again costs the quote nothing", async () => {
  const early = async (f: ReturnType<typeof fake>, o: { payer?: string } = {}) => {
    const e = await f.refused(o)
    return [e.early === true, f.jupiter(), e.message] as const
  }
  const short = await early(fake({ before: { ...BEFORE, [SOURCE.toBase58()]: tokenAt(new PublicKey(ORE.mint), PAYER, SPEND - 1n) } }))
  assert.deepEqual(short.slice(0, 2), [true, 0])
  assert.match(short[2], /doesn't hold/)
  const paid = await early(fake({ before: { ...BEFORE, [DEPOSIT_USDC.toBase58()]: tokenAt(USDC_MINT, DEPOSIT, 0n) } }))
  assert.deepEqual(paid.slice(0, 2), [true, 0])
  assert.deepEqual((await early(fake(), { payer: "not-a-key" })).slice(0, 2), [true, 0])
  // One that Jupiter and a simulation were asked for isn't.
  const late = await fake({ simulations: [{ after: { ...HONEST, [DEPOSIT_USDC.toBase58()]: tokenAt(USDC_MINT, DEPOSIT, NEED - 1n) } }] }).refused()
  assert.notEqual(late.early, true)
})

test("a priority price over our ceiling is lowered, so the whole priority fee stays within it whatever Jupiter answers", async () => {
  const greedy = [ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10n ** 12n })].map(asJson)
  const ixs = decoded((await fake({ instructions: { ...INSTRUCTIONS, computeBudgetInstructions: greedy } }).build()).transaction)
  const budget = ixs.filter((i) => i.program.equals(ComputeBudgetProgram.programId))
  const units = BigInt(budget.find((i) => i.data[0] === 2)!.data.readUInt32LE(1))
  const price = budget.find((i) => i.data[0] === 3)!.data.readBigUInt64LE(1)
  assert.ok((units * price) / 1_000_000n <= BigInt(MAX_PRIORITY_LAMPORTS), `${units} units at ${price} micro-lamports`)
  assert.ok((units * price) / 1_000_000n > BigInt(MAX_PRIORITY_LAMPORTS) - 1_000n, "lowered to the ceiling, not below it")
  // An honest one is left as it is: 310,000 units at 400,000 is 124,000 lamports.
  const honest = decoded((await fake().build()).transaction).find((i) => i.program.equals(ComputeBudgetProgram.programId) && i.data[0] === 3)!
  assert.equal(honest.data.readBigUInt64LE(1), 400_000n)
})

test("a route whose quote went stale in the simulation is tried once more without its markets", async () => {
  const f = fake({ simulations: [{ err: { InstructionError: [2, { Custom: 6001 }] }, logs: ["Program log: Error: SlippageToleranceExceeded"] }] })
  await f.build()
  assert.deepEqual(f.to("quote").map((c) => (c.params as Record<string, string>).excludeDexes), [undefined, "FakeDex"])
  assert.equal(f.to("simulateTransaction").length, 2)
  // Stale twice: the customer hears the price moved.
  const twice = fake({ simulations: [0, 1].map(() => ({ err: { InstructionError: [2, { Custom: 6001 }] }, logs: ["Program log: Error: SlippageToleranceExceeded"] })) })
  assert.match(await twice.refusal(), /price moved/)
})

test("a busy Jupiter is told at once to a request anyone can make, and asked again for a signed-in customer", async () => {
  const anyone = fake({ busy: 1 })
  assert.match(await anyone.refusal({ retryBusy: false }), /Jupiter is busy/)
  assert.equal(anyone.to("quote").length, 1, "one call to Jupiter, not five")
  const price = fake({ busyPrice: 1 })
  assert.match(await price.refusal({ retryBusy: false }), /Jupiter is busy/)
  assert.equal(price.to("price").length, 1, "its price either")
  const customer = fake({ busy: 1 })
  await customer.build({ retryBusy: true })
  assert.equal(customer.to("quote").length, 2)
})

test("a payment is found on chain: the oldest transaction that put at least the USDC needed into the deposit address", async () => {
  const sig = () => base58Encode(randomBytes(64))
  const [dust, failed, payment, sweep] = [sig(), sig(), sig(), sig()]
  const f = fake({
    seen: [
      { signature: dust, pre: 0n, post: 1n },
      { signature: failed, err: { InstructionError: [4, { Custom: 1 }] }, pre: 1n, post: 1n + NEED },
      { signature: payment, pre: 1n, post: 1n + NEED },
      { signature: sweep, pre: 1n + NEED, post: 0n }
    ]
  })
  assert.equal(await f.run((s) => s.paidBy(DEPOSIT.toBase58(), NEED)), payment)
  assert.deepEqual((f.to("getSignaturesForAddress")[0]!.params as Array<string>)[0], DEPOSIT_USDC.toBase58(), "its USDC account, not the address")
  assert.equal(f.to("getTransaction").length, 2, "the failed one isn't even fetched")
  assert.equal(await fake({ seen: [{ signature: dust, pre: 0n, post: 1n }] }).run((s) => s.paidBy(DEPOSIT.toBase58(), NEED)), undefined)
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
