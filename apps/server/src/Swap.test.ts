import { address, lamports } from "@solana/kit"
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createApproveInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token"
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js"
import { ConfigProvider, Effect, Layer } from "effect"
import assert from "node:assert/strict"
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { Chain, type RawAccount, Solana } from "./Solana.ts"
import {
  type Balances,
  JUPITER_PROGRAM,
  jupiterProblem,
  type JupiterQuote,
  MAX_FEE_PAYER_SPEND,
  outcomeProblem,
  quoteProblem,
  simulationProblem,
  Swap,
  SWAP_TOKENS,
  swapInstructions,
  unitsFor
} from "./Swap.ts"
import { solanaLayer, solanaWorld } from "./testing.ts"

const ORE = SWAP_TOKENS.find((t) => t.symbol === "ORE")!
const USDC_MINT = Keypair.generate().publicKey.toBase58()
// 0.07 ORE for 5.025 USDC: $71.79 an ORE, against a market at $71.50.
const quote = (o: Partial<JupiterQuote> = {}): JupiterQuote => ({
  inputMint: ORE.mint,
  outputMint: USDC_MINT,
  inAmount: "7000000000",
  outAmount: "5025000",
  otherAmountThreshold: "5000000",
  swapMode: "ExactIn",
  slippageBps: 50,
  priceImpactPct: "0.0036",
  routePlan: [{ swapInfo: { label: "Meteora DLMM" } }],
  ...o
})
const check = (q: JupiterQuote, usdPrice = 71.5) => quoteProblem(q, { token: ORE, spend: 7_000_000_000n, usdPrice, usdcMint: USDC_MINT })

test("a route is used only when it swaps exactly what was shown into USDC, near the market, for at least 1 USDC", () => {
  assert.equal(check(quote()), undefined)
  assert.match(check(quote({ swapMode: "ExactOut" }))!, /different swap/)
  assert.match(check(quote({ inAmount: "7000000001" }))!, /different swap/, "never more of the token than the customer was shown")
  assert.match(check(quote({ outputMint: ORE.mint }))!, /different swap/)
  assert.match(check(quote({ priceImpactPct: "0.0101" }))!, /big swap/)
  assert.match(check(quote({ priceImpactPct: "NaN" }))!, /big swap/)
  assert.match(check(quote(), 73)!, /off the market/, "2% under Jupiter's market price")
  assert.equal(check(quote(), 72.5), undefined, "1.4% under it is within reach of a route's fees")
  assert.match(check(quote(), 0)!, /off the market/, "no market price, no swap")
  assert.match(check(quote({ outAmount: "0" }))!, /off the market/, "a route that gives nothing")
  assert.match(check(quote({ otherAmountThreshold: "999999" }))!, /at least 1 USDC/, "the program's smallest deposit")
})

test("from Jupiter, only opening the wallet's own token accounts on our fee payer's rent, and a swap without the fee payer in it, pass", () => {
  const [wallet, feePayer, other, mint] = [0, 0, 0, 0].map(() => Keypair.generate().publicKey) as [PublicKey, PublicKey, PublicKey, PublicKey]
  const keys = { wallet, feePayer }
  const own = createAssociatedTokenAccountIdempotentInstruction(feePayer, getAssociatedTokenAddressSync(mint, wallet), wallet, mint)
  const swap = new TransactionInstruction({ programId: new PublicKey(JUPITER_PROGRAM), keys: [{ pubkey: wallet, isSigner: true, isWritable: false }], data: Buffer.from([1]) })
  const ok = { budget: [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })], setup: [own], swap, rest: [] as Array<TransactionInstruction> }
  assert.equal(jupiterProblem(ok, keys), undefined)
  const refused = (j: Partial<typeof ok>, why: string) => assert.match(jupiterProblem({ ...ok, ...j }, keys)!, /doesn't allow/, why)
  refused({ setup: [own, createApproveInstruction(getAssociatedTokenAddressSync(mint, wallet), other, wallet, 1n)] }, "a delegate on the wallet's account")
  refused({ setup: [createAssociatedTokenAccountIdempotentInstruction(feePayer, getAssociatedTokenAddressSync(mint, other), other, mint)] }, "an account for someone else, on our rent")
  refused({ setup: [createAssociatedTokenAccountIdempotentInstruction(wallet, getAssociatedTokenAddressSync(mint, wallet), wallet, mint)] }, "the wallet holds no SOL to pay rent")
  refused({ swap: new TransactionInstruction({ ...swap, keys: [...swap.keys, { pubkey: feePayer, isSigner: true, isWritable: true }] }) }, "the fee payer as an authority in the swap")
  refused({ swap: new TransactionInstruction({ ...swap, keys: [...swap.keys, { pubkey: feePayer, isSigner: false, isWritable: false }] }) }, "or anywhere in it")
  refused({ swap: own }, "another program for the swap")
  refused({ rest: [own] }, "no cleanup or other instructions")
})

test("the compute asked for is Jupiter's limit and room for the deposit, at most Solana's", () => {
  assert.equal(unitsFor([ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })]), 310_000)
  assert.equal(unitsFor([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_390_000 })]), 1_400_000)
  assert.equal(unitsFor([]), 1_400_000)
})

test("a simulated swap is signed only if it takes exactly the token shown, puts at least its minimum into the Balance, and our fee payer only pays", () => {
  const authorities = ["- -", "Vault -", "- -"]
  // The wallet's own token accounts: its token, its USDC (the Vault's authority its delegate), and one the route passes through.
  const before: Balances = { lamports: 0n, feePayer: 50_000_000n, token: 9_000_000_000n, usdc: 300n, balance: 1_000_000n, others: [40n], authorities, owners: ["W", "W", "W"] }
  const after: Balances = { ...before, feePayer: 47_900_000n, token: 2_000_000_000n, usdc: 0n, balance: 1_000_000n + 300n + 5_025_000n }
  const expect = { spend: 7_000_000_000n, minOut: 5_000_000n, wallet: "W" }
  assert.equal(outcomeProblem(before, after, expect), undefined)
  assert.equal(outcomeProblem(before, { ...after, others: [41n] }, expect), undefined, "a token it routes through may come out ahead")
  assert.equal(outcomeProblem(before, { ...after, usdc: 25n, balance: 1_000_000n + 300n + 4_999_975n }, expect), undefined, "what the deposit leaves in the wallet still counts")
  const refused = (changes: Partial<Balances>, why: RegExp, name = JSON.stringify(changes, (_, v) => typeof v === "bigint" ? String(v) : v)) =>
    assert.match(outcomeProblem(before, { ...after, ...changes }, expect) ?? "", why, name)
  refused({ token: 1_999_999_999n }, /exactly the amount shown/)
  refused({ balance: 1_000_000n + 300n + 4_999_999n }, /at least its minimum/)
  refused({ balance: 1_000_000n, usdc: 5_025_300n }, /at least its minimum/, "the deposit didn't run")
  refused({ others: [39n] }, /another token/)
  refused({ owners: ["W", "W", undefined] }, /close one of your wallet's token accounts/)
  refused({ owners: ["Mallory", "W", "W"] }, /to someone else/)
  refused({ authorities: ["Mallory -", "Vault -", "- -"] }, /someone else spend/)
  refused({ lamports: -1n }, /spend your wallet's SOL/)
  refused({ feePayer: 50_000_000n - MAX_FEE_PAYER_SPEND - 1n }, /more in fees and rent/)
  assert.equal(outcomeProblem(before, { ...after, feePayer: 50_000_000n - MAX_FEE_PAYER_SPEND }, expect), undefined, "rent for three token accounts and the fee")
})

test("a failed simulation is told in the customer's words", () => {
  assert.match(simulationProblem(["Program JUP6… failed: custom program error: 0x1771"], "ORE")!, /ORE's price moved/)
  assert.match(simulationProblem(["Program log: AnchorError … Error Message: Deposit at least 1 USDC."], "USDT")!, /at least 1 USDC's worth/)
  assert.match(simulationProblem(["Program log: Error: insufficient funds"], "ORE")!, /doesn't hold enough ORE/)
  assert.match(simulationProblem(["Transfer: insufficient lamports 100, need 2039280"], "ORE")!, /Luckout can't pay/)
  assert.equal(simulationProblem(["Program log: something else"], "ORE"), undefined)
})

// ---------- the whole build: the program's accounts on LiteSVM, Jupiter faked on a local port ----------
// LiteSVM has no Jupiter, so a simulation's outcome is scripted; everything it's compared with is read from the chain.

type World = ReturnType<typeof solanaWorld>
const TOKEN = TOKEN_PROGRAM_ID
const put = (w: World, key: PublicKey, owner: PublicKey, data: Buffer, lamport = 2_039_280n) =>
  w.svm.setAccount({ address: address(key.toBase58()), data, executable: false, lamports: lamports(lamport), programAddress: address(owner.toBase58()), space: BigInt(data.length) })
const tokenData = (mint: PublicKey, owner: PublicKey, amount: bigint) => {
  const d = Buffer.alloc(165)
  mint.toBuffer().copy(d, 0)
  owner.toBuffer().copy(d, 32)
  d.writeBigUInt64LE(amount, 64)
  d[108] = 1
  return d
}
const mintData = (authority: PublicKey) => {
  const d = Buffer.alloc(82)
  d.writeUInt32LE(1, 0)
  authority.toBuffer().copy(d, 4)
  d[44] = 6
  d[45] = 1
  return d
}
const raw = (w: World, key: PublicKey): RawAccount | undefined => {
  const a = w.svm.getAccount(address(key.toBase58()))
  return a.exists ? { owner: new PublicKey(a.programAddress), lamports: BigInt(a.lamports), data: Buffer.from(a.data) } : undefined
}
const amountAt = (a: RawAccount | undefined, offset: number) => (a ? a.data.readBigUInt64LE(offset) : 0n)
const withAmount = (a: RawAccount, offset: number, amount: bigint): RawAccount => {
  const data = Buffer.from(a.data)
  data.writeBigUInt64LE(amount, offset)
  return { ...a, data }
}
/** A Customer account's Balance: after its discriminator, layout, bump and wallet. */
const BALANCE = 8 + 1 + 1 + 32

/** A customer who made the one-time approval (their USDC account's delegate is the Vault's authority), holding `ore`. */
const approved = (w: World, ore = 10_000_000_000n) => {
  const wallet = Keypair.generate()
  const usdc = getAssociatedTokenAddressSync(w.mint, wallet.publicKey)
  w.send([
    createAssociatedTokenAccountIdempotentInstruction(w.feePayer.publicKey, usdc, wallet.publicKey, w.mint),
    createApproveInstruction(usdc, w.program.vaultAuthority, wallet.publicKey, 2n ** 64n - 1n),
    w.program.instruction("open", { wallet: wallet.publicKey, payer: w.feePayer.publicKey, config: w.program.config, customer: w.program.customer(wallet.publicKey) }, {
      default_mode: { kind: "Normal" }
    })
  ], [wallet])
  const source = getAssociatedTokenAddressSync(new PublicKey(ORE.mint), wallet.publicKey)
  if (ore > 0n) put(w, source, TOKEN, tokenData(new PublicKey(ORE.mint), wallet.publicKey, ore))
  return { wallet, usdc, source, customer: w.program.customer(wallet.publicKey) }
}

const asJson = (i: TransactionInstruction) => ({
  programId: i.programId.toBase58(),
  accounts: i.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: Buffer.from(i.data).toString("base64")
})

type Customer = ReturnType<typeof approved>
/** A simulation's outcome over an honest swap's, by account (null: gone); or its logs, when it fails. */
type Scripted = { after?: (c: Customer, w: World) => Record<string, RawAccount | null>; logs?: Array<string> }
const fake = (o: {
  /** What Jupiter's swap-instructions answer, given the customer, the world, and an honest answer. */
  instructions?: (c: Customer, w: World, honest: object) => object
  /** What each simulation (in order) leaves, over an honest swap's outcome; or its logs, when it fails. */
  simulations?: Array<Scripted>
  /** Quote calls answered "busy" before Jupiter answers. */
  busy?: number
  ore?: bigint
  /** The wallet's own SOL: it needs none, but may hold some. */
  sol?: bigint
  approve?: boolean
} = {}) => {
  const w = solanaWorld()
  const c = o.approve === false ? { wallet: Keypair.generate(), usdc: PublicKey.default, source: PublicKey.default, customer: PublicKey.default } : approved(w, o.ore)
  if (o.sol) put(w, c.wallet.publicKey, new PublicKey("11111111111111111111111111111111"), Buffer.alloc(0), o.sol)
  const pool = Keypair.generate().publicKey
  const calls: Array<{ to: string; body?: unknown }> = []
  const simulated: Array<{ bytes: Uint8Array; watch: ReadonlyArray<PublicKey> }> = []
  let busy = o.busy ?? 0
  let last = { spend: 0n, out: 0n }
  const swapIx = () =>
    new TransactionInstruction({
      programId: new PublicKey(JUPITER_PROGRAM),
      keys: [c.wallet.publicKey, c.source, c.usdc, pool].map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: i > 0 })),
      data: Buffer.from([7, 7, 7])
    })
  const honest = () => ({
    computeBudgetInstructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 400_000 })].map(asJson),
    setupInstructions: [asJson(createAssociatedTokenAccountIdempotentInstruction(w.feePayer.publicKey, c.usdc, c.wallet.publicKey, w.mint))],
    swapInstruction: asJson(swapIx()),
    cleanupInstruction: null,
    otherInstructions: [],
    addressLookupTableAddresses: []
  })
  // An honest swap: the token shown gone, and the deposit moves what it gave, with what was waiting, into the Balance.
  const outcome = (k: PublicKey): RawAccount | undefined => {
    const now = raw(w, k)
    if (now && k.equals(c.source)) return withAmount(now, 64, amountAt(now, 64) - last.spend)
    if (now && k.equals(c.usdc)) return withAmount(now, 64, 0n)
    if (now && k.equals(c.customer)) return withAmount(now, BALANCE, amountAt(now, BALANCE) + amountAt(raw(w, c.usdc), 64) + last.out)
    if (now && k.equals(w.feePayer.publicKey)) return { ...now, lamports: now.lamports - 25_000n }
    return now
  }
  const chain = Chain.of({
    ...w.chain,
    simulate: (bytes, watch = []) =>
      Effect.sync(() => {
        const s = o.simulations?.[simulated.length] ?? {}
        simulated.push({ bytes, watch })
        if (s.logs) return { error: { text: "failed" }, logs: s.logs, inner: [], returnData: undefined, units: 1, accounts: watch.map(() => undefined) }
        const after = s.after?.(c, w) ?? {}
        return {
          error: undefined, logs: [], inner: [], returnData: undefined, units: 1,
          accounts: watch.map((k) => (k.toBase58() in after ? after[k.toBase58()] ?? undefined : outcome(k)))
        }
      })
  })
  const reply = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
  const node = createServer((req, res) => {
    let body = ""
    req.on("data", (x) => (body += x)).on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake")
      if (url.pathname === "/price/v3") return calls.push({ to: "price" }), reply(res, 200, { [ORE.mint]: { usdPrice: 70 } })
      if (url.pathname === "/swap/v1/quote") {
        const p = Object.fromEntries(url.searchParams)
        calls.push({ to: "quote", body: p })
        if (busy-- > 0) return reply(res, 429, { error: "Rate limit exceeded" })
        const spend = BigInt(p.amount!)
        const out = (spend * 70n * 997n) / 100_000_000n
        last = { spend, out }
        return reply(res, 200, {
          inputMint: p.inputMint, outputMint: p.outputMint, inAmount: String(spend), outAmount: String(out),
          otherAmountThreshold: String((out * (10_000n - BigInt(p.slippageBps!))) / 10_000n), swapMode: "ExactIn", slippageBps: Number(p.slippageBps),
          priceImpactPct: "0.001", routePlan: [{ swapInfo: { label: "FakeDex" } }]
        })
      }
      if (url.pathname === "/swap/v1/swap-instructions") return calls.push({ to: "swap-instructions", body: JSON.parse(body) }), reply(res, 200, o.instructions?.(c, w, honest()) ?? honest())
      reply(res, 404, {})
    })
  })
  const run = <A, E>(f: (s: Swap["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.acquireUseRelease(
      Effect.promise(() => new Promise<string>((ok) => node.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(node.address() as AddressInfo).port}`)))),
      (url) =>
        Swap.use(f).pipe(Effect.provide(Swap.layer.pipe(
          Layer.provide(Solana.layer.pipe(Layer.provide(Layer.succeed(Chain, chain)))),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ...w.env, JUPITER_API_KEY: "test", JUPITER_API_URL: url })))
        ))),
      () => Effect.promise(() => new Promise<void>((ok) => node.close(() => ok())))
    ))
  const build = (spend?: bigint) => run((s) => s.transaction({ token: ORE, wallet: c.wallet.publicKey.toBase58(), spend }))
  const refusal = (spend?: bigint, wallet = c.wallet.publicKey.toBase58()) =>
    run((s) => Effect.flip(s.transaction({ token: ORE, wallet, spend }))).then((e) => e.message)
  const jupiter = () => calls.filter((x) => ["quote", "swap-instructions"].includes(x.to)).length
  return { w, c, pool, calls, simulated, run, build, refusal, jupiter, swapIx, honest, to: (what: string) => calls.filter((x) => x.to === what) }
}

const decoded = (base64: string) => {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64, "base64"))
  const keys = tx.message.staticAccountKeys
  return {
    tx,
    signers: keys.slice(0, tx.message.header.numRequiredSignatures),
    ixs: tx.message.compiledInstructions.map((i) => ({ program: keys[i.programIdIndex]!, data: Buffer.from(i.data), accounts: i.accountKeyIndexes.map((k) => keys[k]!) }))
  }
}

test("a swap is one transaction the customer signs and our fee payer pays for: Jupiter's ExactIn swap into their USDC account, then deposit_for", async () => {
  const f = fake()
  const tx = await f.build()
  const { tx: v0, signers, ixs } = decoded(tx.transaction)
  assert.equal(v0.version, 0, "a v0 transaction, for Jupiter's lookup tables")
  assert.deepEqual(signers.map(String), [f.w.feePayer.publicKey, f.c.wallet.publicKey].map(String), "our fee payer pays; the customer signs")
  assert.deepEqual(f.to("quote").map((x) => (x.body as Record<string, string>).amount), ["10000000000"], "all the ORE they hold, by default")
  const asked = f.to("swap-instructions")[0]!.body as Record<string, unknown>
  assert.deepEqual([asked.userPublicKey, asked.payer, asked.feeAccount, asked.prioritizationFeeLamports], [f.c.wallet.publicKey.toBase58(), f.w.feePayer.publicKey.toBase58(), undefined, undefined])
  // Our budget, with room for the deposit; then Jupiter's setup and swap; then the deposit.
  const limit = ixs.find((i) => i.program.equals(ComputeBudgetProgram.programId) && i.data[0] === 2)!
  assert.equal(limit.data.readUInt32LE(1), 310_000)
  const price = ixs.find((i) => i.program.equals(ComputeBudgetProgram.programId) && i.data[0] === 3)!
  assert.equal(price.data.readBigUInt64LE(1), 10_000n, "our own priority price, not Jupiter's")
  const [setup, swap, deposit] = ixs.slice(-3)
  assert.ok(setup!.program.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && setup!.accounts[0]!.equals(f.w.feePayer.publicKey), "rent paid by the fee payer")
  assert.equal(swap!.program.toBase58(), JUPITER_PROGRAM)
  assert.ok(deposit!.program.equals(f.w.program.id))
  assert.deepEqual(deposit!.accounts.map(String), [f.w.program.config, f.c.customer, f.c.usdc, f.w.program.vault, f.w.program.vaultAuthority, TOKEN].map(String))
  // The simulation reads back the wallet, the fee payer, the token, the USDC and the Balance; not the pool's account.
  assert.deepEqual(f.simulated[0]!.watch.map(String), [f.c.wallet.publicKey, f.w.feePayer.publicKey, f.c.source, f.c.usdc, f.c.customer].map(String))
  assert.equal(f.simulated[0]!.bytes.toString(), Buffer.from(tx.transaction, "base64").toString(), "what was simulated is what's handed out")
  const out = (10_000_000_000n * 70n * 997n) / 100_000_000n
  assert.deepEqual([tx.spend, tx.usdcOut, tx.minUsdcOut], [10_000_000_000n, out, (out * 9_950n) / 10_000n])
  // A chosen amount: exactly that.
  assert.equal((await fake().build(7_300_000_000n)).spend, 7_300_000_000n)
})

test("the swap-paid tokens a wallet holds are listed for the app's tap, read from the chain alone", async () => {
  const f = fake()
  assert.deepEqual(await f.run((s) => s.held(f.c.wallet.publicKey.toBase58())), [{ token: ORE, amount: 10_000_000_000n }], "its ORE; no USDT account, so no USDT")
  const empty = fake({ ore: 0n })
  assert.deepEqual(await empty.run((s) => s.held(empty.c.wallet.publicKey.toBase58())), [])
  assert.deepEqual(await f.run((s) => s.held("not-a-key")), [])
  assert.equal(f.jupiter() + empty.jupiter(), 0, "Jupiter isn't asked")
})

test("refused before Jupiter is asked: no approval, none of the token or not enough, or not a wallet", async () => {
  const none = fake({ approve: false })
  assert.match(await none.refusal(), /Approve your Deposit Address first/)
  const empty = fake({ ore: 0n })
  assert.match(await empty.refusal(), /holds no ORE/)
  const short = fake()
  assert.match(await short.refusal(10_000_000_001n), /doesn't hold the 0.10000000001 ORE/)
  assert.match(await short.refusal(undefined, "not-a-key"), /isn't a Solana wallet/)
  for (const f of [none, empty, short]) assert.equal(f.jupiter(), 0)
})

test("an instruction from Jupiter we don't allow is refused before anything is simulated", async () => {
  const fees = fake({
    instructions: (c, w, honest) => ({
      ...honest,
      swapInstruction: asJson(new TransactionInstruction({
        programId: new PublicKey(JUPITER_PROGRAM),
        keys: [{ pubkey: c.wallet.publicKey, isSigner: true, isWritable: false }, { pubkey: w.feePayer.publicKey, isSigner: true, isWritable: true }],
        data: Buffer.from([7])
      }))
    })
  })
  assert.match(await fees.refusal(), /doesn't allow/, "the fee payer signing for the swap")
  const approve = fake({
    instructions: (c, _, honest) => ({ ...honest, otherInstructions: [asJson(createApproveInstruction(c.source, Keypair.generate().publicKey, c.wallet.publicKey, 1n))] })
  })
  assert.match(await approve.refusal(), /doesn't allow/)
  assert.equal(fees.simulated.length + approve.simulated.length, 0)
})

test("a simulation that does other than it says is refused: short of its minimum, more of the token, a delegate, our fee payer's SOL, the wallet's", async () => {
  const SPEND = 5_000_000_000n
  const cases: Array<[RegExp, Scripted["after"]]> = [
    [/at least its minimum/, (c, w) => ({ [c.customer.toBase58()]: raw(w, c.customer)! })],
    [/exactly the amount shown/, (c, w) => ({ [c.source.toBase58()]: withAmount(raw(w, c.source)!, 64, 10_000_000_000n - SPEND - 1n) })],
    [/someone else spend/, (c, w) => {
      const a = withAmount(raw(w, c.source)!, 64, 10_000_000_000n - SPEND)
      a.data.writeUInt32LE(1, 72)
      Keypair.generate().publicKey.toBuffer().copy(a.data, 76)
      return { [c.source.toBase58()]: a }
    }],
    [/more in fees and rent/, (_, w) => {
      const a = raw(w, w.feePayer.publicKey)!
      return { [w.feePayer.publicKey.toBase58()]: { ...a, lamports: a.lamports - MAX_FEE_PAYER_SPEND - 1n } }
    }],
    // A wallet that does hold some SOL keeps all of it.
    [/spend your wallet's SOL/, (c, w) => ({ [c.wallet.publicKey.toBase58()]: { ...raw(w, c.wallet.publicKey)!, lamports: 999_999n } })]
  ]
  for (const [why, after] of cases) {
    const f = fake({ simulations: [{ ...(after ? { after } : {}) }], sol: 1_000_000n })
    assert.match(await f.refusal(SPEND), why)
  }
  assert.equal((await fake({ sol: 1_000_000n }).build(SPEND)).spend, SPEND, "and an honest outcome passes")
})

test("a route whose quote went stale in the simulation is tried once more without its markets, and a busy Jupiter is asked again", async () => {
  const stale = { logs: ["Program log: Error: SlippageToleranceExceeded"] }
  const f = fake({ simulations: [stale] })
  await f.build()
  assert.deepEqual(f.to("quote").map((x) => (x.body as Record<string, string>).excludeDexes), [undefined, "FakeDex"])
  assert.equal(f.simulated.length, 2)
  assert.match(await fake({ simulations: [stale, stale] }).refusal(), /price moved/, "stale twice: the price moved")
  const busy = fake({ busy: 1 })
  await busy.build()
  assert.equal(busy.to("quote").length, 2)
})

// ---------- on the real program: the customer signs, our fee payer pays, the Balance takes the swap's USDC ----------
// LiteSVM has no Jupiter: a transfer the customer signs stands in for its swap, so what runs is ours: a v0 transaction
// prepared and co-signed, the fee payer funding a token account for the wallet, and deposit_for after the swap.

test("on the program: a prepared v0 swap transaction lands once its customer signs it; the fee payer pays fee and rent; the Balance takes the USDC", async () => {
  const w = solanaWorld()
  const c = approved(w, 0n)
  // Where the stand-in swap's USDC comes from, and a token the route passes through, whose account our fee payer opens.
  const paying = w.tokenAccount(c.wallet.publicKey, 5_000_000n)
  const hop = Keypair.generate().publicKey
  put(w, hop, TOKEN, mintData(w.owner.publicKey), 1_461_600n)
  const hopAccount = getAssociatedTokenAddressSync(hop, c.wallet.publicKey)
  const jupiter = {
    setup: [createAssociatedTokenAccountIdempotentInstruction(w.feePayer.publicKey, hopAccount, c.wallet.publicKey, hop)],
    swap: createTransferInstruction(paying, c.usdc, c.wallet.publicKey, 5_000_000n)
  }
  const feePayerBefore = raw(w, w.feePayer.publicKey)!.lamports
  const r = await Effect.runPromise(Effect.gen(function*() {
    const solana = yield* Solana
    const prepared = yield* solana.prepare(swapInstructions(solana.program, jupiter, c.wallet.publicKey, c.usdc), c.wallet.publicKey, {
      units: unitsFor([]),
      lookupTables: []
    })
    const unsigned = yield* Effect.flip(solana.cosign(prepared.transaction, prepared.token))
    // Its wallet signs it, as Privy does, and hands it back.
    const tx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, "base64"))
    tx.sign([c.wallet])
    const signed = Buffer.from(tx.serialize()).toString("base64")
    // A byte of its message changed after signing (in the fee payer's key): not the transaction prepared.
    const tampered = Buffer.from(tx.serialize())
    tampered.writeUInt8(tampered.readUInt8(140) ^ 1, 140)
    const changed = yield* Effect.flip(solana.cosign(tampered.toString("base64"), prepared.token))
    yield* solana.cosign(signed, prepared.token)
    return { unsigned: unsigned.message, changed: changed.message, customer: yield* solana.customer(c.wallet.publicKey) }
  }).pipe(Effect.provide(solanaLayer(w))))
  assert.match(r.unsigned, /isn't signed by its customer/)
  assert.match(r.changed, /isn't the one we prepared/)
  assert.equal(r.customer?.balance, 5_000_000n, "the swap's USDC is in the Balance")
  assert.equal(w.tokens(c.usdc), 0n)
  assert.equal(raw(w, c.wallet.publicKey), undefined, "the customer holds no SOL, and spent none")
  assert.equal(raw(w, hopAccount)?.data.subarray(32, 64).toString("hex"), c.wallet.publicKey.toBuffer().toString("hex"), "the account opened is the wallet's")
  const spent = feePayerBefore - raw(w, w.feePayer.publicKey)!.lamports
  const rent = raw(w, hopAccount)!.lamports
  assert.ok(spent >= rent + 10_000n && spent <= MAX_FEE_PAYER_SPEND, `the fee payer paid two signatures' fee and the rent (${rent}): ${spent}`)
})
