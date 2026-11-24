import { Clock, Config, Context, Data, Effect, Layer, Option, Redacted, Schedule, Semaphore } from "effect"
import { actions, baseDecode, teraToGas } from "near-api-js"
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  http,
  isAddress,
  keccak256,
  recoverAddress,
  serializeTransaction,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError
} from "viem"
import { publicKeyToAddress } from "viem/accounts"
import { base, baseSepolia } from "viem/chains"
import { Alerts } from "./Alerts.ts"
import { ContractRejected, Near, NearUnavailable, Network } from "./Near.ts"

// Our wallet on Base (ADR-0009, amended 2026-11-10). Refills swap into it, and only once the USDC is
// here do we ask Bitrefill for an invoice and pay it, so a late or stuck swap can never pay an expired
// invoice. No private key exists for it: the address is derived from the treasury's NEAR account
// through NEAR Chain Signatures, and NEAR's MPC network signs each Base transaction at the treasury's
// request. Whoever controls the treasury account (the server's key, the owner's wallet) controls it.

export class BaseUnavailable extends Data.TaggedError("BaseUnavailable")<{ readonly message: string }> {}

export const BASE_USDC = { mainnet: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", testnet: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" } as const
/** NEAR's Chain Signatures (MPC) contract. */
export const SIGNER = { mainnet: "v1.signer", testnet: "v1.signer-prod.testnet" } as const
/** The derivation path. The same key works on every EVM chain; changing the path changes the address. */
const PATH = "evm"
/** A USDC transfer uses about 60k gas; the limit only caps it. */
const TRANSFER_GAS = 100_000n
/**
 * The most a payment offers per gas, so a fee spike can't leave it unmined while its invoice runs out: EIP-1559 takes
 * only the base fee and the tip, so a high ceiling costs nothing while fees are normal. Base's base fee usually sits
 * around 0.01 gwei or less (the Monitor counts 0.0001 ETH as about 150 payments), and climbs at most
 * (elasticity − 1) / denominator per 2-second block: 2% with the OP Stack's 6 and 250. 0.5 gwei is fifty times the
 * usual fee, which takes about 200 blocks in a row filled to the limit (ln 50 / ln 1.02), nearly 7 minutes, to reach.
 * The node takes a payment only from a wallet holding its gas limit at this ceiling (GAS_RESERVE) plus its small L1 fee.
 * ponytail: a fixed ceiling; a spike past 0.5 gwei still holds a payment until fees fall. Replacing it with the same
 * nonce at a higher fee lifts that, provided every hash signed for the nonce is watched and any of them mined counts as paid.
 */
const FEE_CEILING = 500_000_000n
/** The ETH (wei) the Base Wallet must hold before the node takes a payment from it: 0.00005 ETH, L1 fee aside. */
export const GAS_RESERVE = TRANSFER_GAS * FEE_CEILING

/** A USDC payment from the wallet. Its nonce and fees are fixed before it's signed, so signing it again can only replace it, never pay twice. */
export interface BasePayment {
  readonly to: Hex
  /** USDC base units (6 decimals). */
  readonly amount: string
  readonly nonce: number
  readonly maxFeePerGas: string
  readonly maxPriorityFeePerGas: string
  /** Set once signed, and saved before it's sent. */
  readonly raw?: Hex
  readonly hash?: Hex
}

/** pending: not mined (or not known); success: the transfer happened; reverted: mined, but nothing moved. */
export type PaymentStatus = "pending" | "success" | "reverted"
export type SignedPayment = BasePayment & { raw: Hex; hash: Hex }

export class Base extends Context.Service<Base, {
  /** Base RPC is set (BASE_RPC_URL) and the server has a treasury key to sign with. */
  readonly configured: boolean
  readonly address: Effect.Effect<Hex, BaseUnavailable | NearUnavailable>
  /** USDC (base units) and ETH (wei) in the wallet. */
  readonly balances: Effect.Effect<{ usdc: number; eth: bigint }, BaseUnavailable | NearUnavailable>
  /** Fixes a payment's nonce and fees; nothing is signed yet. */
  prepare(to: Hex, amount: number): Effect.Effect<BasePayment, BaseUnavailable | NearUnavailable>
  /** Has NEAR's MPC network sign the payment as the treasury, and checks the signature is the wallet's. */
  sign(p: BasePayment): Effect.Effect<BasePayment & { raw: Hex; hash: Hex }, BaseUnavailable | NearUnavailable | ContractRejected>
  /** Sends the signed bytes (again is harmless) and says where the payment is. */
  send(p: BasePayment & { raw: Hex; hash: Hex }): Effect.Effect<PaymentStatus, BaseUnavailable>
  /** Where a payment is, without sending anything. */
  status(hash: Hex): Effect.Effect<PaymentStatus, BaseUnavailable>
  /**
   * Pays `amount` (USDC base units) to `to` exactly once. `saved` is this payment's earlier attempt, sent
   * again as the same bytes; a new one is signed, handed to `save` before it's sent, then sent. The wallet is
   * locked from preparing until mined, so two payments never share a nonce. "pending": not mined yet (call
   * again with what was saved). From `sendBefore` (epoch ms) on, nothing is sent or signed, not even again:
   * only the saved payment's receipt is looked up ("pending" when nothing was saved).
   */
  pay(
    to: Hex,
    amount: number,
    saved: SignedPayment | null,
    save: (p: SignedPayment) => Effect.Effect<void>,
    sendBefore: number
  ): Effect.Effect<PaymentStatus, BaseUnavailable | NearUnavailable | ContractRejected>
}>()("luckout/Base") {
  static readonly layer = Layer.effect(
    Base,
    Effect.gen(function*() {
      const near = yield* Near
      const alerts = yield* Alerts
      const network = yield* Network
      const url = yield* Config.Redacted("BASE_RPC_URL").pipe(
        Config.option,
        // Testnet doesn't refill (no NEAR Intents there); its public RPC is enough to show the address.
        Config.map((u) => (Option.isNone(u) && network === "testnet" ? Option.some(Redacted.make("https://sepolia.base.org")) : u))
      )
      const chain = network === "mainnet" ? base : baseSepolia
      const usdc = BASE_USDC[network]
      const client = Option.isSome(url) ? createPublicClient({ chain, transport: http(Redacted.value(url.value), { timeout: 20_000 }) }) : undefined
      const configured = !!client && !!near.treasuryId

      const call = <A>(what: string, f: () => Promise<A>) =>
        client
          ? Effect.tryPromise({
            try: f,
            // viem's short message plus the node's own reason; its full message also prints the RPC URL, which holds our key.
            catch: (e) => {
              const v = e as { shortMessage?: string; details?: string; message?: string }
              return new BaseUnavailable({ message: `Base ${what}: ${v.shortMessage ?? String(v.message ?? e).split("\n")[0]}${v.details ? ` (${v.details})` : ""}` })
            }
          })
          : Effect.fail(new BaseUnavailable({ message: "Base isn't configured (BASE_RPC_URL)" }))

      const derive: Effect.Effect<Hex, BaseUnavailable | NearUnavailable> = near.treasuryId
        ? near.view<string>("derived_public_key", { path: PATH, predecessor: near.treasuryId, domain_id: 0 }, SIGNER[network]).pipe(
            // "secp256k1:<base58 of the 64-byte uncompressed key>"
            Effect.map((key) => publicKeyToAddress(`0x04${Buffer.from(baseDecode(key.replace(/^secp256k1:/, ""))).toString("hex")}`))
          )
        : Effect.fail(new BaseUnavailable({ message: "No treasury key to derive the Base wallet from" }))
      // Remember it once known; a failed lookup (say, a rate limit) is simply tried again next time.
      let known: Hex | undefined
      const address = Effect.suspend(() => (known ? Effect.succeed(known) : Effect.tap(derive, (a) => Effect.sync(() => void (known = a)))))

      const balances = Effect.gen(function*() {
        const a = yield* address
        const [u, eth] = yield* Effect.all([
          call("USDC balance", () => client!.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [a] })),
          call("ETH balance", () => client!.getBalance({ address: a }))
        ], { concurrency: 2 })
        return { usdc: Number(u), eth }
      })

      const prepare = (to: Hex, amount: number) =>
        Effect.gen(function*() {
          if (!isAddress(to)) return yield* new BaseUnavailable({ message: `Not an address to pay: ${to}` })
          const a = yield* address
          const [nonce, fees] = yield* Effect.all([
            call("nonce", () => client!.getTransactionCount({ address: a, blockTag: "pending" })),
            call("fees", () => client!.estimateFeesPerGas())
          ])
          // Up to the ceiling, so a spike can't strand it; a payment signed mid-spike keeps twice today's fee.
          const twice = fees.maxFeePerGas * 2n
          return {
            to: getAddress(to),
            amount: String(amount),
            nonce,
            maxFeePerGas: String(twice > FEE_CEILING ? twice : FEE_CEILING),
            maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas)
          } satisfies BasePayment
        })

      const unsigned = (p: BasePayment) => ({
        chainId: chain.id,
        type: "eip1559" as const,
        nonce: p.nonce,
        to: usdc as Hex,
        value: 0n,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [p.to, BigInt(p.amount)] }),
        gas: TRANSFER_GAS,
        maxFeePerGas: BigInt(p.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(p.maxPriorityFeePerGas)
      })

      const sign = (p: BasePayment) =>
        Effect.gen(function*() {
          const a = yield* address
          const tx = unsigned(p)
          const digest = keccak256(serializeTransaction(tx))
          // 1 yoctoNEAR and about 0.01 NEAR of gas per signature (measured on testnet, 2026-11-10).
          const out = yield* near.treasurySend(
            SIGNER[network],
            [actions.functionCall("sign", { request: { payload_v2: { Ecdsa: digest.slice(2) }, path: PATH, domain_id: 0 } }, teraToGas("50"), 1n)],
            // Nothing to resume: a lost signature is simply asked for again, for the same nonce.
            () => Effect.void
          )
          const s = out.value as { big_r?: { affine_point?: string }; s?: { scalar?: string }; recovery_id?: number } | null
          if (!s?.big_r?.affine_point || !s.s?.scalar || (s.recovery_id !== 0 && s.recovery_id !== 1)) {
            return yield* new BaseUnavailable({ message: `Chain Signatures answered without a signature: ${JSON.stringify(out.value)}` })
          }
          const signature = { r: `0x${s.big_r.affine_point.slice(2)}` as Hex, s: `0x${s.s.scalar}` as Hex, yParity: s.recovery_id }
          // Never send what our wallet didn't sign.
          const signer = yield* call("signature check", () => recoverAddress({ hash: digest, signature }))
          if (signer !== a) return yield* new BaseUnavailable({ message: `The signature recovers to ${signer}, not our wallet ${a}` })
          const raw = serializeTransaction(tx, signature)
          return { ...p, raw, hash: keccak256(raw) }
        })

      // Only the node answering "no such receipt" means not mined yet. Any other failure (the RPC is down, the
      // provider answers 404 Not Found) says nothing about the payment, and must never read as "not mined":
      // that reading is what lets a payment be signed again.
      const status = (hash: Hex) =>
        call("receipt", () => client!.getTransactionReceipt({ hash }).catch((e) => (e instanceof TransactionReceiptNotFoundError ? null : Promise.reject(e)))).pipe(
          Effect.map((r): PaymentStatus => (r === null ? "pending" : r.status === "success" ? "success" : "reverted"))
        )

      /** Whether the node knows a transaction by its hash, waiting or mined. Like `status`, only "not found" means no. */
      const knows = (hash: Hex) =>
        call("transaction", () => client!.getTransaction({ hash }).then(() => true, (e) => (e instanceof TransactionNotFoundError ? false : Promise.reject(e))))

      const send = (p: BasePayment & { raw: Hex; hash: Hex }) =>
        call("send", () => client!.sendRawTransaction({ serializedTransaction: p.raw })).pipe(
          // Already sent, or already mined: the receipt says which.
          Effect.catchTag("BaseUnavailable", (e) => (/already known|known transaction|nonce too low|replacement/i.test(e.message) ? Effect.void : Effect.fail(e))),
          Effect.andThen(status(p.hash))
        )

      // Base makes a block every 2 seconds; half a minute covers a busy one.
      const mined = (p: SignedPayment) =>
        status(p.hash).pipe(Effect.repeat({ schedule: Schedule.spaced("2 seconds"), until: (s) => s !== "pending", times: 15 }))

      const lock = yield* Semaphore.make(1)
      const pay = (to: Hex, amount: number, saved: SignedPayment | null, save: (p: SignedPayment) => Effect.Effect<void>, sendBefore: number) =>
        lock.withPermits(1)(Effect.gen(function*() {
          // Decided here, holding the lock, right before sending: a caller can wait on the lock past its deadline,
          // and a saved payment is watched for half a minute before it may be replaced.
          const late = Effect.map(Clock.currentTimeMillis, (now) => now >= sendBefore)
          if (yield* late) return saved ? yield* status(saved.hash) : "pending"
          if (saved) {
            const s = yield* send(saved)
            if (s !== "pending") return s
            // A saved payment whose nonce another transaction took (one sent after a crash, before this was
            // resent) can never be mined, so only then is a new one safe. The nonce is read first and the receipt
            // watched for half a minute after it, so our own payment mined in between, or a node slow to show its
            // receipt, is never taken for a lost one: signing again then would pay the invoice twice.
            const latest = yield* Effect.flatMap(address, (a) => call("nonce", () => client!.getTransactionCount({ address: a, blockTag: "latest" })))
            const again = yield* mined(saved)
            if (again !== "pending" || latest <= saved.nonce || (yield* late)) return again
            // A node's receipts can lag its blocks: one that still knows the payment by its hash (mined, or waiting) says
            // it isn't lost, whatever the receipt lookup says.
            if (yield* knows(saved.hash)) return "pending"
            yield* Effect.logWarning(`Base payment ${saved.hash} lost its nonce ${saved.nonce} to another transaction; paying again`)
          }
          const p = yield* sign(yield* prepare(to, amount))
          yield* save(p)
          // Only a payment whose nonce was lost gets this far with one saved: signing again is rare enough to tell someone.
          if (saved) {
            yield* alerts.admin(
              `Base payment ${saved.hash} (nonce ${saved.nonce}) lost its nonce to another of the Base Wallet's transactions and the node doesn't know it, ` +
                `so ${(amount / 1e6).toFixed(2)} USDC to ${to} was signed again as ${p.hash}. Check on basescan that only one of them went through.`
            )
          }
          yield* send(p)
          return yield* mined(p)
        }))

      return Base.of({ configured, address, balances, prepare, sign, send, status, pay })
    })
  )
}
