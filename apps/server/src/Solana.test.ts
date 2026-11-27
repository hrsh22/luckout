import { Effect } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { decodeReturn, lucky, normal, type Quote } from "./Program.ts"
import { type Signed, Solana } from "./Solana.ts"
import { solanaLayer, solanaWorld } from "./testing.ts"

const USDC = 1_000_000n

const run = <A, E>(world: ReturnType<typeof solanaWorld>, f: (s: Solana["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.gen(function*() {
    return yield* f(yield* Solana)
  }).pipe(Effect.provide(solanaLayer(world))))

const card = (price: bigint, mode = normal) => ({ reference_price: price, mode, max_debit: 2n ** 64n - 1n, lucky_amount: null })

test("a deposit lands in the customer's Balance, sent by the fee payer alone", async () => {
  const w = solanaWorld()
  const alice = w.shopper()
  w.give(alice.usdc, 25n * USDC)
  const { events, customer } = await run(w, (s) =>
    Effect.gen(function*() {
      const out = yield* s.send([
        s.program.instruction("deposit_for", {
          config: s.program.config,
          customer: s.program.customer(alice.wallet.publicKey),
          source: alice.usdc,
          vault: s.program.vault,
          vault_authority: s.program.vaultAuthority
        })
      ], [], () => Effect.void)
      return { events: out.events, customer: yield* s.customer(alice.wallet.publicKey) }
    }))
  assert.equal(customer?.balance, 25n * USDC)
  assert.deepEqual(events.map((e) => e.name), ["Deposited"])
  assert.equal(w.tokens(alice.usdc), 0n)
})

test("quotes come from simulating the program's quote_many", async () => {
  const w = solanaWorld()
  const quotes = await run(w, (s) =>
    s.simulate([
      s.program.instruction("quote_many", { config: s.program.config }, {
        items: [{ reference_price: 6n * USDC, mode: lucky(1), lucky_amount: null }, { reference_price: 6n * USDC, mode: normal, lucky_amount: null }]
      })
    ]).pipe(Effect.map((o) => decodeReturn<Array<Quote>>("quote_many", o.returnData!))))
  assert.deepEqual(quotes.map((q) => [q.lucky_amount, q.max_price]), [[6n * USDC, 7_200_000n], [0n, 6n * USDC]])
})

test("the operator admits and settles; the Pay Wallet is repaid and the Checkout closes", async () => {
  const w = solanaWorld()
  const alice = w.shopper()
  w.give(alice.usdc, 50n * USDC)
  const saved: Array<Signed> = []
  const keep = (s: Signed) => Effect.sync(() => void saved.push(s))
  const wallet = alice.wallet.publicKey
  const left = await run(w, (s) =>
    Effect.gen(function*() {
      const checkout = s.program.checkout(wallet, 0n)
      yield* s.send([s.program.instruction("deposit_for", { config: s.program.config, customer: s.program.customer(wallet), source: alice.usdc, vault: s.program.vault, vault_authority: s.program.vaultAuthority })], [], keep)
      yield* s.send([
        s.program.instruction("admit", { operator: s.operator, payer: s.feePayer, config: s.program.config, customer: s.program.customer(wallet), checkout }, { number: 0n, cards: [card(10n * USDC)] })
      ], ["operator"], keep)
      yield* s.send([
        s.program.instruction("settle", {
          operator: s.operator,
          payer: s.feePayer,
          config: s.program.config,
          customer: s.program.customer(wallet),
          checkout,
          vault: s.program.vault,
          vault_authority: s.program.vaultAuthority,
          pay_wallet: w.payWalletUsdc,
          checkout_payer: s.feePayer
        }, { delivered: Buffer.from([0]), failed: Buffer.alloc(0) })
      ], ["operator"], keep)
      return { customer: yield* s.customer(wallet), checkout: yield* s.checkout(checkout) }
    }))
  assert.equal(left.customer?.balance, 40n * USDC)
  assert.equal(left.checkout, undefined, "the Checkout closed")
  assert.equal(w.tokens(w.payWalletUsdc), 10n * USDC)
  assert.equal(saved.length, 3, "every transaction was saved before it was sent")
})

test("the program's refusal comes back with its own message", async () => {
  const w = solanaWorld()
  const alice = w.shopper()
  const wallet = alice.wallet.publicKey
  const err = await run(w, (s) =>
    s.send([
      s.program.instruction("admit", { operator: s.operator, payer: s.feePayer, config: s.program.config, customer: s.program.customer(wallet), checkout: s.program.checkout(wallet, 3n) }, { number: 3n, cards: [card(USDC)] })
    ], ["operator"], () => Effect.void).pipe(Effect.flip))
  assert.equal(err._tag, "ProgramRejected")
  assert.equal(err._tag === "ProgramRejected" && err.message, "Not the customer's next Checkout number")
})

test("a transaction saved before a crash is resumed, and one whose blockhash expired is reported so", async () => {
  const w = solanaWorld()
  const alice = w.shopper()
  w.give(alice.usdc, 5n * USDC)
  const deposit = (s: Solana["Service"]) =>
    s.program.instruction("deposit_for", { config: s.program.config, customer: s.program.customer(alice.wallet.publicKey), source: alice.usdc, vault: s.program.vault, vault_authority: s.program.vaultAuthority })
  // The process dies right after saving: the transaction was never sent.
  const crash = async () => {
    let kept: Signed | undefined
    await run(w, (s) => s.send([deposit(s)], [], (signed) => Effect.sync(() => void (kept = signed)).pipe(Effect.andThen(Effect.fail("crash" as const)))).pipe(Effect.flip))
    return kept!
  }
  const first = await crash()
  const resumed = await run(w, (s) => s.resume(first))
  assert.equal(resumed.signature, first.signature)
  assert.equal(w.tokens(alice.usdc), 0n)

  w.give(alice.usdc, 5n * USDC)
  w.expire() // a new blockhash, or the second would be the very same transaction
  const second = await crash()
  w.expire()
  const err = await run(w, (s) => s.resume(second).pipe(Effect.flip))
  assert.equal(err._tag, "TxExpired")
  assert.equal(w.tokens(alice.usdc), 5n * USDC, "the expired one never ran")
})
