import { ADMIN_LIST_LIMIT, GUEST_LIMITS, AdminInvalid, AdminOverview, AdminPurchase, AdminUser, AttentionPurchase, type CreditChange, CreditSettings, PurchaseInvalid, type RefillView, type RelayChange, RelaySettings, type ShopStatus } from "@luckout/api"
import { Config, Context, Effect, Layer, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import { Alerts } from "./Alerts.ts"
import { Bitrefill } from "./Bitrefill.ts"
import { Credit, settingsProblem } from "./Credit.ts"
import { BASE_GAS_ALERT, GAS_ALERT, spendable } from "./Monitor.ts"
import { Near, Network } from "./Near.ts"
import { GUEST_COUNTED_AT, OPEN_STEPS, retryPurchase, retryStep } from "./Purchases.ts"
import { Refill } from "./Refill.ts"
import { Relay } from "./Relay.ts"
import { Sales } from "./Sales.ts"

// The admin panel's server side. Only accounts in ADMIN_ACCOUNTS get anything; everyone else is
// told the page doesn't exist. Nothing here moves money: reserve, proceeds, pausing and gas are
// transactions the admin signs in their own wallet, and the contract checks the owner itself.

/** Bitrefill's purchase cap on our account, per day across all products (deploy/RUNBOOK.md). */
const BITREFILL_DAILY_CAP = 15
/** Customers on the users list: each costs one contract view per load. */
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
  /** Changes only the fields in `change`; the rest stay as they are now. */
  configureRelay(change: RelayChange, by: string): Effect.Effect<RelaySettings>
  /** Changes only the fields in `change`, if the result hangs together; the rest stay as they are now. */
  configureCredit(change: CreditChange, by: string): Effect.Effect<CreditSettings, AdminInvalid>
  refill(amount: number | undefined, by: string): Effect.Effect<RefillView, AdminInvalid>
  resolveRefill(id: string, note: string, by: string): Effect.Effect<void, AdminInvalid>
  /** Stops or restarts new purchases on the server (no wallet needed). */
  setSales(open: boolean, by: string): Effect.Effect<ShopStatus>
  /** Runs a purchase's next step now instead of after its backoff. Never re-buys or re-charges. */
  retry(id: string, by: string): Effect.Effect<void, PurchaseInvalid>
}>()("luckout/Admin") {
  static readonly layer = Layer.effect(
    Admin,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const near = yield* Near
      const relay = yield* Relay
      const credit = yield* Credit
      const refills = yield* Refill
      const sales = yield* Sales
      const alerts = yield* Alerts
      const network = yield* Network
      const bitrefill = yield* Bitrefill
      const admins = new Set(
        (yield* Config.String("ADMIN_ACCOUNTS").pipe(Config.withDefault(""))).split(",").map((a) => a.trim()).filter(Boolean)
      )

      const counted = sql.literal(GUEST_COUNTED_AT)
      const overview = Effect.gen(function*() {
        const gasOf = (role: keyof typeof GAS_ALERT, accountId: string | undefined) =>
          accountId
            ? spendable(near, accountId).pipe(Effect.map((s) => [{ role, accountId, spendable: String(s), alertBelow: String(GAS_ALERT[role]) }]))
            : Effect.succeed([])
        const [config, reserve, stats, gas, settings, relays, top, purchases, attention, c, r, shop, held, checkout] = yield* Effect.all([
          near.view<{ owner: string; pending_owner?: string | null; operator: string; usdc: string; paused: boolean; cashback_cap: { fixed: string | null; reserve_bps: number | null } }>("get_config"),
          near.view<{ free: string; locked: string; max_cashback: string; proceeds: string }>("get_reserve"),
          near.view<{ lucky_settled: number; lucky_amount_total: string; lucky_paid_total: string }>("get_stats"),
          Effect.all([
            gasOf("operator", near.operatorId),
            gasOf("relayer", near.relayerId),
            gasOf("treasury", near.treasuryId),
            gasOf("contract", near.contractId)
          ]).pipe(
            Effect.map((g) => g.flat())
          ),
          relay.settings,
          // What the caps count (Relay.usedToday): a Top-Up's own move-in is sent uncounted, so it isn't shown here either.
          sql<{ n: number }>`SELECT count(*)::int AS n FROM relays WHERE counted AND created_at > now() - interval '1 day'`,
          sql<{ account_id: string; n: number }>`
            SELECT account_id, count(*)::int AS n FROM relays WHERE counted AND created_at > now() - interval '1 day'
            GROUP BY account_id ORDER BY n DESC LIMIT 5`,
          sql<{ today: number; delivered: number; ordered: number }>`
            SELECT count(*)::int AS today,
                   count(*) FILTER (WHERE step = 'settled')::int AS delivered,
                   count(*) FILTER (WHERE invoice_id IS NOT NULL)::int AS ordered
            FROM purchases WHERE created_at > now() - interval '1 day'`,
          // Oldest first: they are the closest to the customer's Reclaim at 24 hours. `total` counts them all,
          // before the limit, so the panel can say how many it isn't showing.
          sql<Row & { checkout_step: string; total: number }>`
            SELECT p.id, p.account_id, p.voucher_name, p.package_value, p.step, p.error, c.attempts, p.created_at, c.step AS checkout_step,
                   count(*) OVER ()::int AS total
            FROM purchases p JOIN checkouts c ON c.id = p.checkout_id
            WHERE p.step IN ('stuck', 'waiting', 'restock') OR (p.step IN ${sql.in(OPEN_STEPS)} AND p.created_at < now() - interval '15 minutes')
            ORDER BY p.created_at LIMIT ${ATTENTION_SHOWN}`,
          credit.view,
          refills.status,
          sales.status,
          near.view<string>("ft_balance_of", { account_id: near.contractId }, near.usdcId),
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
              GROUP BY email_key) per_email`
        ], { concurrency: "unbounded" })
        const p = purchases[0] ?? { today: 0, delivered: 0, ordered: 0 }
        return new AdminOverview({
          network,
          contract: {
            id: near.contractId,
            owner: config.owner,
            ...(config.pending_owner ? { pendingOwner: config.pending_owner } : {}),
            operator: config.operator,
            usdc: config.usdc,
            paused: config.paused
          },
          salesStopped: shop.reason === "stopped",
          reserve: {
            free: Number(reserve.free),
            locked: Number(reserve.locked),
            proceeds: Number(reserve.proceeds),
            maxCashback: Number(reserve.max_cashback),
            cashbackCap: {
              fixed: config.cashback_cap.fixed === null ? null : Number(config.cashback_cap.fixed),
              reserveBps: config.cashback_cap.reserve_bps
            },
            held: Number(held),
            customers: Number(held) - Number(reserve.free) - Number(reserve.locked) - Number(reserve.proceeds)
          },
          stats: { luckySettled: stats.lucky_settled, luckyAmountTotal: Number(stats.lucky_amount_total), luckyPaidTotal: Number(stats.lucky_paid_total) },
          gas,
          relay: {
            configured: near.relayerId !== undefined,
            settings,
            usedToday: relays[0]?.n ?? 0,
            topAccounts: top.map((t) => ({ accountId: t.account_id, count: t.n }))
          },
          purchases: {
            today: p.today,
            deliveredToday: p.delivered,
            bitrefillOrders: c.ordersToday,
            bitrefillCap: BITREFILL_DAILY_CAP,
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
          credit: {
            settings: c.settings,
            ...(c.snapshot ? { balance: c.snapshot.balance, readAt: c.snapshot.readAt.toISOString() } : {}),
            room: c.snapshot?.room ?? 0,
            free: Math.max(0, c.free),
            held: c.held,
            waitingCount: c.waiting.count,
            waitingTotal: c.waiting.total,
            avgDaily: c.avgDaily,
            target: c.target,
            refillBelow: c.refillBelow,
            refilledToday: r.refilledToday,
            ...(r.paused ? { paused: r.paused } : {}),
            refillsAvailable: r.available
          },
          treasury: {
            ...(r.treasury.accountId ? { accountId: r.treasury.accountId } : {}),
            ...(r.treasury.contractTreasury ? { contractTreasury: r.treasury.contractTreasury } : {}),
            dailyCap: r.treasury.dailyCap,
            sweptToday: r.treasury.sweptToday,
            usdc: r.treasury.usdc,
            ...(r.needs !== undefined ? { needs: r.needs } : {}),
            ...(r.wallet ? { wallet: { address: r.wallet.address, usdc: r.wallet.usdc, eth: String(r.wallet.eth), alertBelow: String(BASE_GAS_ALERT) } } : {})
          },
          refills: r.refills,
          checkout: {
            guest: bitrefill.guest,
            emails: checkout[0]?.emails ?? 0,
            connected: checkout[0]?.connected ?? 0,
            limits: { orders: GUEST_LIMITS.orders, daily: GUEST_LIMITS.daily, monthly: GUEST_LIMITS.monthly },
            busiest: { orders: checkout[0]?.orders ?? 0, daily: Number(checkout[0]?.daily ?? 0), monthly: Number(checkout[0]?.monthly ?? 0) }
          }
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
          pay_tx: { hash: string } | null
          pay_amount: string | number | null
          admit_tx: { hash: string } | null
          settle_tx: { hash: string } | null
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
                ...(r.pay_tx ? { payTx: r.pay_tx.hash } : {}),
                ...(r.pay_amount !== null ? { payAmount: Number(r.pay_amount) } : {}),
                ...(r.admit_tx ? { admitTx: r.admit_tx.hash } : {}),
                ...(r.settle_tx ? { settleTx: r.settle_tx.hash } : {}),
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
          near.view<{ balance: string; per_purchase_limit: string; daily_limit: string } | null>("get_account", { account_id: r.account_id }).pipe(
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
      const saving = yield* Semaphore.make(1)

      // Only the fields this admin changed are applied to what is saved now: a panel opened before another
      // admin turned the relayer off must not turn it back on by saving its caps.
      const configureRelay = (change: RelayChange, by: string) =>
        saving.withPermits(1)(
          Effect.flatMap(relay.settings, (now) => relay.configure(new RelaySettings({ ...now, ...change }), by)).pipe(
            Effect.tap((s) =>
              alerts.admin(
                `${by} set the relayer ${s.enabled ? "on" : "off"}: ${s.perAccountDaily} free per account, ${s.allDaily} in all per day`
              )
            )
          )
        )

      // The checkout is what the reconciler runs, so Retry now moves it with its cards (Purchases.ts: retryPurchase).
      const retry = (id: string, by: string) =>
        retryPurchase(id).pipe(
          Effect.flatMap((at) => alerts.admin(`${by} retried purchase ${id} at ${at}`)),
          Effect.provideService(SqlClient.SqlClient, sql)
        )

      const usd = (micro: number) => `$${(micro / 1e6).toFixed(2)}`
      // As for the relayer: only the fields sent change, and the check runs on what would be saved.
      const configureCredit = (change: CreditChange, by: string) =>
        saving.withPermits(1)(Effect.gen(function*() {
          const next = new CreditSettings({ ...(yield* credit.settings), ...change })
          const problem = settingsProblem(next)
          if (problem) return yield* new AdminInvalid({ message: problem })
          const saved = yield* credit.configure(next, by)
          yield* alerts.admin(
            `${by} set ${bitrefill.guest ? "the Base Float" : "Bitrefill credit"}: auto-refill ${next.autoRefill ? "on" : "off"}, top up to at least ${usd(next.floor)}, hold at most ${usd(next.ceiling)}, ` +
              `refill when below ${next.refillBelow ? usd(next.refillBelow) : "half the target"}, ` +
              `refill at most ${usd(next.dailyRefill)} a day, wait up to ${next.waitMinutes} min`
          )
          return saved
        }))

      return Admin.of({
        isAdmin: (a) => admins.has(a),
        overview,
        purchases: purchaseList,
        users,
        configureRelay,
        configureCredit,
        refill: refills.request,
        resolveRefill: refills.resolve,
        setSales: sales.setOpen,
        retry
      })
    })
  )
}
