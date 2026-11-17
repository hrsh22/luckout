import { BitrefillUnavailable, CheckoutEmail, Draw, type Mode, NewPurchase, NotFound, Purchase, PurchaseInvalid, Quote } from "@luckout/api"
import { Config, Context, Effect, Fiber, FiberSet, Layer, Option, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { createHmac } from "node:crypto"
import type { Hex } from "viem"
import { Alerts } from "./Alerts.ts"
import { Base, BaseUnavailable, type SignedPayment } from "./Base.ts"
import { Bitrefill, ORDER_LIMIT } from "./Bitrefill.ts"
import { Connect } from "./Connect.ts"
import { Credit, usd, WAITING_STEPS } from "./Credit.ts"
import { Refill } from "./Refill.ts"
import { stepRows } from "./Rows.ts"
import { closedMessage, Sales } from "./Sales.ts"
import { SealKey, sealWith, unsealWith } from "./Seal.ts"
import { ContractRejected, Near, NearUnavailable, Network, type Outcome, type Signed, TxExpired } from "./Near.ts"

// A purchase walks these steps (ADR-0001). Every step is saved before its side effect,
// so after a crash the reconciler resumes it without buying or charging twice:
//   (waiting →) admit → ordering → (pay →) delivery → confirm → settled
//                    ↘ fail → failed          (admit refused → rejected)
// A guest order (ADR-0012) gets an unpaid invoice at "ordering" and pays it from the Base Float at "pay":
// creating an invoice moves no money, so an unknown outcome there is simply ordered again, and the payment is
// saved before it's sent, so it's only ever sent again as the same transaction.
// A real card our Bitrefill credit can't cover yet starts as "waiting": nothing is charged, a
// refill starts, and it moves on once the credit is there, or is cancelled after waitMinutes
// (ADR-0009). If Bitrefill still says the credit is too low at ordering, it waits as "restock"
// (charged, not yet ordered) and is refunded in full if the credit doesn't come in time.
// "ordering" found by the reconciler means we may have paid Bitrefill without saving the
// invoice id; it becomes "stuck" for a human, and the customer can still Reclaim after 24h.
// The reconciler backs off on each retry and gives up (stuck, with an alert) after MAX_ATTEMPTS.
type Step = "waiting" | "admit" | "ordering" | "restock" | "pay" | "delivery" | "confirm" | "fail" | "settled" | "failed" | "rejected" | "stuck"

interface Row {
  id: string
  account_id: string
  voucher_id: string
  voucher_name: string
  package_value: string
  requested_mode: Mode | null
  reference_price: number | string | bigint
  max_debit: number | string | bigint | null
  step: Step
  error: string | null
  admit_tx: Signed | null
  contract_purchase_id: number | string | bigint | null
  /** The contract's record at admission; `created_at` (nanoseconds) is when Reclaim's 24 hours start. */
  admitted: { mode: Mode; max_price: string; lucky_amount: string; created_at?: number | string } | null
  /** A Lucky Buy's Lucky Amount when it was accepted: admission plays exactly it, or is refused. */
  quoted_lucky_amount: number | string | bigint | null
  invoice_id: string | null
  /** A guest invoice's access token, sealed; and what paying it takes (ADR-0012). */
  invoice_token: string | null
  invoice_at: Date | string | null
  pay_to: string | null
  pay_amount: number | string | bigint | null
  pay_tx: SignedPayment | null
  email_key: string | null
  /** Whom a guest-checkout order was placed for: a guest (Checkout Email) or the customer's own Bitrefill account. */
  buyer: "guest" | "account" | null
  redemption: string | null
  settle_tx: Signed | null
  draw: Record<string, unknown> | null
  created_at: Date | string
  updated_at: Date | string
}

interface QuoteView {
  mode: Mode
  reference_price: string
  lucky_amount: string
  max_price: string
}

/** A purchase as the contract records it (`get_purchase`). */
interface OnchainPurchase {
  status: string
  mode: Mode
  max_price: string
  cashback: string
}

/** Thrown on to stop a run; the reconciler picks the purchase up again later. */
type Unknown = NearUnavailable | BitrefillUnavailable | BaseUnavailable

export const OPEN_STEPS = ["admit", "ordering", "pay", "delivery", "confirm", "fail"]
/** Bitrefill's limits for one Checkout Email (its Terms §8, guests): orders a day, and USD a day and a month. */
export const GUEST_LIMITS = { orders: 15, daily: 500_000_000, monthly: 1_000_000_000 } as const
/** Bitrefill's invoices expire after 60 minutes; one we haven't paid within 40 is asked for again. */
const INVOICE_TTL_MS = 40 * 60_000
/** This long after its invoice, a Base payment is never sent or signed again: the invoice expires at 60 minutes. Base is only asked where it is. */
const PAY_SEND_LIMIT_MS = 50 * 60_000
/** Why a card couldn't be ordered: their Bitrefill login lapsed, and there's no Checkout Email to fall back on. */
const LOGIN_LAPSED = "Your Bitrefill login expired. Connect again or add an email in Wallet."
/** The email shape Bitrefill's buy-products accepts. */
const EMAIL = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/
/** About six hours of retries with backoff (30s doubling, capped at an hour). */
const MAX_ATTEMPTS = 12
/** Unfinished purchases one account may have at once. */
const MAX_OPEN_PER_ACCOUNT = 3
const DAY_MS = 24 * 60 * 60 * 1000
/** A charged purchase still waiting for credit is refunded this long before the customer could Reclaim it. */
const RECLAIM_MARGIN_MS = 60 * 60 * 1000
/** A purchase that waited longer than this for credit is re-priced before it's admitted. */
const REPRICE_AFTER_MS = 10 * 60 * 1000
const time = (v: Date | string) => new Date(v).getTime()
/** When the contract admitted (and so charged) it; the row's creation for rows saved without it. */
const admittedAt = (row: Row) => (row.admitted?.created_at ? Number(row.admitted.created_at) / 1e6 : time(row.created_at))
/** A charged purchase that is refunded rather than tried again: it has waited `waitMinutes`, or the customer could soon Reclaim it. */
const overdue = (row: Row, waitMinutes: number) =>
  Date.now() - time(row.created_at) > waitMinutes * 60_000 || Date.now() > admittedAt(row) + DAY_MS - RECLAIM_MARGIN_MS

/**
 * A Lucky Buy delivered onchain whose draw event we never saw (say, the customer re-ran the Draw):
 * the amount paid and the Cashback as the contract records them. Its seed and roll aren't known here.
 */
const chainDraw = (p: OnchainPurchase) =>
  typeof p.mode === "object"
    ? { game_version: p.mode.lucky, final_price: String(Number(p.max_price) - Number(p.cashback)), cashback: p.cashback }
    : null

/** The contract's view of a customer (amounts in micro-USDC strings). */
interface ContractAccount {
  balance: string
  per_purchase_limit: string
  daily_limit: string
  day: number
  spent_today: string
}

export class Purchases extends Context.Service<Purchases, {
  quote(voucherId: string, value: string, game: number | undefined): Effect.Effect<Quote, BitrefillUnavailable | PurchaseInvalid>
  create(accountId: string, input: NewPurchase): Effect.Effect<Purchase, BitrefillUnavailable | PurchaseInvalid>
  list(accountId: string): Effect.Effect<ReadonlyArray<Purchase>>
  get(accountId: string, id: string): Effect.Effect<Purchase, NotFound>
  /** The customer cancels a purchase still waiting for credit: nothing was charged. */
  cancel(accountId: string, id: string): Effect.Effect<Purchase, NotFound | PurchaseInvalid>
  /** One pass over purchases waiting for credit (also runs every 10 seconds by itself). */
  readonly promoteWaiting: Effect.Effect<void>
  /** One reconciler pass (also runs every 30 seconds by itself). */
  readonly reconcileNow: Effect.Effect<void>
  /** The customer's Checkout Email, and whether buying needs one (ADR-0012). */
  checkoutEmail(accountId: string): Effect.Effect<CheckoutEmail>
  setCheckoutEmail(accountId: string, email: string): Effect.Effect<CheckoutEmail, PurchaseInvalid>
}>()("luckout/Purchases") {
  static readonly layer = Layer.effect(
    Purchases,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const near = yield* Near
      const bitrefill = yield* Bitrefill
      const base = yield* Base
      const credit = yield* Credit
      const refill = yield* Refill
      const sales = yield* Sales
      const alerts = yield* Alerts
      const connect = yield* Connect
      const key = yield* SealKey
      const testnet = (yield* Network) === "testnet"
      const webOrigin = yield* Config.String("WEB_ORIGIN").pipe(Config.withDefault("http://localhost:3000"))
      /** How long a buy request waits for its card before answering "pending" (under Cloudflare's 100 s). */
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
        Effect.all([Option.isNone(key) ? Effect.succeed(undefined) : emailOf(accountId), connect.connected(accountId)]).pipe(
          Effect.map(([e, connected]) =>
            new CheckoutEmail({ needed: bitrefill.guest && !connected, ...(e ? { email: e.email } : {}), ...(connect.offered ? { bitrefill: connected } : {}) })
          )
        )
      const setCheckoutEmail = (accountId: string, input: string) =>
        Effect.gen(function*() {
          if (Option.isNone(key)) return yield* new PurchaseInvalid({ message: "Purchases are disabled: REDEMPTION_KEY is not set" })
          const email = input.trim().toLowerCase()
          if (email.length > 254 || !EMAIL.test(email)) return yield* new PurchaseInvalid({ message: "That doesn't look like an email address." })
          yield* sql`INSERT INTO checkout_emails (account_id, email, email_key) VALUES (${accountId}, ${seal(`email:${accountId}`, email)}, ${emailKey(email)})
                     ON CONFLICT (account_id) DO UPDATE SET email = EXCLUDED.email, email_key = EXCLUDED.email_key, updated_at = now()`.pipe(Effect.orDie)
          return yield* checkoutEmail(accountId)
        })

      /** Why Bitrefill would refuse one more card of `price` for this email now, if it would (GUEST_LIMITS). */
      const overGuestLimit = (emailKeyValue: string, price: number) =>
        sql<{ orders: number; day: string; month: string }>`
          SELECT count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS orders,
                 COALESCE(sum(reference_price) FILTER (WHERE created_at > now() - interval '1 day'), 0)::text AS day,
                 COALESCE(sum(reference_price), 0)::text AS month
          FROM purchases
          WHERE email_key = ${emailKeyValue} AND created_at > now() - interval '30 days'
            AND step <> 'rejected' AND NOT (step = 'failed' AND invoice_id IS NULL)`.pipe(
          Effect.orDie,
          Effect.map(([u]) =>
            (u?.orders ?? 0) >= GUEST_LIMITS.orders
              ? `Bitrefill allows ${GUEST_LIMITS.orders} cards a day per email, and yours has had ${u?.orders} in the last 24 hours. Try again later.`
              : Number(u?.day ?? 0) + price > GUEST_LIMITS.daily
              ? `Bitrefill allows ${usd(GUEST_LIMITS.daily)} of cards a day per email; this one would go over it. Try a smaller card or wait a day.`
              : Number(u?.month ?? 0) + price > GUEST_LIMITS.monthly
              ? `Bitrefill allows ${usd(GUEST_LIMITS.monthly)} of cards a month per email; this one would go over it.`
              : undefined
          )
        )

      const load = (id: string) =>
        sql<Row>`SELECT * FROM purchases WHERE id = ${id}`.pipe(Effect.map((r) => r[0]!), Effect.orDie)
      const rows = stepRows(sql, "purchases")
      const save = rows.save
      const move = (row: Row, fields: Record<string, unknown> & { step: Step }) => rows.move(row, fields)

      /** Sends (or resumes) one contract call whose signed transaction lives in `column`. */
      const submit = (row: Row, column: "admit_tx" | "settle_tx", method: string, args: object) => {
        const fresh = near.call(method, args, (signed) => save(row.id, { [column]: signed }))
        const saved = row[column]
        return (saved ? near.resume(saved) : fresh).pipe(
          Effect.catchTag("TxExpired", (_: TxExpired) => fresh)
        )
      }

      /** One step forward. Returns false when the purchase is finished or must wait. */
      const step = (row: Row, resumed: boolean): Effect.Effect<boolean, Unknown> =>
        Effect.gen(function*() {
          switch (row.step) {
            case "admit": {
              // A purchase that waited for credit is admitted at today's price (CONTEXT: Reference Price is the
              // current Bitrefill price). A higher one can't pass the customer's max_debit, so the contract refuses
              // it, uncharged; a lower one costs them less. Only before anything is signed for it.
              if (!row.admit_tx && Date.now() - time(row.created_at) > REPRICE_AFTER_MS) {
                const now = yield* price(row.voucher_id, row.package_value, true).pipe(
                  Effect.map((p) => p.referencePrice),
                  Effect.orElseSucceed(() => Number(row.reference_price))
                )
                if (now !== Number(row.reference_price)) {
                  const lucky = row.quoted_lucky_amount === null ? null : Math.min(Number(row.quoted_lucky_amount), now)
                  yield* sql`UPDATE purchases SET reference_price = ${now}, quoted_lucky_amount = ${lucky} WHERE id = ${row.id} AND step = 'admit'`.pipe(Effect.orDie)
                  return true
                }
              }
              // order_id makes admission idempotent onchain: re-sending can never debit twice.
              const outcome = yield* submit(row, "admit_tx", "purchase", {
                customer: row.account_id,
                reference_price: String(row.reference_price),
                mode: row.requested_mode,
                order_id: row.id,
                max_debit: String(row.max_debit ?? row.reference_price),
                // A contract without this argument ignores it (near-sdk drops unknown JSON fields).
                ...(row.quoted_lucky_amount !== null ? { lucky_amount: String(row.quoted_lucky_amount) } : {})
              }).pipe(Effect.catchTag("ContractRejected", (e: ContractRejected) => Effect.succeed(e)))
              // Refused, e.g. the price or the Cashback Reserve moved since the customer confirmed: their words, nothing charged.
              if (outcome instanceof ContractRejected) {
                yield* move(row, { step: "rejected", error: outcome.message })
                return false
              }
              // A repeated admission logs no event; read the purchase back from the contract.
              const purchaseId = Number(outcome.value)
              const admitted = outcome.events.find((e) => e.event === "purchase")?.data[0]?.purchase ??
                (yield* near.view("get_purchase", { purchase_id: purchaseId }))
              return yield* move(row, { step: "ordering", contract_purchase_id: purchaseId, admitted })
            }
            case "ordering": {
              if (bitrefill.guest) {
                // Charged long ago and still not paid for (Base or Bitrefill kept failing): nothing was signed, so
                // refund it now rather than order again, and a late card never races a Reclaim.
                if (!row.pay_tx && overdue(row, (yield* credit.settings).waitMinutes)) {
                  yield* alerts.admin(`purchase ${row.id} couldn't be ordered and paid for in time; refunding it in full`)
                  return yield* move(row, { step: "fail", error: "We couldn't order and pay for this card in time" })
                }
                // On the customer's own Bitrefill account if they connected it (a login Bitrefill stops taking is
                // renewed once); without one, or once it lapsed, as a guest with their Checkout Email.
                const place = (renew: boolean) =>
                  Effect.gen(function*() {
                    const token = yield* connect.token(row.account_id, renew)
                    if (token) return { buyer: "account" as const, email_key: null, order: yield* bitrefill.order(row.voucher_id, row.package_value, { token }) }
                    const email = yield* emailOf(row.account_id)
                    if (!email) return undefined
                    return { buyer: "guest" as const, email_key: email.key, order: yield* bitrefill.order(row.voucher_id, row.package_value, { email: email.email }) }
                  })
                let placed = yield* place(false)
                if (placed?.buyer === "account" && placed.order._tag === "Refused" && placed.order.reason.startsWith("HTTP 401")) placed = yield* place(true)
                if (!placed) return yield* move(row, { step: "fail", error: LOGIN_LAPSED })
                const { order, ...buyer } = placed
                if (order._tag !== "Invoiced") {
                  return yield* move(row, { step: "fail", error: `Bitrefill refused: ${"reason" in order ? order.reason : order._tag}`, ...buyer })
                }
                // Never pay Bitrefill more than the price the contract admitted (what the customer is charged).
                if (order.amount > Number(row.reference_price)) {
                  return yield* move(row, { step: "fail", error: `Bitrefill's invoice ${order.invoiceId} costs ${usd(order.amount)}, more than the admitted ${usd(Number(row.reference_price))}` })
                }
                return yield* move(row, {
                  step: "pay",
                  ...buyer,
                  invoice_id: order.invoiceId,
                  invoice_token: seal(`invoice:${row.id}`, order.accessToken),
                  invoice_at: new Date().toISOString(),
                  pay_to: order.payTo,
                  pay_amount: order.amount,
                  pay_tx: null
                })
              }
              if (resumed) {
                yield* move(row, { step: "stuck", error: "Bitrefill order outcome unknown; check the Bitrefill account" })
                yield* Effect.logError("purchase stuck at ordering", row.id)
                return false
              }
              const order = yield* bitrefill.order(row.voucher_id, row.package_value)
              if (order._tag === "Ordered") {
                return yield* move(row, { step: "delivery", invoice_id: order.invoiceId, ordered_at: new Date().toISOString() })
              }
              if (order._tag === "NoCredit") {
                // Nothing was ordered or paid: wait for credit instead of refunding straight away.
                yield* move(row, { step: "restock", error: order.reason })
                yield* Effect.all([credit.refresh, refill.kick], { discard: true })
                return false
              }
              return yield* move(row, { step: "fail", error: `Bitrefill refused: ${"reason" in order ? order.reason : order._tag}` })
            }
            case "pay": {
              // Never signed for in time: ask for a fresh invoice (this one would expire before Bitrefill saw it).
              if (!row.pay_tx && Date.now() - time(row.invoice_at!) > INVOICE_TTL_MS) {
                return yield* move(row, { step: "ordering", invoice_id: null, invoice_token: null, invoice_at: null, pay_to: null, pay_amount: null })
              }
              // Saved only over the payment this run was handed (none, or the lost one it replaces). A run that
              // loaded the row before another saved its payment stops here, before sending a second one.
              // `ordered_at` marks the money leaving the Base Float (Credit counts it from then).
              const savePayment = (p: SignedPayment) =>
                sql<{ id: string }>`
                  UPDATE purchases SET pay_tx = ${JSON.stringify(p)}::jsonb, ordered_at = ${new Date().toISOString()}, updated_at = now()
                  WHERE id = ${row.id} AND step = 'pay' AND pay_tx->>'hash' IS NOT DISTINCT FROM ${row.pay_tx?.hash ?? null}
                  RETURNING id`.pipe(
                  Effect.orDie,
                  Effect.flatMap((saved) => (saved.length === 1 ? Effect.void : Effect.die(`purchase ${row.id}: another run saved a Base payment first; not sending a second`)))
                )
              // Once the invoice is about to expire nothing is sent, not even again, and nothing new is signed for
              // it: Base is only asked where the saved payment is. Paying an expired invoice would leave our USDC
              // at Bitrefill with no card.
              const late = row.pay_tx !== null && Date.now() - time(row.invoice_at!) > PAY_SEND_LIMIT_MS
              const status = yield* (late
                ? base.status(row.pay_tx!.hash)
                : base.pay(row.pay_to as Hex, Number(row.pay_amount), row.pay_tx, savePayment).pipe(
                  Effect.catchTag("ContractRejected", (e) => Effect.fail(new BaseUnavailable({ message: `Chain Signatures refused: ${e.message}` })))
                ))
              if (status === "pending") {
                if (late && !row.error) {
                  yield* save(row.id, { error: `Base payment ${row.pay_tx!.hash} wasn't mined before invoice ${row.invoice_id} neared expiry, so it isn't sent again` })
                }
                return false
              }
              if (status === "reverted") {
                // Nothing moved (say, the float ran short): wait for money like any other, then order afresh.
                yield* move(row, { step: "restock", error: "The Base payment reverted; nothing was paid", pay_tx: null, invoice_id: null, invoice_token: null, invoice_at: null, ordered_at: null })
                yield* alerts.admin(`purchase ${row.id}: its Base payment to Bitrefill reverted (nothing moved); it waits for the float`)
                yield* Effect.all([credit.refresh, refill.kick], { discard: true })
                return false
              }
              return yield* move(row, { step: "delivery" })
            }
            case "delivery": {
              const d = yield* bitrefill.delivery(row.invoice_id!, row.invoice_token ? String(unseal(`invoice:${row.id}`, row.invoice_token)) : undefined)
              if (d._tag === "Failed" && row.pay_tx) {
                // We paid this invoice from the Base Float: the customer is refunded in full, and the money is ours to recover.
                yield* alerts.admin(`purchase ${row.id}: Bitrefill didn't deliver paid invoice ${row.invoice_id} (${d.reason}); Base payment ${row.pay_tx.hash}. Ask Bitrefill support for a refund.`)
              }
              return yield* d._tag === "Delivered"
                ? move(row, { step: "confirm", redemption: seal(row.id, d.redemption) })
                : move(row, { step: "fail", error: d.reason })
            }
            case "confirm":
            case "fail": {
              const confirm = row.step === "confirm"
              const outcome = yield* submit(
                row,
                "settle_tx",
                confirm ? "confirm_delivery" : "fail_purchase",
                { purchase_id: Number(row.contract_purchase_id) }
              ).pipe(Effect.catchTag("ContractRejected", (e: ContractRejected) => Effect.succeed(e)))
              if (outcome instanceof ContractRejected) {
                // Refused: read what actually happened onchain before telling the customer anything.
                const onchain = yield* near.view<OnchainPurchase | null>("get_purchase", { purchase_id: Number(row.contract_purchase_id) })
                const status = onchain?.status
                yield* Effect.logWarning(`settlement of ${row.id} refused (${outcome.message}); onchain ${status}`)
                if (status === "Pending" || status === "Drawing") {
                  // Not closed yet, e.g. the Draw callback failed: sign a fresh transaction next attempt.
                  yield* save(row.id, { settle_tx: null, error: outcome.message })
                  return false
                }
                if (status === "Delivered") {
                  if (confirm) {
                    // A Lucky Buy drawn by another transaction (say, the customer's retry_draw): record its result
                    // from the chain. That transaction isn't known here, so no settle_tx stands in as its proof.
                    const draw = chainDraw(onchain!)
                    yield* move(row, { step: "settled", error: outcome.message, ...(draw ? { draw, settle_tx: null } : {}) })
                  } else {
                    yield* move(row, { step: "stuck", error: `fail_purchase refused, delivered onchain: ${outcome.message}` })
                    yield* alerts.admin(`purchase ${row.id} is delivered onchain but we tried to fail it`)
                  }
                  return false
                }
                // Failed or Reclaimed: the customer already has the full amount back.
                yield* move(row, { step: "failed", error: status === "Reclaimed" ? "Reclaimed" : outcome.message })
                if (confirm) yield* alerts.admin(`purchase ${row.id} was delivered but closed onchain as ${status}; its voucher cost is ours`)
                return false
              }
              const draw = outcome.events.find((e) => e.event === "draw")?.data[0] ?? null
              yield* move(row, { step: confirm ? "settled" : "failed", draw })
              return false
            }
            default:
              return false
          }
        })

      // Workflows run in fibers owned by this service, not by the HTTP request:
      // a client that disconnects stops waiting, but never stops a purchase mid-step.
      const workflows = yield* FiberSet.make<void, never>()

      // ponytail: in-process guard, assumes one server process (ADR-0006); use row locks if it ever scales out.
      const running = new Set<string>()
      // A customer who left before the reconciler finished hears about it in Telegram (if linked).
      const notify = (row: Row) => {
        const what = `${row.voucher_name} ${row.package_value}`
        const text = row.step === "settled"
          ? `Your ${what} is ready. See the code at ${webOrigin}/purchases`
          : row.step === "failed"
          ? `Your ${what} couldn't be delivered. The full amount is back in your Luckout balance.`
          : row.step === "stuck"
          ? `Your ${what} needs a manual check by our team. We'll sort it out; you can also reclaim the full amount 24 hours after purchase.`
          : row.step === "rejected"
          ? `Your ${what} wasn't bought. ${row.error ?? ""}`.trim()
          : undefined
        return text ? Effect.asVoid(alerts.customer(row.account_id, text)) : Effect.void
      }

      const advance = (id: string, resumed: boolean, notifyAfter = resumed) =>
        Effect.suspend(() => {
          // Another run has this purchase: leave it, and leave its guard alone. Only the run that set the
          // guard clears it; a caller turned away here once cleared it, and the next one started a second run.
          if (running.has(id)) return Effect.void
          running.add(id)
          return Effect.gen(function*() {
            let first = true
            while (yield* Effect.flatMap(load(id), (row) => step(row, resumed && first))) first = false
            if (notifyAfter) yield* Effect.flatMap(load(id), notify)
          }).pipe(
            Effect.catch((e: Unknown) => Effect.logWarning(`purchase ${id} paused: ${e.message}`)),
            // Anything unexpected (database, decryption) pauses this purchase only; the reconciler retries it.
            Effect.catchCause((cause) => Effect.logError(`purchase ${id} paused`, cause)),
            Effect.ensuring(Effect.sync(() => running.delete(id)))
          )
        }).pipe(
          // A deploy or shutdown waits for the run to finish: stopping between a side effect and
          // saving its result would leave the purchase for a human (pm2 kill_timeout allows for it).
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
        const status = row.step === "settled"
          ? "delivered"
          : row.step === "failed" || row.step === "rejected"
          ? row.step
          : WAITING_STEPS.includes(row.step)
          ? "waiting"
          : "pending"
        const d = row.draw
        return new Purchase({
          id: row.id,
          voucherId: row.voucher_id,
          voucherName: row.voucher_name,
          ...bitrefill.logo(row.voucher_id),
          value: row.package_value,
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
                cashback: Number(d.cashback)
              })
            }
            : {}),
          ...(row.redemption && row.step === "settled" ? openRedemption(row) : {}),
          ...(row.admit_tx ? { admitTx: row.admit_tx.hash } : {}),
          ...(row.settle_tx ? { settleTx: row.settle_tx.hash } : {}),
          ...(row.contract_purchase_id !== null ? { contractPurchaseId: Number(row.contract_purchase_id) } : {}),
          createdAt: new Date(row.created_at).toISOString()
        })
      }

      const price = (voucherId: string, value: string, purchase = false) =>
        Effect.gen(function*() {
          const voucher = yield* bitrefill.voucher(voucherId, { purchase })
          const pkg = voucher.packages.find((p) => p.value === value)
          if (!pkg) return yield* new PurchaseInvalid({ message: `${voucher.name} has no ${value} package` })
          return { voucher, referencePrice: pkg.priceMicroUsdc }
        })

      // The contract's own terms (ADR-0004): the server never works out a Lucky Amount itself.
      const contractQuote = (referencePrice: number, mode: Mode) =>
        near.view<QuoteView>("quote", { reference_price: String(referencePrice), mode }).pipe(
          Effect.tapError((e) => Effect.logWarning(`quote: ${e.message}`)),
          // The RPC's own error text (endpoint, upstream reply) stays in our logs.
          Effect.mapError((e) =>
            new PurchaseInvalid({
              message: e.message.includes("Reserve too small")
                ? "The reserve is too small for a Lucky Buy right now; use Normal"
                // The contract's own refusal (say, under the minimum) is the customer's answer; anything else isn't.
                : /Smart contract panicked: ([^"\\]+)/.exec(e.message)?.[1] ?? "Couldn't get a price from NEAR right now. Try again in a moment."
            })
          )
        )

      const quote = Effect.fn("Purchases.quote")(function*(voucherId: string, value: string, game: number | undefined) {
        const { referencePrice } = yield* price(voucherId, value)
        const mode: Mode = game === undefined ? "normal" : { lucky: game }
        const q = yield* contractQuote(referencePrice, mode)
        return new Quote({
          mode: q.mode,
          referencePrice: Number(q.reference_price),
          luckyAmount: Number(q.lucky_amount),
          maxPrice: Number(q.max_price)
        })
      })

      // Checked before signing anything, so an empty or capped account can't make the operator pay
      // gas for purchases the contract would refuse. The contract still checks all of it.
      const preflight = Effect.fn("Purchases.preflight")(function*(accountId: string, referencePrice: number, maxPrice: number) {
        const invalid = (message: string) => new PurchaseInvalid({ message })
        const [open] = yield* sql<{ n: number }>`
          SELECT count(*)::int AS n FROM purchases WHERE account_id = ${accountId} AND step IN ${sql.in([...OPEN_STEPS, ...WAITING_STEPS])}`.pipe(Effect.orDie)
        if ((open?.n ?? 0) >= MAX_OPEN_PER_ACCOUNT) return yield* invalid("You have purchases still in progress; try again when they finish")
        if (maxPrice < referencePrice) return yield* invalid("Price changed since you confirmed; please confirm again")
        const a = yield* near.view<ContractAccount | null>("get_account", { account_id: accountId }).pipe(
          Effect.mapError(() => invalid("Couldn't read your balance from NEAR; try again in a moment"))
        )
        if (!a) return yield* invalid("No balance yet; add funds first")
        if (Number(a.balance) < referencePrice) return yield* invalid("Insufficient balance; add funds first")
        if (Number(a.per_purchase_limit) < referencePrice) return yield* invalid("Over the per-purchase spending limit")
        const spent = a.day === Math.floor(Date.now() / DAY_MS) ? Number(a.spent_today) : 0
        if (spent + referencePrice > Number(a.daily_limit)) return yield* invalid("Over the daily spending limit")
      })

      const create = Effect.fn("Purchases.create")(function*(accountId: string, input: NewPurchase) {
        if (Option.isNone(key)) return yield* new PurchaseInvalid({ message: "Purchases are disabled: REDEMPTION_KEY is not set" })
        // A retry of a purchase already made still returns it below; only new ones are held back.
        const shop = yield* sales.status
        // Testnet balances are test money: never let them buy a real voucher paid from our real Bitrefill balance.
        if (testnet && !input.voucherId.startsWith("test-")) {
          return yield* new PurchaseInvalid({ message: "On testnet only Bitrefill test vouchers can be bought" })
        }
        // A retry with the same key returns the original purchase instead of buying again.
        const existing = yield* sql<{ id: string }>`SELECT id FROM purchases WHERE account_id = ${accountId} AND idempotency_key = ${input.idempotencyKey}`
          .pipe(Effect.orDie)
        if (existing[0]) return view(yield* load(existing[0].id))
        if (!shop.open) return yield* new PurchaseInvalid({ message: closedMessage(shop) })
        const { voucher, referencePrice } = yield* price(input.voucherId, input.value, true)
        // Test cards are free on Bitrefill; real ones are paid from our credit (ADR-0009).
        const real = !voucher.id.startsWith("test-")
        // No card is refused for its size: one our credit can't cover waits, uncharged, for a refill
        // sized for it. Only one bigger than Bitrefill lets our account hold could never be bought.
        if (real) {
          // Read Bitrefill first if we haven't yet; unreadable, the card simply waits like any other.
          if (!(yield* credit.view).snapshot) yield* credit.refresh
          const c = yield* credit.view
          const most = Math.max(0, c.free) + (c.snapshot?.room ?? Number.POSITIVE_INFINITY)
          if (referencePrice > most) {
            return yield* new PurchaseInvalid({ message: `That card is bigger than we can buy right now (up to ${usd(most)}). Please choose a smaller one.` })
          }
        }
        // A guest order needs the customer's Checkout Email, and stays within Bitrefill's limits for it (ADR-0012).
        // One on the customer's own Bitrefill account is under that account's limits, which Bitrefill checks.
        const asGuest = real && bitrefill.guest && !(yield* connect.connected(accountId))
        const email = asGuest ? yield* emailOf(accountId) : undefined
        if (asGuest) {
          if (!email) return yield* new PurchaseInvalid({ message: "Add the email for your cards first: Bitrefill needs one for each card (a throwaway one is fine)." })
          const over = yield* overGuestLimit(email.key, referencePrice)
          if (over) return yield* new PurchaseInvalid({ message: over })
        }
        yield* preflight(accountId, referencePrice, input.maxPrice)
        // A Lucky Buy is admitted at the Lucky Amount it's accepted under, or refused: it may wait a day for
        // credit while the reserve moves. (Default Mode isn't known here; those admit as before.)
        // The quote the customer saw carries it; without one (an older client), the contract's quote now.
        if (typeof input.mode === "object" && input.luckyAmount !== undefined && !(input.luckyAmount > 0 && input.luckyAmount <= referencePrice)) {
          return yield* new PurchaseInvalid({ message: "That quote is out of date; please confirm again." })
        }
        const luckyAmount = typeof input.mode !== "object"
          ? null
          : input.luckyAmount ?? (yield* contractQuote(referencePrice, input.mode)).lucky_amount
        // Deciding "go or wait" and recording it happen under one lock, so two purchases can never
        // both count on the same credit.
        const inserted = yield* credit.guard((free) =>
          Effect.gen(function*() {
            const wait = real && free < referencePrice
            if (wait) {
              const [w] = yield* sql<{ n: number }>`
                SELECT count(*)::int AS n FROM purchases WHERE account_id = ${accountId} AND step IN ${sql.in(WAITING_STEPS)}`.pipe(Effect.orDie)
              if ((w?.n ?? 0) > 0) return yield* new PurchaseInvalid({ message: "You already have a card on its way; try again when it's ready." })
            }
            return yield* sql<{ id: string; step: Step }>`
              INSERT INTO purchases (account_id, idempotency_key, voucher_id, voucher_name, package_value, requested_mode, reference_price, max_debit, quoted_lucky_amount, step, email_key)
              VALUES (${accountId}, ${input.idempotencyKey}, ${voucher.id}, ${voucher.name}, ${input.value},
                      ${input.mode === undefined ? null : JSON.stringify(input.mode)}, ${referencePrice}, ${input.maxPrice}, ${luckyAmount}, ${wait ? "waiting" : "admit"},
                      ${email?.key ?? null})
              ON CONFLICT (account_id, idempotency_key) DO NOTHING
              RETURNING id, step`.pipe(Effect.orDie)
          })
        )
        // Two requests with the same key at once: the second returns the first's purchase.
        const id = inserted[0]?.id ??
          (yield* sql<{ id: string }>`SELECT id FROM purchases WHERE account_id = ${accountId} AND idempotency_key = ${input.idempotencyKey}`
            .pipe(Effect.orDie))[0]!.id
        if (inserted[0]?.step === "waiting") yield* refill.kick
        else if (inserted.length > 0) {
          // A guest card can take over a minute (Base payment, then Bitrefill), and Cloudflare drops a request at 100 s:
          // stop waiting at requestWait and answer "pending". The run carries on; the web follows it, and Telegram hears when it ends.
          const run = yield* FiberSet.run(workflows, advance(id, false))
          if (Option.isNone(yield* Fiber.join(run).pipe(Effect.timeoutOption(requestWait)))) {
            yield* FiberSet.run(workflows, Effect.andThen(Fiber.await(run), Effect.flatMap(load(id), notify)).pipe(Effect.ignore))
          }
        }
        return view(yield* load(id))
      })

      const list = (accountId: string) =>
        sql<Row>`SELECT * FROM purchases WHERE account_id = ${accountId} ORDER BY created_at DESC LIMIT 100`.pipe(
          Effect.map((rows) => rows.map(view)),
          Effect.orDie
        )

      const get = (accountId: string, id: string) =>
        sql<Row>`SELECT * FROM purchases WHERE id = ${id} AND account_id = ${accountId}`.pipe(
          Effect.orDie,
          Effect.flatMap((r) => (r[0] ? Effect.succeed(view(r[0])) : Effect.fail(new NotFound())))
        )

      const cancel = (accountId: string, id: string) =>
        Effect.gen(function*() {
          const [row] = yield* sql<Row>`SELECT * FROM purchases WHERE id = ${id} AND account_id = ${accountId}`.pipe(Effect.orDie)
          if (!row) return yield* new NotFound()
          // Only before admission: once charged, the purchase finishes (or is refunded) by itself.
          if (row.step !== "waiting" || !(yield* move(row, { step: "rejected", error: "You cancelled it. You weren't charged." }))) {
            return yield* new PurchaseInvalid({ message: "This purchase is already going through, so it can't be cancelled; if it fails you get the full amount back." })
          }
          return view(yield* load(id))
        })

      const giveUp = (id: string) =>
        Effect.gen(function*() {
          const row = yield* load(id)
          if (!(yield* move(row, { step: "stuck", error: `Gave up after ${MAX_ATTEMPTS} attempts at ${row.step}: ${row.error ?? ""}` }))) return
          yield* alerts.admin(`purchase ${id} stuck after ${MAX_ATTEMPTS} attempts at ${row.step}`)
          yield* notify(yield* load(id))
        })

      // Reconciler: every 30 seconds, resume anything left part-way, each purchase with its own
      // backoff, so a few broken purchases can never starve newer ones.
      const reconcile = sql<{ id: string; attempts: number }>`
        UPDATE purchases SET attempts = attempts + 1,
          next_attempt_at = now() + LEAST(interval '1 hour', interval '30 seconds' * power(2, attempts))
        WHERE id IN (
          SELECT id FROM purchases
          WHERE step IN ${sql.in(OPEN_STEPS)} AND updated_at < now() - interval '30 seconds' AND next_attempt_at <= now()
          ORDER BY next_attempt_at LIMIT 20)
        RETURNING id, attempts`.pipe(
        Effect.orDie,
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (r) => (r.attempts > MAX_ATTEMPTS ? giveUp(r.id) : advance(r.id, true)), { discard: true, concurrency: 4 })
        ),
        // A failed pass (e.g. the database blinked) must never end the reconciler.
        Effect.catchCause((cause) => Effect.logError("reconcile pass failed", cause))
      )
      yield* reconcile.pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped)

      // Purchases waiting for credit: each goes on as soon as the credit covers it (under the same
      // lock as new purchases), or is cancelled after waitMinutes: uncharged if it never reached
      // admission, refunded in full through fail_purchase if it did.
      const promote = Effect.gen(function*() {
        const { waitMinutes } = yield* credit.settings
        // While sales are closed, nothing new is admitted; waiting purchases keep their place (and their timer).
        // At Bitrefill's order limit, charged ones wait too, rather than be refused and refunded.
        const shop = yield* sales.status
        const open = shop.open
        const rows = yield* sql<Row>`SELECT * FROM purchases WHERE step IN ${sql.in(WAITING_STEPS)} ORDER BY created_at LIMIT 50`.pipe(Effect.orDie)
        for (const row of rows) {
          // Its own run may still be finishing the step that moved it here (refreshing the credit after
          // Bitrefill's refusal): moving it now would leave it at "ordering" with nothing running it.
          if (running.has(row.id)) continue
          // Measured from creation, so bouncing between ordering and restock can't extend it. A charged one
          // is refunded an hour before the customer could Reclaim it, so a late order never races a reclaim.
          const late = Date.now() - time(row.created_at) > waitMinutes * 60_000 ||
            (row.step === "restock" && Date.now() > admittedAt(row) + DAY_MS - RECLAIM_MARGIN_MS)
          if (late) {
            if (row.step === "waiting") {
              if (yield* move(row, { step: "rejected", error: "We couldn't get this card ready in time, so we cancelled it. You weren't charged." })) {
                yield* notify(yield* load(row.id))
              }
            } else if (yield* move(row, { step: "fail", error: "Bitrefill credit didn't arrive in time" })) {
              yield* FiberSet.run(workflows, advance(row.id, false, true))
            }
            continue
          }
          if ((row.step === "waiting" && !open) || (row.step === "restock" && shop.reason === "limit")) continue
          const next: Step = row.step === "waiting" ? "admit" : "ordering"
          // Bitrefill refused a restock row for credit: order it again only on a balance read since then, never
          // on the estimate that was already wrong (that would re-order every 10 seconds, spending Bitrefill calls).
          const fresh = (readAt: Date | undefined) => row.step === "waiting" || (readAt !== undefined && readAt.getTime() >= time(row.updated_at))
          const go = yield* credit.guard((free, readAt) =>
            free >= Number(row.reference_price) && fresh(readAt) ? move(row, { step: next, error: null }) : Effect.succeed(false)
          )
          // The customer may have left: tell them in Telegram how it ended.
          if (go) yield* FiberSet.run(workflows, advance(row.id, false, true))
        }
      }).pipe(Effect.catchCause((cause) => Effect.logError("waiting purchases pass failed", cause)))
      yield* promote.pipe(Effect.repeat(Schedule.spaced("10 seconds")), Effect.forkScoped)

      // A stuck purchase the customer reclaimed (or that was failed) onchain is over: say so here too.
      const settleClosed = Effect.gen(function*() {
        const rows = yield* sql<Row>`SELECT * FROM purchases WHERE step = 'stuck' AND contract_purchase_id IS NOT NULL LIMIT 50`.pipe(Effect.orDie)
        for (const row of rows) {
          const onchain = yield* near.view<OnchainPurchase | null>("get_purchase", { purchase_id: Number(row.contract_purchase_id) })
          if (onchain?.status === "Reclaimed" || onchain?.status === "Failed") {
            if (yield* move(row, { step: "failed", error: onchain.status === "Reclaimed" ? "Reclaimed" : row.error })) yield* notify(yield* load(row.id))
          }
          // Delivered after we gave up (say, the customer re-ran the Draw): their code is ready, so show it.
          if (onchain?.status === "Delivered" && row.redemption !== null) {
            const draw = chainDraw(onchain)
            if (yield* move(row, { step: "settled", ...(draw ? { draw, settle_tx: null } : {}) })) yield* notify(yield* load(row.id))
          }
        }
      }).pipe(Effect.catchCause((cause) => Effect.logError("closed purchases pass failed", cause)))
      yield* settleClosed.pipe(Effect.repeat(Schedule.spaced("5 minutes")), Effect.forkScoped)

      return Purchases.of({ quote, create, list, get, cancel, promoteWaiting: promote, reconcileNow: reconcile, checkoutEmail, setCheckoutEmail })
    })
  )
}
