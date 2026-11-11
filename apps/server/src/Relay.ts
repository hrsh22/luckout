import { RelayFailed, RelaySettings, RelayUnavailable, type SignedIntent } from "@luckout/api"
import { deserialize, serialize } from "borsh"
import { Config, Context, Effect, Layer, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import { encodeDelegateAction, KeyType, PublicKey, SCHEMA } from "near-api-js"
import { createHash } from "node:crypto"
import { parsePayload, payloadRefusal, signedBy } from "./Intents.ts"
import { Near, Network, type SignedDelegate } from "./Near.ts"
import { readSetting, writeSetting } from "./Settings.ts"

// The relayer (NEP-366, ADR-0008): customers sign their own calls in the wallet without sending
// them, and our relayer account sends them and pays the network fee. It only pays for our own
// calls with the exact deposit each needs, checks everything it can for free before paying, and
// stops for the day once an account (or everyone together) has used the free relays. The admin
// panel can switch it off and change both caps.

/** Until an admin changes them: free relays per account, and for everyone, per rolling day. Mainnet starts small. */
export const RELAY_DEFAULTS = {
  mainnet: new RelaySettings({ enabled: true, perAccountDaily: 5, allDaily: 50 }),
  testnet: new RelaySettings({ enabled: true, perAccountDaily: 20, allDaily: 500 })
} as const
const MAX_GAS = 100_000_000_000_000n // 100 Tgas, what a deposit's ft_transfer_call needs
/** USDC's storage registration fee: the only deposit besides 1 yoctoNEAR. */
export const USDC_REGISTRATION = 1_250_000_000_000_000_000_000n

export interface Allowlist {
  readonly accountId: string
  readonly contractId: string
  readonly usdcId: string
  readonly testnet: boolean
}

/** The deposit a call must carry for us to pay its fee, or undefined if we don't pay for it at all. */
const expectedDeposit = (receiver: string, method: string, args: Record<string, unknown>, a: Allowlist) => {
  if (receiver === a.contractId && ["withdraw", "set_default_mode", "set_limits"].includes(method)) return 1n
  // A customer's own safety nets: the contract checks it's their purchase.
  if (receiver === a.contractId && ["reclaim", "retry_draw"].includes(method)) return 0n
  if (receiver === a.usdcId) {
    if (method === "ft_transfer_call" && args.receiver_id === a.contractId) return 1n
    if (method === "storage_deposit" && (args.account_id ?? a.accountId) === a.accountId && args.registration_only === true) return USDC_REGISTRATION
    if (method === "faucet" && a.testnet) return 0n
  }
  return undefined
}

/** Why we won't pay for this delegate, or undefined if it's one of our own calls, exactly as the app makes it. */
export const refusal = (d: Pick<SignedDelegate["delegateAction"], "senderId" | "receiverId" | "actions">, a: Allowlist): string | undefined => {
  if (d.senderId !== a.accountId) return "This was signed by a different account than the one signed in."
  const call = d.actions.length === 1 ? d.actions[0]!.functionCall : undefined
  if (!call) return "Luckout only pays the fee for one of its own calls at a time."
  let args: Record<string, unknown>
  try {
    args = JSON.parse(new TextDecoder().decode(Uint8Array.from(call.args)))
  } catch {
    return "Luckout only pays the fee for its own calls."
  }
  const deposit = expectedDeposit(d.receiverId, call.methodName, args ?? {}, a)
  if (deposit === undefined) return "Luckout only pays the fee for its own calls: deposits, withdrawals, settings and reclaims."
  if (BigInt(call.deposit) !== deposit) return "That call carries an unexpected deposit."
  if (BigInt(call.gas) > MAX_GAS) return "That call asks for more gas than it needs."
  return undefined
}

const publicKeyOf = (d: SignedDelegate["delegateAction"]) => {
  const [kind, value] = Object.entries(d.publicKey)[0] ?? []
  const type = kind === "ed25519Key" ? KeyType.ED25519 : kind === "secp256k1Key" ? KeyType.SECP256K1 : undefined
  return type === undefined || !value ? undefined : new PublicKey({ keyType: type, data: Uint8Array.from(value.data) })
}

/** The customer's signature over the delegate (NEP-461 prefix included), checked before we pay. */
const signatureValid = (sd: SignedDelegate, key: PublicKey) => {
  const sig = Object.values(sd.signature)[0]
  if (!sig) return false
  const hash = createHash("sha256").update(encodeDelegateAction(sd.delegateAction as never)).digest()
  try {
    return key.verify(hash, Uint8Array.from(sig.data))
  } catch {
    return false
  }
}

/** Contract panics read fine on their own; NEAR's own errors are JSON nobody should see. */
const readable = (message: string) => (/^[{[]/.test(message.trim()) ? "NEAR refused it. Try again." : message)

export class Relay extends Context.Service<Relay, {
  /** Whether we'd pay this account's next fee: a relayer is set up and today's free relays aren't used up. */
  available(accountId: string): Effect.Effect<boolean>
  /** Checks a base64 borsh SignedDelegate, sends it from the relayer, and waits until it has run. */
  send(accountId: string, signedDelegate: string): Effect.Effect<{ hash: string }, RelayFailed | RelayUnavailable>
  /**
   * EVM wallets (ADR-0011): checks one signed NEAR Intents payload, sends it to `intents.near` from the
   * relayer, and waits until it has run. `counted: false` leaves it out of the daily caps (not the admin's
   * switch), for a Top-Up's own move-in, sent once per real swap.
   */
  sendIntent(accountId: string, signed: SignedIntent, o?: { counted?: boolean }): Effect.Effect<{ hash: string }, RelayFailed | RelayUnavailable>
  readonly settings: Effect.Effect<RelaySettings>
  /** Saves new settings; they apply to the next relay. */
  configure(settings: RelaySettings, by: string): Effect.Effect<RelaySettings>
}>()("luckout/Relay") {
  static readonly layer = Layer.effect(
    Relay,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const near = yield* Near
      const testnet = (yield* Network) === "testnet"
      const usdcId = near.usdcId

      const settings = readSetting("relay", RelaySettings, RELAY_DEFAULTS[testnet ? "testnet" : "mainnet"]).pipe(
        Effect.provideService(SqlClient.SqlClient, sql)
      )
      const configure = (next: RelaySettings, by: string) =>
        writeSetting("relay", RelaySettings, next, by).pipe(Effect.provideService(SqlClient.SqlClient, sql))

      const usedToday = (accountId: string) =>
        sql<{ mine: number; everyone: number }>`
          SELECT count(*) FILTER (WHERE account_id = ${accountId})::int AS mine, count(*)::int AS everyone
          FROM relays WHERE counted AND created_at > now() - interval '1 day'`.pipe(Effect.map((r) => r[0] ?? { mine: 0, everyone: 0 }))

      /** Whether the relayer is on and this account (and everyone) has free relays left today. */
      const quotaLeft = (accountId: string) =>
        Effect.all([settings, usedToday(accountId)]).pipe(
          Effect.map(([s, u]) => s.enabled && u.mine < s.perAccountDaily && u.everyone < s.allDaily)
        )

      const available = (accountId: string) =>
        near.relayerId ? quotaLeft(accountId).pipe(Effect.orElseSucceed(() => false)) : Effect.succeed(false)

      const failed = (message: string) => new RelayFailed({ message })
      // ponytail: one global lock around dedupe, caps, checks and send, so parallel requests can't all
      // pass the caps (or both register USDC) before either is saved. Fine while the relayer sends one
      // at a time from one process (ADR-0006); per-account locks if throughput matters.
      const lock = yield* Semaphore.make(1)

      const send = (accountId: string, signedDelegate: string) =>
        Effect.gen(function*() {
          if (!near.relayerId) return yield* new RelayUnavailable({ message: "Luckout isn't paying network fees right now." })
          const bytes = Buffer.from(signedDelegate, "base64")
          const sd = yield* Effect.try({
            try: () => {
              const decoded = deserialize(SCHEMA.SignedDelegate, bytes) as unknown as SignedDelegate
              // borsh ignores trailing bytes: only the exact encoding, or a padded copy would dodge the dedupe below.
              if (!Buffer.from(serialize(SCHEMA.SignedDelegate, decoded as never)).equals(bytes)) throw new Error("not canonical")
              return decoded
            },
            catch: () => failed("That isn't a signed NEAR action.")
          })
          const d = sd.delegateAction
          const why = refusal(d, { accountId, contractId: near.contractId, usdcId, testnet })
          if (why) return yield* failed(why)

          // The same signature sent twice (a retry, a double click) gets the first result, not a second fee.
          const hash = createHash("sha256").update(bytes).digest("hex")
          const outcome = yield* lock.withPermits(1)(Effect.gen(function*() {
            const [seen] = yield* sql<{ signed_tx: { hash: string; bytes: string } }>`SELECT signed_tx FROM relays WHERE delegate_hash = ${hash}`
            if (seen) return yield* near.resume(seen.signed_tx)
            if (!(yield* quotaLeft(accountId))) {
              return yield* new RelayUnavailable({ message: "Luckout isn't paying this network fee right now, so your wallet pays it." })
            }
            // Everything the network would refuse, refused here for free.
            const key = publicKeyOf(d)
            if (!key) return yield* failed("That wallet key type isn't supported.")
            const [access, height] = yield* Effect.all([near.accessKey(d.senderId, key.toString()), near.height], { concurrency: 2 })
            if (!access) return yield* failed("That key isn't on your NEAR account. Sign in again with your wallet.")
            if (!access.fullAccess) return yield* failed("Approve it with your wallet's full-access key.")
            if (BigInt(d.nonce) <= access.nonce) return yield* failed("That approval was already used. Try again.")
            if (BigInt(d.maxBlockHeight) < height) return yield* failed("That approval expired. Try again.")
            if (!signatureValid(sd, key)) return yield* failed("The signature doesn't match your account.")
            // A second registration would refund its deposit to the customer: a free drip from us.
            if (d.actions[0]!.functionCall!.methodName === "storage_deposit") {
              const registered = yield* near.view<unknown>("storage_balance_of", { account_id: accountId }, usdcId)
              if (registered !== null) return yield* failed("USDC is already enabled on your account.")
            }
            return yield* near.relay(sd, (signed) =>
              sql`INSERT INTO relays (delegate_hash, account_id, signed_tx) VALUES (${hash}, ${accountId}, ${JSON.stringify(signed)}::jsonb)
                  ON CONFLICT DO NOTHING`.pipe(Effect.asVoid, Effect.orDie))
          }))
          if (outcome.failures[0]) return yield* failed(readable(outcome.failures[0]))
          return { hash: outcome.hash }
        }).pipe(
          Effect.catchTags({
            ContractRejected: (e) => Effect.fail(failed(readable(e.message))),
            NearUnavailable: () => Effect.fail(failed("NEAR didn't answer in time. It may still go through, so check your balance before trying again.")),
            TxExpired: () => Effect.fail(failed("It expired before it went through. Try again.")),
            SqlError: (e) => Effect.die(e)
          })
        )

      /** Why this intent would fail for want of money: USDC in the signer's Intents account, or their Luckout Balance. */
      const fundsShort = (accountId: string, intent: Record<string, unknown>) =>
        Effect.gen(function*() {
          const need = intent.intent === "ft_withdraw"
            ? BigInt(String(intent.amount))
            : intent.intent === "transfer"
            ? BigInt(Object.values(intent.tokens as Record<string, string>)[0] ?? "0")
            : undefined
          if (need !== undefined) {
            const has = BigInt(yield* near.view<string>("mt_balance_of", { account_id: accountId, token_id: `nep141:${usdcId}` }, near.intentsId))
            return has < need ? "That USDC isn't in your NEAR Intents account yet." : undefined
          }
          const action = intent.intent === "auth_call" ? JSON.parse(String(intent.msg)) : undefined
          if (action?.withdraw) {
            const a = yield* near.view<{ balance: string } | null>("get_account", { account_id: accountId })
            return BigInt(a?.balance ?? "0") < BigInt(action.withdraw.amount) ? "Your Luckout balance is lower than that." : undefined
          }
          return undefined
        })

      const sendIntent = (accountId: string, signed: SignedIntent, o: { counted?: boolean } = {}) =>
        Effect.gen(function*() {
          if (!near.relayerId) return yield* new RelayUnavailable({ message: "Luckout can't send this right now. Try again later." })
          const p = parsePayload(signed.payload)
          const first = p?.intents[0]
          // A transfer may only pay a 1Click withdrawal we quoted for this account, and exactly its amount.
          const exitAmount = first?.intent === "transfer"
            ? (yield* sql<{ usdc: string }>`
                SELECT usdc::text AS usdc FROM intents_swaps
                WHERE deposit_address = ${String(first.receiver_id)} AND account_id = ${accountId} AND direction = 'out'`)[0]?.usdc
            : undefined
          const why = payloadRefusal(p, { accountId, intentsId: near.intentsId, contractId: near.contractId, usdcId, exitAmount, now: new Date() })
          if (why) return yield* failed(why)
          if (!(yield* Effect.promise(() => signedBy(signed, accountId)))) return yield* failed("The signature doesn't match your account.")

          // The payload holds its nonce, so the same payload twice is the same intent: the first result, not a second fee.
          const hash = createHash("sha256").update(signed.payload).digest("hex")
          const outcome = yield* lock.withPermits(1)(Effect.gen(function*() {
            const [seen] = yield* sql<{ signed_tx: { hash: string; bytes: string } }>`SELECT signed_tx FROM relays WHERE delegate_hash = ${hash}`
            if (seen) return yield* near.resume(seen.signed_tx)
            const counted = o.counted !== false
            if (counted ? !(yield* quotaLeft(accountId)) : !(yield* settings).enabled) {
              return yield* new RelayUnavailable({ message: "You've used today's free actions. Try again tomorrow." })
            }
            const used = yield* near.view<boolean>("is_nonce_used", { account_id: accountId, nonce: p!.nonce }, near.intentsId)
            if (used) return yield* failed("That approval was already used. Try again.")
            // Money the intent would move must be there, checked for free, so nobody makes us pay for a refusal.
            const why = yield* fundsShort(accountId, first!)
            if (why) return yield* failed(why)
            return yield* near.relayerCall(near.intentsId, "execute_intents", { signed: [signed] }, (tx) =>
              sql`INSERT INTO relays (delegate_hash, account_id, signed_tx, counted) VALUES (${hash}, ${accountId}, ${JSON.stringify(tx)}::jsonb, ${counted})
                  ON CONFLICT DO NOTHING`.pipe(Effect.asVoid, Effect.orDie))
          }))
          if (outcome.failures[0]) return yield* failed(readable(outcome.failures[0]))
          return { hash: outcome.hash }
        }).pipe(
          Effect.catchTags({
            ContractRejected: (e) => Effect.fail(failed(readable(e.message))),
            NearUnavailable: () => Effect.fail(failed("NEAR didn't answer in time. It may still go through, so check your balance before trying again.")),
            TxExpired: () => Effect.fail(failed("It expired before it went through. Try again.")),
            SqlError: (e) => Effect.die(e)
          })
        )

      return Relay.of({ available, send, sendIntent, settings, configure })
    })
  )
}
