import { Config, Context, Data, Effect, Layer, Option, Redacted, Semaphore } from "effect"
import {
  type Action,
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
  /** Why any receipt in the transaction failed, even one whose failure didn't fail the whole transaction. */
  readonly failures: ReadonlyArray<string>
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
  const failures = tx.receipts_outcome
    .map((r) => r.outcome.status as Record<string, unknown>)
    .filter((st) => st && typeof st === "object" && "Failure" in st)
    .map((st) => panicMessage(st.Failure))
  return Effect.succeed({ hash, value: raw ? JSON.parse(raw) : null, events, failures })
}

/** testnet or mainnet. Anything else refuses to start, so a typo can't switch off the testnet guards. */
export const Network = Config.Literals(["testnet", "mainnet"], "NEAR_NETWORK").pipe(Config.withDefault("testnet"))

/** Settings that name NEAR accounts: on mainnet none may end in .testnet, and on testnet none in .near. */
const ACCOUNT_SETTINGS = ["LUCKOUT_CONTRACT_ID", "USDC_CONTRACT_ID", "OPERATOR_ACCOUNT_ID", "RELAYER_ACCOUNT_ID", "TREASURY_ACCOUNT_ID", "ADMIN_ACCOUNTS"]

/** Account names in this .env that belong to the other network: a mixed-up .env. */
export const otherNetworkAccounts = (network: "testnet" | "mainnet", env: Record<string, string | undefined>) =>
  ACCOUNT_SETTINGS.flatMap((k) =>
    (env[k] ?? "").split(",").map((a) => a.trim()).filter((a) => (network === "mainnet" ? a.endsWith(".testnet") : a.endsWith(".near")))
      .map((a) => `${k}=${a}`)
  )

/** The chain has never seen this transaction (raw RPC kind, or near-api-js 7's `UnknownTransactionError`). */
export const isUnknownTx = (e: unknown) => /UNKNOWN_TRANSACTION|UnknownTransaction/.test(String(e))
/** NEAR's own error kinds for a transaction that can no longer execute (`InvalidNonceError`, `TransactionExpiredError`). */
export const isDeadTx = (e: unknown) => /InvalidNonce|Invalid nonce|expired/i.test(String(e))

/** Free public endpoints, each tried when the one before is rate-limited or down (checked 2026-11-10). */
export const MAINNET_RPC_URLS = "https://free.rpc.fastnear.com,https://near.drpc.org,https://rpc.intea.rs"
export const TESTNET_RPC_URLS = "https://test.rpc.fastnear.com,https://near-testnet.drpc.org,https://rpc.testnet.near.org"

/**
 * The endpoint failed to answer (rate limit, outage, network, timeout), as opposed to the chain
 * answering, even with an error. near-api-js already retried 500/503/408 a few times by then.
 */
export const transportTrouble = (message: string) =>
  /rate limit|too many requests|-?\b429\b|internal server error|timeout error|bad gateway|unavailable|exceeded \d+ attempts|fetch failed|failed to fetch|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timed out/i
    .test(message)

/**
 * Runs one RPC call with a deadline, moving to the next endpoint on transport trouble. The chain's
 * own answers (unknown transaction, contract panic, invalid nonce…) come back unchanged, so callers
 * can still tell them apart. Every call is a read or the same signed bytes again (same hash), so
 * repeating it elsewhere is safe. The switch sticks until that endpoint fails in turn.
 */
export const failover = <P, A>(providers: ReadonlyArray<P>, at: { i: number }, what: string, f: (provider: P) => Promise<A>) => {
  const attempt = (left: number): Effect.Effect<A, NearUnavailable> => {
    const i = at.i
    return Effect.tryPromise({ try: () => f(providers[i]!), catch: (e) => new NearUnavailable({ message: `${what}: ${e}` }) }).pipe(
      // One hung request must not hold a send lock forever.
      Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.fail(new NearUnavailable({ message: `${what}: timed out` })) }),
      Effect.catchTag("NearUnavailable", (e) => {
        if (left <= 1 || !transportTrouble(e.message)) return Effect.fail(e)
        if (at.i === i) at.i = (i + 1) % providers.length
        return attempt(left - 1)
      })
    )
  }
  return attempt(providers.length)
}

/** A customer's signed NEP-366 delegate action, as borsh decodes it. */
export interface SignedDelegate {
  readonly delegateAction: {
    readonly senderId: string
    readonly receiverId: string
    readonly actions: ReadonlyArray<Action>
    readonly nonce: bigint
    readonly maxBlockHeight: bigint
    readonly publicKey: Record<string, { readonly data: ArrayLike<number> }>
  }
  readonly signature: Record<string, { readonly data: ArrayLike<number> }>
}

export class Near extends Context.Service<Near, {
  readonly contractId: string
  /** The USDC token contract (test USDC on testnet). */
  readonly usdcId: string
  readonly operatorId: string | undefined
  /** The server-held account that refills Bitrefill (ADR-0009), when configured. */
  readonly treasuryId: string | undefined
  /** The account that pays customers' network fees (NEP-366 relayer), when configured. */
  readonly relayerId: string | undefined
  view<A>(method: string, args?: Record<string, unknown>, contract?: string): Effect.Effect<A, NearUnavailable>
  /** Signs `method` with the operator's function-call key, lets `persist` save it, then sends it. */
  call<E>(
    method: string,
    args: object,
    persist: (signed: Signed) => Effect.Effect<void, E>
  ): Effect.Effect<Outcome, ContractRejected | NearUnavailable | E>
  /** Sends a customer's signed delegate from the relayer, which pays its gas and any deposit. */
  relay<E>(
    delegate: SignedDelegate,
    persist: (signed: Signed) => Effect.Effect<void, E>
  ): Effect.Effect<Outcome, ContractRejected | NearUnavailable | E>
  /** Signs `actions` to `receiverId` with the treasury's key, lets `persist` save it, then sends it. */
  treasurySend<E>(
    receiverId: string,
    actions: Array<Action>,
    persist: (signed: Signed) => Effect.Effect<void, E>
  ): Effect.Effect<Outcome, ContractRejected | NearUnavailable | E>
  /** The outcome of a transaction signed earlier, re-sending it if the network never saw it. */
  resume(signed: Signed): Effect.Effect<Outcome, ContractRejected | NearUnavailable | TxExpired>
  /** An access key's nonce and whether it is full-access; undefined if the account has no such key. */
  accessKey(accountId: string, publicKey: string): Effect.Effect<{ readonly nonce: bigint; readonly fullAccess: boolean } | undefined, NearUnavailable>
  /** The latest final block height. */
  readonly height: Effect.Effect<bigint, NearUnavailable>
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
      // Several endpoints, comma-separated: a rate limit or outage moves calls to the next one.
      const rpcUrls = yield* Config.String("NEAR_RPC_URL").pipe(
        Config.withDefault(testnet ? TESTNET_RPC_URLS : MAINNET_RPC_URLS),
        Config.map((s) => s.split(",").map((u) => u.trim()).filter(Boolean))
      )
      const contractId = yield* Config.String("LUCKOUT_CONTRACT_ID").pipe(
        Config.withDefault(testnet ? "app.luckout.testnet" : "")
      )
      const operatorId = yield* Config.option(Config.String("OPERATOR_ACCOUNT_ID"))
      const operatorKey = yield* Config.option(Config.Redacted("OPERATOR_PRIVATE_KEY"))
      const relayerId = yield* Config.option(Config.String("RELAYER_ACCOUNT_ID"))
      const relayerKey = yield* Config.option(Config.Redacted("RELAYER_PRIVATE_KEY"))
      const treasuryIdConfig = yield* Config.option(Config.String("TREASURY_ACCOUNT_ID"))
      const treasuryKey = yield* Config.option(Config.Redacted("TREASURY_PRIVATE_KEY"))
      const usdcId = yield* Config.String("USDC_CONTRACT_ID").pipe(
        Config.withDefault(testnet ? "usdc.luckout.testnet" : "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1")
      )

      const providers = rpcUrls.map((url) => new JsonRpcProvider({ url }))
      const at = { i: 0 }
      const rpc = <A>(what: string, f: (provider: JsonRpcProvider) => Promise<A>) => failover(providers, at, what, f)

      /**
       * One account's key, sending one transaction at a time until it is included, so a later
       * nonce can never land first and void an earlier one.
       * ponytail: serial sends (~1 tx per block per key); rotate several keys if volume needs it.
       */
      const sender = (id: string, key: Redacted.Redacted<string>) =>
        Effect.gen(function*() {
          const signer = KeyPairSigner.fromSecretKey(Redacted.value(key) as KeyPairString)
          const lock = yield* Semaphore.make(1)
          let lastNonce = 0n

          const executed = (hash: string) =>
            rpc("tx status", (p) => p.viewTransactionStatus({ txHash: hash, accountId: id, waitUntil: "EXECUTED_OPTIMISTIC" })).pipe(
              Effect.flatMap((tx) => toOutcome(hash, tx))
            )

          const send = <E>(receiverId: string, txActions: Array<Action>, persist: (signed: Signed) => Effect.Effect<void, E>) =>
            Effect.gen(function*() {
              const hash = yield* lock.withPermits(1)(Effect.gen(function*() {
                const publicKey = yield* rpc("key", () => signer.getPublicKey())
                const [key, block] = yield* Effect.all([
                  rpc("access key", (p) => p.viewAccessKey({ accountId: id, publicKey, finalityQuery: { finality: "optimistic" } })),
                  rpc("block", (p) => p.viewBlock({ finality: "final" }))
                ])
                const nonce = (BigInt(key.nonce) > lastNonce ? BigInt(key.nonce) : lastNonce) + 1n
                const tx = createTransaction(id, publicKey, receiverId, nonce, txActions, baseDecode(block.header.hash))
                const { txHash, signedTransaction } = yield* rpc("sign", () => signer.signTransaction(tx))
                const signed = { hash: baseEncode(txHash), bytes: base64Encode(signedTransaction.encode()) }
                yield* persist(signed)
                lastNonce = nonce
                yield* rpc("send", (p) => p.sendTransactionUntil(signedTransaction, "INCLUDED"))
                return signed.hash
              }))
              return yield* executed(hash)
            })

          const resume = (signed: Signed) =>
            Effect.gen(function*() {
              const seen = yield* executed(signed.hash).pipe(
                Effect.map(Option.some),
                Effect.catchTag("NearUnavailable", (e) => (isUnknownTx(e.message) ? Effect.succeedNone : Effect.fail(e)))
              )
              if (Option.isSome(seen)) return seen.value
              // Never seen: send the same bytes again (same hash, so it can't execute twice).
              const tx = SignedTransaction.decode(base64Decode(signed.bytes))
              const resent = yield* lock.withPermits(1)(
                rpc("resend", (p) => p.sendTransactionUntil(tx, "INCLUDED")).pipe(
                  Effect.as(true),
                  Effect.catchTag("NearUnavailable", (e) => (isDeadTx(e.message) ? Effect.succeed(false) : Effect.fail(e)))
                )
              )
              if (!resent) {
                // A dead nonce can also mean this very transaction already ran and the first lookup
                // hit a lagging node. Ask again at final finality before calling it expired.
                const final = yield* rpc("final tx status", (p) =>
                  p.viewTransactionStatus({ txHash: signed.hash, accountId: id, waitUntil: "FINAL" })
                ).pipe(Effect.map(Option.some), Effect.catchTag("NearUnavailable", (e) => (isUnknownTx(e.message) ? Effect.succeedNone : Effect.fail(e))))
                if (Option.isSome(final)) return yield* toOutcome(signed.hash, final.value)
                return yield* new TxExpired({ hash: signed.hash })
              }
              return yield* executed(signed.hash)
            })

          return { id, send, resume }
        })

      const operator = Option.isSome(operatorId) && Option.isSome(operatorKey) ? yield* sender(operatorId.value, operatorKey.value) : undefined
      const relayer = Option.isSome(relayerId) && Option.isSome(relayerKey) ? yield* sender(relayerId.value, relayerKey.value) : undefined
      const treasury = Option.isSome(treasuryIdConfig) && Option.isSome(treasuryKey)
        ? yield* sender(treasuryIdConfig.value, treasuryKey.value)
        : undefined

      const view = <A>(method: string, args: Record<string, unknown> = {}, contract = contractId) =>
        rpc(`view ${method}`, (p) => p.callFunction({ contractId: contract, method, args })).pipe(
          Effect.map((v) => v as A)
        )

      const call = <E>(method: string, args: object, persist: (signed: Signed) => Effect.Effect<void, E>) =>
        operator
          ? operator.send(contractId, [actions.functionCall(method, args, teraToGas("100"), 0n)], persist)
          : Effect.fail(new NearUnavailable({ message: "OPERATOR_ACCOUNT_ID / OPERATOR_PRIVATE_KEY not set" }))

      // The outer transaction goes from the relayer to the customer's account; the network checks
      // the customer's signature and runs their actions as them (NEP-366).
      const relay = <E>(delegate: SignedDelegate, persist: (signed: Signed) => Effect.Effect<void, E>) =>
        relayer
          ? relayer.send(delegate.delegateAction.senderId, [actions.signedDelegate(delegate as never)], persist)
          : Effect.fail(new NearUnavailable({ message: "RELAYER_ACCOUNT_ID / RELAYER_PRIVATE_KEY not set" }))

      const treasurySend = <E>(receiverId: string, txActions: Array<Action>, persist: (signed: Signed) => Effect.Effect<void, E>) =>
        treasury
          ? treasury.send(receiverId, txActions, persist)
          : Effect.fail(new NearUnavailable({ message: "TREASURY_ACCOUNT_ID / TREASURY_PRIVATE_KEY not set" }))

      // Whichever of our accounts signed it resumes it, under that account's send lock.
      const resume = (signed: Signed) => {
        const signerId = SignedTransaction.decode(base64Decode(signed.bytes)).transaction.signerId
        const by = [operator, relayer, treasury].find((s) => s?.id === signerId)
        return by ? by.resume(signed) : Effect.fail(new NearUnavailable({ message: `no key configured for ${signerId}` }))
      }

      const accessKey = (accountId: string, publicKey: string) =>
        rpc("access key", (p) => p.viewAccessKey({ accountId, publicKey, finalityQuery: { finality: "optimistic" } })).pipe(
          Effect.map((k) => ({ nonce: BigInt(k.nonce), fullAccess: k.permission === "FullAccess" })),
          Effect.catchTag("NearUnavailable", (e) =>
            /UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|does not exist/i.test(e.message) ? Effect.succeed(undefined) : Effect.fail(e))
        )

      const height = rpc("block", (p) => p.viewBlock({ finality: "final" })).pipe(Effect.map((b) => BigInt(b.header.height)))

      const account = (accountId: string) =>
        rpc("account", (p) => p.viewAccount({ accountId, blockQuery: { finality: "optimistic" } })).pipe(
          Effect.map((a) => ({ amount: a.amount, storageUsage: a.storage_usage }))
        )

      const verifySignIn: Near["Service"]["verifySignIn"] = (input) =>
        Effect.tryPromise(() =>
          verifyMessage({
            signerAccountId: input.accountId,
            signerPublicKey: input.publicKey,
            payload: { message: input.message, recipient: input.recipient, nonce: input.nonce },
            signature: input.signature,
            provider: providers[at.i]!
          })
        ).pipe(Effect.as(true), Effect.orElseSucceed(() => false))

      return Near.of({
        contractId,
        usdcId,
        operatorId: operator?.id,
        relayerId: relayer?.id,
        treasuryId: treasury?.id,
        view,
        call,
        relay,
        treasurySend,
        resume,
        accessKey,
        height,
        account,
        verifySignIn
      })
    })
  )
}
