import {
  BitrefillUnavailable,
  CheckoutEmail,
  Draw,
  GUEST_LIMITS,
  MAX_CART,
  type Mode,
  NewPurchase,
  NotFound,
  Purchase,
  PurchaseInvalid,
  PurchasePage,
  Quote,
  redemptionFields
} from "@luckout/api"
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token"
import { PublicKey, type TransactionInstruction } from "@solana/web3.js"
import { Config, Context, Effect, Fiber, FiberSet, Layer, Option, Schedule, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import { createHmac, randomUUID } from "node:crypto"
import { Alerts } from "./Alerts.ts"
import { Bitrefill, type Card, MIN_PRICE, ORDER_LIMIT } from "./Bitrefill.ts"
import { Connect } from "./Connect.ts"
import {
  type Card as ChainCard,
  decodeReturn,
  type DrawEvent,
  filledRandomness,
  type Mode as ProgramMode,
  ORAO_NETWORK_STATE,
  ORAO_VRF,
  oraoRequest,
  oraoTreasury,
  type Quote as ChainQuote
} from "./Program.ts"
import { json, stepRows } from "./Rows.ts"
import { closedMessage, Sales } from "./Sales.ts"
import { SealKey, sealWith, unsealWith } from "./Seal.ts"
import { type Outcome, ProgramRejected, type Signed, Solana, SolanaUnavailable, type TxExpired } from "./Solana.ts"

// A checkout is the cards a customer confirmed together: one card for Buy, up to 15 for a Cart. It is one numbered
// Checkout account in the program (ADR-0015), and each card in it has its own Draw, refund and Reclaim:
//   (waiting →) admit → ordering → (pay →) delivery ⇄ settle → (draw →) done
//                    ↘ every card fails → settle            (admit refused → rejected)
// admit:    one `admit` under the customer's next Checkout number, every card or none.
// ordering: one Bitrefill invoice for every card. A guest invoice (ADR-0012) is unpaid, and paid from the Pay Wallet at
//           "pay": creating one moves no money, so an unknown outcome there is simply ordered again, and the payment is
//           saved before it's sent, so it's only ever sent again as the same transaction.
// delivery: each card's code, matched to its order. A card Bitrefill delivers goes to "confirm", one it won't to "fail".
// settle:   one `settle` for the cards that got that far. It repays the Pay Wallet, and asks ORAO once for the delivered
//           Lucky cards, which wait as "drawing"; the rest go back to delivery, so a slow card never holds the others.
// draw:     each Draw is finished once ORAO's randomness is in (by us, though anyone could), or asked again after an hour.
// Until delivery every card is at its checkout's step; from there each card goes on by itself (confirm/fail → drawing
// → settled, or failed). Every step is saved before its side effect, so after a crash the reconciler resumes it without
// buying or charging twice. A checkout the Pay Wallet's float can't cover yet starts as "waiting": nothing is charged,
// the owner hears of it, and it goes on once the float covers it, or is cancelled after WAIT_MINUTES. A payment that
// fails (the float ran short) waits as "restock" (charged, not yet ordered) and is refunded in full if the money doesn't
// come in time. "ordering" found by the reconciler on store credit means we may have paid Bitrefill without saving the
// invoice id; it becomes "stuck" for a human, and the customer can still Reclaim after 24h. The reconciler backs off on
// each retry and gives up (stuck, with an alert) after MAX_ATTEMPTS, except on a Draw, which only ever waits for ORAO.
type Step =
  | "waiting"
  | "admit"
  | "ordering"
  | "restock"
  | "pay"
  | "delivery"
  | "confirm"
  | "fail"
  | "drawing"
  | "settled"
  | "failed"
  | "rejected"
  | "stuck"
type CheckoutStep = "waiting" | "admit" | "ordering" | "restock" | "pay" | "delivery" | "settle" | "draw" | "done" | "rejected" | "stuck"

/** One card. */
interface Row {
  id: string
  account_id: string
  checkout_id: string
  position: number
  voucher_id: string
  voucher_name: string
  package_value: string
  /** The card's own currency (its value is in it), from the voucher it was priced from; null before purchases kept it. */
  currency: string | null
  requested_mode: Mode | null
  reference_price: number | string | bigint
  max_debit: number | string | bigint | null
  step: Step
  error: string | null
  /** Its checkout's admission, once it went through. */
  admit_tx: Signed | null
  /** Its index in its Checkout account, once admitted. */
  contract_purchase_id: number | string | bigint | null
  /** The program's record at admission; `created_at` (seconds) is when Reclaim's 24 hours start. */
  admitted: { mode: Mode; max_price: string; lucky_amount: string; created_at?: number | string } | null
  /** A Lucky Buy's Lucky Amount when it was accepted: admission plays exactly it, or is refused. */
  quoted_lucky_amount: number | string | bigint | null
  invoice_id: string | null
  /** Its order in the invoice, once delivered: no other card of the checkout may take the same one. */
  order_id: string | null
  email_key: string | null
  /** Whom its order was placed for: a guest (Checkout Email) or the customer's own Bitrefill account. */
  buyer: "guest" | "account" | null
  redemption: string | null
  /** The card's use-by date, from its Redemption Data (ISO), kept outside the sealed data. */
  use_by: string | null
  /** The settlement that confirmed or failed it. */
  settle_tx: Signed | null
  /** A Lucky card's randomness request, once settled. */
  round: number | null
  draw: Record<string, unknown> | null
  /** When the customer marked it used; null while unused. */
  used_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

/** What a checkout's cards share. */
interface CheckoutRow {
  id: string
  account_id: string
  step: CheckoutStep
  error: string | null
  admit_tx: Signed | null
  /** The settlement being sent; cleared once it went through, so the next round signs its own. */
  settle_tx: Signed | null
  buyer: "guest" | "account" | null
  email_key: string | null
  invoice_id: string | null
  /** A guest invoice's access token, sealed; and what paying it takes (ADR-0012). */
  invoice_token: string | null
  invoice_at: Date | string | null
  pay_to: string | null
  pay_amount: number | string | bigint | null
  pay_tx: Signed | null
  /** Its Checkout account's number and address, saved with the admission that takes them. */
  number: number | string | bigint | null
  address: string | null
  /** The Checkout Email it was placed under, sealed (bound to the checkout); null on the customer's own Bitrefill account. */
  email: string | null
  created_at: Date | string
  updated_at: Date | string
}

interface QuoteView {
  mode: Mode
  reference_price: string
  lucky_amount: string
  max_price: string
  /** A Lucky card put at Normal by luckyCheckout. */
  belowMin?: true
}

/**
 * The program refuses a Checkout whose Lucky cards play less than the smallest Lucky Checkout in all (`min`): its margin
 * must cover the Draw (ADR-0015). Such a checkout's Lucky cards are quoted and bought at Normal instead, marked
 * `belowMin` so the web and the Agent can say why. The web's luckyCheckout (apps/web/lib/modes.ts) is the same rule.
 */
const luckyCheckout = (quotes: ReadonlyArray<QuoteView>, min: number): Array<QuoteView> => {
  const plays = quotes.reduce((s, q) => s + (q.mode === "normal" ? 0 : Number(q.lucky_amount)), 0)
  if (plays === 0 || plays >= min) return [...quotes]
  return quotes.map((q) => (q.mode === "normal" ? q : { mode: "normal", reference_price: q.reference_price, lucky_amount: "0", max_price: q.reference_price, belowMin: true }))
}

/** Thrown on to stop a run; the reconciler picks the checkout up again later. */
type Unknown = SolanaUnavailable | BitrefillUnavailable

/** A card's steps that are still on their way (for alerts, the admin panel and the per-account limit). */
export const OPEN_STEPS = ["admit", "ordering", "pay", "delivery", "confirm", "fail", "drawing"]
/** A checkout's steps the reconciler resumes. */
export const CHECKOUT_OPEN_STEPS = ["admit", "ordering", "pay", "delivery", "settle", "draw"]
/** Steps where a card or checkout waits for the Pay Wallet's float. */
export const WAITING_STEPS = ["waiting", "restock"]
export const usd = (micro: number | bigint) => `$${(Number(micro) / 1e6).toFixed(2)}`
/** How long a checkout may wait for the float before it's cancelled (uncharged) or refunded (charged).
 * ponytail: fixed; make it an admin setting if the owner wants to tune it. */
const WAIT_MINUTES = 60
/**
 * Why Bitrefill would refuse `count` more cards costing `price` (micro-USDC) in all for a Checkout Email that has
 * `used` this much of its limits (GUEST_LIMITS), if it would; undefined if they fit.
 */
export const guestLimitRefusal = (used: { readonly orders: number; readonly day: number; readonly month: number }, price: number, count: number) => {
  const these = count === 1 ? "this one" : "this cart"
  return used.orders + count > GUEST_LIMITS.orders
    ? `Bitrefill allows ${GUEST_LIMITS.orders} cards a day per email, and yours has had ${used.orders} in the last 24 hours. ${
      used.orders < GUEST_LIMITS.orders ? `This cart can have at most ${GUEST_LIMITS.orders - used.orders}.` : "Try again later."
    }`
    : used.day + price > GUEST_LIMITS.daily
    ? `Bitrefill allows ${usd(GUEST_LIMITS.daily)} of cards a day per email; ${these} would go over it. Try ${count === 1 ? "a smaller card" : "fewer cards"} or wait a day.`
    : used.month + price > GUEST_LIMITS.monthly
    ? `Bitrefill allows ${usd(GUEST_LIMITS.monthly)} of cards a month per email; ${these} would go over it.`
    : undefined
}
/**
 * What Bitrefill lets our one paying address buy as a guest (ADR-0015): every guest card counts, whatever its email.
 * Past it, new checkouts are refused until the window moves on; KYB is the way past it.
 */
export const PAYING_LIMITS = { daily: 10_000_000_000, monthly: 50_000_000_000 }
/** A checkout's steps where every card is still at the checkout's own step. */
const SHARED_STEPS = ["waiting", "admit", "ordering", "restock", "pay", "delivery"]
/**
 * When a card counts toward Bitrefill's limits for its Checkout Email: when it was ordered, which is when Bitrefill
 * counts it. One not ordered yet counts as ordered now (it may wait hours for the float); one that ended without an
 * order time counts from when it was placed.
 */
export const GUEST_COUNTED_AT = "COALESCE(ordered_at, CASE WHEN step IN ('waiting', 'admit', 'ordering', 'restock', 'pay') THEN now() ELSE created_at END)"
/**
 * A card that gave up where going again is safe: settling (confirm, fail) closes a purchase onchain only once, and
 * delivery only asks Bitrefill again about the invoice already paid. Anywhere else (admit, ordering, pay) going again
 * could charge, order or pay twice, so a human looks first (deploy/RUNBOOK.md).
 */
export const GAVE_UP_AT = /^Gave up after \d+ attempts at (confirm|fail|delivery):/
/**
 * Where Retry now (Admin) sends a card: on from its own step while its checkout still runs, back to the step it gave
 * up at if that's safe to repeat; undefined when it needs a human.
 */
export const retryStep = (card: { readonly step: string; readonly error: string | null }, checkoutStep: string) =>
  card.step === "stuck"
    ? checkoutStep === "stuck" ? GAVE_UP_AT.exec(card.error ?? "")?.[1] : undefined
    : OPEN_STEPS.includes(card.step) && CHECKOUT_OPEN_STEPS.includes(checkoutStep)
    ? card.step
    : undefined

/**
 * Retry now: a purchase's checkout runs its next step on the reconciler's next pass instead of after its backoff. One
 * that gave up goes back with every card of it that gave up somewhere safe, each to its own step: the checkout to
 * settle if a card is to be confirmed or failed, else to delivery. Never charges, orders or pays again.
 */
export const retryPurchase = Effect.fn("Purchases.retry")(function*(id: string) {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ checkout_id: string; step: string; error: string | null; checkout_step: string }>`
    SELECT p.checkout_id, p.step, p.error, c.step AS checkout_step
    FROM purchases p JOIN checkouts c ON c.id = p.checkout_id WHERE p.id = ${id}`.pipe(Effect.orDie)
  if (!row) return yield* new PurchaseInvalid({ message: "No such purchase." })
  const at = retryStep(row, row.checkout_step)
  if (!at) return yield* new PurchaseInvalid({ message: "This one needs a manual check. See deploy/RUNBOOK.md." })
  // updated_at in the past lets the reconciler pick it up on its next pass (it skips checkouts touched in the last 30s).
  if (row.step !== "stuck") {
    yield* sql`UPDATE checkouts SET attempts = 0, next_attempt_at = now(), updated_at = now() - interval '1 minute'
               WHERE id = ${row.checkout_id} AND step = ${row.checkout_step}`.pipe(Effect.orDie)
    return at
  }
  yield* sql.withTransaction(Effect.gen(function*() {
    const stuck = yield* sql<{ id: string; error: string | null }>`SELECT id, error FROM purchases WHERE checkout_id = ${row.checkout_id} AND step = 'stuck'`
    const back = stuck.flatMap((c) => {
      const s = GAVE_UP_AT.exec(c.error ?? "")?.[1]
      return s ? [{ id: c.id, step: s }] : []
    })
    const next = back.some((c) => c.step !== "delivery") ? "settle" : "delivery"
    const moved = yield* sql`UPDATE checkouts SET step = ${next}, error = NULL, attempts = 0, next_attempt_at = now(), updated_at = now() - interval '1 minute'
                             WHERE id = ${row.checkout_id} AND step = 'stuck' RETURNING id`
    if (moved.length === 0) return
    for (const c of back) yield* sql`UPDATE purchases SET step = ${c.step}, error = NULL, updated_at = now() WHERE id = ${c.id} AND step = 'stuck'`
  })).pipe(Effect.orDie)
  return at
})
/** Bitrefill's invoices expire after 60 minutes; one we haven't paid within 40 is asked for again. */
const INVOICE_TTL_MS = 40 * 60_000
/** This long after its invoice, a payment is never signed again: the invoice expires at 60 minutes. */
const PAY_SEND_LIMIT_MS = 50 * 60_000
/** Why a card couldn't be ordered: their Bitrefill login lapsed, and there's no Checkout Email to fall back on. */
const LOGIN_LAPSED = "Your Bitrefill login expired. Connect again or add an email in Wallet."
/** A delivered card's use-by date from its Redemption Data, as ISO; null if it has none or it isn't a date. */
export const useByOf = (redemption: Readonly<Record<string, unknown>>) => {
  const at = Date.parse(redemptionFields(redemption).expires ?? "")
  return Number.isNaN(at) ? null : new Date(at).toISOString()
}

/** The email shape Bitrefill's buy-products accepts. */
const EMAIL = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/
/** About six hours of retries with backoff (30s doubling, capped at an hour). */
const MAX_ATTEMPTS = 12
/** Unfinished cards one account may have at once: a full Cart. */
const MAX_OPEN_PER_ACCOUNT = MAX_CART
/** Admissions the contract refused that one account may cause in ten minutes: each one cost the operator a fee. */
const MAX_RECENT_REFUSALS = 3
/** Price lookups that found nothing, per account per minute: each one spent one of Bitrefill's lookups. */
const MAX_PRICE_MISSES = 3
const DAY_MS = 24 * 60 * 60 * 1000
/** A charged checkout still waiting for money is refunded this long before the customer could Reclaim it. */
const RECLAIM_MARGIN_MS = 60 * 60 * 1000
/** A checkout that waited longer than this for money is re-priced before it's admitted. */
const REPRICE_AFTER_MS = 10 * 60 * 1000
const time = (v: Date | string) => new Date(v).getTime()
/** When the contract admitted (and so charged) a checkout's cards; its creation for one saved without it. */
const admittedAt = (co: CheckoutRow, cards: ReadonlyArray<Row>) => {
  const at = cards[0]?.admitted?.created_at
  return at ? Number(at) * 1000 : time(co.created_at)
}
/** A charged checkout that is refunded rather than tried again: it has waited `waitMinutes`, or the customer could soon Reclaim it. */
const overdue = (co: CheckoutRow, cards: ReadonlyArray<Row>, waitMinutes: number) =>
  Date.now() - time(co.created_at) > waitMinutes * 60_000 || Date.now() > admittedAt(co, cards) + DAY_MS - RECLAIM_MARGIN_MS
const total = (cards: ReadonlyArray<Row>) => cards.reduce((s, c) => s + Number(c.reference_price), 0)
/** Each card as Bitrefill is asked about it; one delivered before carries the order it holds (matchOrders). */
const cardsOf = (cards: ReadonlyArray<Row>): Array<Card> =>
  cards.map((c) => ({ id: c.voucher_id, value: c.package_value, ...(c.order_id ? { orderId: c.order_id } : {}) }))

/** A Lucky card drawn by a transaction we didn't record (anyone may finish a Draw): what the program keeps of it. */
const chainDraw = (c: ChainCard) =>
  c.mode.kind === "Lucky" ? { game_version: c.mode.fields[0], final_price: String(c.max_price - c.cashback), cashback: String(c.cashback) } : null

const toProgramMode = (m: Mode): ProgramMode => (m === "normal" ? { kind: "Normal" } : { kind: "Lucky", fields: [m.lucky] })
const fromProgramMode = (m: ProgramMode): Mode => (m.kind === "Normal" ? "normal" : { lucky: m.fields[0] })
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex")
/** A Draw Proof as kept with its card: the program's record, its request, and the transactions that filled and finished it. */
const proofOf = (d: DrawEvent, finish: string, fill: string | undefined) => ({
  game_version: d.game_version,
  seed: hex(d.seed),
  random: hex(d.random),
  roll: d.roll,
  final_bps: d.final_bps,
  final_price: String(d.final_price),
  cashback: String(d.cashback),
  randomness: hex(d.randomness),
  request: d.request.toBase58(),
  round: d.round,
  finish,
  ...(fill ? { fill } : {})
})
/** Where a checkout goes once no card waits at its own step. */
const onward = (steps: ReadonlyArray<Step>): CheckoutStep =>
  steps.some((s) => s === "confirm" || s === "fail")
    ? "settle"
    : steps.includes("delivery")
    ? "delivery"
    : steps.includes("drawing")
    ? "draw"
    : "done"

/** One card to price in a Cart: what `quoteCart` takes. */
export interface CartLine {
  readonly voucherId: string
  readonly value: string
  readonly mode: Mode
}

export class Purchases extends Context.Service<Purchases, {
  quote(voucherId: string, value: string, game: number | undefined): Effect.Effect<Quote, BitrefillUnavailable | PurchaseInvalid>
  /**
   * A Cart's terms as the contract would admit it now (`quote_many`): each Lucky card priced on the reserve the cards
   * before it left. A Lucky card the reserve can't cover at all comes back Normal.
   */
  quoteCart(lines: ReadonlyArray<CartLine>): Effect.Effect<ReadonlyArray<Quote>, BitrefillUnavailable | PurchaseInvalid>
  create(accountId: string, input: NewPurchase): Effect.Effect<Purchase, BitrefillUnavailable | PurchaseInvalid>
  /** Every card in a Cart, or none, as one checkout: the cards come back in the Cart's order. */
  createCart(accountId: string, inputs: ReadonlyArray<NewPurchase>): Effect.Effect<ReadonlyArray<Purchase>, BitrefillUnavailable | PurchaseInvalid>
  /** Newest first. `before`: the id of the last purchase already seen; `limit`: the page size (100 unless given). */
  list(accountId: string, page?: { readonly before?: string | undefined; readonly limit?: number | undefined }): Effect.Effect<PurchasePage>
  get(accountId: string, id: string): Effect.Effect<Purchase, NotFound>
  /** The customer cancels a checkout still waiting for money, by any of its cards: nothing was charged. */
  cancel(accountId: string, id: string): Effect.Effect<Purchase, NotFound | PurchaseInvalid>
  /** The customer marks their own delivered card used, or unused again; nothing else changes. */
  setUsed(accountId: string, id: string, used: boolean): Effect.Effect<Purchase, NotFound | PurchaseInvalid>
  /** One pass over checkouts waiting for money (also runs every 10 seconds by itself). */
  readonly promoteWaiting: Effect.Effect<void>
  /** One reconciler pass (also runs every 30 seconds by itself). */
  readonly reconcileNow: Effect.Effect<void>
  /** The customer's Checkout Email, and whether buying needs one (ADR-0012). */
  checkoutEmail(accountId: string): Effect.Effect<CheckoutEmail>
  setCheckoutEmail(accountId: string, email: string): Effect.Effect<CheckoutEmail, PurchaseInvalid>
  /** The use-by date (ISO) on the last card of this voucher delivered in the last 60 days, if any. */
  useBy(voucherId: string): Effect.Effect<string | undefined>
}>()("luckout/Purchases") {
  static readonly layer = Layer.effect(
    Purchases,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const solana = yield* Solana
      const program = solana.program
      const bitrefill = yield* Bitrefill
      const sales = yield* Sales
      const alerts = yield* Alerts
      const connect = yield* Connect
      const key = yield* SealKey
      // Off mainnet only Bitrefill's test cards are sold: balances there are test money.
      const testnet = solana.cluster !== "mainnet"
      /** One admission at a time: each takes the customer's next Checkout number (ADR-0015).
       * ponytail: one lock for every customer; per-customer locks if admissions ever queue. */
      const admitLock = yield* Semaphore.make(1)
      /** Deciding "go or wait" on the float and recording it happen under one lock, so two checkouts never count on the same money. */
      const floatLock = yield* Semaphore.make(1)
      const webOrigin = yield* Config.String("WEB_ORIGIN").pipe(Config.withDefault("http://localhost:3000"))
      /** How long a buy request waits for its cards before answering "pending" (under Cloudflare's 100 s). */
      const requestWait = yield* Config.Number("PURCHASE_REQUEST_WAIT_MS").pipe(Config.withDefault(60_000))

      // Redemption Data is encrypted at rest (Seal.ts), bound to its purchase id.
      const seal = (id: string, data: unknown) => sealWith(Option.getOrThrow(key), id, data)
      const unseal = (id: string, sealed: string) => unsealWith(Option.getOrThrow(key), id, sealed) as Record<string, unknown>

      // The Checkout Email is sealed like Redemption Data (bound to its account). Its keyed hash lets Bitrefill's
      // per-email limits be counted without reading it, and gives the same value for the same email on any account.
      const emailKey = (email: string) => createHmac("sha256", Option.getOrThrow(key)).update(`checkout-email:${email}`).digest("hex")
      const emailOf = (accountId: string) =>
        sql<{ email: string; email_key: string }>`SELECT email, email_key FROM checkout_emails WHERE account_id = ${accountId}`.pipe(
          Effect.orDie,
          Effect.map(([r]) => (r ? { email: String(unseal(`email:${accountId}`, r.email)), key: r.email_key } : undefined))
        )
      // A customer who connected their own Bitrefill account needs no email: their cards are bought on it.
      const checkoutEmail = (accountId: string) =>
        Effect.gen(function*() {
          const [e, connected] = yield* Effect.all([Option.isNone(key) ? Effect.succeed(undefined) : emailOf(accountId), connect.connected(accountId)])
          const needed = bitrefill.guest && !connected
          const used = needed && e ? yield* guestUse(e.key) : undefined
          return new CheckoutEmail({ needed, ...(e ? { email: e.email } : {}), ...(connect.offered ? { bitrefill: connected } : {}), ...(used ? { used } : {}) })
        })
      const setCheckoutEmail = (accountId: string, input: string) =>
        Effect.gen(function*() {
          if (Option.isNone(key)) return yield* new PurchaseInvalid({ message: "Purchases are disabled: REDEMPTION_KEY is not set" })
          const email = input.trim().toLowerCase()
          if (email.length > 254 || !EMAIL.test(email)) return yield* new PurchaseInvalid({ message: "That doesn't look like an email address." })
          yield* sql`INSERT INTO checkout_emails (account_id, email, email_key) VALUES (${accountId}, ${seal(`email:${accountId}`, email)}, ${emailKey(email)})
                     ON CONFLICT (account_id) DO UPDATE SET email = EXCLUDED.email, email_key = EXCLUDED.email_key, updated_at = now()`.pipe(Effect.orDie)
          return yield* checkoutEmail(accountId)
        })

      // A card is ordered within two days of being placed (a day waiting for the float at most, then refunded before
      // Reclaim), so one placed longer ago than 32 days can't count, and the email's index still narrows the rows.
      const counted = sql.literal(GUEST_COUNTED_AT)
      /** What an email has used of a guest's limits: every card ordered for it through Luckout, on any account. */
      const guestUse = (emailKeyValue: string) =>
        sql<{ orders: number; day: string; month: string }>`
          SELECT count(*) FILTER (WHERE ${counted} > now() - interval '1 day')::int AS orders,
                 COALESCE(sum(reference_price) FILTER (WHERE ${counted} > now() - interval '1 day'), 0)::text AS day,
                 COALESCE(sum(reference_price) FILTER (WHERE ${counted} > now() - interval '30 days'), 0)::text AS month
          FROM purchases
          WHERE email_key = ${emailKeyValue} AND created_at > now() - interval '32 days'
            AND step <> 'rejected' AND NOT (step = 'failed' AND invoice_id IS NULL)`.pipe(
          Effect.orDie,
          Effect.map(([u]) => ({ orders: u?.orders ?? 0, day: Number(u?.day ?? 0), month: Number(u?.month ?? 0) }))
        )
      const overGuestLimit = (emailKeyValue: string, price: number, count: number) =>
        Effect.map(guestUse(emailKeyValue), (u) => guestLimitRefusal(u, price, count))

      const load = (id: string) => sql<Row>`SELECT * FROM purchases WHERE id = ${id}`.pipe(Effect.map((r) => r[0]!), Effect.orDie)
      const loadCheckout = (id: string) => sql<CheckoutRow>`SELECT * FROM checkouts WHERE id = ${id}`.pipe(Effect.map((r) => r[0]!), Effect.orDie)
      const cardsIn = (checkoutId: string) => sql<Row>`SELECT * FROM purchases WHERE checkout_id = ${checkoutId} ORDER BY position`.pipe(Effect.orDie)
      const cards = stepRows(sql, "purchases")
      const checkouts = stepRows(sql, "checkouts")
      const saveCheckout = checkouts.save

      /**
       * Moves a checkout on from the step it was loaded at, and with it (`all`) every card still at that step (they
       * are, until delivery), together. False if another run already moved it: this one then stops. `each` moves single
       * cards on from their own step, with fields of their own.
       */
      const move = (
        co: CheckoutRow,
        fields: Record<string, unknown> & { step: CheckoutStep },
        all?: Record<string, unknown> & { step: Step },
        each: ReadonlyArray<readonly [Row, Record<string, unknown> & { step: Step }]> = []
      ) =>
        sql.withTransaction(Effect.gen(function*() {
          if (!(yield* checkouts.move(co, fields))) return false
          for (const [card, f] of each) yield* cards.move(card, f)
          if (all) {
            yield* sql`UPDATE purchases SET ${sql.update(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, json(v)])))}, updated_at = now()
                       WHERE checkout_id = ${co.id} AND step = ${co.step}`
          }
          return true
        })).pipe(Effect.orDie)

      /** Every card still at the checkout's step fails (refunded at settle), and the checkout goes to settle. */
      const failAll = (co: CheckoutRow, error: string, also: Record<string, unknown> = {}) =>
        move(co, { step: "settle", error, ...also }, { step: "fail", error, ...also })

      /** Sends (or resumes) one operator transaction whose signed bytes live in the checkout's `column`. */
      const submit = (
        co: CheckoutRow,
        column: "admit_tx" | "settle_tx",
        build: Effect.Effect<{ readonly ix: TransactionInstruction; readonly also?: Record<string, unknown> }, Unknown | ProgramRejected>
      ) => {
        const fresh: Effect.Effect<Outcome, ProgramRejected | Unknown> = Effect.flatMap(
          build,
          ({ ix, also }) => solana.send([ix], ["operator"], (signed) => saveCheckout(co.id, { [column]: signed, ...also }))
        )
        const saved = co[column]
        const sent: Effect.Effect<Outcome, ProgramRejected | Unknown | TxExpired> = saved ? solana.resume(saved) : fresh
        return sent.pipe(Effect.catchTag("TxExpired", () => fresh))
      }

      /** USDC the Pay Wallet can still spend: its balance, less what checkouts on their way are yet to pay. */
      const freeFloat = Effect.gen(function*() {
        const config = yield* solana.config
        const account = yield* solana.account(config.pay_wallet)
        const balance = account ? Number(account.data.readBigUInt64LE(64)) : 0
        const [r] = yield* sql<{ owed: string }>`
          SELECT COALESCE(sum(reference_price), 0)::text AS owed FROM purchases
          WHERE step IN ('admit', 'ordering', 'pay') AND voucher_id NOT LIKE 'test-%'`.pipe(Effect.orDie)
        return balance - Number(r?.owed ?? 0)
      })
      /** Runs `f` with the free float, under the float's lock. An unreadable float counts as empty: the checkout waits. */
      const floatGuard = <A, E>(f: (free: number) => Effect.Effect<A, E>) =>
        floatLock.withPermits(1)(Effect.flatMap(freeFloat.pipe(Effect.orElseSucceed(() => 0)), f))

      /**
       * Finishes the Draws of a checkout's cards waiting on randomness: each request ORAO has filled in is finished (by
       * us, though anyone could), and one still empty an hour after it was made is asked again. True if a card moved.
       */
      const finishDraws = (co: CheckoutRow, all: ReadonlyArray<Row>) =>
        Effect.gen(function*() {
          const drawing = all.filter((c) => c.step === "drawing")
          if (drawing.length === 0) return false
          const address = new PublicKey(co.address!)
          const wallet = new PublicKey(co.account_id)
          const onchain = yield* solana.checkout(address)
          let moved = false
          if (!onchain) {
            // Closed: someone else finished the last Draws. Their transactions on the account still hold the proofs.
            for (const signature of yield* solana.signatures(address, 20)) {
              const tx = yield* solana.transaction(signature)
              for (const e of tx?.events.filter((ev) => ev.name === "Draw") ?? []) {
                const d = e.data as unknown as DrawEvent
                const c = drawing.find((r) => r.position === d.card)
                if (c && (yield* cards.move(c, { step: "settled", round: d.round, draw: proofOf(d, signature, undefined) }))) moved = true
              }
            }
            return moved
          }
          for (const c of drawing) {
            const card = onchain.cards[c.position]!
            if (card.status.kind === "Delivered" && (yield* cards.move(c, { step: "settled", draw: chainDraw(card) }))) moved = true
          }
          const waiting = drawing.filter((c) => onchain.cards[c.position]!.status.kind === "Drawing")
          for (const round of new Set(waiting.map((c) => onchain.cards[c.position]!.round))) {
            const request = oraoRequest(address, round)
            const value = filledRandomness((yield* solana.account(request))?.data ?? Buffer.alloc(0))
            if (value) {
              const out = yield* solana.send([
                program.instruction("finish_draw", {
                  config: program.config,
                  customer: program.customer(wallet),
                  checkout: address,
                  randomness: request,
                  checkout_payer: onchain.payer,
                  event_authority: program.eventAuthority,
                  program: program.id
                }, { round })
              ], [], () => Effect.void).pipe(Effect.catchTag("ProgramRejected", (e) => Effect.succeed(e)))
              // Finished by someone else meanwhile: the next pass reads it from the account.
              if (out instanceof ProgramRejected) continue
              const settled = new Set(waiting.flatMap((c) => (c.settle_tx ? [c.settle_tx.signature] : [])))
              const fill = (yield* solana.signatures(request, 5)).find((s) => s !== out.signature && !settled.has(s))
              for (const e of out.events.filter((ev) => ev.name === "Draw")) {
                const d = e.data as unknown as DrawEvent
                const c = waiting.find((r) => r.position === d.card)
                if (c && (yield* cards.move(c, { step: "settled", round, draw: proofOf(d, out.signature, fill) }))) moved = true
              }
            } else if (Date.now() / 1000 >= Number(onchain.requested_at) + 3600) {
              const state = yield* solana.account(ORAO_NETWORK_STATE)
              if (!state) continue
              yield* solana.send([
                program.instruction("request_again", {
                  payer: solana.feePayer,
                  checkout: address,
                  old_request: request,
                  vrf: ORAO_VRF,
                  network_state: ORAO_NETWORK_STATE,
                  treasury: oraoTreasury(state.data),
                  request: oraoRequest(address, onchain.rounds)
                }, { round })
              ], [], () => Effect.void).pipe(
                // Only once it went through: the chain's clock may lag ours, and this runs every 2 seconds.
                Effect.andThen(alerts.admin(`checkout ${co.id}: ORAO hadn't filled round ${round} after an hour; asked again`)),
                Effect.catchTag("ProgramRejected", (e) => Effect.logWarning(`checkout ${co.id}: request_again refused (${e.message})`))
              )
            }
          }
          return moved
        })

      /** One step forward. Returns false when the checkout is finished or must wait. */
      const step = (co: CheckoutRow, resumed: boolean): Effect.Effect<boolean, Unknown> =>
        Effect.gen(function*() {
          const all = yield* cardsIn(co.id)
          const shared = all.filter((c) => c.step === co.step)
          switch (co.step) {
            case "admit": {
              // A checkout that waited for money is admitted at today's prices (CONTEXT: Reference Price is the current
              // Bitrefill price). A higher one can't pass the customer's max_debit, so the contract refuses the cart,
              // uncharged; a lower one costs them less. Only before anything is signed for it.
              if (!co.admit_tx && Date.now() - time(co.created_at) > REPRICE_AFTER_MS) {
                let changed = false
                for (const c of all) {
                  const now = yield* price(c.voucher_id, c.package_value, true).pipe(
                    Effect.map((p) => p.referencePrice),
                    Effect.orElseSucceed(() => Number(c.reference_price))
                  )
                  if (now !== Number(c.reference_price)) {
                    const lucky = c.quoted_lucky_amount === null ? null : Math.min(Number(c.quoted_lucky_amount), now)
                    yield* sql`UPDATE purchases SET reference_price = ${now}, quoted_lucky_amount = ${lucky} WHERE id = ${c.id} AND step = 'admit'`.pipe(Effect.orDie)
                    changed = true
                  }
                }
                if (changed) return true
              }
              const wallet = new PublicKey(co.account_id)
              // One at a time, each under the customer's next Checkout number: that makes admission idempotent onchain (a
              // retry of an admitted checkout can't debit twice, even after its account has closed).
              const outcome = yield* admitLock.withPermits(1)(
                submit(
                  co,
                  "admit_tx",
                  Effect.gen(function*() {
                    const customer = yield* solana.customer(wallet)
                    if (!customer) return yield* new ProgramRejected({ message: "No balance yet; add funds first" })
                    const address = program.checkout(wallet, customer.checkouts)
                    const ix = program.instruction("admit", {
                      operator: solana.operator,
                      payer: solana.feePayer,
                      config: program.config,
                      customer: program.customer(wallet),
                      checkout: address
                    }, {
                      number: customer.checkouts,
                      cards: all.map((c) => ({
                        reference_price: BigInt(c.reference_price),
                        mode: c.requested_mode === null ? null : toProgramMode(c.requested_mode),
                        max_debit: BigInt(c.max_debit ?? c.reference_price),
                        lucky_amount: c.quoted_lucky_amount === null ? null : BigInt(c.quoted_lucky_amount)
                      }))
                    })
                    return { ix, also: { number: String(customer.checkouts), address: address.toBase58() } }
                  })
                ).pipe(Effect.catchTag("ProgramRejected", (e: ProgramRejected) => Effect.succeed(e)))
              )
              const saved = yield* loadCheckout(co.id)
              // Refused, e.g. the price or the Cashback Reserve moved since the customer confirmed: their words, nothing charged.
              if (outcome instanceof ProgramRejected) {
                yield* move(co, { step: "rejected", error: outcome.message }, { step: "rejected", error: outcome.message, admit_tx: saved.admit_tx })
                return false
              }
              const onchain = yield* solana.checkout(new PublicKey(saved.address!))
              if (!onchain) return yield* new SolanaUnavailable({ message: `checkout ${co.id}: its account isn't visible yet` })
              const each = all.map((c) => {
                const card = onchain.cards[c.position]!
                const admitted = { mode: fromProgramMode(card.mode), max_price: String(card.max_price), lucky_amount: String(card.lucky_amount), created_at: String(onchain.created_at) }
                return [c, { step: "ordering" as const, contract_purchase_id: c.position, admitted, admit_tx: saved.admit_tx }] as const
              })
              return yield* move(co, { step: "ordering" }, undefined, each)
            }
            case "ordering": {
              if (bitrefill.guest) {
                // Charged long ago and still not paid for (Base or Bitrefill kept failing): nothing was signed, so
                // refund it now rather than order again, and a late card never races a Reclaim.
                if (!co.pay_tx && overdue(co, all, WAIT_MINUTES)) {
                  yield* alerts.admin(`checkout ${co.id} couldn't be ordered and paid for in time; refunding it in full`)
                  return yield* failAll(co, "We couldn't order and pay for this card in time")
                }
                // On the customer's own Bitrefill account if they connected it (a login Bitrefill stops taking is
                // renewed once); without one, or once it lapsed, as a guest with the Checkout Email it was placed under.
                // One placed on their own account kept none, and falls back to the email they have now.
                const kept = co.email ? String(unseal(`checkout-email:${co.id}`, co.email)) : undefined
                const place = (renew: boolean) =>
                  Effect.gen(function*() {
                    const token = yield* connect.token(co.account_id, renew)
                    if (token) return { buyer: "account" as const, email_key: null, order: yield* bitrefill.order(cardsOf(shared), { token }) }
                    const email = kept ? { email: kept, key: emailKey(kept) } : yield* emailOf(co.account_id)
                    if (!email) return undefined
                    return { buyer: "guest" as const, email_key: email.key, order: yield* bitrefill.order(cardsOf(shared), { email: email.email }) }
                  })
                let placed = yield* place(false)
                if (placed?.buyer === "account" && placed.order._tag === "Refused" && placed.order.reason.startsWith("HTTP 401")) placed = yield* place(true)
                if (!placed) return yield* failAll(co, LOGIN_LAPSED)
                const { order, ...buyer } = placed
                if (order._tag !== "Invoiced") return yield* failAll(co, `Bitrefill refused: ${"reason" in order ? order.reason : order._tag}`, buyer)
                // Never pay Bitrefill more than the prices the contract admitted (what the customer is charged).
                if (order.amount > total(shared)) {
                  return yield* failAll(co, `Bitrefill's invoice ${order.invoiceId} costs ${usd(order.amount)}, more than the admitted ${usd(total(shared))}`)
                }
                return yield* move(co, {
                  step: "pay",
                  ...buyer,
                  invoice_id: order.invoiceId,
                  invoice_token: seal(`invoice:${co.id}`, order.accessToken),
                  invoice_at: new Date().toISOString(),
                  pay_to: order.payTo,
                  pay_amount: order.amount,
                  pay_tx: null
                }, { step: "pay", ...buyer, invoice_id: order.invoiceId })
              }
              if (resumed) {
                const error = "Bitrefill order outcome unknown; check the Bitrefill account"
                yield* move(co, { step: "stuck", error }, { step: "stuck", error })
                yield* Effect.logError("checkout stuck at ordering", co.id)
                return false
              }
              const order = yield* bitrefill.order(cardsOf(shared))
              if (order._tag === "Ordered") {
                const at = new Date().toISOString()
                return yield* move(co, { step: "delivery", invoice_id: order.invoiceId, ordered_at: at }, { step: "delivery", invoice_id: order.invoiceId, ordered_at: at })
              }
              if (order._tag === "NoCredit") {
                // Nothing was ordered or paid: wait for credit instead of refunding straight away.
                yield* move(co, { step: "restock", error: order.reason }, { step: "restock", error: order.reason })
                return false
              }
              return yield* failAll(co, `Bitrefill refused: ${"reason" in order ? order.reason : order._tag}`)
            }
            case "pay": {
              // Never signed for in time: ask for a fresh invoice (this one would expire before Bitrefill saw it).
              if (!co.pay_tx && Date.now() - time(co.invoice_at!) > INVOICE_TTL_MS) {
                return yield* move(co, { step: "ordering", invoice_id: null, invoice_token: null, invoice_at: null, pay_to: null, pay_amount: null }, {
                  step: "ordering",
                  invoice_id: null
                })
              }
              if (!solana.payWallet || !solana.feePayer) return yield* new SolanaUnavailable({ message: "the Pay Wallet's or fee payer's key isn't set" })
              const payWallet = solana.payWallet
              const feePayer = solana.feePayer
              // Saved before it's sent, and only over the payment this run was handed (none, or the lost one it replaces),
              // while the invoice is fresh: a run that loaded the checkout before another saved its payment stops here.
              const savePayment = (p: Signed) =>
                sql<{ id: string }>`
                  UPDATE checkouts SET pay_tx = ${JSON.stringify(p)}::jsonb, updated_at = now()
                  WHERE id = ${co.id} AND step = 'pay' AND pay_tx->>'signature' IS NOT DISTINCT FROM ${co.pay_tx?.signature ?? null}
                    AND invoice_at > now() - interval '50 minutes'
                  RETURNING id`.pipe(
                  Effect.orDie,
                  Effect.flatMap((saved) =>
                    saved.length === 1
                      ? Effect.void
                      : Effect.die(`checkout ${co.id}: another run saved a payment first, or invoice ${co.invoice_id} neared expiry; not sending`)
                  )
                )
              const fresh = Effect.gen(function*() {
                const config = yield* solana.config
                const payee = new PublicKey(co.pay_to!)
                const payeeUsdc = getAssociatedTokenAddressSync(config.usdc_mint, payee, true)
                return yield* solana.send([
                  createAssociatedTokenAccountIdempotentInstruction(feePayer, payeeUsdc, payee, config.usdc_mint),
                  createTransferCheckedInstruction(config.pay_wallet, config.usdc_mint, payeeUsdc, payWallet, BigInt(co.pay_amount!), 6)
                ], ["payWallet"], savePayment)
              })
              // A payment that never landed is signed again while the invoice is fresh; past that, the invoice is asked for again.
              const sent: Effect.Effect<Outcome, ProgramRejected | SolanaUnavailable | TxExpired> = co.pay_tx ? solana.resume(co.pay_tx) : fresh
              const result: Outcome | ProgramRejected | "late" = yield* sent.pipe(
                Effect.catchTag("TxExpired", (): Effect.Effect<Outcome | "late", ProgramRejected | SolanaUnavailable> =>
                  Date.now() - time(co.invoice_at!) < PAY_SEND_LIMIT_MS ? fresh : Effect.succeed("late" as const)),
                Effect.catchTag("ProgramRejected", (e) => Effect.succeed(e))
              )
              if (result === "late") {
                return yield* move(co, { step: "ordering", invoice_id: null, invoice_token: null, invoice_at: null, pay_to: null, pay_amount: null, pay_tx: null }, {
                  step: "ordering",
                  invoice_id: null
                })
              }
              if (result instanceof ProgramRejected) {
                // Nothing moved (say, the float ran short): wait for money like any other, then order afresh.
                const error = `The payment failed, so nothing was paid: ${result.message}`
                yield* move(co, { step: "restock", error, pay_tx: null, invoice_id: null, invoice_token: null, invoice_at: null }, {
                  step: "restock",
                  error,
                  invoice_id: null
                })
                yield* alerts.admin(`checkout ${co.id}: its payment to Bitrefill failed (${result.message}); it waits for the Pay Wallet's float`)
                return false
              }
              const at = new Date().toISOString()
              return yield* move(co, { step: "delivery", ordered_at: at }, { step: "delivery", ordered_at: at })
            }
            case "delivery": {
              // Cards already settled may be waiting for their Draws: finish those first, so a slow card never holds them.
              if (yield* finishDraws(co, all)) return true
              if (shared.length === 0) return yield* move(co, { step: onward(all.map((c) => c.step)) })
              const token = co.invoice_token ? String(unseal(`invoice:${co.id}`, co.invoice_token)) : undefined
              // Bitrefill is asked about every card of the invoice, in the order they were ordered (the cards it was
              // ordered for keep its id), so each is matched to its own order. Asked about alone, a card still on its
              // way would be matched to the first order for the same card and amount: another copy's, already delivered.
              const invoiced = all.filter((c) => c.invoice_id === co.invoice_id)
              const found = yield* bitrefill.delivery(co.invoice_id!, token, cardsOf(invoiced))
              const each: Array<readonly [Row, Record<string, unknown> & { step: Step }]> = []
              const undelivered: Array<string> = []
              const blank: Array<string> = []
              // Each card keeps the order it was delivered from, and is asked about with it, so it takes that order again
              // however Bitrefill lists them (matchOrders). Should a card still come back with an order another card of
              // the checkout holds, it waits as still on its way: a code never goes to two cards. Its own it may always take.
              const holder = new Map(invoiced.flatMap((c) => (c.order_id ? [[c.order_id, c.id] as const] : [])))
              const misplaced: Array<string> = []
              for (const [i, c] of invoiced.entries()) {
                const d = found[i]!
                if (c.step !== "delivery") continue
                if (d._tag === "Delivered" && (holder.get(d.orderId) ?? c.id) !== c.id) {
                  misplaced.push(`purchase ${c.id} (order ${d.orderId})`)
                  continue
                }
                if (d._tag === "Delivered") {
                  holder.set(d.orderId, c.id)
                  each.push([c, { step: "confirm", redemption: seal(c.id, d.redemption), use_by: useByOf(d.redemption), order_id: d.orderId }])
                  const shown = redemptionFields(d.redemption)
                  if (shown.secrets.length === 0 && !shown.link) blank.push(`purchase ${c.id}`)
                }
                if (d._tag === "Failed") {
                  each.push([c, { step: "fail", error: d.reason }])
                  undelivered.push(`purchase ${c.id} (${d.reason})`)
                }
              }
              if (misplaced.length > 0) {
                yield* alerts.admin(
                  `checkout ${co.id}: Bitrefill matched ${misplaced.join(", ")} to an order another card of it already has, on invoice ${co.invoice_id}. Left waiting so no code goes to two cards; if it lasts, compare the invoice's orders with Bitrefill support.`
                )
              }
              // Every card still waiting is still on its way: asked again after the reconciler's backoff, not round settle at once.
              if (each.length === 0) return yield* new BitrefillUnavailable({ message: `invoice ${co.invoice_id} is still on its way` })
              if (undelivered.length > 0 && co.pay_tx) {
                // We paid this invoice from the Pay Wallet: the customer is refunded in full, and the money is ours to claim back.
                yield* alerts.admin(
                  `checkout ${co.id}: Bitrefill didn't deliver ${undelivered.join(", ")} on paid invoice ${co.invoice_id}; payment ${co.pay_tx.signature}. Claim the refund to the Pay Wallet.`
                )
              }
              const moved = yield* move(co, { step: "settle" }, undefined, each)
              if (moved && blank.length > 0) {
                // The customer sees only what else Bitrefill sent (its text or instructions), if anything. Never the data here.
                yield* alerts.admin(
                  `checkout ${co.id}: Bitrefill delivered ${blank.join(", ")} with no code or link we recognise on invoice ${co.invoice_id}. Check the card with Bitrefill support before the customer has to ask.`
                )
              }
              return moved
            }
            case "settle": {
              const due = all.filter((c) => c.step === "confirm" || c.step === "fail")
              if (due.length === 0) return yield* move(co, { step: onward(all.map((c) => c.step)), settle_tx: null })
              const delivered = due.filter((c) => c.step === "confirm")
              const failed = due.filter((c) => c.step === "fail")
              const address = new PublicKey(co.address!)
              const wallet = new PublicKey(co.account_id)
              const lucky = (c: Row) => typeof c.admitted?.mode === "object"
              const outcome = yield* submit(
                co,
                "settle_tx",
                Effect.gen(function*() {
                  const [config, onchain, state] = yield* Effect.all([solana.config, solana.checkout(address), solana.account(ORAO_NETWORK_STATE)])
                  if (!onchain) return yield* new ProgramRejected({ message: "Its Checkout account has closed" })
                  // Delivered Lucky cards share one randomness request, under the Checkout's next seed.
                  const randomness = delivered.some(lucky) && state
                    ? { vrf: ORAO_VRF, network_state: ORAO_NETWORK_STATE, treasury: oraoTreasury(state.data), request: oraoRequest(address, onchain.rounds) }
                    : {}
                  const ix = program.instruction("settle", {
                    operator: solana.operator,
                    payer: solana.feePayer,
                    config: program.config,
                    customer: program.customer(wallet),
                    checkout: address,
                    vault: program.vault,
                    vault_authority: program.vaultAuthority,
                    pay_wallet: config.pay_wallet,
                    checkout_payer: onchain.payer,
                    ...randomness
                  }, { delivered: Buffer.from(delivered.map((c) => c.position)), failed: Buffer.from(failed.map((c) => c.position)) })
                  return { ix }
                })
              ).pipe(Effect.catchTag("ProgramRejected", (e: ProgramRejected) => Effect.succeed(e)))
              if (outcome instanceof ProgramRejected) {
                // Refused as a whole, say one card was reclaimed meanwhile: read each card onchain before telling the
                // customer anything, close the ones that are closed, and settle the rest with a fresh transaction.
                yield* Effect.logWarning(`settlement of checkout ${co.id} refused (${outcome.message})`)
                const onchain = yield* solana.checkout(address)
                let closed = 0
                for (const c of due) {
                  // An account that has closed holds no open card: the ones we never settled were reclaimed.
                  const card = onchain?.cards[c.position]
                  const status = card?.status.kind ?? "Reclaimed"
                  if (status === "Pending") continue
                  closed++
                  const confirm = c.step === "confirm"
                  if (status === "Drawing") {
                    yield* cards.move(c, { step: "drawing", round: card!.round })
                    continue
                  }
                  if (status === "Delivered") {
                    if (confirm) {
                      const draw = chainDraw(card!)
                      yield* cards.move(c, { step: "settled", error: outcome.message, ...(draw ? { draw, settle_tx: null } : {}) })
                    } else {
                      yield* cards.move(c, { step: "stuck", error: `failing it was refused, delivered onchain: ${outcome.message}` })
                      yield* alerts.admin(`purchase ${c.id} is delivered onchain but we tried to fail it`)
                    }
                    continue
                  }
                  // Failed or Reclaimed: the customer already has the full amount back.
                  yield* cards.move(c, { step: "failed", error: status === "Reclaimed" ? "Reclaimed" : outcome.message })
                  if (confirm) yield* alerts.admin(`purchase ${c.id} was delivered but closed onchain as ${status}; its voucher cost is ours`)
                }
                yield* saveCheckout(co.id, { settle_tx: null, error: outcome.message })
                // Something moved: go on at once. Nothing did: the reconciler tries again with its backoff.
                return closed > 0
              }
              const signed = (yield* loadCheckout(co.id)).settle_tx
              const round = Number(outcome.events.find((e) => e.name === "DrawRequested")?.data.round ?? 0)
              const after = [
                ...delivered.map((c) => [c, lucky(c) ? { step: "drawing" as const, round, settle_tx: signed } : { step: "settled" as const, settle_tx: signed }] as const),
                ...failed.map((c) => [c, { step: "failed" as const, settle_tx: signed }] as const)
              ]
              const steps = all.map((c) => after.find(([a]) => a.id === c.id)?.[1].step ?? c.step)
              return yield* move(co, { step: onward(steps), settle_tx: null }, undefined, after)
            }
            case "draw": {
              if (!all.some((c) => c.step === "drawing")) return yield* move(co, { step: onward(all.map((c) => c.step)) })
              // ORAO fills a request in 4-20 s: wait for it here a little, then leave it to the reconciler.
              for (let i = 0; i < 15; i++) {
                if (yield* finishDraws(co, all)) return true
                yield* Effect.sleep("2 seconds")
              }
              return false
            }
            default:
              return false
          }
        })

      // Workflows run in fibers owned by this service, not by the HTTP request:
      // a client that disconnects stops waiting, but never stops a checkout mid-step.
      const workflows = yield* FiberSet.make<void, never>()

      // ponytail: in-process guard, assumes one server process (ADR-0006); use row locks if it ever scales out.
      const running = new Set<string>()

      /** One card's line in a message about how it ended; undefined while it's still on its way. */
      const ended = (row: Row) => {
        const what = `${row.voucher_name} ${row.package_value}`
        return row.step === "settled"
          ? `Your ${what} is ready.`
          : row.step === "failed"
          ? `Your ${what} couldn't be delivered. The full amount is back in your Luckout balance.`
          : row.step === "stuck"
          ? `Your ${what} needs a manual check by our team. We'll sort it out; you can also reclaim the full amount 24 hours after purchase.`
          : row.step === "rejected"
          ? `Your ${what} wasn't bought. ${row.error ?? ""}`.trim()
          : undefined
      }
      // A customer who left before the run finished hears about it in Telegram (if linked), once per checkout, once
      // every card has ended.
      const tell = (accountId: string, rows: ReadonlyArray<Row>) => {
        const lines = rows.map(ended)
        if (lines.length === 0 || lines.some((l) => l === undefined)) return Effect.void
        const text = rows.length > 1 && rows.every((r) => r.step === "rejected")
          ? `Your ${rows.length} cards weren't bought. ${rows[0]!.error ?? ""}`.trim()
          : rows.length > 1
          ? `${lines.join("\n")}\nSee ${rows.some((r) => r.step === "settled") ? "the codes" : "them"} at ${webOrigin}/purchases`
          : rows[0]!.step === "settled"
          ? `${lines[0]} See the code at ${webOrigin}/purchases`
          : lines[0]!
        // Telegram didn't take it (no answer, or it limited us): the reconciler sends it again, as for a Top-Up's.
        return Effect.flatMap(alerts.customer(accountId, text), (sent) =>
          sent ? Effect.void : sql`UPDATE checkouts SET retell = true WHERE id = ${rows[0]!.checkout_id}`.pipe(Effect.asVoid, Effect.orDie))
      }
      const notify = (checkoutId: string) => Effect.flatMap(loadCheckout(checkoutId), (co) => Effect.flatMap(cardsIn(co.id), (rows) => tell(co.account_id, rows)))

      const advance = (id: string, resumed: boolean, notifyAfter = resumed) =>
        Effect.suspend(() => {
          // Another run has this checkout: leave it, and leave its guard alone. Only the run that set the
          // guard clears it; a caller turned away here once cleared it, and the next one started a second run.
          if (running.has(id)) return Effect.void
          running.add(id)
          return Effect.gen(function*() {
            let first = true
            while (yield* Effect.flatMap(loadCheckout(id), (co) => step(co, resumed && first))) first = false
            if (notifyAfter) yield* notify(id)
          }).pipe(
            Effect.catch((e: Unknown) => Effect.logWarning(`checkout ${id} paused: ${e.message}`)),
            // Anything unexpected (database, decryption) pauses this checkout only; the reconciler retries it.
            Effect.catchCause((cause) => Effect.logError(`checkout ${id} paused`, cause)),
            Effect.ensuring(Effect.sync(() => running.delete(id)))
          )
        }).pipe(
          // A deploy or shutdown waits for the run to finish: stopping between a side effect and
          // saving its result would leave the checkout for a human (pm2 kill_timeout allows for it).
          Effect.uninterruptible
        )

      // A row that fails to decrypt (key missing or rotated) must not break the whole list.
      const openRedemption = (row: Row) => {
        try {
          return { redemption: unseal(row.id, row.redemption!) }
        } catch {
          return {}
        }
      }

      const view = (row: Row): Purchase => {
        const status = row.step === "settled" || row.step === "drawing"
          ? "delivered"
          : row.step === "failed" || row.step === "rejected"
          ? row.step
          : WAITING_STEPS.includes(row.step)
          ? "waiting"
          : "pending"
        const d = row.draw
        return new Purchase({
          id: row.id,
          checkoutId: row.checkout_id,
          voucherId: row.voucher_id,
          voucherName: row.voucher_name,
          ...bitrefill.logo(row.voucher_id),
          value: row.package_value,
          ...(row.currency ? { currency: row.currency } : {}),
          status,
          // Rejections are the contract's own words (limits, balance); internal details stay in the database.
          ...(status === "rejected" && row.error ? { error: row.error } : {}),
          ...(status === "failed"
            ? {
              error: row.error === "Reclaimed"
                ? "You reclaimed the full amount after 24 hours."
                : row.error === LOGIN_LAPSED
                ? `${LOGIN_LAPSED} The full amount went back to your balance.`
                : ORDER_LIMIT.test(row.error ?? "")
                ? row.buyer === "account"
                  ? "Your Bitrefill account's limit was reached just then. The full amount went back to your balance."
                  : "Bitrefill's daily order limit was reached just then. The full amount went back to your balance."
                : "Bitrefill couldn't deliver this voucher. The full amount went back to your balance."
            }
            : {}),
          ...(row.step === "stuck" ? { error: "This purchase needs a manual check. If it isn't resolved, you can reclaim the full amount after 24 hours." } : {}),
          ...(row.admitted ? { mode: row.admitted.mode } : row.requested_mode ? { mode: row.requested_mode } : {}),
          referencePrice: Number(row.reference_price),
          ...(row.admitted
            ? { maxPrice: Number(row.admitted.max_price), luckyAmount: Number(row.admitted.lucky_amount) }
            : {}),
          ...(d
            ? {
              // A Draw recorded from the chain (chainDraw) has no seed, random or roll: "" and 0 say so.
              draw: new Draw({
                gameVersion: Number(d.game_version),
                seed: String(d.seed ?? ""),
                random: String(d.random ?? ""),
                roll: Number(d.roll ?? 0),
                finalBps: Number(d.final_bps ?? 0),
                finalPrice: Number(d.final_price),
                cashback: Number(d.cashback),
                ...(d.finish ? { proof: { tx: String(d.finish), card: row.position } } : {})
              })
            }
            : {}),
          ...(row.redemption && (row.step === "settled" || row.step === "drawing") ? openRedemption(row) : {}),
          ...(row.admit_tx ? { admitTx: row.admit_tx.signature } : {}),
          ...(row.settle_tx ? { settleTx: row.settle_tx.signature } : {}),
          ...(row.contract_purchase_id !== null ? { contractPurchaseId: Number(row.contract_purchase_id) } : {}),
          createdAt: new Date(row.created_at).toISOString(),
          ...(row.used_at && row.step === "settled" ? { usedAt: new Date(row.used_at).toISOString() } : {})
        })
      }

      const price = (voucherId: string, value: string, purchase = false) =>
        Effect.gen(function*() {
          const voucher = yield* bitrefill.voucher(voucherId, { purchase })
          const pkg = voucher.packages.find((p) => p.value === value)
          if (!pkg) return yield* new PurchaseInvalid({ message: `${voucher.name} has no ${value} package` })
          return { voucher, referencePrice: pkg.priceMicroUsdc }
        })

      /** The RPC's own error text stays in our logs; the program's own refusal is the customer's answer. */
      const quoteRefused = (e: SolanaUnavailable | ProgramRejected) =>
        new PurchaseInvalid({
          message: e._tag === "ProgramRejected"
            ? e.message.includes("Reserve too small") ? "The reserve is too small for a Lucky Buy right now; use Normal" : e.message
            : "Couldn't get a price right now. Try again in a moment."
        })
      /**
       * A cart's terms (ADR-0013), from simulating the program's `quote_many`: each card priced on the reserve the cards
       * before it left. A card's confirmed Lucky Amount, when the reserve still covers it, is what it plays and locks, as
       * admission would. The server never works out a Lucky Amount itself (ADR-0004). Under the smallest Lucky Checkout,
       * read live from Config, the cards are one checkout's (luckyCheckout).
       */
      const contractQuotes = (items: ReadonlyArray<{ readonly referencePrice: number; readonly mode: Mode; readonly luckyAmount?: number | undefined }>) =>
        Effect.all([
          solana.simulate([
            program.instruction("quote_many", { config: program.config }, {
              items: items.map((i) => ({
                reference_price: BigInt(i.referencePrice),
                mode: toProgramMode(i.mode),
                lucky_amount: i.luckyAmount === undefined ? null : BigInt(i.luckyAmount)
              }))
            })
          ]),
          solana.config
        ], { concurrency: 2 }).pipe(
          Effect.map(([o, config]) =>
            luckyCheckout(
              decodeReturn<Array<ChainQuote>>("quote_many", o.returnData ?? Buffer.alloc(0)).map((q): QuoteView => ({
                mode: fromProgramMode(q.mode),
                reference_price: String(q.reference_price),
                lucky_amount: String(q.lucky_amount),
                max_price: String(q.max_price)
              })),
              Number(config.min_lucky_checkout)
            )
          ),
          Effect.tapError((e) => Effect.logWarning(`quote_many: ${e.message}`)),
          Effect.mapError(quoteRefused)
        )
      const contractQuote = (referencePrice: number, mode: Mode) => Effect.map(contractQuotes([{ referencePrice, mode }]), (qs) => qs[0]!)
      const toQuote = (q: QuoteView) =>
        new Quote({
          mode: q.mode,
          referencePrice: Number(q.reference_price),
          luckyAmount: Number(q.lucky_amount),
          maxPrice: Number(q.max_price),
          ...(q.belowMin ? { belowMin: true as const } : {})
        })

      const quote = Effect.fn("Purchases.quote")(function*(voucherId: string, value: string, game: number | undefined) {
        const { referencePrice } = yield* price(voucherId, value)
        const mode: Mode = game === undefined ? "normal" : { lucky: game }
        return toQuote(yield* contractQuote(referencePrice, mode))
      })

      const quoteCart = Effect.fn("Purchases.quoteCart")(function*(lines: ReadonlyArray<CartLine>) {
        if (lines.length === 0 || lines.length > MAX_CART) return yield* new PurchaseInvalid({ message: `A cart holds 1 to ${MAX_CART} cards` })
        const prices = yield* Effect.forEach(lines, (l) => price(l.voucherId, l.value))
        return (yield* contractQuotes(lines.map((l, i) => ({ referencePrice: prices[i]!.referencePrice, mode: l.mode })))).map(toQuote)
      })

      // Checked before a price is looked up or anything is signed, so an empty or capped account can neither use up
      // Bitrefill's price lookups nor make the operator pay gas for purchases the contract would refuse.
      /** An account's cards not finished yet: waiting for the float, or on their way. */
      const openCards = (accountId: string) =>
        sql<{ n: number }>`SELECT count(*)::int AS n FROM purchases WHERE account_id = ${accountId} AND step IN ${sql.in([...OPEN_STEPS, ...WAITING_STEPS])}`.pipe(
          Effect.orDie,
          Effect.map(([r]) => r?.n ?? 0)
        )
      const IN_PROGRESS = "You have purchases still in progress; try again when they finish"
      const preflightAccount = Effect.fn("Purchases.preflightAccount")(function*(accountId: string, count: number) {
        const invalid = (message: string) => new PurchaseInvalid({ message })
        if ((yield* openCards(accountId)) + count > MAX_OPEN_PER_ACCOUNT) return yield* invalid(IN_PROGRESS)
        const [n] = yield* sql<{ refused: number }>`
          SELECT count(*)::int AS refused FROM checkouts WHERE account_id = ${accountId} AND step = 'rejected' AND admit_tx IS NOT NULL
            AND created_at > now() - interval '10 minutes'`.pipe(Effect.orDie)
        // Each admission the contract refuses costs the operator a fee and the customer nothing.
        if ((n?.refused ?? 0) >= MAX_RECENT_REFUSALS) return yield* invalid("Several of your purchases were just refused; wait a few minutes and try again")
        const a = yield* solana.customer(new PublicKey(accountId)).pipe(
          Effect.mapError(() => invalid("Couldn't read your balance; try again in a moment"))
        )
        if (!a) return yield* invalid("No balance yet; add funds first")
        if (Number(a.balance) < MIN_PRICE) return yield* invalid("Insufficient balance; add funds first")
        return a
      })

      // ponytail: in memory, one process; a restart forgets it. A lookup that finds no card still spends one of the
      // 24 a minute a purchase may use (Bitrefill.ts), so an account gets only a few misses a minute.
      const misses = new Map<string, { n: number; until: number }>()
      const missed = (accountId: string) =>
        Effect.sync(() => {
          const now = Date.now()
          if (misses.size > 1_000) for (const [k, m] of misses) if (m.until < now) misses.delete(k)
          const m = misses.get(accountId)
          misses.set(accountId, m && m.until > now ? { n: m.n + 1, until: m.until } : { n: 1, until: now + 60_000 })
        })

      // Checks and records one checkout, all its cards or none: one card for Buy, every card in a Cart. Returns the
      // checkout, its cards' ids in the order asked, and whether it goes ahead now (or waits for money, or existed).
      const place = Effect.fn("Purchases.place")(function*(accountId: string, inputs: ReadonlyArray<NewPurchase>) {
        const invalid = (message: string) => new PurchaseInvalid({ message })
        if (Option.isNone(key)) return yield* invalid("Purchases are disabled: REDEMPTION_KEY is not set")
        if (inputs.length === 0 || inputs.length > MAX_CART) return yield* invalid(`A cart holds 1 to ${MAX_CART} cards`)
        // A retry of a purchase already made still returns it below; only new ones are held back.
        const shop = yield* sales.status
        // Testnet balances are test money: never let them buy a real voucher paid from our real Bitrefill balance.
        if (testnet && inputs.some((i) => !i.voucherId.startsWith("test-"))) return yield* invalid("On testnet only Bitrefill test vouchers can be bought")
        const keys = inputs.map((i) => i.idempotencyKey)
        if (new Set(keys).size !== keys.length) return yield* invalid("Each card in a cart needs its own key")
        const byKey = sql<{ id: string; idempotency_key: string; checkout_id: string }>`
          SELECT id, idempotency_key, checkout_id FROM purchases WHERE account_id = ${accountId} AND idempotency_key IN ${sql.in(keys)}`.pipe(
          Effect.orDie,
          Effect.map((rows) => keys.flatMap((k) => rows.filter((r) => r.idempotency_key === k)))
        )
        // A retry with the same keys returns the original purchases instead of buying again. Some of these cards sent
        // before and others not (say, one added after an attempt that seemed to fail) is refused: buying only the new
        // ones, or answering with only the old, would leave the customer guessing.
        const sentBefore = (rows: ReadonlyArray<{ id: string; checkout_id: string }>) =>
          rows.length !== keys.length || new Set(rows.map((r) => r.checkout_id)).size > 1
            ? Effect.fail(invalid("Some of these cards were already sent in an earlier checkout. Check Purchases, remove those from your cart, and try again."))
            : Effect.succeed({ checkoutId: rows[0]!.checkout_id, ids: rows.map((r) => r.id), go: false })
        const existing = yield* byKey
        if (existing.length > 0) return yield* sentBefore(existing)
        if (!shop.open) return yield* invalid(closedMessage(shop))
        const account = yield* preflightAccount(accountId, inputs.length)
        const miss = misses.get(accountId)
        if (miss && miss.until > Date.now() && miss.n >= MAX_PRICE_MISSES) {
          return yield* invalid("We couldn't find several cards you asked for; try again in a minute")
        }
        // In a Cart, a refusal says which card it's about.
        const about = (i: number, name: string) => (e: PurchaseInvalid) =>
          inputs.length === 1 ? e : new PurchaseInvalid({ message: `${name} ${inputs[i]!.value}: ${e.message}` })
        const priced = yield* Effect.forEach(inputs, (input) =>
          price(input.voucherId, input.value, true).pipe(
            // A busy minute spent no lookup and says nothing about the card, so it isn't counted as a miss.
            Effect.tapError((e) => (e._tag === "BitrefillUnavailable" && !e.message.startsWith("Prices are busy") ? missed(accountId) : Effect.void)),
            // Test cards are free on Bitrefill; real ones are paid from our credit (ADR-0009).
            Effect.map(({ voucher, referencePrice }) => ({ input, voucher, referencePrice, real: !voucher.id.startsWith("test-") }))
          ))
        const real = priced.filter((p) => p.real)
        const sum = real.reduce((s, p) => s + p.referencePrice, 0)
        // No checkout is refused for its size: one the Pay Wallet's float can't cover waits, uncharged, while the owner
        // tops it up (or the cards before it settle and repay it).
        // A guest order needs the customer's Checkout Email, and stays within Bitrefill's limits for it (ADR-0012).
        // One on the customer's own Bitrefill account is under that account's limits, which Bitrefill checks.
        const asGuest = real.length > 0 && bitrefill.guest && !(yield* connect.connected(accountId))
        const email = asGuest ? yield* emailOf(accountId) : undefined
        if (asGuest) {
          if (!email) return yield* invalid("Add the email for your cards first: Bitrefill needs one for each card (a throwaway one is fine).")
          const over = yield* overGuestLimit(email.key, sum, real.length)
          if (over) return yield* invalid(over)
          const [paid] = yield* sql<{ day: string; month: string }>`
            SELECT COALESCE(sum(reference_price) FILTER (WHERE ${counted} > now() - interval '1 day'), 0)::text AS day,
                   COALESCE(sum(reference_price) FILTER (WHERE ${counted} > now() - interval '30 days'), 0)::text AS month
            FROM purchases
            WHERE email_key IS NOT NULL AND created_at > now() - interval '32 days'
              AND step <> 'rejected' AND NOT (step = 'failed' AND invoice_id IS NULL)`.pipe(Effect.orDie)
          if (Number(paid?.day ?? 0) + sum > PAYING_LIMITS.daily || Number(paid?.month ?? 0) + sum > PAYING_LIMITS.monthly) {
            yield* alerts.admin(`Luckout's paying address reached Bitrefill's limit (${usd(PAYING_LIMITS.daily)} a day, ${usd(PAYING_LIMITS.monthly)} a month); new guest checkouts are refused until it frees up`)
            return yield* invalid("Luckout has bought as many cards as Bitrefill allows us for now. Please try again later.")
          }
        }
        // A Lucky Buy is admitted at the Lucky Amount it's accepted under, or refused: it may wait a day for money
        // while the reserve moves. The quote the customer saw carries it; without one, the contract's quote now. One
        // confirmed on more than the card's price today (the whole of a price that has since fallen) plays the whole
        // card, as a checkout that waited for money does.
        for (const [i, { input, voucher }] of priced.entries()) {
          if (typeof input.mode === "object" && input.luckyAmount !== undefined && !(input.luckyAmount > 0)) {
            return yield* about(i, voucher.name)(invalid("That quote is out of date; please confirm again."))
          }
        }
        const confirmedLucky = priced.map(({ input, referencePrice }) =>
          typeof input.mode !== "object" || input.luckyAmount === undefined ? undefined : Math.min(input.luckyAmount, referencePrice)
        )
        // The contract's own admission checks, made here first against what it will debit: the Reference Price in
        // Normal, the quote's maximum in a Lucky Buy, each card priced on the reserve the cards before it left
        // (quote_many). Each card goes with its confirmed Lucky Amount, so the cards after it are priced on what admission
        // will lock for it, not on the most the reserve would let it play now. The contract still checks all of it.
        const resolved = priced.map((p) => p.input.mode ?? fromProgramMode(account.default_mode))
        const quotes = yield* contractQuotes(priced.map((p, i) => ({ referencePrice: p.referencePrice, mode: resolved[i]!, luckyAmount: confirmedLucky[i] })))
        // Lucky cards playing less than the smallest Lucky Checkout together are bought at Normal, as their quote says,
        // rather than sent for the program to refuse: never a premium that can't play.
        const requested = priced.map(({ input }, i): Mode | undefined => (quotes[i]!.belowMin ? "normal" : input.mode))
        const modes = requested.map((m) => m ?? fromProgramMode(account.default_mode))
        // A refusal after signing costs the operator gas and counts against the customer (MAX_RECENT_REFUSALS), so a
        // price that rose since they confirmed is refused here, before anything is signed; one that fell buys at today's.
        const debits: Array<number> = []
        let versions: ReadonlyArray<{ readonly premium_bps: number }> | undefined
        for (const [i, { input, voucher, referencePrice }] of priced.entries()) {
          const q = quotes[i]!
          const mode = modes[i]!
          const lucky = confirmedLucky[i]
          let debit = Number(q.max_price)
          if (typeof mode === "object") {
            // A Lucky card the reserve no longer covers comes back Normal, or covers less than the customer saw: the
            // contract would refuse it, so say so before signing.
            if (typeof q.mode !== "object" || (lucky !== undefined && lucky > Number(q.lucky_amount))) {
              return yield* about(i, voucher.name)(invalid("That quote is out of date; please confirm again."))
            }
            // A smaller Lucky Amount than the live quote's (a contract from before quote_many read confirmed amounts
            // quotes the most the reserve allows) is debited today's price plus that amount's premium, as the contract
            // works it out from the Game Version (quote_at: the premium rounded up).
            if (lucky !== undefined && lucky !== Number(q.lucky_amount)) {
              versions ??= (yield* solana.config.pipe(Effect.mapError(quoteRefused))).versions
              const premium = versions[mode.lucky]?.premium_bps
              if (premium === undefined) return yield* about(i, voucher.name)(invalid("That quote is out of date; please confirm again."))
              debit = referencePrice + Math.ceil(lucky * premium / 10_000)
            }
          }
          if (input.maxPrice < debit) return yield* about(i, voucher.name)(invalid("Price changed since you confirmed; please confirm again"))
          debits.push(debit)
        }
        const debitTotal = debits.reduce((s, d) => s + d, 0)
        if (Number(account.balance) < debitTotal) return yield* invalid("Insufficient balance; add funds first")
        const over = debits.findIndex((d) => Number(account.per_purchase_limit) < d)
        if (over >= 0) return yield* about(over, priced[over]!.voucher.name)(invalid("Over the per-purchase spending limit"))
        const spent = Number(account.day) === Math.floor(Date.now() / DAY_MS) ? Number(account.spent_today) : 0
        if (spent + debitTotal > Number(account.daily_limit)) return yield* invalid("Over the daily spending limit")
        // The Lucky Amount each card is accepted under: the customer's, or (an older client) the contract's quote now.
        const luckyAmounts = requested.map((m, i) => (typeof m !== "object" ? null : confirmedLucky[i] ?? Number(quotes[i]!.lucky_amount)))
        // Deciding "go or wait" and recording it happen under one lock, so two checkouts can never both count on the
        // same money.
        const placed = yield* floatGuard((free) =>
          Effect.gen(function*() {
            // The same cards sent twice at once: the copy that waited for the lock finds the first's, and returns it
            // rather than count it against itself. (Every checkout is recorded under this lock; the keys' unique index
            // backs it up.)
            const again = yield* byKey
            if (again.length > 0) return { again }
            // Counted again here, where checkouts are recorded one at a time: two placed at once (the web and Telegram,
            // or two accounts with one Checkout Email) can't both pass on room the first counts saw for each.
            if ((yield* openCards(accountId)) + inputs.length > MAX_OPEN_PER_ACCOUNT) return yield* invalid(IN_PROGRESS)
            if (email) {
              const over = yield* overGuestLimit(email.key, sum, real.length)
              if (over) return yield* invalid(over)
            }
            const wait = real.length > 0 && free < sum
            if (wait) {
              const [w] = yield* sql<{ n: number }>`
                SELECT count(*)::int AS n FROM checkouts WHERE account_id = ${accountId} AND step IN ${sql.in(WAITING_STEPS)}`.pipe(Effect.orDie)
              if ((w?.n ?? 0) > 0) return yield* invalid("You already have a card on its way; try again when it's ready.")
            }
            const first: Step = wait ? "waiting" : "admit"
            return yield* sql.withTransaction(Effect.gen(function*() {
              // A guest checkout keeps the email it was confirmed under, sealed to it: one that waits for the float is
              // ordered with it, whatever the customer's email is by then.
              const id = randomUUID()
              yield* sql`INSERT INTO checkouts (id, account_id, step, email)
                         VALUES (${id}, ${accountId}, ${first}, ${email ? seal(`checkout-email:${id}`, email.email) : null})`
              for (const [i, { input, voucher, referencePrice, real: isReal }] of priced.entries()) {
                yield* sql`
                  INSERT INTO purchases (account_id, checkout_id, position, idempotency_key, voucher_id, voucher_name, package_value, currency,
                                         requested_mode, reference_price, max_debit, quoted_lucky_amount, step, email_key)
                  VALUES (${accountId}, ${id}, ${i}, ${input.idempotencyKey}, ${voucher.id}, ${voucher.name}, ${input.value}, ${voucher.currency},
                          ${requested[i] === undefined ? null : JSON.stringify(requested[i])}, ${referencePrice}, ${input.maxPrice}, ${luckyAmounts[i]}, ${first},
                          ${isReal ? email?.key ?? null : null})`
              }
              return { waiting: wait }
            })).pipe(Effect.orDie)
          })
        )
        if ("again" in placed) return yield* sentBefore(placed.again)
        const after = yield* byKey
        if (placed.waiting) {
          yield* alerts.admin(`checkout ${after[0]!.checkout_id} waits for the Pay Wallet: its float can't cover ${usd(sum)} yet. Top it up, or it's cancelled after ${WAIT_MINUTES} minutes.`)
        }
        return { checkoutId: after[0]!.checkout_id, ids: after.map((r) => r.id), go: !placed.waiting }
      })

      /**
       * Starts a checkout's run. A guest checkout can take over a minute (Base payment, then Bitrefill), and Cloudflare
       * drops a request at 100 s: stop waiting at requestWait and answer "pending". The run carries on; the web follows
       * it, and Telegram hears when it ends.
       */
      const run = (checkoutId: string) =>
        Effect.gen(function*() {
          const fiber = yield* FiberSet.run(workflows, advance(checkoutId, false))
          if (Option.isNone(yield* Fiber.join(fiber).pipe(Effect.timeoutOption(requestWait)))) {
            yield* FiberSet.run(workflows, Effect.andThen(Fiber.await(fiber), notify(checkoutId)).pipe(Effect.ignore))
          }
        })

      const create = Effect.fn("Purchases.create")(function*(accountId: string, input: NewPurchase) {
        const { checkoutId, ids: [id], go } = yield* place(accountId, [input])
        if (go) yield* run(checkoutId)
        return view(yield* load(id!))
      })

      const createCart = Effect.fn("Purchases.createCart")(function*(accountId: string, inputs: ReadonlyArray<NewPurchase>) {
        const { checkoutId, ids, go } = yield* place(accountId, inputs)
        if (go) yield* run(checkoutId)
        return yield* Effect.forEach(ids, (id) => Effect.map(load(id), view))
      })

      // Newest first, a page at a time. The cursor is the last purchase's id: its (created_at, id) is looked up
      // in the same query, so paging keeps full timestamp precision, two purchases made at the same instant
      // are both returned once, and an id from another account matches nothing.
      const list = (accountId: string, page: { readonly before?: string | undefined; readonly limit?: number | undefined } = {}) => {
        const limit = page.limit ?? 100
        // One more than the page, to know whether another page follows.
        const rows = page.before
          ? sql<Row>`SELECT * FROM purchases WHERE account_id = ${accountId}
                       AND (created_at, id) < (SELECT created_at, id FROM purchases WHERE id = ${page.before} AND account_id = ${accountId})
                     ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`
          : sql<Row>`SELECT * FROM purchases WHERE account_id = ${accountId} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`
        return rows.pipe(
          Effect.map((r) => new PurchasePage({ items: r.slice(0, limit).map(view), ...(r.length > limit ? { next: r[limit - 1]!.id } : {}) })),
          Effect.orDie
        )
      }

      const get = (accountId: string, id: string) =>
        sql<Row>`SELECT * FROM purchases WHERE id = ${id} AND account_id = ${accountId}`.pipe(
          Effect.orDie,
          Effect.flatMap((r) => (r[0] ? Effect.succeed(view(r[0])) : Effect.fail(new NotFound())))
        )

      const cancel = (accountId: string, id: string) =>
        Effect.gen(function*() {
          const [row] = yield* sql<Row>`SELECT * FROM purchases WHERE id = ${id} AND account_id = ${accountId}`.pipe(Effect.orDie)
          if (!row) return yield* new NotFound()
          // Only before admission: once charged, the checkout finishes (or is refunded) by itself. Its cards go together.
          const co = yield* loadCheckout(row.checkout_id)
          const error = "You cancelled it. You weren't charged."
          if (co.step !== "waiting" || !(yield* move(co, { step: "rejected", error }, { step: "rejected", error }))) {
            return yield* new PurchaseInvalid({ message: "This purchase is already going through, so it can't be cancelled; if it fails you get the full amount back." })
          }
          return view(yield* load(id))
        })

      // Only the customer's own card, and only once delivered (settled is final). Marking it used again keeps when it was
      // first marked, so a retried request changes nothing. `updated_at` stays: this is a note, not a step.
      const setUsed = (accountId: string, id: string, used: boolean) =>
        Effect.gen(function*() {
          const [row] = yield* sql<Row>`
            UPDATE purchases SET used_at = CASE WHEN ${used}::boolean THEN COALESCE(used_at, now()) END
            WHERE id = ${id} AND account_id = ${accountId} AND step = 'settled'
            RETURNING *`.pipe(Effect.orDie)
          if (row) return view(row)
          yield* get(accountId, id)
          return yield* new PurchaseInvalid({ message: "Only a delivered card can be marked as used." })
        })

      const giveUp = (id: string) =>
        Effect.gen(function*() {
          const co = yield* loadCheckout(id)
          // A Draw needs nothing but ORAO's randomness, which finishing or asking again gets: it's never given up.
          if (co.step === "draw") {
            yield* alerts.admin(`checkout ${id}: a Draw is still unfinished after ${MAX_ATTEMPTS} tries`)
            yield* sql`UPDATE checkouts SET attempts = 0 WHERE id = ${id}`.pipe(Effect.orDie)
            return yield* advance(id, true)
          }
          // A guest order that never got as far as a payment cost us nothing (an unpaid invoice just expires): the
          // customer is refunded in full now, rather than left "stuck" for a human until they can Reclaim.
          if (bitrefill.guest && co.step === "ordering" && !co.pay_tx) {
            if (!(yield* failAll(co, "We couldn't order this card from Bitrefill"))) return
            yield* alerts.admin(`checkout ${id} couldn't be ordered from Bitrefill in ${MAX_ATTEMPTS} attempts (nothing was paid); refunding it in full`)
            return yield* advance(id, true)
          }
          const gaveUp = (at: string) => `Gave up after ${MAX_ATTEMPTS} attempts at ${at}: ${co.error ?? ""}`
          const open = (yield* cardsIn(id)).filter((c) => SHARED_STEPS.includes(c.step) || c.step === "confirm" || c.step === "fail")
          // Each card says the step it was at, so Retry now can send it back there where that's safe (GAVE_UP_AT).
          const each = open.map((c) => [c, { step: "stuck" as const, error: gaveUp(c.step) }] as const)
          if (!(yield* move(co, { step: "stuck", error: gaveUp(co.step) }, undefined, each))) return
          yield* alerts.admin(`checkout ${id} stuck after ${MAX_ATTEMPTS} attempts at ${co.step}`)
          yield* notify(id)
        })

      // Reconciler: every 30 seconds, resume any checkout left part-way, each with its own backoff, so a few broken
      // ones can never starve newer ones.
      const reconcile = sql<{ id: string; attempts: number }>`
        UPDATE checkouts SET attempts = attempts + 1,
          next_attempt_at = now() + LEAST(interval '1 hour', interval '30 seconds' * power(2, LEAST(attempts, 7)))
        WHERE id IN (
          SELECT id FROM checkouts
          WHERE step IN ${sql.in(CHECKOUT_OPEN_STEPS)} AND updated_at < now() - interval '30 seconds' AND next_attempt_at <= now()
          ORDER BY next_attempt_at LIMIT 20)
        RETURNING id, attempts`.pipe(
        Effect.orDie,
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (r) => (r.attempts > MAX_ATTEMPTS ? giveUp(r.id) : advance(r.id, true)), { discard: true, concurrency: 4 })
        ),
        // Notices Telegram didn't take, sent again for up to a day; claimed first, so one is never sent twice at once.
        Effect.andThen(
          sql<{ id: string }>`
            UPDATE checkouts SET retell = false
            WHERE id IN (SELECT id FROM checkouts WHERE retell AND updated_at > now() - interval '1 day' LIMIT 20)
            RETURNING id`.pipe(Effect.orDie, Effect.flatMap((rows) => Effect.forEach(rows, (r) => notify(r.id), { discard: true })))
        ),
        // A failed pass (e.g. the database blinked) must never end the reconciler.
        Effect.catchCause((cause) => Effect.logError("reconcile pass failed", cause))
      )
      yield* reconcile.pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped)

      // Checkouts waiting for money: each goes on as soon as the float covers all its cards (under the same lock as
      // new ones), or is cancelled after waitMinutes: uncharged if it never reached admission, refunded in full
      // through `settle` if it did.
      const promote = Effect.gen(function*() {
        const waitMinutes = WAIT_MINUTES
        // While sales are closed, nothing new is admitted; waiting checkouts keep their place (and their timer).
        // At Bitrefill's order limit, charged ones wait too, rather than be refused and refunded.
        const shop = yield* sales.status
        const rows = yield* sql<CheckoutRow>`SELECT * FROM checkouts WHERE step IN ${sql.in(WAITING_STEPS)} ORDER BY created_at LIMIT 50`.pipe(Effect.orDie)
        for (const co of rows) {
          // Its own run may still be finishing the step that moved it here (refreshing the credit after
          // Bitrefill's refusal): moving it now would leave it at "ordering" with nothing running it.
          if (running.has(co.id)) continue
          const all = yield* cardsIn(co.id)
          // Measured from creation, so bouncing between ordering and restock can't extend it. A charged one
          // is refunded an hour before the customer could Reclaim it, so a late order never races a reclaim.
          const late = Date.now() - time(co.created_at) > waitMinutes * 60_000 ||
            (co.step === "restock" && Date.now() > admittedAt(co, all) + DAY_MS - RECLAIM_MARGIN_MS)
          if (late) {
            if (co.step === "waiting") {
              const error = "We couldn't get this card ready in time, so we cancelled it. You weren't charged."
              if (yield* move(co, { step: "rejected", error }, { step: "rejected", error })) yield* notify(co.id)
            } else if (yield* failAll(co, "The Pay Wallet's float didn't cover it in time")) {
              yield* FiberSet.run(workflows, advance(co.id, false, true))
            }
            continue
          }
          if ((co.step === "waiting" && !shop.open) || (co.step === "restock" && shop.reason === "limit")) continue
          const next = co.step === "waiting" ? "admit" : "ordering"
          const go = yield* floatGuard((free) =>
            free >= total(all) ? move(co, { step: next, error: null }, { step: next, error: null }) : Effect.succeed(false)
          )
          // The customer may have left: tell them in Telegram how it ended.
          if (go) yield* FiberSet.run(workflows, advance(co.id, false, true))
        }
      }).pipe(Effect.catchCause((cause) => Effect.logError("waiting checkouts pass failed", cause)))
      yield* promote.pipe(Effect.repeat(Schedule.spaced("10 seconds")), Effect.forkScoped)

      // A stuck card the customer reclaimed (or that was failed) onchain is over: say so here too.
      const settleClosed = Effect.gen(function*() {
        const rows = yield* sql<Row & { checkout_address: string }>`
          SELECT p.*, c.address AS checkout_address FROM purchases p JOIN checkouts c ON c.id = p.checkout_id
          WHERE p.step = 'stuck' AND c.address IS NOT NULL LIMIT 50`.pipe(Effect.orDie)
        for (const row of rows) {
          // An account that has closed holds no open card: one we gave up on was reclaimed.
          const card = (yield* solana.checkout(new PublicKey(row.checkout_address)))?.cards[row.position]
          const status = card?.status.kind ?? "Reclaimed"
          if (status === "Reclaimed" || status === "Failed") {
            if (yield* cards.move(row, { step: "failed", error: status === "Reclaimed" ? "Reclaimed" : row.error })) yield* tell(row.account_id, [yield* load(row.id)])
          }
          // Delivered after we gave up (say, someone else finished its Draw): their code is ready, so show it.
          if (status === "Delivered" && row.redemption !== null) {
            const draw = card ? chainDraw(card) : null
            if (yield* cards.move(row, { step: "settled", ...(draw ? { draw, settle_tx: null } : {}) })) yield* tell(row.account_id, [yield* load(row.id)])
          }
        }
      }).pipe(Effect.catchCause((cause) => Effect.logError("closed purchases pass failed", cause)))
      yield* settleClosed.pipe(Effect.repeat(Schedule.spaced("5 minutes")), Effect.forkScoped)

      const useBy = (voucherId: string) =>
        sql<{ use_by: Date | string }>`
          SELECT use_by FROM purchases
          WHERE voucher_id = ${voucherId} AND use_by IS NOT NULL AND created_at > now() - interval '60 days'
          ORDER BY created_at DESC LIMIT 1`.pipe(
          Effect.orDie,
          Effect.map(([r]) => (r ? new Date(r.use_by).toISOString() : undefined))
        )

      return Purchases.of({
        quote,
        quoteCart,
        create,
        createCart,
        list,
        get,
        cancel,
        setUsed,
        promoteWaiting: promote,
        reconcileNow: reconcile,
        checkoutEmail,
        setCheckoutEmail,
        useBy
      })
    })
  )
}
