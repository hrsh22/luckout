/**
 * Deposits arrive by themselves (ADR-0015). Each customer's Deposit Address is their Privy wallet. A one-time approval,
 * which they sign and we pay for, opens its USDC account and their Customer account and makes the Vault's authority
 * that USDC account's delegate. From then on `deposit_for`, which anyone may call, moves what arrives there into their
 * own Balance and nowhere else. The server calls it in a sweep every two minutes and whenever the RPC's webhook says
 * something moved. Less than 1 USDC waits until more arrives.
 */
import type { CustomerAccount, Mode } from "@luckout/api"
import { createApproveInstruction, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token"
import { PublicKey, type TransactionInstruction } from "@solana/web3.js"
import { Config, Context, Effect, Layer, Option, Redacted, Schedule } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { createHmac, timingSafeEqual } from "node:crypto"
import { Alerts } from "./Alerts.ts"
import type { Customer } from "./Program.ts"
import { type RawAccount, Solana, SolanaUnavailable } from "./Solana.ts"

/** The program's minimum deposit: what a deposit's fee is worth moving for. */
export const MIN_DEPOSIT = 1_000_000n
const MAX_APPROVAL = 2n ** 64n - 1n
/** Failed deposits in a row before an account's alert: a blip or two (the RPC, a busy minute) isn't one. */
const FAILURES_BEFORE_ALERT = 3

/** A token account's balance and delegate (SPL Token's 165-byte layout). */
export const tokenAccount = (a: RawAccount) => ({
  amount: a.data.readBigUInt64LE(64),
  delegate: a.data.readUInt32LE(72) === 1 ? new PublicKey(a.data.subarray(76, 108)) : undefined,
  delegated: a.data.readBigUInt64LE(121)
})

export interface Prepared { readonly transaction: string; readonly token: string }

export type Account = CustomerAccount

/** A Customer account as the app and the Agent read it; null when they've never made the one-time approval. */
export const accountOf = (c: Customer | undefined): Account | null =>
  c
    ? {
      balance: String(c.balance),
      per_purchase_limit: String(c.per_purchase_limit),
      daily_limit: String(c.daily_limit),
      day: Number(c.day),
      spent_today: String(c.spent_today),
      default_mode: c.default_mode.kind === "Lucky" ? { lucky: c.default_mode.fields[0] } : "normal",
      premiums_paid: String(c.premiums_paid),
      cashback_received: String(c.cashback_received)
    }
    : null

const programMode = (m: Mode) => (m === "normal" ? { kind: "Normal" } : { kind: "Lucky", fields: [m.lucky] })

export interface DepositStatus {
  /** The customer's Deposit Address: their Privy wallet. */
  readonly address: string
  /** Their approval stands: what arrives moves into their Balance by itself. */
  readonly approved: boolean
  /** USDC sitting at the address, not yet moved (base units). */
  readonly waiting: number
}

export class Deposits extends Context.Service<Deposits, {
  /** The customer's one-time approval (with their account, opened on `mode`, if they have none yet), for them to sign. */
  approval(wallet: string, mode: Mode): Effect.Effect<{ readonly transaction: string; readonly token: string }, SolanaUnavailable>
  status(wallet: string): Effect.Effect<DepositStatus, SolanaUnavailable>
  /** The customer's Customer account: their Balance, Spending Limits and Default Mode. */
  account(wallet: string): Effect.Effect<Account | null, SolanaUnavailable>
  /** One pass over every customer's Deposit Address (it also runs every two minutes by itself). */
  readonly sweep: Effect.Effect<void>
  /** Runs a sweep soon, once, however many webhooks ask for one at once. */
  readonly nudge: Effect.Effect<void>
  /** A withdrawal of `amount` from the Balance to any Solana address (its USDC account opened if it has none). */
  withdrawal(wallet: string, amount: number, to: string): Effect.Effect<Prepared, SolanaUnavailable>
  /** New Spending Limits; u64's maximum is "No limit". */
  limits(wallet: string, perPurchase: bigint, daily: bigint): Effect.Effect<Prepared, SolanaUnavailable>
  defaultMode(wallet: string, mode: Mode): Effect.Effect<Prepared, SolanaUnavailable>
  /** Takes back a card nobody confirmed or failed within 24 hours (the program checks the time). */
  reclaim(wallet: string, purchaseId: string): Effect.Effect<Prepared, SolanaUnavailable>
}>()("luckout/Deposits") {
  static readonly layer = Layer.effect(
    Deposits,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const solana = yield* Solana
      const alerts = yield* Alerts
      const program = solana.program

      const usdcOf = (wallet: PublicKey) => Effect.map(solana.config, (c) => ({ mint: c.usdc_mint, usdc: getAssociatedTokenAddressSync(c.usdc_mint, wallet) }))

      const approval = (walletText: string, mode: Mode) =>
        Effect.gen(function*() {
          const wallet = new PublicKey(walletText)
          if (!solana.feePayer) return yield* new SolanaUnavailable({ message: "the fee payer isn't set" })
          const { mint, usdc } = yield* usdcOf(wallet)
          const ixs: Array<TransactionInstruction> = [
            createAssociatedTokenAccountIdempotentInstruction(solana.feePayer, usdc, wallet, mint),
            createApproveInstruction(usdc, program.vaultAuthority, wallet, MAX_APPROVAL)
          ]
          if (!(yield* solana.customer(wallet))) {
            ixs.push(program.instruction("open", { wallet, payer: solana.feePayer, config: program.config, customer: program.customer(wallet) }, {
              default_mode: programMode(mode)
            }))
          }
          return yield* solana.prepare(ixs, wallet)
        })

      const status = (walletText: string) =>
        Effect.gen(function*() {
          const wallet = new PublicKey(walletText)
          const { usdc } = yield* usdcOf(wallet)
          const [account, customer] = yield* Effect.all([solana.account(usdc), solana.customer(wallet)])
          const t = account && account.data.length >= 165 ? tokenAccount(account) : undefined
          return {
            address: walletText,
            approved: customer !== undefined && (t?.delegate?.equals(program.vaultAuthority) ?? false),
            waiting: Number(t?.amount ?? 0n)
          }
        })

      const depositFor = (wallet: PublicKey, usdc: PublicKey) =>
        solana.send([
          program.instruction("deposit_for", {
            config: program.config,
            customer: program.customer(wallet),
            source: usdc,
            vault: program.vault,
            vault_authority: program.vaultAuthority
          })
        ], [], () => Effect.void)

      // ponytail: in memory, so a restart counts afresh; fine for one process (ADR-0006).
      const failures = new Map<string, number>()
      // Each alert reads the same for its account every time, so Alerts sends it at most once an hour while it lasts.
      const depositFailed = (accountId: string, message: string) =>
        Effect.gen(function*() {
          yield* Effect.logWarning(`deposit for ${accountId} failed: ${message}`)
          const n = (failures.get(accountId) ?? 0) + 1
          failures.set(accountId, n)
          if (n >= FAILURES_BEFORE_ALERT) {
            yield* alerts.admin(`deposits for ${accountId} keep failing, so the USDC at their Deposit Address isn't reaching their Balance; the log says why (deposit for … failed)`)
          }
        })

      const sweep = Effect.gen(function*() {
        const config = yield* solana.config
        const rows = yield* sql<{ account_id: string; approval_lost_at: Date | string | null }>`SELECT account_id, approval_lost_at FROM known_accounts`.pipe(Effect.orDie)
        const customers = rows.flatMap((r) => {
          try {
            const wallet = new PublicKey(r.account_id)
            return [{ ...r, wallet, usdc: getAssociatedTokenAddressSync(config.usdc_mint, wallet) }]
          } catch {
            return []
          }
        })
        const accounts = yield* solana.accounts(customers.map((c) => c.usdc))
        for (const [i, c] of customers.entries()) {
          const a = accounts[i]
          if (!a || a.data.length < 165) continue
          const t = tokenAccount(a)
          const ours = t.delegate?.equals(program.vaultAuthority) ?? false
          const movable = ours ? (t.amount < t.delegated ? t.amount : t.delegated) : 0n
          if (movable >= MIN_DEPOSIT) {
            yield* depositFor(c.wallet, c.usdc).pipe(
              Effect.andThen(Effect.sync(() => failures.delete(c.account_id))),
              Effect.andThen(alerts.customer(c.account_id, `$${(Number(movable) / 1e6).toFixed(2)} arrived in your Luckout balance.`)),
              Effect.catch((e) => depositFailed(c.account_id, e.message))
            )
          }
          // Another app's approval replaced ours: what arrives stays at the address until they approve again.
          if (!ours && t.amount >= MIN_DEPOSIT && !c.approval_lost_at) {
            yield* sql`UPDATE known_accounts SET approval_lost_at = now() WHERE account_id = ${c.account_id}`.pipe(Effect.orDie)
            yield* alerts.customer(c.account_id, "USDC is waiting at your Deposit Address, but its approval for Luckout was replaced. Open Wallet in the app to approve it again.")
            yield* alerts.admin(`another app's approval replaced ours at ${c.account_id}'s Deposit Address: what arrives waits there until they approve again in Wallet`)
          }
          if (ours && c.approval_lost_at) yield* sql`UPDATE known_accounts SET approval_lost_at = NULL WHERE account_id = ${c.account_id}`.pipe(Effect.orDie)
        }
      }).pipe(Effect.catchCause((cause) => Effect.logError("deposit sweep failed", cause)))

      // ponytail: one flag, one process (ADR-0006).
      let pending = false
      const nudge = Effect.suspend(() => {
        if (pending) return Effect.void
        pending = true
        return Effect.forkDetach(Effect.sleep("3 seconds").pipe(Effect.andThen(Effect.sync(() => void (pending = false))), Effect.andThen(sweep)))
      }).pipe(Effect.asVoid)

      const customerAccounts = (wallet: PublicKey) => ({ wallet, config: program.config, customer: program.customer(wallet) })
      const withdrawal = (walletText: string, amount: number, toText: string) =>
        Effect.gen(function*() {
          const wallet = new PublicKey(walletText)
          const to = yield* Effect.try({ try: () => new PublicKey(toText), catch: () => new SolanaUnavailable({ message: "That isn't a Solana address" }) })
          // USDC sent there moves straight back into the Balance (deposit_for): a withdrawal that only costs fees.
          if (to.equals(wallet)) return yield* new SolanaUnavailable({ message: "That's your own Deposit Address: what lands there moves back into your balance. Send it to another address." })
          if (!solana.feePayer) return yield* new SolanaUnavailable({ message: "the fee payer isn't set" })
          const { mint } = yield* usdcOf(wallet)
          const toUsdc = getAssociatedTokenAddressSync(mint, to, true)
          return yield* solana.prepare([
            createAssociatedTokenAccountIdempotentInstruction(solana.feePayer, toUsdc, to, mint),
            program.instruction("withdraw", { ...customerAccounts(wallet), vault: program.vault, vault_authority: program.vaultAuthority, to: toUsdc }, { amount: BigInt(amount) })
          ], wallet)
        })
      const limits = (walletText: string, perPurchase: bigint, daily: bigint) => {
        const wallet = new PublicKey(walletText)
        return solana.prepare([program.instruction("set_limits", customerAccounts(wallet), { per_purchase: perPurchase, daily })], wallet)
      }
      const defaultMode = (walletText: string, mode: Mode) => {
        const wallet = new PublicKey(walletText)
        return solana.prepare([program.instruction("set_default_mode", customerAccounts(wallet), { mode: programMode(mode) })], wallet)
      }
      const reclaim = (walletText: string, purchaseId: string) =>
        Effect.gen(function*() {
          const [row] = yield* sql<{ position: number; address: string | null }>`
            SELECT p.position, c.address FROM purchases p JOIN checkouts c ON c.id = p.checkout_id
            WHERE p.id = ${purchaseId} AND p.account_id = ${walletText}`.pipe(Effect.orDie)
          if (!row?.address) return yield* new SolanaUnavailable({ message: "That purchase can't be reclaimed" })
          const wallet = new PublicKey(walletText)
          const checkout = yield* solana.checkout(new PublicKey(row.address))
          if (!checkout) return yield* new SolanaUnavailable({ message: "That purchase is already closed" })
          return yield* solana.prepare([
            program.instruction("reclaim", { ...customerAccounts(wallet), checkout: new PublicKey(row.address), checkout_payer: checkout.payer }, { card: row.position })
          ], wallet)
        })

      yield* sweep.pipe(Effect.repeat(Schedule.spaced("2 minutes")), Effect.forkScoped)
      const account = (walletText: string) =>
        Effect.try({ try: () => new PublicKey(walletText), catch: () => new SolanaUnavailable({ message: `${walletText} isn't a Solana wallet` }) }).pipe(
          Effect.flatMap(solana.customer),
          Effect.map(accountOf)
        )

      return Deposits.of({ approval, status, account, sweep, nudge, withdrawal, limits, defaultMode, reclaim })
    })
  )
}

/**
 * The RPC provider's webhook (Alchemy's Address Activity): something moved at a Deposit Address, so sweep soon. Signed
 * with ALCHEMY_WEBHOOK_SIGNING_KEY; without it the route isn't served and the two-minute sweep does the work alone.
 */
export const DepositsWebhook = Layer.unwrap(Effect.gen(function*() {
  const deposits = yield* Deposits
  const key = yield* Config.option(Config.Redacted("ALCHEMY_WEBHOOK_SIGNING_KEY"))
  if (Option.isNone(key)) return Layer.empty
  return HttpRouter.add("POST", "/webhooks/deposits", Effect.gen(function*() {
    const req = yield* HttpServerRequest.HttpServerRequest
    const body = yield* req.text
    const given = Buffer.from(String(req.headers["x-alchemy-signature"] ?? ""))
    const expected = Buffer.from(createHmac("sha256", Redacted.value(key.value)).update(body).digest("hex"))
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return HttpServerResponse.empty({ status: 401 })
    yield* deposits.nudge
    return HttpServerResponse.empty({ status: 200 })
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 400 })))))
}))
