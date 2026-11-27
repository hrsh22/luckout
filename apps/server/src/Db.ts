import { PgClient } from "@effect/sql-pg"
import { PgliteClient } from "@effect/sql-pglite"
import { PGlite } from "@electric-sql/pglite"
import { Config, Effect, Layer, Option } from "effect"
import { Migrator, SqlClient } from "effect/sql"
import { mkdirSync } from "node:fs"
import { ContractId, Network } from "./Near.ts"

// Exactly one server process per database (ADR-0006): a second one would poll Telegram twice
// and race the operator's transaction nonces. The lock lives as long as this connection.
const SingleInstance = Layer.effectDiscard(
  Effect.gen(function*() {
    const conn = yield* (yield* SqlClient.SqlClient).reserve
    const rows = yield* conn.execute("SELECT pg_try_advisory_lock(735001) AS ok", [], undefined)
    if (rows[0]?.ok !== true) return yield* Effect.die("Another Luckout server is already running against this database")
  }).pipe(Effect.orDie)
)

/** Postgres when DATABASE_URL is set, otherwise PGlite in `.data/` (no install, ADR-0006). */
const Client = Layer.unwrap(
  Effect.gen(function*() {
    const url = yield* Config.option(Config.Redacted("DATABASE_URL"))
    if (Option.isSome(url)) return SingleInstance.pipe(Layer.provideMerge(PgClient.layer({ url: url.value })))
    const dataDir = new URL("../.data/pglite", import.meta.url).pathname
    mkdirSync(dataDir, { recursive: true })
    return PgliteClient.layer({ dataDir })
  })
)

/** Every migration by name, in order. Exported so a test can stop before one and fill in the data it moves. */
export const migrationSteps = {
  "0001_auth_and_purchases": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE auth_nonces (nonce TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL)`
    yield* sql`
      CREATE TABLE purchases (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        voucher_id TEXT NOT NULL,
        voucher_name TEXT NOT NULL,
        package_value TEXT NOT NULL,
        requested_mode JSONB,
        reference_price BIGINT NOT NULL,
        step TEXT NOT NULL,
        error TEXT,
        admit_tx JSONB,
        contract_purchase_id BIGINT,
        admitted JSONB,
        invoice_id TEXT,
        redemption TEXT,
        settle_tx JSONB,
        draw JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (account_id, idempotency_key)
      )`
    yield* sql`CREATE INDEX purchases_account ON purchases (account_id, created_at DESC)`
  }),
  "0002_telegram": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE telegram_link_codes (
        code TEXT PRIMARY KEY,
        telegram_user_id BIGINT NOT NULL,
        chat_id BIGINT NOT NULL,
        telegram_name TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      )`
    yield* sql`
      CREATE TABLE telegram_links (
        telegram_user_id BIGINT PRIMARY KEY,
        account_id TEXT NOT NULL,
        chat_id BIGINT NOT NULL,
        linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`
  }),
  // Security review: codes are now issued by the signed-in web session, not by the bot.
  "0003_web_issued_telegram_codes_and_max_debit": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DROP TABLE telegram_link_codes`
    yield* sql`
      CREATE TABLE telegram_link_codes (
        code TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      )`
    yield* sql`ALTER TABLE telegram_links ADD COLUMN telegram_name TEXT NOT NULL DEFAULT ''`
    yield* sql`ALTER TABLE purchases ADD COLUMN max_debit BIGINT`
  }),
  // Production review: reconciler backoff (S3) and one Telegram link per account (S4).
  "0004_reconciler_backoff_and_one_link_per_account": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE purchases ADD COLUMN attempts INT NOT NULL DEFAULT 0`
    yield* sql`ALTER TABLE purchases ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()`
    yield* sql`CREATE INDEX purchases_open ON purchases (next_attempt_at) WHERE step IN ('admit', 'ordering', 'delivery', 'confirm', 'fail')`
    yield* sql`DELETE FROM telegram_links a USING telegram_links b WHERE a.account_id = b.account_id AND a.linked_at < b.linked_at`
    yield* sql`CREATE UNIQUE INDEX telegram_links_account ON telegram_links (account_id)`
  }),
  // The contract's draw event calls it cashback now; rename it in stored Draws too.
  "0005_draw_cashback": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE purchases SET draw = (draw - 'refund') || jsonb_build_object('cashback', draw->'refund') WHERE draw ? 'refund'`
  }),
  // Relayed customer transactions (ADR-0008): dedupe by signature, daily quotas, resume after a crash.
  "0006_relays": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE relays (
        delegate_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        signed_tx JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`
    yield* sql`CREATE INDEX relays_created ON relays (created_at)`
  }),
  // Switches changed from the admin panel, such as the relayer's on/off and caps.
  "0007_settings": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`
  }),
  // Bitrefill credit (ADR-0009): purchases may wait for credit, and refills are tracked step by step.
  "0008_credit_and_refills": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE purchases ADD COLUMN ordered_at TIMESTAMPTZ`
    yield* sql`CREATE INDEX purchases_ordered ON purchases (ordered_at) WHERE ordered_at IS NOT NULL`
    yield* sql`CREATE INDEX purchases_waiting ON purchases (created_at) WHERE step IN ('waiting', 'restock')`
    yield* sql`
      CREATE TABLE refills (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        amount BIGINT NOT NULL,
        reason TEXT NOT NULL,
        requested_by TEXT,
        step TEXT NOT NULL,
        invoice_id TEXT,
        pay_address TEXT,
        invoice_at TIMESTAMPTZ,
        swap JSONB,
        sweep_tx JSONB,
        send_tx JSONB,
        swap_status TEXT,
        sent_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        error TEXT,
        attempts INT NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`
    // At most one refill runs at a time: the database enforces it, not just the code.
    yield* sql`CREATE UNIQUE INDEX refills_one_open ON refills ((true)) WHERE step IN ('invoice', 'quote', 'fund', 'send', 'swapping', 'crediting')`
  }),
  // Refills land in our Base wallet first, then pay Bitrefill from it (ADR-0009, amended 2026-11-10).
  "0009_base_wallet": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE refills ADD COLUMN pay_tx JSONB`
    yield* sql`ALTER TABLE refills ADD COLUMN paid_at TIMESTAMPTZ`
    yield* sql`DROP INDEX refills_one_open`
    yield* sql`CREATE UNIQUE INDEX refills_one_open ON refills ((true)) WHERE step IN ('fund', 'quote', 'send', 'swapping', 'invoice', 'pay', 'crediting')`
  }),
  // Audit fixes: a stuck refill remembers the step it stopped at, so only a stuck swap carries on by
  // itself; a Lucky Buy is admitted at the Lucky Amount it was accepted under, or not at all.
  "0010_refill_stuck_at_and_quoted_lucky_amount": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE refills ADD COLUMN stuck_at TEXT`
    // Refills already stuck: one that paid 1Click but never had a successful swap stopped while swapping.
    yield* sql`UPDATE refills SET stuck_at = 'swapping'
               WHERE step = 'stuck' AND send_tx IS NOT NULL AND pay_tx IS NULL AND swap_status IS DISTINCT FROM 'SUCCESS'`
    yield* sql`ALTER TABLE purchases ADD COLUMN quoted_lucky_amount BIGINT`
  }),
  // Every account that ever signed in, bought, relayed or linked Telegram: the solvency check sums their
  // balances. "Sign out everywhere" ends every session issued before its time.
  "0011_known_accounts_and_session_resets": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE known_accounts (account_id TEXT PRIMARY KEY, first_seen TIMESTAMPTZ NOT NULL DEFAULT now())`
    yield* sql`INSERT INTO known_accounts (account_id)
               SELECT account_id FROM purchases UNION SELECT account_id FROM relays UNION SELECT account_id FROM telegram_links
               ON CONFLICT DO NOTHING`
    yield* sql`CREATE TABLE session_resets (account_id TEXT PRIMARY KEY, after TIMESTAMPTZ NOT NULL)`
  }),
  // EVM wallets (ADR-0011): 1Click swaps into or out of a customer's NEAR Intents account. An inward
  // Top-Up's signed move-in waits here until its swap lands; an outward quote is what a transfer may pay.
  "0012_intents_swaps": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE intents_swaps (
        deposit_address TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        usdc BIGINT NOT NULL,
        move_in JSONB,
        move TEXT CHECK (move IN ('waiting', 'moved', 'failed')),
        move_detail TEXT,
        checked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`
    yield* sql`CREATE INDEX intents_swaps_waiting ON intents_swaps (checked_at NULLS FIRST) WHERE move = 'waiting'`
    // A Top-Up's own move-in is paid for but not counted against the daily caps.
    yield* sql`ALTER TABLE relays ADD COLUMN counted BOOLEAN NOT NULL DEFAULT true`
  }),
  // Money in transit is never out of sight: every 1Click swap of a customer's money (NEAR wallets' Top-Ups
  // too) keeps what was sent, where, its latest status, any delivery or refund, and which Telegram notices
  // went out. Swaps from before this are marked as already told, so nobody gets a stale message.
  "0013_transfers_in_sight": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      ALTER TABLE intents_swaps
        ADD COLUMN symbol TEXT,
        ADD COLUMN chain TEXT,
        ADD COLUMN amount_in TEXT,
        ADD COLUMN amount_out TEXT,
        ADD COLUMN deposit_memo TEXT,
        ADD COLUMN deadline TIMESTAMPTZ,
        ADD COLUMN time_estimate INT,
        ADD COLUMN status TEXT,
        ADD COLUMN status_at TIMESTAMPTZ,
        ADD COLUMN deposit_seen_at TIMESTAMPTZ,
        ADD COLUMN delivered_tx TEXT,
        ADD COLUMN refunded TEXT,
        ADD COLUMN refund_reason TEXT,
        ADD COLUMN told TEXT[] NOT NULL DEFAULT '{}'`
    yield* sql`UPDATE intents_swaps SET told = '{landed,arrived,late,refunded}'`
    yield* sql`CREATE INDEX intents_swaps_account ON intents_swaps (account_id, created_at)`
  }),
  // A Top-Up paid short: what reached 1Click so far, so the customer can be told to send the rest.
  "0014_transfers_deposited": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE intents_swaps ADD COLUMN deposited TEXT`
  }),
  // A send-back ('back'): a token held in the customer's NEAR Intents account, all of it, to their own wallet.
  // What it takes is kept so the relayer pays for exactly that transfer.
  "0015_transfers_send_back": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE intents_swaps DROP CONSTRAINT intents_swaps_direction_check`
    yield* sql`ALTER TABLE intents_swaps ADD CONSTRAINT intents_swaps_direction_check CHECK (direction IN ('in', 'out', 'back'))`
    yield* sql`ALTER TABLE intents_swaps ADD COLUMN origin_asset TEXT, ADD COLUMN origin_amount TEXT`
  }),
  // A Top-Up the app paid from the customer's wallet: its transaction, so the money stays in sight (and is
  // chased) even if 1Click never confirms it arrived.
  "0016_transfers_deposit_tx": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE intents_swaps ADD COLUMN deposit_tx TEXT`
  }),
  // A transfer notice Telegram didn't take: the swap stays tracked so it's sent again, for a day.
  "0017_transfers_retell": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE intents_swaps ADD COLUMN retell BOOLEAN NOT NULL DEFAULT false`
  }),
  // Guest checkout (ADR-0012): each customer's Checkout Email, sealed, with a keyed hash so Bitrefill's
  // per-email limits can be counted without reading it; and each purchase's invoice and Base payment.
  "0018_guest_checkout": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE checkout_emails (
      account_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      email_key TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`
    yield* sql`ALTER TABLE purchases ADD COLUMN email_key TEXT, ADD COLUMN invoice_token TEXT, ADD COLUMN invoice_at TIMESTAMPTZ,
               ADD COLUMN pay_to TEXT, ADD COLUMN pay_amount BIGINT, ADD COLUMN pay_tx JSONB`
    yield* sql`CREATE INDEX purchases_email_key ON purchases (email_key, created_at) WHERE email_key IS NOT NULL`
  }),
  // Connect Bitrefill (ADR-0012): a customer's own Bitrefill login, one per account, its tokens sealed together; and
  // whom each guest-checkout order was placed for: a guest with the Checkout Email, or the customer's own account.
  "0019_bitrefill_connections": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE bitrefill_connections (
      account_id TEXT PRIMARY KEY,
      tokens TEXT NOT NULL,
      access_expires_at TIMESTAMPTZ NOT NULL,
      refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`
    yield* sql`ALTER TABLE purchases ADD COLUMN buyer TEXT CHECK (buyer IN ('guest', 'account'))`
  }),
  // The reconciler's index (0004) predates the `pay` step (0018), so its query, which includes `pay`, couldn't
  // use it. Recreated with every open step (Purchases.ts: OPEN_STEPS).
  "0020_purchases_open_with_pay": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DROP INDEX purchases_open`
    yield* sql`CREATE INDEX purchases_open ON purchases (next_attempt_at) WHERE step IN ('admit', 'ordering', 'pay', 'delivery', 'confirm', 'fail')`
  }),
  // Signing in is free, and the solvency check reads a balance per known account: only accounts the contract has
  // been seen to know are read every round, and the rest take turns (Monitor.ts). Everyone known so far counts
  // as seen, so nothing is left out the day this ships.
  "0021_known_accounts_onchain": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE known_accounts ADD COLUMN onchain BOOLEAN NOT NULL DEFAULT false, ADD COLUMN checked_at TIMESTAMPTZ`
    yield* sql`UPDATE known_accounts SET onchain = true`
  }),
  "0022_ended_sessions": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // Sessions signed out before their token expired (Auth.ts): the token's signature, kept until that expiry.
    yield* sql`CREATE TABLE ended_sessions (tag TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL)`
  }),
  // A delivered card's use-by date, outside its sealed Redemption Data, so a card's page can say it before buying.
  "0023_purchase_use_by": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE purchases ADD COLUMN use_by TIMESTAMPTZ`
    yield* sql`CREATE INDEX purchases_use_by ON purchases (voucher_id, created_at) WHERE use_by IS NOT NULL`
  }),
  // Solana wallets (ADR-0011): an account named like a NEAR implicit one may be either, so each swap keeps the kind of
  // wallet it was quoted for. Earlier rows stay NULL and are read from the account's name (TopUp.ts).
  "0024_swap_wallet": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE intents_swaps ADD COLUMN wallet TEXT CHECK (wallet IN ('near', 'evm', 'solana'))`
  }),
  // Carts (ADR-0013): the cards a customer confirms together are one checkout, with one admission, one invoice, one
  // Base payment and one settlement each round; each card stays its own purchase. What the cards share moves to the
  // checkout. Every purchase so far becomes a checkout of its own under the same id, so its sealed invoice token
  // (bound to that id) still opens, and one saved in flight resumes where it was.
  "0025_checkouts": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE checkouts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id TEXT NOT NULL,
      step TEXT NOT NULL,
      error TEXT,
      admit_tx JSONB,
      settle_tx JSONB,
      buyer TEXT CHECK (buyer IN ('guest', 'account')),
      email_key TEXT,
      invoice_id TEXT,
      invoice_token TEXT,
      invoice_at TIMESTAMPTZ,
      pay_to TEXT,
      pay_amount BIGINT,
      pay_tx JSONB,
      ordered_at TIMESTAMPTZ,
      attempts INT NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`
    yield* sql`INSERT INTO checkouts (id, account_id, step, error, admit_tx, settle_tx, buyer, email_key, invoice_id, invoice_token, invoice_at,
                                      pay_to, pay_amount, pay_tx, ordered_at, attempts, next_attempt_at, created_at, updated_at)
               SELECT id, account_id,
                      CASE step WHEN 'confirm' THEN 'settle' WHEN 'fail' THEN 'settle' WHEN 'settled' THEN 'done' WHEN 'failed' THEN 'done' ELSE step END,
                      error, admit_tx, CASE WHEN step IN ('confirm', 'fail') THEN settle_tx END, buyer, email_key, invoice_id, invoice_token, invoice_at,
                      pay_to, pay_amount, pay_tx, ordered_at, attempts, next_attempt_at, created_at, updated_at
               FROM purchases`
    yield* sql`ALTER TABLE purchases ADD COLUMN checkout_id UUID REFERENCES checkouts (id), ADD COLUMN position INT NOT NULL DEFAULT 0`
    yield* sql`UPDATE purchases SET checkout_id = id`
    yield* sql`ALTER TABLE purchases ALTER COLUMN checkout_id SET NOT NULL`
    yield* sql`ALTER TABLE purchases DROP COLUMN invoice_token, DROP COLUMN invoice_at, DROP COLUMN pay_to, DROP COLUMN pay_amount, DROP COLUMN pay_tx`
    yield* sql`CREATE INDEX purchases_checkout ON purchases (checkout_id, position)`
    // The reconciler's (Purchases.ts: CHECKOUT_OPEN_STEPS), the waiting checkouts', and the Base Float's payments.
    yield* sql`CREATE INDEX checkouts_open ON checkouts (next_attempt_at) WHERE step IN ('admit', 'ordering', 'pay', 'delivery', 'settle')`
    yield* sql`CREATE INDEX checkouts_account ON checkouts (account_id, step)`
    yield* sql`CREATE INDEX checkouts_ordered ON checkouts (ordered_at) WHERE ordered_at IS NOT NULL`
  }),
  // Top-Ups paid with a Solana token 1Click doesn't take (ADR-0014): the row stays 1Click's side (USDC on Solana);
  // these say what the customer's transaction swaps into it. paid_raw is the exact amount (base units) they were
  // shown and sign; amount_in_raw is the USDC (base units) the transaction sends on to 1Click.
  "0026_swap_paid": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE intents_swaps ADD COLUMN paid_symbol TEXT, ADD COLUMN paid_mint TEXT, ADD COLUMN paid_amount TEXT,
               ADD COLUMN paid_raw TEXT, ADD COLUMN amount_in_raw TEXT`
  }),
  // A guest checkout keeps the Checkout Email it was placed under (sealed, bound to the checkout), so one that waits
  // for the float is ordered with the email the customer confirmed. Older checkouts have none and use the current one.
  // `retell`: a notice Telegram didn't take, sent again by the reconciler (as intents_swaps.retell).
  // A card keeps the invoice order it was delivered from (`order_id`), so no other card of its checkout takes the same
  // one, and its voucher's currency (`currency`), so its value can be shown as "50 INR". Older cards have neither.
  "0027_checkout_email_order_currency": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE checkouts ADD COLUMN email TEXT, ADD COLUMN retell BOOLEAN NOT NULL DEFAULT false`
    yield* sql`CREATE INDEX checkouts_retell ON checkouts (updated_at) WHERE retell`
    yield* sql`ALTER TABLE purchases ADD COLUMN order_id TEXT, ADD COLUMN currency TEXT`
  }),
  // A Top-Up the customer dismissed before paying into it: off their list, still tracked (money sent anyway is moved in
  // and listed again). A swap-paid one is cancelled too: no new transaction, no place in the account's quote cap.
  "0028_swap_dismissed": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE intents_swaps ADD COLUMN dismissed_at TIMESTAMPTZ`
  }),
  // When the customer marked a delivered card used, to tell it from the ones they haven't used. Only their own note: it
  // changes nothing about money, the Draw, Cashback or Reclaim, and clearing it marks the card unused again.
  "0029_purchase_used": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE purchases ADD COLUMN used_at TIMESTAMPTZ`
  }),
  // Solana (ADR-0015): a checkout is one numbered Checkout account, and a Lucky card waits on one of its randomness
  // requests (its round) between settle and its Draw.
  // ponytail: appended while Phase 2 runs; squashed into one migration for the fresh Solana database before it deploys.
  "0030_solana_checkouts": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE checkouts ADD COLUMN number BIGINT, ADD COLUMN address TEXT`
    yield* sql`ALTER TABLE purchases ADD COLUMN round SMALLINT`
  }),
  // When a customer's Deposit Address lost its approval (another app's replaced ours), so they're told once.
  "0031_deposit_approval": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE known_accounts ADD COLUMN approval_lost_at TIMESTAMPTZ`
  }),
  // Where 1Click refunds a Top-Up: an address on its source chain, which the customer gives (ADR-0015).
  "0032_swap_refund_to": Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE intents_swaps ADD COLUMN refund_to TEXT`
  })
}
const migrations = Migrator.fromRecord(migrationSteps)

const Migrations = Layer.effectDiscard(Migrator.make({})({ loader: migrations }))

/**
 * A database belongs to one deployment for good: the first server to start records its network and
 * contract, and a server for another refuses to start against it. So testnet and mainnet data never
 * mix, and neither do staging and production, which are both on mainnet (ADR-0010).
 */
export const DeploymentLock = Layer.effectDiscard(
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const network = yield* Network
    const contract = yield* ContractId
    for (const [key, value, setting] of [["network", network, "NEAR_NETWORK"], ["contract", contract, "LUCKOUT_CONTRACT_ID"]]) {
      yield* sql`INSERT INTO settings (key, value, updated_by) VALUES (${key}, ${JSON.stringify(value)}::jsonb, 'server')
                 ON CONFLICT (key) DO NOTHING`
      const [row] = yield* sql<{ value: unknown }>`SELECT value FROM settings WHERE key = ${key}`
      if (row?.value !== value) {
        return yield* Effect.die(`This database belongs to ${String(row?.value)}, but ${setting} is ${value}. Point DATABASE_URL at that deployment's own database.`)
      }
    }
  }).pipe(Effect.orDie)
)

export const DbLive = DeploymentLock.pipe(Layer.provideMerge(Migrations), Layer.provideMerge(Client))

// Tests migrate one database per process and start each fresh one from its dump: ~70ms instead of
// ~1s to boot and migrate. (The template is closed once dumped; left open, the process lingers 10s.)
let migrated: Promise<File | Blob> | undefined
const migratedDump = () =>
  migrated ??= PGlite.create().then(async (pg) => {
    await Effect.runPromise(Effect.provide(Migrator.make({})({ loader: migrations }), PgliteClient.layer({ liveClient: pg })))
    const dump = await pg.dumpDataDir("none")
    await pg.close()
    return dump
  })

/** A fresh in-memory database, for tests. */
export const DbMemory = PgliteClient.layerFrom(
  Effect.acquireRelease(
    Effect.promise(async () => PGlite.create({ loadDataDir: await migratedDump() })),
    (pg) => Effect.promise(() => pg.close())
  ).pipe(Effect.flatMap((liveClient) => PgliteClient.make({ liveClient })))
)
