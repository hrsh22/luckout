import { BitrefillUnavailable, type Mode, NewPurchase, ShopStatus, Voucher } from "@luckout/api"
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token"
import { Keypair, PublicKey, Transaction, type TransactionInstruction, VersionedTransaction } from "@solana/web3.js"
import { ConfigProvider, Effect, Exit, Fiber, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { Alerts } from "./Alerts.ts"
import { Bitrefill, type CardDelivery, matchOrders, type Order } from "./Bitrefill.ts"
import { Connect } from "./Connect.ts"
import { DbMemory } from "./Db.ts"
import {
  base58,
  type Card as ChainCard,
  type Checkout,
  type Config as ProgramConfig,
  type Customer,
  decodeAccount,
  decodeEvents,
  type DrawEvent,
  idl,
  oraoRequest,
  type ProgramEvent,
  TOKEN_PROGRAM
} from "./Program.ts"
import { GAVE_UP_AT, guestLimitRefusal, Purchases, retryPurchase } from "./Purchases.ts"
import { Sales } from "./Sales.ts"
import { Chain, type Outcome, type Refused, type Signed, type SignerName, Solana, SolanaUnavailable } from "./Solana.ts"
import { fakeBitrefill, fakeBitrefillOAuth, solanaLayer, solanaWorld, type SolanaWorld } from "./testing.ts"

// The purchase workflow end to end on an in-memory database and the real program on LiteSVM (ORAO's VRF program too),
// with Bitrefill faked.
process.env.REDEMPTION_KEY = "11".repeat(32)

const USDC = 1_000_000
/** What ORAO's oracles fill a request with. */
const RANDOMNESS = Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256)
/** Each Game Version's Risk Premium: with the world's reserve, a Lucky Buy plays its card's whole price at it, rounded up. */
const PREMIUM_BPS = [1_000, 2_000, 5_000]

/** "down": the RPC doesn't answer, so nothing is signed. "crash": the server dies after saving the signed transaction, before sending it (once). */
type Fault = "down" | "crash"

const setOperator = (sw: SolanaWorld, operator: PublicKey) =>
  void sw.send([sw.program.instruction("set_operator", { owner: sw.owner.publicKey, config: sw.program.config }, { operator })], [sw.owner])

const world = (opts: {
  /** The customer's Balance, micro-USDC ($500 unless set); null: they never made the one-time approval. */
  balance?: number | null
  /** Their Spending Limits, if not the program's defaults. */
  limits?: { perPurchase: number; daily: number }
  /** The mode the customer buys in. */
  mode?: Mode
  /** A real card (mainnet) instead of a free test card. */
  real?: boolean
  price?: number
  /** The Pay Wallet's USDC ($1000 unless set). */
  float?: number
  orders?: Array<Order["_tag"]>
  /** Guest checkout (ADR-0012): orders are invoices the Pay Wallet pays, each to a fresh wallet. */
  guest?: boolean
  /** What a guest invoice costs; the cards' prices unless set. */
  invoiceAmount?: number
  /** Bitrefill's OAuth endpoints, for customers who connect their own Bitrefill account. */
  oauth?: ReturnType<typeof fakeBitrefillOAuth>
  /** Why an order tagged "Refused" is refused; a lapsed login (401) unless set. */
  refusal?: string
  /** Bitrefill takes this long (ms) to deliver. */
  deliveryDelay?: number
  /** How long a buy request waits (ms) before answering "pending". */
  requestWait?: number
  /** Bitrefill has no such card: every price lookup fails. */
  noCard?: boolean
  /** Bitrefill's lookups are used up for this minute: every price lookup is turned away. */
  pricesBusy?: boolean
  /** For each delivery poll, the order in which Bitrefill lists the invoice's orders (cart order unless set). */
  listed?: Array<ReadonlyArray<number>>
  /**
   * Where each order of the invoice is at each delivery poll, one list per poll, in cart order; delivered unless set.
   * "NoCode": delivered with Redemption Data that holds neither a code nor a link.
   */
  deliveries?: Array<Array<"Delivered" | "Failed" | "Pending" | "NoCode">>
  /** Bitrefill can't be reached (or is rate limiting us) for this call: its outcome is unknown. */
  bitrefillDown?: "order" | "delivery"
  /** Telegram doesn't take this many customer notices first (it's worth sending them again). */
  telegramDown?: number
  /** Runs as Bitrefill takes its `n`th order: the chain changes under a checkout on its way. */
  onOrder?: (sw: SolanaWorld, n: number) => void
  /** ORAO fills each request as soon as it's made; false leaves it to the test. */
  autoFill?: boolean
  /** The chain's clock, in seconds after the real time (where it starts). */
  clock?: number
} = {}) => {
  const sw = solanaWorld()
  const p = sw.program
  // The server compares the chain's times with its own clock; LiteSVM's starts at 1970.
  const clock = sw.svm.getClock()
  clock.unixTimestamp = BigInt(Math.floor(Date.now() / 1000) + (opts.clock ?? 0))
  sw.svm.setClock(clock)

  const account = (key: PublicKey) => {
    const a = Effect.runSync(sw.chain.accounts([key]))[0]
    return a && a.owner.equals(p.id) && a.data.length > 0 ? a.data : undefined
  }
  /** A customer who made the one-time approval, with `balance` in their Balance. Their account id is their wallet's address. */
  const shopper = (balance: number | null) => {
    if (balance === null) {
      const wallet = Keypair.generate()
      return { wallet, usdc: sw.tokenAccount(wallet.publicKey, 0n), id: wallet.publicKey.toBase58() }
    }
    const s = sw.shopper()
    if (balance > 0) {
      sw.give(s.usdc, BigInt(balance))
      sw.send([
        p.instruction("deposit_for", { config: p.config, customer: p.customer(s.wallet.publicKey), source: s.usdc, vault: p.vault, vault_authority: p.vaultAuthority })
      ], [])
    }
    return { ...s, id: s.wallet.publicKey.toBase58() }
  }
  type Shopper = ReturnType<typeof shopper>
  const limit = (who: Shopper, perPurchase: number, daily: number) =>
    void sw.send([
      p.instruction("set_limits", { wallet: who.wallet.publicKey, config: p.config, customer: p.customer(who.wallet.publicKey) }, {
        per_purchase: BigInt(perPurchase),
        daily: BigInt(daily)
      })
    ], [who.wallet])
  const alice = shopper(opts.balance === undefined ? 500 * USDC : opts.balance)
  const bob = shopper(500 * USDC)
  if (opts.limits) limit(alice, opts.limits.perPurchase, opts.limits.daily)
  sw.give(sw.payWalletUsdc, BigInt(opts.float ?? 1_000 * USDC))
  const owner = (name: string, args: Record<string, unknown>, accounts: Record<string, PublicKey> = {}) =>
    void sw.send([p.instruction(name, { owner: sw.owner.publicKey, config: p.config, ...accounts }, args)], [sw.owner])
  const config = () => decodeAccount<ProgramConfig>("Config", account(p.config)!)

  /** Every transaction sent to the chain, by its instruction, once however often it's sent: "pay" is a Pay Wallet payment. */
  const calls: Array<string> = []
  const nameOf = (program: PublicKey, data: Uint8Array) =>
    program.equals(p.id)
      ? idl.instructions.find((i) => i.discriminator.every((b, j) => data[j] === b))?.name
      : program.equals(TOKEN_PROGRAM)
      ? "pay"
      : undefined
  const sent = new Set<string>()
  // A refused transaction is refused again, as an RPC's preflight would (LiteSVM would call it already processed).
  const refused = new Map<string, Refused>()
  const chain = Chain.of({
    ...sw.chain,
    submit: (bytes) =>
      Effect.suspend(() => {
        const signature = base58.encode(bytes.subarray(1, 65))
        const before = refused.get(signature)
        if (before) return Effect.fail(before)
        if (!sent.has(signature)) {
          sent.add(signature)
          const m = VersionedTransaction.deserialize(bytes).message
          for (const ix of m.compiledInstructions) {
            const name = nameOf(m.staticAccountKeys[ix.programIdIndex]!, ix.data)
            if (name) calls.push(name)
          }
        }
        return sw.chain.submit(bytes).pipe(Effect.catchTag("Refused", (e) => {
          refused.set(signature, e)
          return Effect.fail(e)
        }))
      })
  })

  /** Faults by instruction ("admit", "settle", "pay"...). */
  const faults = new Map<string, Fault>()
  /** How long signing each kind of transaction takes (ms): a slow RPC or wallet. */
  const delays = new Map<string, number>()
  /** The program's events in every transaction the server sent and saw land. */
  const events: Array<ProgramEvent> = []
  const autoFill = opts.autoFill ?? true
  const observe = (out: Outcome) => {
    for (const e of out.events) {
      events.push(e)
      if (e.name === "DrawRequested" && autoFill) sw.fill(e.data.checkout as PublicKey, Number(e.data.round), RANDOMNESS)
    }
    return out
  }
  const solana = Layer.effect(
    Solana,
    Effect.gen(function*() {
      const real = yield* Solana
      return Solana.of({
        ...real,
        send: <E>(ixs: ReadonlyArray<TransactionInstruction>, signers: ReadonlyArray<SignerName>, persist: (s: Signed) => Effect.Effect<void, E>) =>
          Effect.gen(function*() {
            const name = ixs.map((ix) => nameOf(ix.programId, ix.data)).find(Boolean) ?? "?"
            yield* Effect.sleep(delays.get(name) ?? 0)
            const fault = faults.get(name)
            if (fault === "down") return yield* new SolanaUnavailable({ message: `${name}: fetch failed` })
            if (fault === "crash") faults.delete(name)
            // Saved, it's sent at once, so its first look finds it landed: LiteSVM needs no half-second wait.
            const keep: (s: Signed) => Effect.Effect<void, E | SolanaUnavailable> = fault === "crash"
              ? (s) => Effect.andThen(persist(s), Effect.fail(new SolanaUnavailable({ message: "the server died before sending it" })))
              : (s) => Effect.andThen(persist(s), Effect.ignore(chain.submit(Buffer.from(s.bytes, "base64"))))
            return observe(yield* real.send(ixs, signers, keep))
          }),
        resume: (signed) => Effect.map(real.resume(signed), observe)
      })
    })
  ).pipe(Layer.provide(solanaLayer({ ...sw, chain, env: { ...sw.env, SOLANA_CLUSTER: opts.real ? "mainnet" : "localnet" } })))

  const alerts: Array<string> = []
  /** Telegram notices to customers. */
  const notices: Array<string> = []
  const orders = [...(opts.orders ?? [])]
  /** Price lookups made at Bitrefill. */
  let lookups = 0
  /** How many cards each Bitrefill order held. */
  const ordered: Array<number> = []
  /** Each guest invoice's paying address: a fresh wallet. */
  const payees: Array<PublicKey> = []
  const deliveries = [...(opts.deliveries ?? [])]
  const listed = [...(opts.listed ?? [])]
  /** How many cards each invoice holds, as ordered. */
  const invoiceCards = new Map<string, number>()
  let bitrefillDown = opts.bitrefillDown
  let telegramDown = opts.telegramDown ?? 0
  let shop = new ShopStatus({ open: true })
  const price = opts.price ?? 10 * USDC
  const mode = opts.mode ?? "normal"
  const voucherId = opts.real ? "amazon-us" : "test-card"
  const bitrefill = fakeBitrefill({
    guest: opts.guest ?? false,
    voucher: () =>
      Effect.suspend(() => {
        lookups++
        if (opts.pricesBusy) return Effect.fail(new BitrefillUnavailable({ message: "Prices are busy right now; try again in a minute" }))
        return opts.noCard
          ? Effect.fail(new BitrefillUnavailable({ message: "No such voucher" }))
          : Effect.succeed(new Voucher({ id: voucherId, name: "Card", countryCode: "US", currency: "USD", packages: [{ value: "10", priceMicroUsdc: price }] }))
      }),
    order: (cart, buyer) =>
      Effect.suspend(() => (bitrefillDown === "order" ? Effect.fail(new BitrefillUnavailable({ message: "Bitrefill is rate limiting us" })) : Effect.void)).pipe(
        Effect.andThen(Effect.sync((): Order => {
          calls.push(!opts.guest ? "order" : buyer && "token" in buyer ? `order:token:${buyer.token}` : `order:${buyer?.email}`)
          ordered.push(cart.length)
          opts.onOrder?.(sw, ordered.length)
          const tag = orders.shift() ?? (opts.guest ? "Invoiced" : "Ordered")
          // A token Bitrefill no longer takes: the tool never ran.
          if (tag === "Refused") return { _tag: "Refused", reason: opts.refusal ?? "HTTP 401 invalid_token" }
          const invoiceId = `inv-${calls.length}`
          invoiceCards.set(invoiceId, cart.length)
          if (tag === "Invoiced") {
            const payTo = Keypair.generate().publicKey
            payees.push(payTo)
            return { _tag: "Invoiced", invoiceId, accessToken: "secret-token", payTo: payTo.toBase58(), amount: opts.invoiceAmount ?? price * cart.length }
          }
          if (tag === "NoCredit") return { _tag: "NoCredit", reason: "Balance too low (INVALID_INPUT)" }
          return { _tag: "Ordered", invoiceId }
        }))
      ),
    // The invoice's orders as Bitrefill lists them, in cart order, each matched to the cards asked about the way
    // Bitrefill.ts matches them: by product and amount, not by place in the list asked about.
    delivery: (invoiceId, token, cart) =>
      bitrefillDown === "delivery"
        ? Effect.fail(new BitrefillUnavailable({ message: `invoice ${invoiceId} is still pending` }))
        : Effect.suspend(() => {
          if (token) calls.push(`delivery:${token}`)
          const poll = deliveries.shift() ?? []
          const order = listed.shift()
          const inCartOrder = Array.from({ length: invoiceCards.get(invoiceId) ?? cart.length }, (_, j) => {
            const state = poll[j] ?? "Delivered"
            const redemption_info: Record<string, unknown> | undefined = state === "Delivered"
              ? { code: `ABC-12${j + 3}`, expirationTime: "2027-03-30T00:00:00.000Z" }
              : state === "NoCode"
              ? { other: "Show this at the till: S3CRET-TEXT" }
              : undefined
            return { order_id: `o-${j}`, status: state, product: { id: voucherId, value: "10" }, redemption_info }
          })
          const invoice = order ? order.map((j) => inCartOrder[j]!) : inCartOrder
          const found = matchOrders(cart, invoice).map((o): CardDelivery =>
            o?.redemption_info
              ? { _tag: "Delivered", orderId: o.order_id, redemption: o.redemption_info }
              : o?.status === "Failed"
              ? { _tag: "Failed", reason: `order ${o.order_id} failed` }
              : { _tag: "Pending" }
          )
          return found.every((d) => d._tag === "Pending")
            ? Effect.fail(new BitrefillUnavailable({ message: `invoice ${invoiceId} is still pending` }))
            : Effect.succeed(found)
        }).pipe(Effect.delay(opts.deliveryDelay ?? 0))
  })
  const layer = Purchases.layer.pipe(
    Layer.provideMerge(Connect.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, (opts.oauth ?? fakeBitrefillOAuth()).fetch)))),
    Layer.provide(Layer.mergeAll(
      solana,
      Layer.succeed(Bitrefill, bitrefill),
      Layer.succeed(Sales, Sales.of({ status: Effect.sync(() => shop), setOpen: () => Effect.die("not used") })),
      Layer.succeed(Alerts, Alerts.of({ admin: (t) => Effect.sync(() => void alerts.push(t)), customer: (_, t) => Effect.sync(() => (notices.push(t), telegramDown-- <= 0)) }))
    )),
    Layer.provideMerge(DbMemory),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({
      env: {
        ...(process.env as Record<string, string>),
        BITREFILL_REDIRECT_URI: "https://api.luckout.test/bitrefill/callback",
        ...(opts.requestWait ? { PURCHASE_REQUEST_WAIT_MS: String(opts.requestWait) } : {})
      }
    })))
  )
  /** What the customer confirms: the price, or a Lucky Buy on all of it. */
  const maxPrice = (m: Mode) => (m === "normal" ? price : price + Math.ceil(price * PREMIUM_BPS[m.lucky]! / 10_000))
  const buy = (key: string = crypto.randomUUID(), who = alice.id) =>
    Purchases.use((s) => s.create(who, new NewPurchase({ voucherId, value: "10", mode, maxPrice: maxPrice(mode), idempotencyKey: key })))
  /** A Cart of `keys.length` of the card, all in one request. */
  const cart = (keys: ReadonlyArray<string>, who = alice.id) =>
    Purchases.use((s) => s.createCart(who, keys.map((k) => new NewPurchase({ voucherId, value: "10", mode, maxPrice: maxPrice(mode), idempotencyKey: k }))))
  const run = <A, E>(e: Effect.Effect<A, E, Purchases | Connect | SqlClient.SqlClient>) => Effect.runPromise(Effect.scoped(e).pipe(Effect.provide(layer)))
  return {
    sw,
    alice,
    bob,
    calls,
    alerts,
    notices,
    ordered,
    payees,
    faults,
    delays,
    buy,
    cart,
    run,
    limit,
    owner,
    config,
    lookups: () => lookups,
    setShop: (s: ShopStatus) => void (shop = s),
    setBitrefillDown: (d: typeof bitrefillDown) => void (bitrefillDown = d),
    withdrawReserve: (amount: bigint) =>
      owner("withdraw_reserve", { amount }, { vault: p.vault, vault_authority: p.vaultAuthority, to: sw.tokenAccount(sw.owner.publicKey, 0n) }),
    customer: (who: Shopper = alice) => decodeAccount<Customer>("Customer", account(p.customer(who.wallet.publicKey))!),
    /** A Checkout account; undefined once it closed. */
    checkout: (address: string | PublicKey) => {
      const d = account(new PublicKey(address))
      return d ? decodeAccount<Checkout>("Checkout", d) : undefined
    },
    /** The USDC a wallet holds where the Pay Wallet pays it (its associated token account). */
    usdcOf: (wallet: PublicKey) => sw.tokens(getAssociatedTokenAddressSync(sw.mint, wallet, true)),
    float: () => sw.tokens(sw.payWalletUsdc),
    admitted: () => events.filter((e) => e.name === "Admitted").flatMap((e) => e.data.cards as Array<ChainCard>),
    settles: () =>
      events.filter((e) => e.name === "Settled").map((e) => ({ delivered: [...(e.data.delivered as Buffer)], failed: [...(e.data.failed as Buffer)] })),
    draws: () => events.filter((e) => e.name === "Draw").map((e) => e.data as unknown as DrawEvent)
  }
}
type World = ReturnType<typeof world>
const balanceOf = (w: World, who = w.alice) => Number(w.customer(who).balance)
const keys = (n: number) => Array.from({ length: n }, () => crypto.randomUUID())
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex")

/** A purchase's row as saved. */
const rowOf = (id: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ step: string; attempts: number; due: boolean; quoted_lucky_amount: string | null }>`
      SELECT p.step, c.attempts, c.next_attempt_at <= now() AS due, p.quoted_lucky_amount::text
      FROM purchases p JOIN checkouts c ON c.id = p.checkout_id WHERE p.id = ${id}`).pipe(Effect.map((r) => r[0]!))
/** Its checkout's row. */
const checkoutOf = (id: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ step: string; error: string | null; number: string | null; address: string | null; admit_tx: Signed | null; pay_to: string | null; pay_tx: Signed | null }>`
      SELECT c.step, c.error, c.number::text, c.address, c.admit_tx, c.pay_to, c.pay_tx
      FROM checkouts c JOIN purchases p ON p.checkout_id = c.id WHERE p.id = ${id}`).pipe(Effect.map((r) => r[0]!))

/** Steps a card rests at: nothing more happens to it without the reconciler, money, or a human. */
const RESTING = ["settled", "failed", "rejected", "stuck", "waiting", "restock"]
/** Lets the workflow's own fiber run until the purchase rests, or holds a step for a second (a stalled call). */
const settled = (id: string) =>
  Effect.gen(function*() {
    let last = ""
    let since = Date.now()
    for (let i = 0; i < 600; i++) {
      const { step } = yield* rowOf(id)
      if (RESTING.includes(step)) return step
      if (step !== last) [last, since] = [step, Date.now()]
      else if (Date.now() - since > 1_000) return step
      yield* Effect.sleep("25 millis")
    }
    return last
  })
/** Waits (up to 15 seconds) for `ready`. */
const until = <E, R>(ready: Effect.Effect<boolean, E, R>, what: string) =>
  Effect.gen(function*() {
    for (let i = 0; i < 600; i++) {
      if (yield* ready) return
      yield* Effect.sleep("25 millis")
    }
    return yield* Effect.die(`never: ${what}`)
  })
const stepIs = (want: string) =>
  until(Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.map(sql<{ step: string }>`SELECT step FROM purchases`, (r) => r[0]?.step === want)), want)
/** Makes every open checkout due, as 30 seconds of waiting would, then runs one reconciler pass. */
const reconcilePass = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE checkouts SET updated_at = now() - interval '1 minute', next_attempt_at = now()`
  yield* Purchases.use((s) => s.reconcileNow)
})
const promote = Purchases.use((s) => s.promoteWaiting)
const get = (who: string, id: string) => Purchases.use((s) => s.get(who, id))
// Guest checkout (ADR-0012): each real card is a guest invoice carrying the customer's Checkout Email, paid exactly
// once from the Pay Wallet.
const withEmail = (email: string, who: string) => Purchases.use((s) => s.setCheckoutEmail(who, email))
/** Adds `n` cards already bought for an email today, so it's that much nearer Bitrefill's limits. */
const boughtFor = (who: string, n: number, at = { created: "now()", ordered: "NULL" }) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const [{ email_key }] = (yield* sql<{ email_key: string }>`SELECT email_key FROM checkout_emails WHERE account_id = ${who}`) as [{ email_key: string }]
    for (let i = 0; i < n; i++) {
      yield* sql`WITH co AS (INSERT INTO checkouts (account_id, step) VALUES ('test', 'done') RETURNING id)
                 INSERT INTO purchases (checkout_id, account_id, idempotency_key, voucher_id, voucher_name, package_value, reference_price, step, email_key, invoice_id, created_at, ordered_at)
                 VALUES ((SELECT id FROM co), ${who}, ${`k${i}`}, 'amazon-us', 'Card', '1', 1000000, 'settled', ${email_key}, ${`inv${i}`},
                         ${sql.literal(at.created)}, ${sql.literal(at.ordered)})`
    }
  })

/** A Pay Wallet payment some other run signed, as Purchases signs one. */
const otherPayment = (w: World, to: PublicKey, amount: bigint): Signed => {
  const { sw } = w
  const ata = getAssociatedTokenAddressSync(sw.mint, to, true)
  const { blockhash, lastValidBlockHeight } = Effect.runSync(sw.chain.blockhash)
  const tx = new Transaction({ feePayer: sw.feePayer.publicKey, blockhash, lastValidBlockHeight }).add(
    createAssociatedTokenAccountIdempotentInstruction(sw.feePayer.publicKey, ata, to, sw.mint),
    createTransferCheckedInstruction(sw.payWalletUsdc, sw.mint, ata, sw.payWallet.publicKey, amount, 6)
  )
  tx.sign(sw.feePayer, sw.payWallet)
  return { signature: base58.encode(tx.signature!), bytes: tx.serialize().toString("base64"), lastValidBlockHeight }
}

test("a purchase walks every step and shows the code only once delivered", async () => {
  const w = world()
  const p = await w.run(w.buy())
  assert.equal(p.status, "delivered")
  assert.equal(p.redemption?.code, "ABC-123")
  assert.equal(p.currency, "USD", "the card's own currency, for showing its value")
  assert.deepEqual(w.calls, ["admit", "order", "settle"])
})

test("a delivered card's use-by date is kept outside its sealed code, so the card's page can show it before buying", async () => {
  const w = world()
  const r = await w.run(Effect.gen(function*() {
    yield* w.buy()
    const purchases = yield* Purchases
    const fresh = yield* purchases.useBy("test-card")
    const other = yield* purchases.useBy("amazon-us")
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE purchases SET created_at = now() - interval '61 days'`
    return { fresh, other, stale: yield* purchases.useBy("test-card") }
  }))
  assert.deepEqual(r, { fresh: "2027-03-30T00:00:00.000Z", other: undefined, stale: undefined }, "only this card's, and only from the last 60 days")
})

test("the same idempotency key never buys twice", async () => {
  const w = world()
  const [a, b] = await w.run(Effect.all([w.buy("same-key-1"), w.buy("same-key-1")]))
  assert.equal(a.id, b.id)
  assert.deepEqual(w.calls, ["admit", "order", "settle"])
})

test("an account with no Balance is refused before anything is signed", async () => {
  const never = world({ balance: null })
  const e = await never.run(never.buy().pipe(Effect.flip))
  assert.match(e.message, /No balance yet/)
  const empty = world({ balance: 0 })
  const f = await empty.run(empty.buy().pipe(Effect.flip))
  assert.match(f.message, /Insufficient balance/)
  for (const x of [never, empty]) assert.deepEqual(x.calls, [])
})

test("over the per-purchase limit is refused before anything is signed", async () => {
  const w = world({ limits: { perPurchase: 5 * USDC, daily: 1_000 * USDC } })
  const e = await w.run(w.buy().pipe(Effect.flip))
  assert.match(e.message, /per-purchase spending limit/)
  assert.deepEqual(w.calls, [])
})

// ---------- the program (ADR-0015) ----------

test("a guest card is debited onchain, paid once from the Pay Wallet and delivered; settle repays the Pay Wallet and closes the Checkout", async () => {
  const w = world({ real: true, guest: true })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("  Alice@Example.com ", w.alice.id)
    const p = yield* w.buy()
    const sql = yield* SqlClient.SqlClient
    const [stored] = yield* sql<{ email: string }>`SELECT email FROM checkout_emails WHERE account_id = ${w.alice.id}`
    const seen = yield* Purchases.use((s) => s.checkoutEmail(w.alice.id))
    return { p, co: yield* checkoutOf(p.id), stored: stored!.email, seen }
  }))
  assert.equal(r.p.status, "delivered")
  assert.equal(r.p.redemption?.code, "ABC-123")
  assert.deepEqual(w.calls, ["admit", "order:alice@example.com", "pay", "delivery:secret-token", "settle"])
  // Admitted under the customer's first Checkout number, debited from their Balance.
  const customer = w.customer()
  assert.equal(customer.balance, 490_000_000n)
  assert.equal(customer.checkouts, 1n)
  assert.equal(r.co.number, "0")
  assert.equal(r.co.address, w.sw.program.checkout(w.alice.wallet.publicKey, 0n).toBase58())
  assert.equal(r.p.admitTx, r.co.admit_tx?.signature)
  // The Pay Wallet paid the invoice's own wallet, once, and settle paid it back.
  assert.equal(w.payees.length, 1)
  assert.equal(r.co.pay_to, w.payees[0]!.toBase58())
  assert.equal(w.usdcOf(w.payees[0]!), 10_000_000n)
  assert.deepEqual(w.settles(), [{ delivered: [0], failed: [] }])
  assert.equal(w.float(), 1_000_000_000n, "repaid in full")
  assert.equal(w.checkout(r.co.address!), undefined, "the Checkout account closed")
  assert.ok(!r.stored.includes("alice"), "the email is sealed at rest")
  assert.deepEqual({ needed: r.seen.needed, email: r.seen.email }, { needed: true, email: "alice@example.com" })
  assert.deepEqual(r.seen.used, { orders: 1, day: 10_000_000, month: 10_000_000 }, "what the email has used of a guest's limits")
})

test("a 15-card Lucky cart is admitted, paid and settled as one; its Draws finish once ORAO fills the request", async () => {
  const w = world({ mode: { lucky: 1 }, real: true, guest: true, autoFill: false })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const sql = yield* SqlClient.SqlClient
    const buying = yield* Effect.forkChild(w.cart(keys(15)))
    yield* until(Effect.map(sql<{ n: number }>`SELECT count(*)::int AS n FROM purchases WHERE step = 'drawing'`, ([x]) => x!.n === 15), "every card drawing")
    const [co] = yield* sql<{ step: string; address: string }>`SELECT step, address FROM checkouts`
    const rounds = (yield* sql<{ round: number }>`SELECT round FROM purchases`).map((x) => x.round)
    const before = w.draws().length
    w.sw.fill(new PublicKey(co!.address), 0, RANDOMNESS)
    const placed = yield* Fiber.join(buying)
    const rows = yield* sql<{ step: string; draw: { cashback: string; round: number } }>`SELECT step, draw FROM purchases ORDER BY position`
    return { co: co!, rounds, before, placed, rows }
  }))
  assert.equal(r.co.step, "draw", "settled, the checkout waits on its Draws")
  assert.deepEqual(r.rounds, Array(15).fill(0), "one request for every card")
  assert.equal(r.before, 0, "no Draw before ORAO filled it")
  assert.deepEqual(r.rows.map((x) => x.step), Array(15).fill("settled"))
  assert.equal(new Set(r.placed.map((p) => p.checkoutId)).size, 1, "one checkout")
  assert.deepEqual(w.calls, ["admit", "order:alice@example.com", "pay", "delivery:secret-token", "settle", "finish_draw"])
  assert.deepEqual(w.ordered, [15], "one invoice")
  assert.equal(w.usdcOf(w.payees[0]!), 150_000_000n, "one payment")
  assert.deepEqual(w.settles(), [{ delivered: Array.from({ length: 15 }, (_, i) => i), failed: [] }])
  const draws = w.draws()
  assert.equal(draws.length, 15)
  r.rows.forEach((row, i) => assert.equal(row.draw.cashback, String(draws.find((d) => d.card === i)!.cashback), `card ${i}: the program's Draw`))
  const total = r.rows.reduce((s, row) => s + BigInt(row.draw.cashback), 0n)
  assert.equal(total, w.customer().cashback_received, "every Cashback reached the customer's Balance")
  assert.equal(w.checkout(r.co.address), undefined, "the Checkout account closed")
})

test("an admission saved before a crash is resumed as signed; one whose blockhash expired is signed again under the same Checkout number", async () => {
  const w = world()
  const r = await w.run(Effect.gen(function*() {
    w.faults.set("admit", "crash")
    const first = yield* w.buy()
    const saved = yield* checkoutOf(first.id)
    const untouched = balanceOf(w)
    yield* reconcilePass
    const resumed = yield* get(w.alice.id, first.id)
    // The next one crashes too, and its blockhash expires before the reconciler comes by.
    w.faults.set("admit", "crash")
    const second = yield* w.buy()
    const lost = yield* checkoutOf(second.id)
    w.sw.expire()
    yield* reconcilePass
    return { first, saved, untouched, resumed, lost, again: yield* get(w.alice.id, second.id), after: yield* checkoutOf(second.id) }
  }))
  assert.equal(r.first.status, "pending")
  assert.equal(r.saved.number, "0")
  assert.equal(r.untouched, 500 * USDC, "never sent: nothing charged yet")
  assert.equal(r.resumed.status, "delivered")
  assert.equal(r.resumed.admitTx, r.saved.admit_tx!.signature, "the very transaction it saved")
  assert.equal(r.lost.number, "1")
  assert.equal(r.again.status, "delivered")
  assert.notEqual(r.after.admit_tx!.signature, r.lost.admit_tx!.signature, "signed again")
  assert.equal(r.after.number, "1", "under the same Checkout number")
  assert.equal(w.customer().checkouts, 2n)
  assert.equal(balanceOf(w), 480 * USDC, "each charged once")
  assert.equal(w.calls.filter((c) => c === "admit").length, 2)
})

test("an admission the program refuses leaves every card rejected with the program's own words, and nothing charged", async () => {
  // Each waits for the float, and meanwhile the customer lowers their limit, or the owner takes the reserve out.
  const w = world({ real: true, guest: true, float: 0 })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const p = yield* w.buy()
    w.limit(w.alice, 5 * USDC, 1_000 * USDC)
    w.sw.give(w.sw.payWalletUsdc, 100n * BigInt(USDC))
    yield* promote
    yield* settled(p.id)
    yield* until(Effect.sync(() => w.notices.length > 0), "the customer told")
    return { first: p.status, after: yield* get(w.alice.id, p.id), co: yield* checkoutOf(p.id) }
  }))
  assert.equal(r.first, "waiting")
  assert.equal(r.after.status, "rejected")
  assert.equal(r.after.error, "Over the per-purchase spending limit")
  assert.deepEqual(w.calls, ["admit"], "nothing ordered or paid")
  assert.equal(balanceOf(w), 500 * USDC)
  assert.equal(r.co.step, "rejected")
  assert.ok(r.co.admit_tx, "kept: it counts against the account's recent refusals")
  assert.match(w.notices[0]!, /wasn't bought\. Over the per-purchase spending limit/)

  const lucky = world({ real: true, guest: true, float: 0, mode: { lucky: 1 } })
  const l = await lucky.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", lucky.alice.id)
    const p = yield* lucky.buy()
    lucky.withdrawReserve(lucky.config().free_reserve)
    lucky.sw.give(lucky.sw.payWalletUsdc, 100n * BigInt(USDC))
    yield* promote
    yield* settled(p.id)
    return yield* get(lucky.alice.id, p.id)
  }))
  assert.equal(l.status, "rejected")
  assert.equal(l.error, "The Cashback Reserve moved since you confirmed; please confirm again")
  assert.equal(balanceOf(lucky), 500 * USDC)
})

test("a request ORAO hasn't filled after an hour is asked again, and its Draw finishes on the new round", async () => {
  // Bought an hour ago by the chain's clock.
  const w = world({ mode: { lucky: 1 }, autoFill: false, clock: -3_660 })
  const r = await w.run(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const buying = yield* Effect.forkChild(w.buy())
    yield* stepIs("drawing")
    const [co] = yield* sql<{ address: string }>`SELECT address FROM checkouts`
    const address = new PublicKey(co!.address)
    // The hour passes on the chain too (the server may already have asked, too early for the program).
    w.sw.warp(3_600)
    w.sw.expire()
    yield* until(Effect.sync(() => w.checkout(address)?.rounds === 2), "a second request")
    const moved = w.checkout(address)!.cards[0]!.round
    w.sw.fill(address, 1, RANDOMNESS)
    const p = yield* Fiber.join(buying)
    const [row] = yield* sql<{ step: string; draw: { round: number; request: string } }>`SELECT step, draw FROM purchases`
    return { address, moved, p, row: row! }
  }))
  assert.equal(r.moved, 1, "the card moved to the new request")
  assert.equal(r.p.status, "delivered")
  assert.equal(r.row.step, "settled")
  assert.equal(r.row.draw.round, 1)
  assert.equal(r.row.draw.request, oraoRequest(r.address, 1).toBase58())
  assert.ok(w.calls.includes("request_again"))
  assert.equal(w.alerts.filter((a) => /asked again/.test(a)).length, 1, "one alert, for the request that went through")
  assert.equal(w.checkout(r.address), undefined)
})

test("a Draw someone else finished first is recorded from their transaction, with its proof", async () => {
  const w = world({ mode: { lucky: 1 }, autoFill: false })
  const r = await w.run(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const buying = yield* Effect.forkChild(w.buy())
    yield* stepIs("drawing")
    const [co] = yield* sql<{ address: string }>`SELECT address FROM checkouts`
    const address = new PublicKey(co!.address)
    w.sw.fill(address, 0, RANDOMNESS)
    // Anyone may finish a Draw: someone does, before the server's next look. The Checkout closes with it.
    const { program } = w.sw
    const finish = w.sw.send([
      program.instruction("finish_draw", {
        config: program.config,
        customer: program.customer(w.alice.wallet.publicKey),
        checkout: address,
        randomness: oraoRequest(address, 0),
        checkout_payer: w.checkout(address)!.payer,
        event_authority: program.eventAuthority,
        program: program.id
      }, { round: 0 })
    ], [])
    const p = yield* Fiber.join(buying)
    const [row] = yield* sql<{ step: string; draw: { finish: string } }>`SELECT step, draw FROM purchases`
    return { address, finish, p, row: row! }
  }))
  const ran = Effect.runSync(w.sw.chain.landed(r.finish))!
  const theirs = decodeEvents(ran.logs, ran.inner).find((e) => e.name === "Draw")!.data as unknown as DrawEvent
  assert.equal(w.checkout(r.address), undefined, "their transaction closed the Checkout")
  assert.equal(r.p.status, "delivered")
  assert.equal(r.row.step, "settled")
  assert.equal(r.row.draw.finish, r.finish, "the proof names their transaction")
  assert.deepEqual(r.p.draw?.proof, { tx: r.finish, card: 0 }, "the customer's link to its Draw Proof")
  assert.equal(r.p.draw?.cashback, Number(theirs.cashback))
  assert.equal(r.p.draw?.finalPrice, Number(theirs.final_price))
  assert.equal(r.p.draw?.seed, hex(theirs.seed))
  assert.equal(r.p.draw?.gameVersion, 1)
  assert.ok(!w.calls.includes("finish_draw"), "ours was never needed")
})

test("a card the customer reclaimed after 24 hours is recorded as reclaimed when we settle, and the rest still settle", async () => {
  // A cart of two: Bitrefill takes a day, the customer reclaims the first card, then both arrive.
  const w = world({ real: true, guest: true, deliveries: [["Pending", "Pending"]] })
  const reclaim = (x: World, address: PublicKey, card: number) => {
    const { program } = x.sw
    x.sw.send([
      program.instruction("reclaim", {
        wallet: x.alice.wallet.publicKey,
        config: program.config,
        customer: program.customer(x.alice.wallet.publicKey),
        checkout: address,
        checkout_payer: x.checkout(address)!.payer
      }, { card })
    ], [x.alice.wallet])
  }
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const placed = yield* w.cart(keys(2))
    const co = yield* checkoutOf(placed[0]!.id)
    w.sw.warp(24 * 3_600 + 60)
    reclaim(w, new PublicKey(co.address!), 0)
    yield* reconcilePass
    return { co, cards: yield* Effect.forEach(placed, (p) => get(w.alice.id, p.id)) }
  }))
  assert.deepEqual(r.cards.map((p) => p.status), ["failed", "delivered"])
  assert.equal(r.cards[0]!.error, "You reclaimed the full amount after 24 hours.")
  assert.equal(r.cards[1]!.redemption?.code, "ABC-124")
  assert.deepEqual(w.settles(), [{ delivered: [1], failed: [] }], "the refused settlement changed nothing; a fresh one settled the other card")
  assert.equal(balanceOf(w), 490 * USDC, "the reclaimed card's money is back")
  assert.match(w.alerts.join(" "), /was delivered but closed onchain as Reclaimed/)
  assert.equal(w.checkout(r.co.address!), undefined)

  // One card alone: reclaiming it closed its Checkout, so there's nothing to sign.
  const one = world({ real: true, guest: true, deliveries: [["Pending"]] })
  const p = await one.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", one.alice.id)
    const p = yield* one.buy()
    const co = yield* checkoutOf(p.id)
    one.sw.warp(24 * 3_600 + 60)
    reclaim(one, new PublicKey(co.address!), 0)
    yield* reconcilePass
    return yield* get(one.alice.id, p.id)
  }))
  assert.equal(p.status, "failed")
  assert.equal(p.error, "You reclaimed the full amount after 24 hours.")
  assert.ok(!one.calls.includes("settle"))
  assert.equal(balanceOf(one), 500 * USDC)
})

test("a refused settlement whose cards are still open onchain stays pending, and the next try signs afresh", async () => {
  // The owner moves the operator role away while the card is on its way; then back.
  const stranger = Keypair.generate().publicKey
  const w = world({ onOrder: (sw) => setOperator(sw, stranger) })
  const r = await w.run(Effect.gen(function*() {
    const p = yield* w.buy()
    const step = (yield* rowOf(p.id)).step
    setOperator(w.sw, w.sw.operator.publicKey)
    yield* reconcilePass
    return { p, step, after: yield* get(w.alice.id, p.id) }
  }))
  assert.equal(r.p.status, "pending")
  assert.equal(r.p.settleTx, undefined)
  assert.equal(r.step, "confirm", "left for the reconciler")
  assert.equal(r.after.status, "delivered")
  assert.deepEqual(w.calls, ["admit", "order", "settle", "settle"])
})

// ---------- the Pay Wallet's float ----------

test("a checkout the float can't cover waits uncharged while the owner hears of it, and goes on once the float is topped up", async () => {
  const w = world({ real: true, guest: true, price: 12 * USDC, float: 5 * USDC })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const p = yield* w.buy()
    const before = { calls: [...w.calls], balance: balanceOf(w) }
    w.sw.give(w.sw.payWalletUsdc, 30n * BigInt(USDC))
    yield* promote
    return { first: p.status, before, after: yield* settled(p.id) }
  }))
  assert.equal(r.first, "waiting")
  assert.deepEqual(r.before, { calls: [], balance: 500 * USDC }, "nothing signed or charged while waiting")
  assert.match(w.alerts.join(" "), /waits for the Pay Wallet: its float can't cover \$12\.00 yet/)
  assert.equal(r.after, "settled")
  assert.equal(w.usdcOf(w.payees[0]!), 12_000_000n)
  assert.equal(w.float(), 35_000_000n, "paid, then repaid")
})

test("a checkout that waits too long is cancelled, and nothing was charged", async () => {
  const w = world({ real: true, guest: true, price: 12 * USDC, float: 0 })
  const p = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const sql = yield* SqlClient.SqlClient
    const p = yield* w.buy()
    yield* sql`UPDATE checkouts SET created_at = now() - interval '61 minutes'`
    yield* promote
    return yield* get(w.alice.id, p.id)
  }))
  assert.equal(p.status, "rejected")
  assert.match(p.error ?? "", /weren't charged/)
  assert.deepEqual(w.calls, [])
  assert.equal(balanceOf(w), 500 * USDC)
})

test("two checkouts can never count on the same float", async () => {
  const w = world({ real: true, guest: true, float: 15 * USDC })
  const statuses = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    yield* withEmail("bob@example.com", w.bob.id)
    const ps = yield* Effect.all([w.buy(), w.buy(undefined, w.bob.id)], { concurrency: 2 })
    return ps.map((p) => p.status).sort()
  }))
  assert.deepEqual(statuses, ["delivered", "waiting"])
})

test("a waiting purchase can be cancelled, uncharged; one going through can't", async () => {
  const w = world({ real: true, guest: true, price: 12 * USDC, float: 0 })
  const r = await w.run(Effect.gen(function*() {
    const purchases = yield* Purchases
    yield* withEmail("alice@example.com", w.alice.id)
    yield* withEmail("bob@example.com", w.bob.id)
    const waiting = yield* w.buy()
    const cancelled = yield* purchases.cancel(w.alice.id, waiting.id)
    w.sw.give(w.sw.payWalletUsdc, 100n * BigInt(USDC))
    const going = yield* w.buy(undefined, w.bob.id)
    const refused = yield* purchases.cancel(w.bob.id, going.id).pipe(Effect.flip)
    const notYours = yield* purchases.cancel(w.bob.id, waiting.id).pipe(Effect.flip)
    return { cancelled, refused, notYours }
  }))
  assert.equal(r.cancelled.status, "rejected")
  assert.match(r.cancelled.error ?? "", /You cancelled it\. You weren't charged/)
  assert.match(r.refused.message, /already going through/)
  assert.equal(r.notYours._tag, "NotFound")
  assert.equal(w.calls.filter((c) => c === "admit").length, 1, "only bob's went through")
  assert.equal(balanceOf(w), 500 * USDC)
})

test("one account can have only one purchase waiting", async () => {
  const w = world({ real: true, guest: true, price: 12 * USDC, float: 0 })
  const e = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    yield* w.buy()
    return yield* w.buy().pipe(Effect.flip)
  }))
  assert.match(e.message, /already have a card on its way/)
})

test("while sales are closed, new purchases are refused and waiting ones keep their place", async () => {
  const w = world({ real: true, guest: true, price: 12 * USDC, float: 0 })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const waiting = yield* w.buy()
    w.setShop(new ShopStatus({ open: false, reason: "stopped" }))
    const refused = yield* w.buy(undefined, w.bob.id).pipe(Effect.flip)
    w.sw.give(w.sw.payWalletUsdc, 30n * BigInt(USDC))
    yield* promote
    const held = (yield* get(w.alice.id, waiting.id)).status
    w.setShop(new ShopStatus({ open: true }))
    yield* promote
    return { refused: refused.message, held, after: yield* settled(waiting.id) }
  }))
  assert.match(r.refused, /paused for a few minutes/)
  assert.equal(r.held, "waiting", "not admitted while closed")
  assert.equal(r.after, "settled")
})

test("each step gets its own retries: a backoff earned earlier never delays the next step", async () => {
  const w = world({ real: true, guest: true, price: 12 * USDC, float: 0, bitrefillDown: "delivery" })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const sql = yield* SqlClient.SqlClient
    const p = yield* w.buy()
    // Retries used up and an hour's backoff earned before it moves on.
    yield* sql`UPDATE checkouts SET attempts = 11, next_attempt_at = now() + interval '1 hour'`
    w.sw.give(w.sw.payWalletUsdc, 30n * BigInt(USDC))
    yield* promote
    yield* settled(p.id)
    return yield* rowOf(p.id)
  }))
  assert.equal(r.step, "delivery", "paused where Bitrefill didn't answer")
  assert.equal(r.attempts, 0, "with all its retries still ahead")
  assert.equal(r.due, true, "and no backoff carried over, so the code isn't held up")
})

test("a payment that fails moves nothing: the charged checkout waits for the float, then a fresh invoice is paid once", async () => {
  // Another payment emptied the float between admission and this one.
  const w = world({ real: true, guest: true, float: 10 * USDC, onOrder: (sw, n) => n === 1 && sw.give(sw.payWalletUsdc, -sw.tokens(sw.payWalletUsdc)) })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const p = yield* w.buy()
    const co = yield* checkoutOf(p.id)
    const charged = balanceOf(w)
    w.sw.give(w.sw.payWalletUsdc, 20n * BigInt(USDC))
    yield* promote
    return { first: p.status, co, charged, after: yield* settled(p.id) }
  }))
  assert.equal(r.first, "waiting")
  assert.equal(r.co.step, "restock")
  assert.match(r.co.error ?? "", /^The payment failed, so nothing was paid/)
  assert.equal(r.charged, 490 * USDC, "charged once, at admission")
  assert.match(w.alerts.join(" "), /its payment to Bitrefill failed/)
  assert.equal(r.after, "settled")
  assert.deepEqual(w.payees.map((x) => w.usdcOf(x)), [0n, 10_000_000n], "the first invoice was never paid; a fresh one was, once")
  assert.equal(w.calls.filter((c) => c === "admit").length, 1)
  assert.equal(balanceOf(w), 490 * USDC)
})

test("a charged checkout the float never covers in time is refunded in full", async () => {
  const w = world({ real: true, guest: true, float: 10 * USDC, onOrder: (sw) => sw.give(sw.payWalletUsdc, -sw.tokens(sw.payWalletUsdc)) })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const sql = yield* SqlClient.SqlClient
    const p = yield* w.buy()
    yield* sql`UPDATE checkouts SET created_at = now() - interval '61 minutes'`
    yield* promote
    return { first: p.status, after: yield* settled(p.id) }
  }))
  assert.equal(r.first, "waiting")
  assert.equal(r.after, "failed")
  assert.deepEqual(w.settles(), [{ delivered: [], failed: [0] }])
  assert.equal(balanceOf(w), 500 * USDC)
})

test("if Bitrefill says our store credit is too low, the charged checkout waits, then is refunded in full", async () => {
  const w = world({ real: true, orders: ["NoCredit"] })
  const r = await w.run(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const p = yield* w.buy()
    yield* sql`UPDATE checkouts SET created_at = now() - interval '61 minutes'`
    yield* promote
    return { waiting: p.status, after: yield* settled(p.id) }
  }))
  assert.equal(r.waiting, "waiting")
  assert.equal(r.after, "failed")
  assert.deepEqual(w.calls, ["admit", "order", "settle"], "charged once, ordered once, refunded")
  assert.equal(balanceOf(w), 500 * USDC)
})

test("a purchase that waited for money is admitted at today's price", async () => {
  const w = world({ price: 10 * USDC })
  const step = await w.run(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // Accepted 20 minutes ago at $9, when Bitrefill's price was lower; it's $10 now.
    const [row] = yield* sql<{ id: string }>`
      WITH co AS (INSERT INTO checkouts (account_id, step, created_at) VALUES (${w.alice.id}, 'waiting', now() - interval '20 minutes') RETURNING id)
      INSERT INTO purchases (checkout_id, account_id, idempotency_key, voucher_id, voucher_name, package_value, reference_price, max_debit, step, created_at)
      VALUES ((SELECT id FROM co), ${w.alice.id}, 'waited-key-1', 'test-card', 'Card', '10', 9000000, 11000000, 'waiting', now() - interval '20 minutes')
      RETURNING id`
    yield* promote
    return yield* settled(row!.id)
  }))
  assert.equal(step, "settled")
  assert.equal(w.admitted()[0]!.reference_price, 10_000_000n, "admitted at the current price, within what they confirmed")
  assert.equal(balanceOf(w), 490 * USDC)
})

// ---------- Lucky Buys ----------

test("a Lucky Buy is admitted at the Lucky Amount it was accepted under; a Normal one with none", async () => {
  const lucky = world({ mode: { lucky: 1 } })
  const r = await lucky.run(Effect.flatMap(lucky.buy(), (p) => rowOf(p.id)))
  assert.equal(r.quoted_lucky_amount, "10000000", "the program's quote when it was accepted: the whole card")
  assert.equal(lucky.admitted()[0]!.lucky_amount, 10_000_000n)
  assert.equal(lucky.admitted()[0]!.max_price, 12_000_000n)

  const normal = world()
  await normal.run(normal.buy())
  assert.equal(normal.admitted()[0]!.mode.kind, "Normal")
  assert.equal(normal.admitted()[0]!.lucky_amount, 0n)
})

test("the Lucky Amount the customer saw is the one bound; an impossible one is refused", async () => {
  const w = world({ mode: { lucky: 1 } })
  const create = (luckyAmount: number) =>
    Purchases.use((p) =>
      p.create(w.alice.id, new NewPurchase({ voucherId: "test-card", value: "10", mode: { lucky: 1 }, maxPrice: 11_200_000, luckyAmount, idempotencyKey: crypto.randomUUID() }))
    )
  const r = await w.run(Effect.gen(function*() {
    const p = yield* create(5_000_000)
    const bad = yield* create(20_000_000).pipe(Effect.flip)
    return { row: yield* rowOf(p.id), bad }
  }))
  assert.equal(r.row.quoted_lucky_amount, "5000000", "what the customer saw, not the program's quote now")
  assert.equal(w.admitted()[0]!.lucky_amount, 5_000_000n)
  assert.equal(r.bad._tag, "PurchaseInvalid", "more than the price can never have been quoted")
  assert.equal(w.admitted().length, 1)
})

test("a Lucky Buy is checked against what the program will debit before anything is signed", async () => {
  // A Lucky Buy on the whole $10 costs $12; the balance covers the card but not that.
  const poor = world({ mode: { lucky: 1 }, balance: 10_600_000 })
  const short = await poor.run(poor.buy().pipe(Effect.flip))
  assert.match(short.message, /Insufficient balance/)
  assert.deepEqual(poor.calls, [], "nothing signed")
  // A maximum under the Lucky price: the program would refuse it, after the operator paid to ask.
  const w = world({ mode: { lucky: 1 } })
  const low = await w.run(Purchases.use((p) =>
    p.create(w.alice.id, new NewPurchase({ voucherId: "test-card", value: "10", mode: { lucky: 1 }, maxPrice: 10_000_000, luckyAmount: 6_000_000, idempotencyKey: crypto.randomUUID() }))
  ).pipe(Effect.flip))
  assert.match(low.message, /Price changed/)
  assert.deepEqual(w.calls, [], "nothing signed")
  // The quote the customer saw, as the program gives it now, goes through.
  const ok = world({ mode: { lucky: 1 } })
  assert.equal((await ok.run(ok.buy())).status, "delivered")
  assert.deepEqual(ok.calls, ["admit", "order", "settle", "finish_draw"])
})

test("a Lucky card the reserve no longer covers is refused before anything is signed, so the customer confirms again", async () => {
  const w = world({ mode: { lucky: 1 } })
  w.withdrawReserve(w.config().free_reserve)
  const e = await w.run(w.cart(keys(2)).pipe(Effect.flip))
  assert.match(e.message, /^Card 10: That quote is out of date/)
  assert.deepEqual(w.calls, [])
})

test("a Lucky cart confirmed under a smaller reserve is admitted as confirmed; a card the reserve no longer covers is refused before signing", async () => {
  // A $12 reserve, half of it the most one card may win: $10 cards play $5 of it at most. Confirmed at $4, the first
  // locks $4 and leaves the second $3.33. Had it played its most, it would leave the second less than $3.
  const w = world()
  w.owner("set_cashback_cap", { fixed: 50_000_000n, reserve_bps: 5_000 })
  w.withdrawReserve(w.config().free_reserve - 12_000_000n)
  const card = (luckyAmount: number) =>
    new NewPurchase({ voucherId: "test-card", value: "10", mode: { lucky: 1 }, luckyAmount, maxPrice: 10_000_000 + luckyAmount / 5, idempotencyKey: crypto.randomUUID() })
  const r = await w.run(Effect.gen(function*() {
    // $5 for the second card is more than the first leaves it: the program would refuse it.
    const stale = yield* Purchases.use((p) => p.createCart(w.alice.id, [card(4_000_000), card(5_000_000)])).pipe(Effect.flip)
    const signed = [...w.calls]
    const placed = yield* Purchases.use((p) => p.createCart(w.alice.id, [card(4_000_000), card(3_000_000)]))
    return { stale, signed, steps: yield* Effect.forEach(placed, (p) => settled(p.id)) }
  }))
  assert.match(r.stale.message, /^Card 10: That quote is out of date/)
  assert.deepEqual(r.signed, [], "nothing signed for the stale cart")
  assert.deepEqual(r.steps, ["settled", "settled"])
  assert.deepEqual(w.admitted().map((a) => [a.lucky_amount, a.max_price]), [[4_000_000n, 10_800_000n], [3_000_000n, 10_600_000n]])
})

test("a card whose price rose since it was confirmed is refused before anything is signed; a drop buys at the lower price", async () => {
  // The card is $10 now. Lucky Buys here play their whole price at a 20% premium.
  const w = world({ price: 10 * USDC })
  const lucky = { lucky: 1 }
  const buy = (cards: ReadonlyArray<{ mode: Mode; maxPrice: number; luckyAmount?: number }>) => {
    const items = cards.map((c) => new NewPurchase({ voucherId: "test-card", value: "10", ...c, idempotencyKey: crypto.randomUUID() }))
    return items.length === 1
      ? Effect.map(Purchases.use((p) => p.create(w.alice.id, items[0]!)), (p) => [p])
      : Purchases.use((p) => p.createCart(w.alice.id, items))
  }
  // Confirmed at $8: $8 in Normal, $9.60 for a Lucky Buy on the whole $8.
  const normalUp = { mode: "normal" as const, maxPrice: 8_000_000 }
  const luckyUp = { mode: lucky, luckyAmount: 8_000_000, maxPrice: 9_600_000 }
  // Confirmed at $12: $12 in Normal, $14.40 for a Lucky Buy on the whole $12.
  const normalDown = { mode: "normal" as const, maxPrice: 12_000_000 }
  const luckyDown = { mode: lucky, luckyAmount: 12_000_000, maxPrice: 14_400_000 }
  // Price unchanged, and the reserve has grown since a Lucky Buy on $5 of it was confirmed at $11: still exactly $11.
  const luckyGrown = { mode: lucky, luckyAmount: 5_000_000, maxPrice: 11_000_000 }
  const r = await w.run(Effect.gen(function*() {
    const refused: Array<string> = []
    for (const cards of [[normalUp], [luckyUp], [normalDown, luckyUp], [luckyDown, normalUp]]) refused.push((yield* Effect.flip(buy(cards))).message)
    const signed = [...w.calls]
    const bought = [...(yield* buy([normalDown])), ...(yield* buy([luckyDown])), ...(yield* buy([normalDown, luckyDown])), ...(yield* buy([luckyGrown]))]
    return { refused, signed, bought: yield* Effect.forEach(bought, (p) => settled(p.id)) }
  }))
  assert.deepEqual(r.refused.map((m) => /Price changed since you confirmed; please confirm again/.test(m)), [true, true, true, true])
  assert.deepEqual(r.signed, [], "nothing signed, so none of it counts as a refusal against the customer")
  assert.deepEqual(r.bought, ["settled", "settled", "settled", "settled", "settled"], "four refusals later the customer still buys")
  assert.deepEqual(w.admitted().map((a) => [a.reference_price, a.lucky_amount]), [
    [10_000_000n, 0n],
    [10_000_000n, 10_000_000n],
    [10_000_000n, 0n],
    [10_000_000n, 10_000_000n],
    [10_000_000n, 5_000_000n]
  ], "at today's lower price, a whole-price Lucky Buy on the whole of it")
})

// ---------- guest checkout and Connect Bitrefill ----------

test("a buy request stops waiting after its limit and answers pending; the card still arrives and Telegram says so", async () => {
  const w = world({ real: true, guest: true, deliveryDelay: 400, requestWait: 50 })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const p = yield* w.buy()
    const before = [...w.notices]
    yield* settled(p.id)
    yield* until(Effect.sync(() => w.notices.length > 0), "a notice")
    return { p, before, after: yield* get(w.alice.id, p.id) }
  }))
  assert.equal(r.p.status, "pending", "the request answered before the card arrived")
  assert.deepEqual(r.before, [])
  assert.equal(r.after.status, "delivered")
  assert.equal(w.notices.length, 1)
  assert.match(w.notices[0]!, /is ready/)
  // A card that arrives within the wait is answered in the request, with no extra message.
  const fast = world({ real: true, guest: true })
  const q = await fast.run(Effect.andThen(withEmail("alice@example.com", fast.alice.id), fast.buy()))
  assert.equal(q.status, "delivered")
  assert.deepEqual(fast.notices, [])
})

test("a guest card needs the customer's email first, and a malformed one is refused", async () => {
  const w = world({ real: true, guest: true })
  const r = await w.run(Effect.gen(function*() {
    const noEmail = yield* w.buy().pipe(Effect.flip)
    const bad = yield* withEmail("not an email", w.alice.id).pipe(Effect.flip)
    return { noEmail, bad }
  }))
  assert.match(r.noEmail.message, /Add the email for your cards first/)
  assert.match(r.bad.message, /doesn't look like an email/)
  assert.deepEqual(w.calls, [], "nothing signed or ordered")
})

test("Bitrefill's limits count per email, across accounts: the 16th card in a day is refused before anything is signed", async () => {
  const w = world({ real: true, guest: true })
  const e = await w.run(Effect.gen(function*() {
    yield* withEmail("shared@example.com", w.bob.id)
    yield* withEmail("SHARED@example.com", w.alice.id)
    yield* boughtFor(w.bob.id, 15)
    return yield* w.buy().pipe(Effect.flip)
  }))
  assert.match(e.message, /15 cards a day per email/)
  assert.deepEqual(w.calls, [])
})

test("a guest invoice costing more than the admitted price is never paid: the customer is refunded in full", async () => {
  const w = world({ real: true, guest: true, invoiceAmount: 10_000_001 })
  const p = await w.run(Effect.andThen(withEmail("alice@example.com", w.alice.id), w.buy()))
  assert.equal(p.status, "failed")
  assert.equal(w.usdcOf(w.payees[0]!), 0n, "nothing paid")
  assert.deepEqual(w.calls, ["admit", "order:alice@example.com", "settle"])
  assert.equal(balanceOf(w), 500 * USDC)
})

// Connect Bitrefill: a customer who logs in to their own Bitrefill account has their cards ordered on it, under its
// limits instead of a guest's, and still paid from the Pay Wallet.

/** Connects `who`'s Bitrefill account the way the browser does: our authorize URL, Bitrefill's redirect back, then the Wallet page. */
const connectAs = (who: string) =>
  Connect.use((c) =>
    Effect.gen(function*() {
      const state = new URL(yield* c.url(who)).searchParams.get("state")!
      const back = new URL(yield* c.callback(new URLSearchParams({ code: "the-code", state, iss: "https://api.bitrefill.com/oauth/mcp" }))).searchParams
      yield* c.finish(who, back.get("code")!, back.get("state")!)
      return back.get("bitrefill")
    })
  )
const buyerOf = (id: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ buyer: string | null; email_key: string | null }>`SELECT buyer, email_key FROM purchases WHERE id = ${id}`).pipe(Effect.map((r) => r[0]!))

test("a connected customer's card is ordered on their own Bitrefill account, with no email and none of the guest limits", async () => {
  const w = world({ real: true, guest: true })
  const r = await w.run(Effect.gen(function*() {
    // Their email has had a day's 15 guest cards, so as a guest the next would be refused.
    yield* withEmail("alice@example.com", w.alice.id)
    yield* boughtFor(w.alice.id, 15)
    const connected = yield* connectAs(w.alice.id)
    const seen = yield* Purchases.use((s) => s.checkoutEmail(w.alice.id))
    const p = yield* w.buy()
    return { connected, seen, p, row: yield* buyerOf(p.id) }
  }))
  assert.equal(r.connected, "finish")
  assert.deepEqual({ needed: r.seen.needed, bitrefill: r.seen.bitrefill }, { needed: false, bitrefill: true })
  assert.equal(r.p.status, "delivered")
  assert.deepEqual(w.calls, ["admit", "order:token:access-1", "pay", "delivery:secret-token", "settle"], "their token and no email; delivery still reads the invoice by its access token")
  assert.deepEqual(r.row, { buyer: "account", email_key: null }, "not counted against the email's guest limits")
  assert.equal(w.usdcOf(w.payees[0]!), 10_000_000n, "paid once from the Pay Wallet, as any card")
})

test("a lapsed Bitrefill login falls back to a guest order with the Checkout Email, or with none fails and refunds in full", async () => {
  // The login from connecting ends within a minute, so the order renews it first, and Bitrefill refuses.
  const oauth = fakeBitrefillOAuth(60)
  const w = world({ real: true, guest: true, oauth })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    yield* connectAs(w.alice.id)
    oauth.lapse()
    const p = yield* w.buy()
    return { p, row: yield* buyerOf(p.id), seen: yield* Purchases.use((s) => s.checkoutEmail(w.alice.id)) }
  }))
  assert.equal(r.p.status, "delivered")
  assert.deepEqual(w.calls, ["admit", "order:alice@example.com", "pay", "delivery:secret-token", "settle"])
  assert.equal(r.row.buyer, "guest")
  assert.ok(r.row.email_key, "counted against the email's guest limits")
  assert.deepEqual({ needed: r.seen.needed, bitrefill: r.seen.bitrefill }, { needed: true, bitrefill: false }, "the lapsed login is forgotten")

  const lapsing = fakeBitrefillOAuth(60)
  const bare = world({ real: true, guest: true, oauth: lapsing })
  const p = await bare.run(Effect.gen(function*() {
    yield* connectAs(bare.alice.id)
    lapsing.lapse()
    return yield* bare.buy()
  }))
  assert.equal(p.status, "failed")
  assert.match(p.error ?? "", /Your Bitrefill login expired\. Connect again or add an email in Wallet\. The full amount went back/)
  assert.deepEqual(bare.calls, ["admit", "settle"], "nothing ordered or paid")
  assert.equal(balanceOf(bare), 500 * USDC)
})

test("two purchases at once renew a login only once, and are admitted one after the other under their own Checkout numbers", async () => {
  const oauth = fakeBitrefillOAuth(60)
  const w = world({ real: true, guest: true, oauth })
  const ps = await w.run(Effect.andThen(connectAs(w.alice.id), Effect.all([w.buy(), w.buy()], { concurrency: "unbounded" })))
  assert.deepEqual(ps.map((p) => p.status), ["delivered", "delivered"])
  assert.equal(oauth.grants("refresh_token").length, 1)
  assert.deepEqual(w.calls.filter((c) => c.startsWith("order:")), ["order:token:access-2", "order:token:access-2"])
  assert.equal(w.customer().checkouts, 2n)
  assert.equal(balanceOf(w), 480 * USDC)
})

test("a login Bitrefill stops taking (401) is renewed once and the card ordered again; its limit reads as the account's", async () => {
  const w = world({ real: true, guest: true, orders: ["Refused"] })
  const p = await w.run(Effect.andThen(connectAs(w.alice.id), w.buy()))
  assert.equal(p.status, "delivered")
  assert.deepEqual(w.calls.filter((c) => c.startsWith("order:")), ["order:token:access-1", "order:token:access-2"])

  const limited = world({ real: true, guest: true, orders: ["Refused"], refusal: "Purchase limit reached (INVALID_INPUT)" })
  const refused = await limited.run(Effect.andThen(connectAs(limited.alice.id), limited.buy()))
  assert.equal(refused.status, "failed")
  assert.match(refused.error ?? "", /^Your Bitrefill account's limit was reached/)
})

// ---------- the reconciler and Pay Wallet payments ----------

test("the reconciler coming by a purchase that is still running never starts a second run", async () => {
  const w = world({ real: true, guest: true, deliveryDelay: 400 })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const buying = yield* Effect.forkChild(w.buy())
    yield* stepIs("delivery")
    yield* reconcilePass
    yield* reconcilePass
    const p = yield* Fiber.join(buying)
    return yield* settled(p.id)
  }))
  assert.equal(r, "settled")
  assert.equal(w.calls.filter((c) => c.startsWith("delivery:")).length, 1, "one run asked Bitrefill for the card")
  assert.equal(w.calls.filter((c) => c === "settle").length, 1)
})

test("two reconciler passes during a slow payment never pay the invoice twice", async () => {
  const w = world({ real: true, guest: true })
  w.delays.set("pay", 400)
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const buying = yield* Effect.forkChild(w.buy())
    yield* stepIs("pay")
    yield* reconcilePass
    yield* reconcilePass
    const p = yield* Fiber.join(buying)
    return yield* settled(p.id)
  }))
  assert.equal(r, "settled")
  assert.equal(w.calls.filter((c) => c === "pay").length, 1)
  assert.equal(w.usdcOf(w.payees[0]!), 10_000_000n, "paid once")
})

test("a payment is never saved over one another run already saved: the saved one is sent instead", async () => {
  const w = world({ real: true, guest: true })
  w.delays.set("pay", 300)
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const sql = yield* SqlClient.SqlClient
    const buying = yield* Effect.forkChild(w.buy())
    yield* stepIs("pay")
    // Another run's payment lands in the row while this one is still signing its own.
    const other = otherPayment(w, w.payees[0]!, 10_000_000n)
    yield* sql`UPDATE checkouts SET pay_tx = ${JSON.stringify(other)}::jsonb`
    const p = yield* Fiber.join(buying)
    const during = { status: p.status, sent: w.calls.includes("pay"), saved: (yield* checkoutOf(p.id)).pay_tx?.signature === other.signature }
    yield* reconcilePass
    return { during, after: yield* settled(p.id), saved: (yield* checkoutOf(p.id)).pay_tx?.signature === other.signature }
  }))
  assert.deepEqual(r.during, { status: "pending", sent: false, saved: true }, "its own payment was neither saved nor sent")
  assert.equal(r.after, "settled")
  assert.ok(r.saved)
  assert.equal(w.calls.filter((c) => c === "pay").length, 1, "the saved payment was sent, once")
  assert.equal(w.usdcOf(w.payees[0]!), 10_000_000n)
})

test("a payment signed after its invoice neared expiry is neither saved nor sent: a fresh invoice is paid once", async () => {
  const w = world({ real: true, guest: true })
  w.delays.set("pay", 300)
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const sql = yield* SqlClient.SqlClient
    const buying = yield* Effect.forkChild(w.buy())
    yield* stepIs("pay")
    // The invoice passes 50 minutes while the payment is still being signed.
    yield* sql`UPDATE checkouts SET invoice_at = now() - interval '51 minutes'`
    const p = yield* Fiber.join(buying)
    const during = { status: p.status, sent: w.calls.includes("pay"), step: (yield* rowOf(p.id)).step, saved: (yield* checkoutOf(p.id)).pay_tx !== null }
    yield* reconcilePass
    return { during, after: yield* settled(p.id) }
  }))
  assert.deepEqual(r.during, { status: "pending", sent: false, step: "pay", saved: false }, "the late payment was neither saved nor sent")
  assert.equal(r.after, "settled")
  assert.deepEqual(w.payees.map((x) => w.usdcOf(x)), [0n, 10_000_000n], "a fresh invoice was asked for, and paid once")
})

test("a saved payment that never landed is signed again while its invoice is fresh; past 50 minutes a fresh invoice is paid instead", async () => {
  const w = world({ real: true, guest: true })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    w.faults.set("pay", "crash")
    const p = yield* w.buy()
    const lost = (yield* checkoutOf(p.id)).pay_tx!
    w.sw.expire()
    yield* reconcilePass
    return { first: p.status, lost, after: yield* settled(p.id), paid: (yield* checkoutOf(p.id)).pay_tx! }
  }))
  assert.equal(r.first, "pending")
  assert.equal(r.after, "settled")
  assert.notEqual(r.paid.signature, r.lost.signature, "signed again")
  assert.equal(w.calls.filter((c) => c === "pay").length, 1, "the lost one never reached the chain")
  assert.deepEqual(w.payees.map((x) => w.usdcOf(x)), [10_000_000n], "one invoice, paid once")

  const late = world({ real: true, guest: true })
  const after = await late.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", late.alice.id)
    const sql = yield* SqlClient.SqlClient
    late.faults.set("pay", "crash")
    const p = yield* late.buy()
    late.sw.expire()
    yield* sql`UPDATE checkouts SET invoice_at = now() - interval '51 minutes'`
    yield* reconcilePass
    return yield* settled(p.id)
  }))
  assert.equal(after, "settled")
  assert.deepEqual(late.payees.map((x) => late.usdcOf(x)), [0n, 10_000_000n], "the old invoice is let go; a fresh one is paid once")
})

test("a charged purchase that can't be paid for in time is refunded in full, with no new invoice", async () => {
  const w = world({ real: true, guest: true })
  w.faults.set("pay", "down")
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const sql = yield* SqlClient.SqlClient
    const p = yield* w.buy()
    const before = (yield* rowOf(p.id)).step
    // Never signed: its invoice goes stale, and the purchase is now 23.5 hours old (Reclaim opens at 24).
    yield* sql`UPDATE checkouts SET invoice_at = now() - interval '41 minutes', created_at = now() - interval '1410 minutes'`
    yield* reconcilePass
    return { before, after: yield* settled(p.id) }
  }))
  assert.equal(r.before, "pay")
  assert.equal(r.after, "failed")
  assert.ok(!w.calls.includes("pay"), "nothing was ever paid")
  assert.equal(w.calls.filter((c) => c.startsWith("order:")).length, 1, "no second invoice")
  assert.ok(w.calls.includes("settle"))
  assert.match(w.alerts.join(" "), /in time/)
  assert.equal(balanceOf(w), 500 * USDC)
})

test("after three admissions the program refused, the account waits before the operator signs another", async () => {
  const w = world()
  const e = await w.run(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const refused = JSON.stringify({ signature: "refused", bytes: "", lastValidBlockHeight: 0 })
    for (let i = 0; i < 3; i++) yield* sql`INSERT INTO checkouts (account_id, step, admit_tx) VALUES (${w.alice.id}, 'rejected', ${refused}::jsonb)`
    return yield* w.buy().pipe(Effect.flip)
  }))
  assert.match(e.message, /just refused/)
  assert.deepEqual(w.calls, [], "the fourth was never signed")
})

test("an account with no money, or one that keeps asking for cards we can't find, stops spending price lookups", async () => {
  const empty = world({ balance: null })
  await empty.run(empty.buy().pipe(Effect.flip))
  assert.equal(empty.lookups(), 0, "no balance: refused before the lookup")
  const w = world({ noCard: true })
  const e = await w.run(Effect.gen(function*() {
    for (let i = 0; i < 3; i++) yield* w.buy().pipe(Effect.flip)
    return yield* w.buy().pipe(Effect.flip)
  }))
  assert.match(e.message, /couldn't find several cards/)
  assert.equal(w.lookups(), 3, "the fourth asked Bitrefill nothing")
})

test("a guest order Bitrefill never took is refunded in full once the retries run out; a paid one still stops for a human", async () => {
  const w = world({ real: true, guest: true, bitrefillDown: "order" })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const sql = yield* SqlClient.SqlClient
    const p = yield* w.buy()
    const before = (yield* rowOf(p.id)).step
    // Twelve tries later Bitrefill still hasn't taken the order.
    yield* sql`UPDATE checkouts SET attempts = 12`
    yield* reconcilePass
    return { before, after: yield* settled(p.id) }
  }))
  assert.equal(r.before, "ordering")
  assert.equal(r.after, "failed")
  assert.deepEqual(w.payees, [], "nothing was ever paid")
  assert.ok(w.calls.includes("settle"), "refunded through the program")
  assert.equal(balanceOf(w), 500 * USDC)
  assert.match(w.alerts.join(" "), /couldn't be ordered from Bitrefill in 12 attempts/)
  assert.match(w.notices.join(" "), /full amount is back/)

  // Paid, and the card never arrives: that outcome isn't ours to guess.
  const paid = world({ real: true, guest: true, bitrefillDown: "delivery" })
  const after = await paid.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", paid.alice.id)
    const sql = yield* SqlClient.SqlClient
    const p = yield* paid.buy()
    yield* sql`UPDATE checkouts SET attempts = 12`
    yield* reconcilePass
    return yield* settled(p.id)
  }))
  assert.equal(after, "stuck")
  assert.equal(paid.usdcOf(paid.payees[0]!), 10_000_000n)
  assert.ok(!paid.calls.includes("settle"), "never refunded while Bitrefill may still deliver")
  assert.match(paid.alerts.join(" "), /stuck after 12 attempts at delivery/)
})

test("a busy minute at Bitrefill isn't counted against the account as cards it couldn't find", async () => {
  const w = world({ pricesBusy: true })
  const e = await w.run(Effect.gen(function*() {
    for (let i = 0; i < 3; i++) yield* w.buy().pipe(Effect.flip)
    return yield* w.buy().pipe(Effect.flip)
  }))
  assert.match(e.message, /Prices are busy/)
})

// ---------- the purchase list ----------

test("the purchase list pages newest first, every purchase exactly once, and only the caller's own", async () => {
  const w = world()
  await w.run(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // Saved straight to the table, at whole minutes, so two can share one instant.
    const add = (who: string, minutesAgo: number) =>
      sql<{ id: string }>`
        WITH co AS (INSERT INTO checkouts (account_id, step) VALUES ('test', 'done') RETURNING id) INSERT INTO purchases (checkout_id, account_id, idempotency_key, voucher_id, voucher_name, package_value, requested_mode, reference_price, max_debit, step, created_at)
        VALUES ((SELECT id FROM co), ${who}, ${crypto.randomUUID()}, 'amazon-us', 'Card', '10', '"normal"', 10000000, 10000000, 'failed',
                date_trunc('minute', now()) - make_interval(mins => ${minutesAgo}))
        RETURNING id`.pipe(Effect.map((r) => r[0]!.id))
    const mine = [yield* add("alice.test", 1), yield* add("alice.test", 2), yield* add("alice.test", 2), yield* add("alice.test", 3), yield* add("alice.test", 4)]
    const bobs = yield* add("bob.test", 0)
    const p = yield* Purchases
    const seen: Array<string> = []
    let before: string | undefined
    for (let i = 0; i < 5; i++) {
      const page = yield* p.list("alice.test", { limit: 2, before })
      assert.ok(page.items.length <= 2)
      seen.push(...page.items.map((x) => x.id))
      before = page.next
      if (!before) break
    }
    assert.equal(seen.length, 5, "three pages of two, two and one")
    assert.deepEqual([...seen].sort(), [...mine].sort(), "each of alice's once, none of bob's")
    assert.equal(seen[0], mine[0], "newest first")
    assert.equal(seen[4], mine[4], "oldest last")
    // Someone else's purchase is no cursor into alice's list.
    assert.deepEqual((yield* p.list("alice.test", { before: bobs })).items, [])
    // Without a limit, a page holds up to 100 and says nothing follows.
    const all = yield* p.list("alice.test")
    assert.equal(all.items.length, 5)
    assert.equal(all.next, undefined)
  }))
})

test("a customer marks their own delivered card used, again changes nothing, and unused clears it; the list carries it", async () => {
  const w = world()
  const r = await w.run(Effect.gen(function*() {
    const p = yield* Purchases
    const me = w.alice.id
    const card = yield* w.buy()
    const other = yield* w.buy()
    const used = yield* p.setUsed(me, card.id, true)
    yield* Effect.sleep("20 millis")
    const again = yield* p.setUsed(me, card.id, true)
    const listed = (yield* p.list(me)).items
    const got = yield* p.get(me, card.id)
    const cleared = yield* p.setUsed(me, card.id, false)
    const clearedAgain = yield* p.setUsed(me, card.id, false)
    return { card, other, used, again, listed, got, cleared, clearedAgain, after: (yield* p.list(me)).items }
  }))
  assert.equal(r.card.usedAt, undefined, "a new card is unused")
  assert.ok(r.used.usedAt && Date.parse(r.used.usedAt) > 0)
  assert.equal(r.again.usedAt, r.used.usedAt, "marking it again keeps when it was first marked")
  assert.equal(r.got.usedAt, r.used.usedAt)
  assert.deepEqual(r.listed.map((x) => [x.id, x.usedAt]), [[r.other.id, undefined], [r.card.id, r.used.usedAt]], "only that card, in the list too")
  assert.equal(r.cleared.usedAt, undefined)
  assert.equal(r.clearedAgain.usedAt, undefined)
  assert.ok(r.after.every((x) => x.usedAt === undefined))
  assert.equal(r.cleared.status, "delivered", "only a note: the card is as it was")
  assert.equal(r.cleared.redemption?.code, "ABC-123")
  assert.deepEqual(w.calls, ["admit", "order", "settle", "admit", "order", "settle"], "nothing is sent to the chain or Bitrefill")
})

test("only the customer's own card, and only once delivered, can be marked used", async () => {
  const w = world({ real: true, guest: true, price: 12 * USDC, float: 0 })
  const r = await w.run(Effect.gen(function*() {
    const p = yield* Purchases
    const me = w.alice.id
    yield* withEmail("alice@example.com", me)
    yield* withEmail("bob@example.com", w.bob.id)
    const waiting = yield* w.buy()
    const notDelivered = yield* p.setUsed(me, waiting.id, true).pipe(Effect.flip)
    const cancelled = yield* p.cancel(me, waiting.id)
    const notBought = yield* p.setUsed(me, cancelled.id, true).pipe(Effect.flip)
    // Only now the float: the promote loop must not take the waiting card first.
    w.sw.give(w.sw.payWalletUsdc, 100n * BigInt(USDC))
    const delivered = yield* w.buy(undefined, w.bob.id)
    const notYours = yield* p.setUsed(me, delivered.id, true).pipe(Effect.flip)
    const unknown = yield* p.setUsed(me, crypto.randomUUID(), true).pipe(Effect.flip)
    const sql = yield* SqlClient.SqlClient
    const marked = yield* sql<{ n: number }>`SELECT count(*)::int AS n FROM purchases WHERE used_at IS NOT NULL`
    return { delivered, notYours, notDelivered, unknown, notBought, marked: marked[0]!.n, bobs: yield* p.get(w.bob.id, delivered.id) }
  }))
  assert.equal(r.delivered.status, "delivered")
  assert.equal(r.notYours._tag, "NotFound", "someone else's card is no different from one that doesn't exist")
  assert.equal(r.unknown._tag, "NotFound")
  assert.match(r.notDelivered.message, /Only a delivered card/)
  assert.match(r.notBought.message, /Only a delivered card/)
  assert.equal(r.marked, 0, "nothing was marked")
  assert.equal(r.bobs.usedAt, undefined)
})

test("a cart's cards are marked one at a time: the order view shows just that one used", async () => {
  const w = world()
  const r = await w.run(Effect.gen(function*() {
    const p = yield* Purchases
    const placed = yield* w.cart(keys(3))
    yield* p.setUsed(w.alice.id, placed[1]!.id, true)
    const order = (yield* p.list(w.alice.id)).items.filter((x) => x.checkoutId === placed[0]!.checkoutId)
    return { placed, order }
  }))
  assert.equal(r.order.length, 3)
  assert.deepEqual(r.order.filter((x) => x.usedAt).map((x) => x.id), [r.placed[1]!.id])
})

// ---------- carts ----------

test("a cart buys every card as its own purchase, admitted together in one Checkout, each delivered on its own", async () => {
  const w = world()
  const r = await w.run(Effect.gen(function*() {
    const asked = keys(3)
    const placed = yield* w.cart(asked)
    const steps = yield* Effect.forEach(placed, (p) => settled(p.id))
    const again = yield* w.cart(asked)
    return { placed, steps, again }
  }))
  assert.equal(r.placed.length, 3)
  assert.deepEqual(r.steps, ["settled", "settled", "settled"])
  assert.deepEqual(r.placed.map((p) => p.contractPurchaseId), [0, 1, 2], "each its own card in the Checkout")
  assert.deepEqual(w.calls, ["admit", "order", "settle"])
  assert.equal(w.admitted().length, 3)
  assert.deepEqual(r.again.map((p) => p.id), r.placed.map((p) => p.id), "a retry with the same keys returns the same purchases, in order")
  assert.deepEqual(w.calls, ["admit", "order", "settle"], "and buys nothing again")
})

test("a cart is checked as a whole before anything is signed: all its cards or none", async () => {
  const poor = world({ balance: 25 * USDC })
  const e = await poor.run(poor.cart(keys(3)).pipe(Effect.flip))
  assert.match(e.message, /Insufficient balance/)
  const capped = world({ limits: { perPurchase: 200 * USDC, daily: 25 * USDC } })
  const d = await capped.run(capped.cart(keys(3)).pipe(Effect.flip))
  assert.match(d.message, /daily spending limit/)
  const perCard = world({ limits: { perPurchase: 5 * USDC, daily: 1_000 * USDC } })
  const c = await perCard.run(perCard.cart(keys(2)).pipe(Effect.flip))
  assert.match(c.message, /^Card 10: Over the per-purchase spending limit/, "a cart says which card")
  const dup = world()
  const k = crypto.randomUUID()
  const twice = await dup.run(dup.cart([k, k]).pipe(Effect.flip))
  assert.match(twice.message, /its own key/)
  for (const x of [poor, capped, perCard, dup]) assert.deepEqual(x.calls, [], "nothing signed")
  const rows = await poor.run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ n: number }>`SELECT count(*)::int AS n FROM purchases`))
  assert.equal(rows[0]!.n, 0, "nothing recorded")
})

test("a guest cart counts all its cards against the email's 15 a day", async () => {
  const w = world({ real: true, guest: true })
  const e = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    yield* boughtFor(w.alice.id, 12)
    return yield* w.cart(keys(4)).pipe(Effect.flip)
  }))
  assert.match(e.message, /15 cards a day per email, and yours has had 12 in the last 24 hours\. This cart can have at most 3\./)
  assert.deepEqual(w.calls, [])
})

test("a cart the float can't cover waits whole, uncharged, then goes as one order and one payment", async () => {
  const w = world({ real: true, guest: true, float: 25 * USDC })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const placed = yield* w.cart(keys(3))
    w.sw.give(w.sw.payWalletUsdc, 100n * BigInt(USDC))
    yield* promote
    return { placed, steps: yield* Effect.forEach(placed, (p) => settled(p.id)) }
  }))
  assert.deepEqual(r.placed.map((p) => p.status), ["waiting", "waiting", "waiting"])
  assert.deepEqual(r.steps, ["settled", "settled", "settled"])
  assert.deepEqual(w.ordered, [3], "one Bitrefill order for the whole cart")
  assert.equal(w.usdcOf(w.payees[0]!), 30_000_000n, "one payment for all of it")
})

test("each card of a cart gets its own code, and a card Bitrefill fails is refunded without holding the others", async () => {
  const w = world({ real: true, guest: true, deliveries: [["Delivered", "Failed", "Delivered"]] })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const placed = yield* w.cart(keys(3))
    return yield* Effect.forEach(placed, (p) => get(w.alice.id, p.id))
  }))
  assert.deepEqual(r.map((p) => p.status), ["delivered", "failed", "delivered"])
  assert.deepEqual(r.map((p) => p.redemption?.code), ["ABC-123", undefined, "ABC-125"], "each card its own order's code")
  assert.deepEqual(w.settles(), [{ delivered: [0, 2], failed: [1] }])
  assert.equal(balanceOf(w), 480 * USDC, "the failed card's money is back")
  assert.ok(w.alerts.some((a) => /didn't deliver purchase .* on paid invoice/.test(a)), "we paid for it: ask Bitrefill for the money back")
})

test("a card still on its way doesn't hold the others: they're settled now, it is later", async () => {
  // Still pending when it's asked about again: the run pauses there, the others settled.
  const w = world({ real: true, guest: true, deliveries: [["Delivered", "Pending", "Delivered"], ["Delivered", "Pending", "Delivered"]] })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const placed = yield* w.cart(keys(3))
    const first = yield* Effect.forEach(placed, (p) => settled(p.id))
    // The reconciler comes by again; this time the slow card is there.
    yield* reconcilePass
    return { first, then: yield* Effect.forEach(placed, (p) => settled(p.id)) }
  }))
  assert.deepEqual(r.first, ["settled", "delivery", "settled"])
  assert.deepEqual(r.then, ["settled", "settled", "settled"])
  assert.deepEqual(w.settles(), [{ delivered: [0, 2], failed: [] }, { delivered: [1], failed: [] }])
})

test("identical cards delivered in different rounds each get their own order's code", async () => {
  // Bitrefill lists an order for each copy of the same card; the first copy arrives at once, the second a round later.
  const w = world({ real: true, guest: true, deliveries: [["Delivered", "Pending"], ["Delivered", "Pending"]] })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const placed = yield* w.cart(keys(2))
    const first = yield* Effect.forEach(placed, (p) => settled(p.id))
    yield* reconcilePass
    return { first, cards: yield* Effect.forEach(placed, (p) => get(w.alice.id, p.id)) }
  }))
  assert.deepEqual(r.first, ["settled", "delivery"], "the second copy is still on its way after the first round")
  assert.deepEqual(r.cards.map((p) => p.redemption?.code), ["ABC-123", "ABC-124"], "the second copy gets the second order's code, never the first's again")
  assert.deepEqual(w.settles(), [{ delivered: [0], failed: [] }, { delivered: [1], failed: [] }])
})

test("two carts at once can't both pass an email's guest limits or an account's open cards", async () => {
  // Two accounts with the same Checkout Email: 10 cards each would make 20 for the email today.
  const guest = world({ real: true, guest: true })
  const g = await guest.run(Effect.gen(function*() {
    yield* withEmail("shared@example.com", guest.bob.id)
    yield* withEmail("shared@example.com", guest.alice.id)
    return yield* Effect.all([Effect.exit(guest.cart(keys(10))), Effect.exit(guest.cart(keys(10), guest.bob.id))], { concurrency: "unbounded" })
  }))
  assert.equal(g.filter(Exit.isSuccess).length, 1, "only one cart goes through")
  assert.match(JSON.stringify(g.find(Exit.isFailure)), /15 cards a day per email/)
  assert.equal(guest.calls.filter((c) => c === "admit").length, 1, "the other is refused before anything is signed")

  // One account, two carts of 10 at once: 20 unfinished cards, more than a full cart.
  const one = world({ deliveryDelay: 300 })
  const o = await one.run(Effect.all([Effect.exit(one.cart(keys(10))), Effect.exit(one.cart(keys(10)))], { concurrency: "unbounded" }))
  assert.equal(o.filter(Exit.isSuccess).length, 1)
  assert.match(JSON.stringify(o.find(Exit.isFailure)), /still in progress/)
})

test("a card counts against its email's day from when it was ordered, not when it was placed", async () => {
  // Fifteen cards placed 25 hours ago that waited for the float and were ordered an hour ago: Bitrefill counts them today.
  const w = world({ real: true, guest: true })
  const e = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    yield* boughtFor(w.alice.id, 15, { created: "now() - interval '25 hours'", ordered: "now() - interval '1 hour'" })
    return yield* w.buy().pipe(Effect.flip)
  }))
  assert.match(e.message, /15 cards a day per email, and yours has had 15/)
  assert.deepEqual(w.calls, [])
})

test("a checkout whose cards were partly bought already is refused, and nothing more is bought", async () => {
  const w = world()
  const k = crypto.randomUUID()
  const e = await w.run(Effect.gen(function*() {
    yield* w.cart([k])
    return yield* w.cart([k, crypto.randomUUID()]).pipe(Effect.flip)
  }))
  assert.match(e.message, /already sent in an earlier checkout/)
  assert.equal(w.calls.filter((c) => c === "admit").length, 1)
})

test("a notice Telegram didn't take is sent again on the next pass, and only once", async () => {
  const w = world({ real: true, guest: true, deliveryDelay: 400, requestWait: 50, telegramDown: 1 })
  await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    yield* w.buy()
    const sql = yield* SqlClient.SqlClient
    yield* until(Effect.map(sql<{ retell: boolean }>`SELECT retell FROM checkouts`, ([c]) => c!.retell), "Telegram didn't take it")
    yield* reconcilePass
    yield* reconcilePass
  }))
  assert.equal(w.notices.length, 2, "tried once, then sent once more")
  assert.match(w.notices[1]!, /is ready/)
})

test("a checkout is ordered with the Checkout Email it was placed under, even if that changed while it waited", async () => {
  const w = world({ real: true, guest: true, price: 12 * USDC, float: 5 * USDC })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const p = yield* w.buy()
    yield* withEmail("later@example.com", w.alice.id)
    const sql = yield* SqlClient.SqlClient
    const [stored] = yield* sql<{ email: string | null }>`SELECT email FROM checkouts`
    w.sw.give(w.sw.payWalletUsdc, 100n * BigInt(USDC))
    yield* promote
    return { first: p.status, stored: stored!.email, after: yield* settled(p.id) }
  }))
  assert.equal(r.first, "waiting")
  assert.equal(r.after, "settled")
  assert.deepEqual(w.calls.filter((c) => c.startsWith("order:")), ["order:alice@example.com"], "the email the customer confirmed")
  assert.ok(r.stored && !r.stored.includes("alice"), "kept on the checkout, sealed")
})

test("a card delivered with neither a code nor a link tells an admin, naming the purchase and none of its data", async () => {
  const w = world({ real: true, guest: true, deliveries: [["NoCode"]] })
  const p = await w.run(Effect.andThen(withEmail("alice@example.com", w.alice.id), w.buy()))
  assert.equal(p.status, "delivered")
  assert.equal(w.alerts.filter((a) => a.includes(p.id)).length, 1)
  assert.ok(!w.alerts.join(" ").includes("S3CRET"), "never the Redemption Data")
})

test("a checkout that gave up at settle goes back on Retry now, each card to where it was, and finishes", async () => {
  // The RPC doesn't take the settlement for six hours of retries: one card has its code, the other failed at Bitrefill.
  const w = world({ real: true, guest: true, deliveries: [["Delivered", "Failed"]] })
  w.faults.set("settle", "down")
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const placed = yield* w.cart(keys(2))
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE checkouts SET attempts = 12`
    yield* reconcilePass
    const stuck = yield* sql<{ step: string; error: string }>`SELECT step, error FROM purchases ORDER BY position`
    const [checkout] = yield* sql<{ step: string }>`SELECT step FROM checkouts`
    // The RPC is back; the admin presses Retry now on either card.
    w.faults.delete("settle")
    const at = yield* retryPurchase(placed[1]!.id)
    yield* reconcilePass
    const after = yield* Effect.forEach(placed, (p) => settled(p.id))
    return { stuck, checkout: checkout!.step, at, after, cards: yield* Effect.forEach(placed, (p) => get(w.alice.id, p.id)) }
  }))
  assert.equal(r.checkout, "stuck")
  assert.deepEqual(r.stuck.map((c) => [c.step, GAVE_UP_AT.exec(c.error)?.[1]]), [["stuck", "confirm"], ["stuck", "fail"]], "each card says where it gave up")
  assert.equal(r.at, "fail")
  assert.deepEqual(r.after, ["settled", "failed"])
  assert.equal(r.cards[0]!.redemption?.code, "ABC-123", "the code it already had")
  assert.deepEqual(w.settles(), [{ delivered: [0], failed: [1] }], "settled once, as it was")
  assert.equal(w.calls.filter((c) => c.startsWith("order:")).length, 1, "never ordered again")
  assert.equal(w.calls.filter((c) => c === "pay").length, 1, "never paid again")
})

test("a checkout that gave up at delivery goes back to asking Bitrefill; one that gave up at pay needs a human", async () => {
  const slow = world({ real: true, guest: true, bitrefillDown: "delivery" })
  const d = await slow.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", slow.alice.id)
    const p = yield* slow.buy()
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE checkouts SET attempts = 12`
    yield* reconcilePass
    const stuck = (yield* rowOf(p.id)).step
    const at = yield* retryPurchase(p.id)
    return { stuck, at, row: yield* rowOf(p.id), checkout: (yield* sql<{ step: string; error: string | null }>`SELECT step, error FROM checkouts`)[0]! }
  }))
  assert.equal(d.stuck, "stuck")
  assert.equal(d.at, "delivery")
  assert.deepEqual([d.row.step, d.row.attempts, d.row.due], ["delivery", 0, true], "due on the reconciler's next pass")
  assert.deepEqual(d.checkout, { step: "delivery", error: null })
  assert.equal(slow.usdcOf(slow.payees[0]!), 10_000_000n)

  const unpaid = world({ real: true, guest: true })
  unpaid.faults.set("pay", "down")
  const p = await unpaid.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", unpaid.alice.id)
    const p = yield* unpaid.buy()
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE checkouts SET attempts = 12`
    yield* reconcilePass
    return { step: (yield* rowOf(p.id)).step, refused: yield* retryPurchase(p.id).pipe(Effect.flip) }
  }))
  assert.equal(p.step, "stuck")
  assert.match(p.refused.message, /needs a manual check/)
})

test("the same cart sent twice at once is one checkout, returned to both", async () => {
  const w = world()
  const asked = keys(10)
  const [a, b] = await w.run(Effect.all([w.cart(asked), w.cart(asked)], { concurrency: "unbounded" }))
  assert.deepEqual(a.map((p) => p.id), b.map((p) => p.id))
  assert.equal(new Set(a.map((p) => p.checkoutId)).size, 1)
  assert.equal(w.calls.filter((c) => c === "admit").length, 1, "admitted once")
  assert.equal(w.admitted().length, 10)
})

test("a copy keeps its own order and the other copy gets the other, even once Bitrefill lists them the other way for good", async () => {
  // Two copies of one card: the first arrives at once; from the second round on Bitrefill lists the orders reversed.
  const w = world({
    real: true,
    guest: true,
    deliveries: [["Delivered", "Pending"], ["Delivered", "Pending"], ["Delivered", "Delivered"]],
    listed: [[0, 1], [1, 0], [1, 0]]
  })
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const placed = yield* w.cart(keys(2))
    const first = yield* Effect.forEach(placed, (p) => settled(p.id))
    yield* reconcilePass
    return { first, cards: yield* Effect.forEach(placed, (p) => get(w.alice.id, p.id)) }
  }))
  assert.deepEqual(r.first, ["settled", "delivery"], "the second copy still on its way, never given the first copy's order")
  assert.deepEqual(r.cards.map((p) => p.redemption?.code), ["ABC-123", "ABC-124"], "each its own order's code")
  assert.deepEqual(w.alerts.filter((a) => /already has/.test(a)), [], "nothing for a human to untangle")
  assert.deepEqual(w.settles(), [{ delivered: [0], failed: [] }, { delivered: [1], failed: [] }])
})

test("cards sent back to delivery by the runbook's restart take their own orders again, and settle", async () => {
  // Both cards have their codes, but the RPC doesn't take the settlement for six hours of retries.
  const w = world({ real: true, guest: true })
  w.faults.set("settle", "down")
  const restart = /Restart a purchase[^]*?```sql\n([^]*?)```/.exec(readFileSync(new URL("../../../deploy/RUNBOOK.md", import.meta.url), "utf8"))![1]!
  const r = await w.run(Effect.gen(function*() {
    yield* withEmail("alice@example.com", w.alice.id)
    const placed = yield* w.cart(keys(2))
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE checkouts SET attempts = 12`
    yield* reconcilePass
    const stuck = yield* Effect.forEach(placed, (p) => Effect.map(rowOf(p.id), (row) => row.step))
    // The RPC is back, and an operator runs the restart block as the runbook shows it.
    w.faults.delete("settle")
    const [{ checkout_id }] = (yield* sql<{ checkout_id: string }>`SELECT checkout_id FROM purchases LIMIT 1`) as [{ checkout_id: string }]
    const statements = restart.replace(/--.*$/gm, "").replaceAll("<checkout_id>", checkout_id).split(";").map((x) => x.trim())
    yield* sql.withTransaction(Effect.forEach(statements.filter((x) => x && !/^(BEGIN|COMMIT)$/i.test(x)), (x) => sql.unsafe(x)))
    yield* reconcilePass
    return { stuck, after: yield* Effect.forEach(placed, (p) => settled(p.id)), cards: yield* Effect.forEach(placed, (p) => get(w.alice.id, p.id)) }
  }))
  assert.deepEqual(r.stuck, ["stuck", "stuck"])
  assert.deepEqual(r.after, ["settled", "settled"])
  assert.deepEqual(r.cards.map((p) => p.redemption?.code), ["ABC-123", "ABC-124"])
  assert.deepEqual(w.alerts.filter((a) => /already has/.test(a)), [], "a card may always take the order it already holds")
  assert.equal(w.calls.filter((c) => c === "pay").length, 1, "never paid again")
})

test("Bitrefill's guest limits, as one rule the shop and the bot share", () => {
  assert.equal(guestLimitRefusal({ orders: 11, day: 0, month: 0 }, 4_000_000, 4), undefined)
  assert.match(guestLimitRefusal({ orders: 12, day: 0, month: 0 }, 4_000_000, 4) ?? "", /yours has had 12 in the last 24 hours\. This cart can have at most 3\./)
  assert.match(guestLimitRefusal({ orders: 0, day: 450_000_000, month: 450_000_000 }, 60_000_000, 1) ?? "", /a day per email; this one would go over it/)
  assert.match(guestLimitRefusal({ orders: 0, day: 0, month: 950_000_000 }, 60_000_000, 2) ?? "", /a month per email; this cart would go over it/)
})
