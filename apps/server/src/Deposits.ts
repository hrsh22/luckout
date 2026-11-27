/**
 * Deposits arrive by themselves (ADR-0015). Each customer's Deposit Address is their Privy wallet. A one-time approval,
 * which they sign and we pay for, opens its USDC account and their Customer account and makes the Vault's authority
 * that USDC account's delegate. From then on `deposit_for`, which anyone may call, moves what arrives there into their
 * own Balance and nowhere else. The server calls it in a sweep every two minutes and whenever the RPC's webhook says
 * something moved. Less than 1 USDC waits until more arrives.
 */
import type { Mode } from "@luckout/api"
import { createApproveInstruction, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token"
import { PublicKey, type TransactionInstruction } from "@solana/web3.js"
import { Config, Context, Effect, Layer, Option, Redacted, Schedule } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { createHmac, timingSafeEqual } from "node:crypto"
import { Alerts } from "./Alerts.ts"
import { type RawAccount, Solana, SolanaUnavailable } from "./Solana.ts"

/** The program's minimum deposit: what a deposit's fee is worth moving for. */
export const MIN_DEPOSIT = 1_000_000n
const MAX_APPROVAL = 2n ** 64n - 1n

/** A token account's balance and delegate (SPL Token's 165-byte layout). */
export const tokenAccount = (a: RawAccount) => ({
  amount: a.data.readBigUInt64LE(64),
  delegate: a.data.readUInt32LE(72) === 1 ? new PublicKey(a.data.subarray(76, 108)) : undefined,
  delegated: a.data.readBigUInt64LE(121)
})

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
  /** One pass over every customer's Deposit Address (it also runs every two minutes by itself). */
  readonly sweep: Effect.Effect<void>
  /** Runs a sweep soon, once, however many webhooks ask for one at once. */
  readonly nudge: Effect.Effect<void>
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
              default_mode: mode === "normal" ? { kind: "Normal" } : { kind: "Lucky", fields: [mode.lucky] }
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
              Effect.andThen(alerts.customer(c.account_id, `$${(Number(movable) / 1e6).toFixed(2)} arrived in your Luckout balance.`)),
              Effect.catch((e) => Effect.logWarning(`deposit for ${c.account_id} failed: ${e.message}`))
            )
          }
          // Another app's approval replaced ours: what arrives stays at the address until they approve again.
          if (!ours && t.amount >= MIN_DEPOSIT && !c.approval_lost_at) {
            yield* sql`UPDATE known_accounts SET approval_lost_at = now() WHERE account_id = ${c.account_id}`.pipe(Effect.orDie)
            yield* alerts.customer(c.account_id, "USDC is waiting at your Deposit Address, but its approval for Luckout was replaced. Open Wallet in the app to approve it again.")
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

      yield* sweep.pipe(Effect.repeat(Schedule.spaced("2 minutes")), Effect.forkScoped)
      return Deposits.of({ approval, status, sweep, nudge })
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
