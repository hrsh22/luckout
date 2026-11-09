import { Config, Context, Data, Effect, Layer, Option, Redacted, Semaphore } from "effect"
import {
  actions,
  base64Decode,
  base64Encode,
  baseDecode,
  baseEncode,
  createTransaction,
  JsonRpcProvider,
  KeyPairSigner,
  type KeyPairString,
  SignedTransaction,
  teraToGas
} from "near-api-js"
import { verifyMessage } from "near-api-js/nep413"

/** The contract refused the call (it panicked); nothing changed onchain. */
export class ContractRejected extends Data.TaggedError("ContractRejected")<{ readonly message: string }> {}
/** RPC or network trouble: the call's outcome is unknown. */
export class NearUnavailable extends Data.TaggedError("NearUnavailable")<{ readonly message: string }> {}
/** A signed transaction that never executed and can no longer be sent; sign a new one. */
export class TxExpired extends Data.TaggedError("TxExpired")<{ readonly hash: string }> {}

/** A signed operator transaction, saved before it is sent so it can be resumed after a crash. */
export interface Signed {
  readonly hash: string
  /** base64 of the signed transaction */
  readonly bytes: string
}

export interface Outcome {
  readonly hash: string
  readonly value: unknown
  /** Luckout `EVENT_JSON` events, in order. */
  readonly events: ReadonlyArray<{ readonly event: string; readonly data: ReadonlyArray<Record<string, unknown>> }>
}

type Tx = Awaited<ReturnType<JsonRpcProvider["viewTransactionStatus"]>>

const panicMessage = (failure: unknown) => {
  const text = JSON.stringify(failure)
  return /Smart contract panicked: ([^"\\]+)/.exec(text)?.[1] ?? text
}

const toOutcome = (hash: string, tx: Tx): Effect.Effect<Outcome, ContractRejected> => {
  const status = tx.status as Record<string, unknown>
  if (status && typeof status === "object" && "Failure" in status) {
    return Effect.fail(new ContractRejected({ message: panicMessage(status.Failure) }))
  }
  const raw = typeof status?.SuccessValue === "string" ? new TextDecoder().decode(base64Decode(status.SuccessValue)) : ""
  const events = tx.receipts_outcome.flatMap((r) => r.outcome.logs)
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice("EVENT_JSON:".length)))
    .filter((e) => e.standard === "luckout")
  return Effect.succeed({ hash, value: raw ? JSON.parse(raw) : null, events })
}

/** testnet or mainnet. Anything else refuses to start, so a typo can't switch off the testnet guards. */
export const Network = Config.Literals(["testnet", "mainnet"], "NEAR_NETWORK").pipe(Config.withDefault("testnet"))

const isUnknownTx = (e: unknown) => /UNKNOWN_TRANSACTION/.test(String(e))
/** NEAR's own error kinds for a transaction that can no longer execute. */
const isDeadTx = (e: unknown) => /InvalidNonce|\bExpired\b|InvalidTransaction.*Expired/.test(String(e))

export class Near extends Context.Service<Near, {
  readonly contractId: string
  readonly operatorId: string | undefined
  view<A>(method: string, args?: Record<string, unknown>): Effect.Effect<A, NearUnavailable>
  /** Signs `method` with the operator's function-call key, lets `persist` save it, then sends it. */
  call<E>(
    method: string,
    args: object,
    persist: (signed: Signed) => Effect.Effect<void, E>
  ): Effect.Effect<Outcome, ContractRejected | NearUnavailable | E>
  /** The outcome of a transaction signed earlier, re-sending it if the network never saw it. */
  resume(signed: Signed): Effect.Effect<Outcome, ContractRejected | NearUnavailable | TxExpired>
  /** An account's NEAR balance and storage, for monitoring. */
  account(accountId: string): Effect.Effect<{ readonly amount: bigint; readonly storageUsage: number }, NearUnavailable>
  /** NEP-413 check: a valid signature by a full-access key of `accountId`. */
  verifySignIn(input: {
    accountId: string
    publicKey: string
    signature: Uint8Array
    message: string
    recipient: string
    nonce: Uint8Array
  }): Effect.Effect<boolean>
}>()("luckout/Near") {
  static readonly layer = Layer.effect(
    Near,
    Effect.gen(function*() {
      const testnet = (yield* Network) === "testnet"
      const rpcUrl = yield* Config.String("NEAR_RPC_URL").pipe(
        Config.withDefault(testnet ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com")
      )
      const contractId = yield* Config.String("LUCKOUT_CONTRACT_ID").pipe(
        Config.withDefault(testnet ? "app.luckout.testnet" : "")
      )
      const operatorId = yield* Config.option(Config.String("OPERATOR_ACCOUNT_ID"))
      const operatorKey = yield* Config.option(Config.Redacted("OPERATOR_PRIVATE_KEY"))

      const provider = new JsonRpcProvider({ url: rpcUrl })
      const operator = Option.isSome(operatorId) && Option.isSome(operatorKey)
        ? {
          id: operatorId.value,
          signer: KeyPairSigner.fromSecretKey(Redacted.value(operatorKey.value) as KeyPairString)
        }
        : undefined

      // Every RPC call has a deadline: one hung request must not hold the send lock forever.
      const rpc = <A>(what: string, f: () => Promise<A>) =>
        Effect.tryPromise({ try: f, catch: (e) => new NearUnavailable({ message: `${what}: ${e}` }) }).pipe(
          Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.fail(new NearUnavailable({ message: `${what}: timed out` })) })
        )

      // One key means one nonce sequence: sign and send one transaction at a time, until
      // it is included, so a later nonce can never land first and void an earlier one.
      // ponytail: serial sends (~1 tx per block); rotate several function-call keys if volume needs it.
      const sendLock = yield* Semaphore.make(1)
      let lastNonce = 0n

      const executed = (hash: string) =>
        rpc("tx status", () =>
          provider.viewTransactionStatus({ txHash: hash, accountId: operator!.id, waitUntil: "EXECUTED_OPTIMISTIC" })
        ).pipe(Effect.flatMap((tx) => toOutcome(hash, tx)))

      const view = <A>(method: string, args: Record<string, unknown> = {}) =>
        rpc(`view ${method}`, () => provider.callFunction({ contractId, method, args })).pipe(
          Effect.map((v) => v as A)
        )

      const call = <E>(method: string, args: object, persist: (signed: Signed) => Effect.Effect<void, E>) =>
        Effect.gen(function*() {
          if (!operator) return yield* new NearUnavailable({ message: "OPERATOR_ACCOUNT_ID / OPERATOR_PRIVATE_KEY not set" })
          const hash = yield* sendLock.withPermits(1)(Effect.gen(function*() {
            const publicKey = yield* rpc("key", () => operator.signer.getPublicKey())
            const [key, block] = yield* Effect.all([
              rpc("access key", () =>
                provider.viewAccessKey({ accountId: operator.id, publicKey, finalityQuery: { finality: "optimistic" } })
              ),
              rpc("block", () => provider.viewBlock({ finality: "final" }))
            ])
            const nonce = (BigInt(key.nonce) > lastNonce ? BigInt(key.nonce) : lastNonce) + 1n
            const tx = createTransaction(
              operator.id,
              publicKey,
              contractId,
              nonce,
              [actions.functionCall(method, args, teraToGas("100"), 0n)],
              baseDecode(block.header.hash)
            )
            const { txHash, signedTransaction } = yield* rpc("sign", () => operator.signer.signTransaction(tx))
            const signed = { hash: baseEncode(txHash), bytes: base64Encode(signedTransaction.encode()) }
            yield* persist(signed)
            lastNonce = nonce
            yield* rpc("send", () => provider.sendTransactionUntil(signedTransaction, "INCLUDED"))
            return signed.hash
          }))
          return yield* executed(hash)
        })

      const resume = (signed: Signed) =>
        Effect.gen(function*() {
          if (!operator) return yield* new NearUnavailable({ message: "operator not configured" })
          const seen = yield* executed(signed.hash).pipe(
            Effect.map(Option.some),
            Effect.catchTag("NearUnavailable", (e) => (isUnknownTx(e.message) ? Effect.succeedNone : Effect.fail(e)))
          )
          if (Option.isSome(seen)) return seen.value
          // Never seen: send the same bytes again (same hash, so it can't execute twice).
          const tx = SignedTransaction.decode(base64Decode(signed.bytes))
          const resent = yield* sendLock.withPermits(1)(
            rpc("resend", () => provider.sendTransactionUntil(tx, "INCLUDED")).pipe(
              Effect.as(true),
              Effect.catchTag("NearUnavailable", (e) => (isDeadTx(e.message) ? Effect.succeed(false) : Effect.fail(e)))
            )
          )
          if (!resent) {
            // A dead nonce can also mean this very transaction already ran and the first lookup
            // hit a lagging node. Ask again at final finality before calling it expired.
            const final = yield* rpc("final tx status", () =>
              provider.viewTransactionStatus({ txHash: signed.hash, accountId: operator.id, waitUntil: "FINAL" })
            ).pipe(Effect.map(Option.some), Effect.catchTag("NearUnavailable", (e) => (isUnknownTx(e.message) ? Effect.succeedNone : Effect.fail(e))))
            if (Option.isSome(final)) return yield* toOutcome(signed.hash, final.value)
            return yield* new TxExpired({ hash: signed.hash })
          }
          return yield* executed(signed.hash)
        })

      const account = (accountId: string) =>
        rpc("account", () => provider.viewAccount({ accountId, blockQuery: { finality: "optimistic" } })).pipe(
          Effect.map((a) => ({ amount: a.amount, storageUsage: a.storage_usage }))
        )

      const verifySignIn: Near["Service"]["verifySignIn"] = (input) =>
        Effect.tryPromise(() =>
          verifyMessage({
            signerAccountId: input.accountId,
            signerPublicKey: input.publicKey,
            payload: { message: input.message, recipient: input.recipient, nonce: input.nonce },
            signature: input.signature,
            provider
          })
        ).pipe(Effect.as(true), Effect.orElseSucceed(() => false))

      return Near.of({ contractId, operatorId: operator?.id, view, call, resume, account, verifySignIn })
    })
  )
}
