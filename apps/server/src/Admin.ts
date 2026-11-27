import {
  ADMIN_LIST_LIMIT,
  AdminInvalid,
  AdminOverview,
  AdminPurchase,
  AdminUser,
  AttentionPurchase,
  GUEST_LIMITS,
  NotFound,
  type OwnerAction,
  type PurchaseInvalid,
  type ShopStatus
} from "@luckout/api"
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token"
import { PublicKey, type TransactionInstruction } from "@solana/web3.js"
import { Config, Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { Alerts } from "./Alerts.ts"
import { Bitrefill } from "./Bitrefill.ts"
import { LOW_LINES } from "./Monitor.ts"
import { GUEST_COUNTED_AT, OPEN_STEPS, PAYING_LIMITS, payingUse, retryPurchase, retryStep } from "./Purchases.ts"
import { Sales } from "./Sales.ts"
import { maxCashback } from "./Program.ts"
import { Solana } from "./Solana.ts"

// The admin panel's server side. Only accounts in ADMIN_ACCOUNTS get anything; everyone else is
// told the page doesn't exist. Nothing here moves money: the reserve, Proceeds, pausing and caps are
// transactions prepared here for the owner to sign in their own wallet (ADR-0015), and the program checks
// the owner itself.

/** Customers on the users list: each costs one account read per load. */
const USERS_SHOWN = ADMIN_LIST_LIMIT
/** Purchases the overview lists as needing attention; the count of all of them comes with it. */
const ATTENTION_SHOWN = 20

interface Row {
  id: string
  account_id: string
  voucher_name: string
  package_value: string
  step: string
  error: string | null
  attempts: number
  created_at: Date | string
}

export class Admin extends Context.Service<Admin, {
  isAdmin(accountId: string): boolean
  readonly overview: Effect.Effect<AdminOverview>
  /** The latest purchases, or one account's; with `id`, only that purchase, however old. */
  purchases(accountId?: string, id?: string): Effect.Effect<ReadonlyArray<AdminPurchase>>
  readonly users: Effect.Effect<ReadonlyArray<AdminUser>>
  /** Stops or restarts new purchases on the server (no wallet needed). */
  setSales(open: boolean, by: string): Effect.Effect<ShopStatus>
  /** Runs a purchase's next step now instead of after its backoff. Never re-buys or re-charges. */
  retry(id: string, by: string): Effect.Effect<void, PurchaseInvalid>
  /**
   * An owner transaction for admin `by`, unsigned: our fee payer pays, and the owner signs (the proposed owner, for
   * `accept_owner`). It goes through /transactions/submit like any other prepared transaction.
   */
  ownerTransaction(by: string, action: OwnerAction): Effect.Effect<{ readonly transaction: string; readonly token: string }, NotFound | AdminInvalid>
}>()("luckout/Admin") {
  static readonly layer = Layer.effect(
    Admin,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const solana = yield* Solana
      const sales = yield* Sales
      const alerts = yield* Alerts
      const bitrefill = yield* Bitrefill
      const admins = new Set(
        (yield* Config.String("ADMIN_ACCOUNTS").pipe(Config.withDefault(""))).split(",").map((a) => a.trim()).filter(Boolean)
      )

      const counted = sql.literal(GUEST_COUNTED_AT)
      const overview = Effect.gen(function*() {
        const config = yield* solana.config
        const [vault, payWallet, feePayerSol, purchases, attention, shop, checkout, paying] = yield* Effect.all([
          solana.account(config.vault),
          solana.account(config.pay_wallet),
          solana.feePayer ? solana.balance(solana.feePayer) : Effect.succeed(undefined),
          sql<{ today: number; delivered: number }>`
            SELECT count(*)::int AS today, count(*) FILTER (WHERE step = 'settled')::int AS delivered
            FROM purchases WHERE created_at > now() - interval '1 day'`,
          // Oldest first: they are the closest to the customer's Reclaim at 24 hours. `total` counts them all,
          // before the limit, so the panel can say how many it isn't showing.
          sql<Row & { checkout_step: string; total: number }>`
            SELECT p.id, p.account_id, p.voucher_name, p.package_value, p.step, p.error, c.attempts, p.created_at, c.step AS checkout_step,
                   count(*) OVER ()::int AS total
            FROM purchases p JOIN checkouts c ON c.id = p.checkout_id
            WHERE p.step IN ('stuck', 'waiting', 'restock') OR (p.step IN ${sql.in(OPEN_STEPS)} AND p.created_at < now() - interval '15 minutes')
            ORDER BY p.created_at LIMIT ${ATTENTION_SHOWN}`,
          sales.status,
          // Per Checkout Email, counted the way Purchases checks Bitrefill's limits; the busiest on each figure.
          sql<{ emails: number; connected: number; orders: number; daily: string; monthly: string }>`
            SELECT (SELECT count(*)::int FROM checkout_emails) AS emails, (SELECT count(*)::int FROM bitrefill_connections) AS connected,
                   COALESCE(max(orders), 0)::int AS orders, COALESCE(max(daily), 0)::text AS daily, COALESCE(max(monthly), 0)::text AS monthly
            FROM (
              SELECT count(*) FILTER (WHERE ${counted} > now() - interval '1 day') AS orders,
                     COALESCE(sum(reference_price) FILTER (WHERE ${counted} > now() - interval '1 day'), 0) AS daily,
                     COALESCE(sum(reference_price) FILTER (WHERE ${counted} > now() - interval '30 days'), 0) AS monthly
              FROM purchases
              WHERE email_key IS NOT NULL AND created_at > now() - interval '32 days'
                AND step <> 'rejected' AND NOT (step = 'failed' AND invoice_id IS NULL)
              GROUP BY email_key) per_email`,
          payingUse(sql)
        ], { concurrency: "unbounded" })
        const p = purchases[0] ?? { today: 0, delivered: 0 }
        const held = vault ? Number(vault.data.readBigUInt64LE(64)) : 0
        const free = Number(config.free_reserve)
        const fixed = config.cashback_cap.fixed === null ? null : Number(config.cashback_cap.fixed)
        const today = BigInt(Math.floor(Date.now() / 86_400_000))
        return new AdminOverview({
          cluster: solana.cluster,
          program: {
            id: solana.program.id.toBase58(),
            owner: config.owner.toBase58(),
            ...(config.pending_owner ? { pendingOwner: config.pending_owner.toBase58() } : {}),
            operator: config.operator.toBase58(),
            usdcMint: config.usdc_mint.toBase58(),
            vault: config.vault.toBase58(),
            payWallet: config.pay_wallet.toBase58(),
            paused: config.paused
          },
          salesStopped: shop.reason === "stopped",
          reserve: {
            free,
            locked: Number(config.locked_reserve),
            proceeds: Number(config.proceeds),
            maxCashback: Number(maxCashback(config)),
            cashbackCap: { fixed, reserveBps: config.cashback_cap.reserve_bps },
            minLuckyCheckout: Number(config.min_lucky_checkout),
            held,
            customers: held - free - Number(config.locked_reserve) - Number(config.proceeds)
          },
          repay: { dailyCap: Number(config.repay_daily_cap), repaidToday: config.repay_day === today ? Number(config.repaid_today) : 0 },
          stats: { luckySettled: Number(config.lucky_settled), luckyAmountTotal: Number(config.lucky_amount_total), luckyPaidTotal: Number(config.lucky_paid_total) },
          keys: [
            ...(solana.feePayer && feePayerSol !== undefined
              ? [{ role: "feePayer" as const, address: solana.feePayer.toBase58(), balance: String(feePayerSol), alertBelow: String(LOW_LINES.feePayer) }]
              : []),
            {
              role: "payWallet" as const,
              address: config.pay_wallet.toBase58(),
              balance: String(payWallet ? payWallet.data.readBigUInt64LE(64) : 0n),
              alertBelow: String(LOW_LINES.float)
            }
          ],
          purchases: {
            today: p.today,
            deliveredToday: p.delivered,
            attention: attention.map((r) =>
              new AttentionPurchase({
                id: r.id,
                accountId: r.account_id,
                voucherName: r.voucher_name,
                value: r.package_value,
                step: r.step,
                ...(r.error ? { error: r.error } : {}),
                attempts: r.attempts,
                createdAt: new Date(r.created_at).toISOString(),
                retryable: retryStep(r, r.checkout_step) !== undefined
              })
            ),
            attentionTotal: attention[0]?.total ?? 0
          },
          checkout: {
            guest: bitrefill.guest,
            emails: checkout[0]?.emails ?? 0,
            connected: checkout[0]?.connected ?? 0,
            limits: { orders: GUEST_LIMITS.orders, daily: GUEST_LIMITS.daily, monthly: GUEST_LIMITS.monthly },
            busiest: { orders: checkout[0]?.orders ?? 0, daily: Number(checkout[0]?.daily ?? 0), monthly: Number(checkout[0]?.monthly ?? 0) }
          },
          paying: { ...paying, limits: PAYING_LIMITS }
        })
      }).pipe(Effect.orDie)

      const purchaseList = (accountId?: string, id?: string) =>
        sql<Row & {
          checkout_id: string
          currency: string | null
          requested_mode: AdminPurchase["mode"] | null
          admitted: { mode: AdminPurchase["mode"]; max_price: string } | null
          reference_price: string | number
          draw: { final_price: string | number; cashback: string | number } | null
          invoice_id: string | null
          pay_tx: { signature: string } | null
          pay_amount: string | number | null
          admit_tx: { signature: string } | null
          settle_tx: { signature: string } | null
          updated_at: Date | string
        }>`
          SELECT p.id, p.checkout_id, p.account_id, p.voucher_name, p.package_value, p.currency, p.step, p.error, c.attempts, p.created_at, p.updated_at,
                 p.requested_mode, p.admitted, p.reference_price, p.draw, p.invoice_id, c.pay_tx, c.pay_amount, p.admit_tx, p.settle_tx
          FROM purchases p JOIN checkouts c ON c.id = p.checkout_id
          ${id ? sql`WHERE p.id = ${id}` : accountId ? sql`WHERE p.account_id = ${accountId}` : sql``}
          ORDER BY p.created_at DESC LIMIT ${ADMIN_LIST_LIMIT}`.pipe(
          Effect.map((rows) =>
            rows.map((r) => {
              const mode = r.admitted?.mode ?? r.requested_mode
              // Same as the customer's own view: the Draw's final price, else the admitted maximum, else the reference price.
              const paid = r.draw ? Number(r.draw.final_price) : r.step === "settled" ? Number(r.admitted?.max_price ?? r.reference_price) : undefined
              return new AdminPurchase({
                id: r.id,
                checkoutId: r.checkout_id,
                accountId: r.account_id,
                voucherName: r.voucher_name,
                value: r.package_value,
                ...(r.currency ? { currency: r.currency } : {}),
                step: r.step,
                ...(mode ? { mode } : {}),
                referencePrice: Number(r.reference_price),
                ...(r.admitted ? { maxPrice: Number(r.admitted.max_price) } : {}),
                ...(paid !== undefined ? { paid } : {}),
                ...(r.draw ? { cashback: Number(r.draw.cashback) } : {}),
                ...(r.error ? { error: r.error } : {}),
                attempts: r.attempts,
                ...(r.invoice_id ? { invoiceId: r.invoice_id } : {}),
                ...(r.pay_tx ? { payTx: r.pay_tx.signature } : {}),
                ...(r.pay_amount !== null ? { payAmount: Number(r.pay_amount) } : {}),
                ...(r.admit_tx ? { admitTx: r.admit_tx.signature } : {}),
                ...(r.settle_tx ? { settleTx: r.settle_tx.signature } : {}),
                createdAt: new Date(r.created_at).toISOString(),
                updatedAt: new Date(r.updated_at).toISOString()
              })
            })
          ),
          Effect.orDie
        )

      // ponytail: the 300 most recent customers, one get_account view each on every load; page it when there are more.
      const users = Effect.gen(function*() {
        const rows = yield* sql<{
          account_id: string
          first_seen: Date | string
          telegram_name: string | null
          purchases: number
          delivered: number
          spent: string | number
          cashback: string | number
          last_purchase_at: Date | string | null
          checkout_email: boolean
          bitrefill_connected: boolean
        }>`
          SELECT k.account_id, k.first_seen, t.telegram_name, (e.account_id IS NOT NULL) AS checkout_email,
                 (b.account_id IS NOT NULL) AS bitrefill_connected,
                 count(p.id)::int AS purchases,
                 count(p.id) FILTER (WHERE p.step = 'settled')::int AS delivered,
                 coalesce(sum(coalesce((p.draw->>'final_price')::bigint, (p.admitted->>'max_price')::bigint, p.reference_price))
                   FILTER (WHERE p.step = 'settled'), 0) AS spent,
                 coalesce(sum((p.draw->>'cashback')::bigint) FILTER (WHERE p.step = 'settled'), 0) AS cashback,
                 max(p.created_at) AS last_purchase_at
          FROM known_accounts k
          LEFT JOIN purchases p ON p.account_id = k.account_id
          LEFT JOIN telegram_links t ON t.account_id = k.account_id
          LEFT JOIN checkout_emails e ON e.account_id = k.account_id
          LEFT JOIN bitrefill_connections b ON b.account_id = k.account_id
          GROUP BY k.account_id, k.first_seen, k.onchain, t.telegram_name, e.account_id, b.account_id
          -- Buyers first, then accounts the contract knows, then the newest sign-ups: signing in is free, so
          -- sign-ups that never deposited can't crowd the rest out.
          ORDER BY max(p.created_at) DESC NULLS LAST, k.onchain DESC, k.first_seen DESC
          LIMIT ${USERS_SHOWN}`.pipe(Effect.orDie)
        const accounts = yield* Effect.forEach(rows, (r) =>
          Effect.suspend(() => solana.customer(new PublicKey(r.account_id))).pipe(
            Effect.map((c) => (c ? { balance: c.balance, per_purchase_limit: String(c.per_purchase_limit), daily_limit: String(c.daily_limit) } : null)),
            Effect.orElseSucceed(() => undefined)
          ), { concurrency: 8 })
        return rows.map((r, i) => {
          const a = accounts[i]
          return new AdminUser({
            accountId: r.account_id,
            firstSeen: new Date(r.first_seen).toISOString(),
            // null from the contract: never deposited, so nothing held.
            ...(a === null ? { balance: 0 } : a ? { balance: Number(a.balance), perPurchaseLimit: a.per_purchase_limit, dailyLimit: a.daily_limit } : {}),
            ...(r.telegram_name ? { telegram: r.telegram_name } : {}),
            purchases: r.purchases,
            delivered: r.delivered,
            spent: Number(r.spent),
            cashback: Number(r.cashback),
            ...(r.last_purchase_at ? { lastPurchaseAt: new Date(r.last_purchase_at).toISOString() } : {}),
            checkoutEmail: r.checkout_email,
            bitrefillConnected: r.bitrefill_connected
          })
        })
      })

      // ponytail: one lock in memory, one process (ADR-0006). A save reads the current settings and writes them
      // back with its own fields changed; two saves at once must not both start from the same old copy.
      const retry = (id: string, by: string) =>
        retryPurchase(id).pipe(
          Effect.flatMap((at) => alerts.admin(`${by} retried purchase ${id} at ${at}`)),
          Effect.provideService(SqlClient.SqlClient, sql)
        )

      const ownerTransaction = (by: string, action: OwnerAction) =>
        Effect.gen(function*() {
          if (!admins.has(by)) return yield* new NotFound()
          const feePayer = solana.feePayer
          if (!feePayer) return yield* new AdminInvalid({ message: "The server's fee payer isn't set" })
          const config = yield* solana.config
          const p = solana.program
          const owner = config.owner
          const key = (text: string) =>
            Effect.try({ try: () => new PublicKey(text), catch: () => new AdminInvalid({ message: `${text} isn't a Solana address` }) })
          const usdc = (wallet: PublicKey) => getAssociatedTokenAddressSync(config.usdc_mint, wallet)
          // Opened, if it has none, at our fee payer's cost.
          const open = (wallet: PublicKey) => createAssociatedTokenAccountIdempotentInstruction(feePayer, usdc(wallet), wallet, config.usdc_mint)
          const ix = (accounts: Readonly<Record<string, PublicKey>>, args: Readonly<Record<string, unknown>> = {}) =>
            p.instruction(action._tag, { owner, config: p.config, ...accounts }, args)
          const payout = (to: PublicKey, amount: number) => ix({ vault: p.vault, vault_authority: p.vaultAuthority, to }, { amount: BigInt(amount) })

          let signer = owner
          let ixs: Array<TransactionInstruction>
          switch (action._tag) {
            case "set_paused":
              ixs = [ix({}, { paused: action.paused })]
              break
            case "set_cashback_cap":
              ixs = [ix({}, { fixed: action.fixed === null ? null : BigInt(action.fixed), reserve_bps: action.reserveBps })]
              break
            case "set_repay_cap":
              ixs = [ix({}, { daily: BigInt(action.daily) })]
              break
            case "set_min_lucky_checkout":
              ixs = [ix({}, { amount: BigInt(action.amount) })]
              break
            case "fund_reserve":
              ixs = [ix({ from: usdc(owner), vault: p.vault }, { amount: BigInt(action.amount) })]
              break
            case "withdraw_reserve":
              ixs = [open(owner), payout(usdc(owner), action.amount)]
              break
            case "withdraw_proceeds":
              ixs = action.to === "payWallet" ? [payout(config.pay_wallet, action.amount)] : [open(owner), payout(usdc(owner), action.amount)]
              break
            case "set_operator":
              ixs = [ix({}, { operator: yield* key(action.operator) })]
              break
            case "set_pay_wallet": {
              const wallet = yield* key(action.payWallet)
              ixs = [open(wallet), ix({ pay_wallet: usdc(wallet) })]
              break
            }
            case "propose_owner":
              ixs = [ix({}, { new_owner: action.newOwner === null ? null : yield* key(action.newOwner) })]
              break
            case "accept_owner":
              if (!config.pending_owner) return yield* new AdminInvalid({ message: "No new owner is proposed" })
              signer = config.pending_owner
              ixs = [p.instruction("accept_owner", { new_owner: signer, config: p.config })]
              break
          }
          return yield* solana.prepare(ixs, signer)
        }).pipe(Effect.catchTag("SolanaUnavailable", (e) => Effect.fail(new AdminInvalid({ message: e.message }))))

      return Admin.of({
        isAdmin: (a) => admins.has(a),
        overview,
        purchases: purchaseList,
        users,
        setSales: sales.setOpen,
        retry,
        ownerTransaction
      })
    })
  )
}
