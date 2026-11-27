import { getAssociatedTokenAddressSync } from "@solana/spl-token"
import { Keypair, type PublicKey, Transaction } from "@solana/web3.js"
import { Effect, Layer, ManagedRuntime } from "effect"
import { SqlClient } from "effect/sql"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Alerts } from "./Alerts.ts"
import { DbMemory } from "./Db.ts"
import { Deposits } from "./Deposits.ts"
import { Solana } from "./Solana.ts"
import { solanaLayer, solanaWorld } from "./testing.ts"

const USDC = 1_000_000n

const setup = () => {
  const world = solanaWorld()
  const told: Array<[string, string]> = []
  const alerts = Layer.succeed(Alerts, Alerts.of({ admin: () => Effect.void, customer: (a, t) => Effect.sync(() => (told.push([a, t]), true)) }))
  // One database and one Deposits for the whole test, as in the server.
  const runtime = ManagedRuntime.make(Deposits.layer.pipe(Layer.provideMerge(Layer.mergeAll(solanaLayer(world), DbMemory, alerts))))
  const run = <A, E>(f: Effect.Effect<A, E, Deposits | Solana | SqlClient.SqlClient>) => runtime.runPromise(f)
  return { world, told, run, done: () => runtime.dispose() }
}

/** What the customer's wallet does with a prepared transaction: signs it, and hands it back. */
const signAs = (wallet: Keypair, transaction: string) => {
  const tx = Transaction.from(Buffer.from(transaction, "base64"))
  tx.partialSign(wallet)
  return tx.serialize({ requireAllSignatures: false }).toString("base64")
}

/** A new customer who signed in once (so the sweep knows them) and made the one-time approval. */
const approved = (run: ReturnType<typeof setup>["run"]) =>
  run(Effect.gen(function*() {
    const wallet = Keypair.generate()
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO known_accounts (account_id) VALUES (${wallet.publicKey.toBase58()})`
    const deposits = yield* Deposits
    const solana = yield* Solana
    const { transaction, token } = yield* deposits.approval(wallet.publicKey.toBase58(), { lucky: 1 })
    yield* solana.cosign(signAs(wallet, transaction), token)
    return wallet
  }))

const usdcOf = (world: ReturnType<typeof solanaWorld>, wallet: PublicKey) => getAssociatedTokenAddressSync(world.mint, wallet)

test("the one-time approval opens the customer's account and makes the Vault's authority their delegate; we pay for it", async () => {
  const { world, run, done } = setup()
  const wallet = await approved(run)
  const { customer, status } = await run(Effect.gen(function*() {
    return { customer: yield* (yield* Solana).customer(wallet.publicKey), status: yield* (yield* Deposits).status(wallet.publicKey.toBase58()) }
  }))
  assert.deepEqual(customer?.default_mode, { kind: "Lucky", fields: [1] }, "opened on the Default Mode they chose")
  assert.deepEqual(status, { address: wallet.publicKey.toBase58(), approved: true, waiting: 0 })
  assert.equal(world.svm.getBalance(wallet.publicKey.toBase58() as never) ?? 0n, 0n, "the customer spent no SOL")
  await done()
})

test("the sweep moves what arrived into the Balance, from 1 USDC; less waits for more", async () => {
  const { world, told, run, done } = setup()
  const wallet = await approved(run)
  const usdc = usdcOf(world, wallet.publicKey)
  world.give(usdc, 999_999n)
  await run(Effect.flatMap(Deposits, (d) => d.sweep))
  assert.equal(world.tokens(usdc), 999_999n, "less than 1 USDC waits")
  world.give(usdc, 5n * USDC)
  await run(Effect.flatMap(Deposits, (d) => d.sweep))
  const customer = await run(Effect.flatMap(Solana, (s) => s.customer(wallet.publicKey)))
  assert.equal(customer?.balance, 5n * USDC + 999_999n)
  assert.equal(world.tokens(usdc), 0n)
  assert.match(told.at(-1)![1], /\$6\.00 arrived/)
  await done()
})

test("the fee payer signs only a transaction we prepared, unchanged, and signed by its customer", async () => {
  const { world, run, done } = setup()
  const wallet = Keypair.generate()
  const errors = await run(Effect.gen(function*() {
    const deposits = yield* Deposits
    const solana = yield* Solana
    const a = yield* deposits.approval(wallet.publicKey.toBase58(), "normal")
    const b = yield* deposits.approval(Keypair.generate().publicKey.toBase58(), "normal")
    const flip = (e: Effect.Effect<unknown, { readonly message: string }>) => Effect.map(Effect.flip(e), (x) => x.message)
    return [
      yield* flip(solana.cosign(a.transaction, a.token)),
      yield* flip(solana.cosign(signAs(wallet, a.transaction), b.token)),
      yield* flip(solana.cosign("junk", a.token))
    ]
  }))
  assert.match(errors[0]!, /isn't signed by its customer/)
  assert.match(errors[1]!, /isn't the one we prepared/)
  assert.match(errors[2]!, /isn't a transaction/)
  assert.equal(world.svm.getAccount(usdcOf(world, wallet.publicKey).toBase58() as never).exists, false, "nothing was sent")
  await done()
})

test("an approval another app replaced is noticed once: what arrives waits, and the customer is told", async () => {
  const { world, told, run, done } = setup()
  const wallet = await approved(run)
  const usdc = usdcOf(world, wallet.publicKey)
  // Another app's approval: the delegate is someone else now.
  const a = world.svm.getAccount(usdc.toBase58() as never)
  if (!a.exists) throw new Error("no USDC account")
  const data = Buffer.from(a.data)
  Keypair.generate().publicKey.toBuffer().copy(data, 76)
  world.svm.setAccount({ ...a, data })
  world.give(usdc, 2n * USDC)
  await run(Effect.flatMap(Deposits, (d) => d.sweep))
  await run(Effect.flatMap(Deposits, (d) => d.sweep))
  assert.equal(world.tokens(usdc), 2n * USDC, "nothing moved")
  assert.equal(told.filter(([, t]) => /approval for Luckout was replaced/.test(t)).length, 1, "told once")
  const status = await run(Effect.flatMap(Deposits, (d) => d.status(wallet.publicKey.toBase58())))
  assert.equal(status.approved, false)
  await done()
})

test("a withdrawal goes to any Solana address, its USDC account opened for it; Spending Limits change only as the customer signs", async () => {
  const { world, run, done } = setup()
  const wallet = await approved(run)
  world.give(usdcOf(world, wallet.publicKey), 5n * USDC)
  await run(Effect.flatMap(Deposits, (d) => d.sweep))
  const friend = Keypair.generate().publicKey
  const customer = await run(Effect.gen(function*() {
    const deposits = yield* Deposits
    const solana = yield* Solana
    const w = yield* deposits.withdrawal(wallet.publicKey.toBase58(), 2_000_000, friend.toBase58())
    yield* solana.cosign(signAs(wallet, w.transaction), w.token)
    const l = yield* deposits.limits(wallet.publicKey.toBase58(), 50_000_000n, 2n ** 64n - 1n)
    yield* solana.cosign(signAs(wallet, l.transaction), l.token)
    return yield* solana.customer(wallet.publicKey)
  }))
  assert.equal(world.tokens(usdcOf(world, friend)), 2n * USDC)
  assert.equal(customer?.balance, 3n * USDC)
  assert.equal(customer?.per_purchase_limit, 50_000_000n)
  await done()
})
