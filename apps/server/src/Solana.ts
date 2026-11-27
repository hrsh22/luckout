/**
 * The Solana program, as the server uses it (ADR-0015). `Chain` is the transport (RPC here, LiteSVM in tests);
 * `Solana` holds our three keys and sends: every transaction is signed, saved by the caller, then sent, so one
 * interrupted by a crash is resumed rather than signed twice.
 *
 * Keys: the operator admits and settles; the fee payer pays every fee and rent and has no rights in the program;
 * the Pay Wallet pays Bitrefill. None is the owner, which lives in the owner's own wallet.
 */
import {
  type AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  type ParsedInstruction,
  type PartiallyDecodedInstruction,
  PublicKey,
  SendTransactionError,
  Transaction,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js"
import { Config, Context, Data, Effect, Layer, Option, Redacted } from "effect"
import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto"
import {
  base58,
  type Checkout,
  type Config as ProgramConfig,
  type Customer,
  decodeAccount,
  decodeEvents,
  IDL_PROGRAM_ID,
  type Program,
  type ProgramEvent,
  programAt,
  programError
} from "./Program.ts"

/** The program refused the transaction; nothing changed onchain. `name` is its error's name, when it's one of ours. */
export class ProgramRejected extends Data.TaggedError("ProgramRejected")<{ readonly message: string; readonly name?: string }> {}
/** RPC or network trouble: the outcome is unknown. */
export class SolanaUnavailable extends Data.TaggedError("SolanaUnavailable")<{ readonly message: string }> {}
/** A signed transaction that never landed and no longer can (its blockhash expired); sign a new one. */
export class TxExpired extends Data.TaggedError("TxExpired")<{ readonly signature: string }> {}
/** The chain refused a transaction before running it for good (preflight, or LiteSVM): it never landed. */
export class Refused extends Data.TaggedError("Refused")<{ readonly error: TxError; readonly logs: ReadonlyArray<string> }> {}

/** A transaction to co-sign that isn't one we prepared, or isn't signed by its customer: the fee payer never signs it. */
export class NotOurs extends Data.TaggedError("NotOurs")<{ readonly message: string }> {}

/** Why a transaction failed: the program's custom error code if it has one, and a readable form. */
export interface TxError { readonly code?: number; readonly text: string }

export interface RawAccount { readonly owner: PublicKey; readonly lamports: bigint; readonly data: Buffer }

/** A transaction that ran (or was simulated). */
export interface Ran {
  readonly error: TxError | undefined
  readonly logs: ReadonlyArray<string>
  /** Data of the inner instructions our program called itself with: `emit_cpi!` events. */
  readonly inner: ReadonlyArray<Uint8Array>
  readonly returnData: Buffer | undefined
  readonly units: number | undefined
  /** When it landed (Unix seconds), if the chain dates it. */
  readonly time?: number | undefined
}

/** A signed transaction, saved before it is sent. */
export interface Signed {
  readonly signature: string
  /** base64 of the signed transaction */
  readonly bytes: string
  readonly lastValidBlockHeight: number
}

/** A simulation, with the watched accounts as it leaves them (undefined where one doesn't exist). */
export interface Simulated extends Ran {
  readonly accounts: Array<RawAccount | undefined>
}

export interface Outcome {
  readonly signature: string
  readonly events: ReadonlyArray<ProgramEvent>
  readonly returnData: Buffer | undefined
  readonly units: number | undefined
}

export class Chain extends Context.Service<Chain, {
  accounts(keys: ReadonlyArray<PublicKey>): Effect.Effect<Array<RawAccount | undefined>, SolanaUnavailable>
  readonly blockhash: Effect.Effect<{ readonly blockhash: string; readonly lastValidBlockHeight: number }, SolanaUnavailable>
  readonly blockHeight: Effect.Effect<number, SolanaUnavailable>
  /** Sends signed bytes. Already-landed bytes are fine to send again: the chain runs a signature once. */
  submit(bytes: Uint8Array): Effect.Effect<void, SolanaUnavailable | Refused>
  /** What a landed transaction did; undefined while the chain hasn't got it. */
  landed(signature: string): Effect.Effect<Ran | undefined, SolanaUnavailable>
  /** Runs bytes without landing them (signatures unchecked); `watch`: accounts to read back as it leaves them. */
  simulate(bytes: Uint8Array, watch?: ReadonlyArray<PublicKey>): Effect.Effect<Simulated, SolanaUnavailable>
  balance(key: PublicKey): Effect.Effect<bigint, SolanaUnavailable>
  signatures(key: PublicKey, limit: number): Effect.Effect<Array<string>, SolanaUnavailable>
}>()("luckout/Chain") {
  /** RPC: SOLANA_RPC_URL, or the cluster's public endpoint. */
  static readonly layer = Layer.effect(
    Chain,
    Effect.gen(function*() {
      const cluster = yield* Cluster
      const url = yield* Config.String("SOLANA_RPC_URL").pipe(
        Config.withDefault(cluster === "mainnet" ? "https://api.mainnet-beta.solana.com" : cluster === "devnet" ? "https://api.devnet.solana.com" : "http://127.0.0.1:8899")
      )
      const conn = new Connection(url, "confirmed")
      const rpc = <A>(what: string, f: () => Promise<A>) =>
        Effect.tryPromise({ try: f, catch: (e) => new SolanaUnavailable({ message: `${what}: ${e}` }) }).pipe(
          Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.fail(new SolanaUnavailable({ message: `${what}: timed out` })) })
        )
      const txError = (err: unknown): TxError => {
        const custom = (err as { InstructionError?: [number, { Custom?: number }] })?.InstructionError?.[1]?.Custom
        return { ...(typeof custom === "number" ? { code: custom } : {}), text: JSON.stringify(err) }
      }
      const ours = (ix: ParsedInstruction | PartiallyDecodedInstruction): ix is PartiallyDecodedInstruction =>
        "data" in ix && ix.programId.equals(program.id)
      const program = programAt(yield* ProgramId)

      return Chain.of({
        accounts: (keys) =>
          Effect.forEach(
            Array.from({ length: Math.ceil(keys.length / 100) }, (_, i) => keys.slice(i * 100, i * 100 + 100)),
            (chunk) => rpc("accounts", () => conn.getMultipleAccountsInfo([...chunk])),
            { concurrency: 4 }
          ).pipe(Effect.map((pages) =>
            pages.flat().map((a) => (a ? { owner: a.owner, lamports: BigInt(a.lamports), data: Buffer.from(a.data) } : undefined))
          )),
        blockhash: rpc("blockhash", () => conn.getLatestBlockhash("confirmed")),
        blockHeight: rpc("block height", () => conn.getBlockHeight("confirmed")),
        submit: (bytes) =>
          Effect.tryPromise({
            try: () => conn.sendRawTransaction(bytes, { preflightCommitment: "confirmed", maxRetries: 5 }),
            catch: (e) => e
          }).pipe(Effect.matchEffect({ onSuccess: () => Effect.void, onFailure: submitFailure })),
        landed: (signature) =>
          rpc("transaction", () => conn.getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })).pipe(
            Effect.map((tx) =>
              tx
                ? {
                  error: tx.meta?.err ? txError(tx.meta.err) : undefined,
                  logs: tx.meta?.logMessages ?? [],
                  inner: (tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions.filter(ours).map((ix) => base58.decode(ix.data))),
                  returnData: undefined,
                  units: tx.meta?.computeUnitsConsumed,
                  time: tx.blockTime ?? undefined
                }
                : undefined
            )
          ),
        simulate: (bytes, watch = []) =>
          rpc("simulate", () =>
            conn.simulateTransaction(VersionedTransaction.deserialize(bytes), {
              sigVerify: false,
              commitment: "confirmed",
              ...(watch.length > 0 ? { accounts: { encoding: "base64" as const, addresses: watch.map((k) => k.toBase58()) } } : {})
            })).pipe(
              Effect.map(({ value }) => ({
                error: value.err ? txError(value.err) : undefined,
                logs: value.logs ?? [],
                inner: [],
                returnData: value.returnData ? Buffer.from(value.returnData.data[0], "base64") : undefined,
                units: value.unitsConsumed,
                accounts: watch.map((_, i) => {
                  const a = value.accounts?.[i]
                  return a ? { owner: new PublicKey(a.owner), lamports: BigInt(a.lamports), data: Buffer.from(a.data[0] ?? "", "base64") } : undefined
                })
              }))
            ),
        balance: (key) => rpc("balance", () => conn.getBalance(key, "confirmed")).pipe(Effect.map(BigInt)),
        signatures: (key, limit) =>
          rpc("signatures", () => conn.getSignaturesForAddress(key, { limit }, "confirmed")).pipe(Effect.map((s) => s.map((x) => x.signature)))
      })
    })
  )
}

/** A send RPC's error: a resend of landed bytes is fine, a preflight refusal is `Refused`, the rest is trouble. */
const submitFailure = (e: unknown): Effect.Effect<void, SolanaUnavailable | Refused> => {
  const text = String(e)
  if (/already been processed|AlreadyProcessed/i.test(text)) return Effect.void
  if (e instanceof SendTransactionError) {
    const logs = e.logs ?? []
    const custom = /custom program error: 0x([0-9a-f]+)/i.exec(text)
    if (logs.length > 0 || custom) {
      return Effect.fail(new Refused({ error: { ...(custom ? { code: parseInt(custom[1]!, 16) } : {}), text }, logs }))
    }
  }
  return Effect.fail(new SolanaUnavailable({ message: `send: ${text}` }))
}

/** localnet, devnet or mainnet. Anything else refuses to start, so a typo can't switch off the non-mainnet guards. */
export const Cluster = Config.Literals(["localnet", "devnet", "mainnet"], "SOLANA_CLUSTER").pipe(Config.withDefault("devnet"))

/** This deployment's program: staging and production each have their own (ADR-0015, "Environments"). */
export const ProgramId = Config.String("SOLANA_PROGRAM_ID").pipe(
  Config.withDefault(IDL_PROGRAM_ID.toBase58()),
  Config.map((s) => new PublicKey(s))
)

/** A key from a base58 secret (64 bytes, as Phantom and `solana-keygen` export them). */
const keypair = (name: string) =>
  Config.option(Config.Redacted(name)).pipe(
    Config.map(Option.map((secret) => Keypair.fromSecretKey(base58.decode(Redacted.value(secret)))))
  )

/** Each transaction asks for this much compute, and pays this priority fee per unit (micro-lamports). */
const UNITS = 400_000
const DEFAULT_PRIORITY = 10_000

export type SignerName = "operator" | "payWallet"

/** How a prepared transaction is built: its compute limit, and lookup tables, which make it a v0 transaction. */
export interface PrepareOptions {
  readonly units?: number
  readonly lookupTables?: ReadonlyArray<AddressLookupTableAccount>
}

/** Whether `signature` is `key`'s Ed25519 signature of `message`. */
const signedBy = (key: PublicKey, message: Uint8Array, signature: Uint8Array) =>
  verify(null, message, createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.toBuffer()]), format: "der", type: "spki" }), signature)

const rejected = (error: TxError, logs: ReadonlyArray<string>) => {
  const ours = error.code === undefined ? undefined : programError(error.code)
  const anchor = logs.map((l) => /Error Message: (.+?)\.?$/.exec(l)?.[1]).find(Boolean)
  return new ProgramRejected({ message: ours?.msg ?? anchor ?? error.text, ...(ours ? { name: ours.name } : {}) })
}

export class Solana extends Context.Service<Solana, {
  readonly cluster: "localnet" | "devnet" | "mainnet"
  readonly program: Program
  readonly operator: PublicKey | undefined
  readonly feePayer: PublicKey | undefined
  /** The Pay Wallet's own address (its USDC account is `Config.pay_wallet`). */
  readonly payWallet: PublicKey | undefined
  account(key: PublicKey): Effect.Effect<RawAccount | undefined, SolanaUnavailable>
  accounts(keys: ReadonlyArray<PublicKey>): Effect.Effect<Array<RawAccount | undefined>, SolanaUnavailable>
  readonly config: Effect.Effect<ProgramConfig, SolanaUnavailable>
  customer(wallet: PublicKey): Effect.Effect<Customer | undefined, SolanaUnavailable>
  checkout(address: PublicKey): Effect.Effect<Checkout | undefined, SolanaUnavailable>
  /** Runs instructions without sending them, paid by the fee payer: quotes. */
  simulate(ixs: ReadonlyArray<TransactionInstruction>): Effect.Effect<Outcome, ProgramRejected | SolanaUnavailable>
  /** Signs with the fee payer and `signers`, lets `persist` save it, sends it and waits until it lands. */
  send<E>(
    ixs: ReadonlyArray<TransactionInstruction>,
    signers: ReadonlyArray<SignerName>,
    persist: (signed: Signed) => Effect.Effect<void, E>
  ): Effect.Effect<Outcome, ProgramRejected | SolanaUnavailable | E>
  /** The outcome of a transaction signed earlier, sending its bytes again while its blockhash is still valid. */
  resume(signed: Signed): Effect.Effect<Outcome, ProgramRejected | SolanaUnavailable | TxExpired>
  balance(key: PublicKey): Effect.Effect<bigint, SolanaUnavailable>
  signatures(key: PublicKey, limit: number): Effect.Effect<Array<string>, SolanaUnavailable>
  /** What any landed transaction did, ours or not; undefined while the chain hasn't got it. */
  landed(signature: string): Effect.Effect<Ran | undefined, SolanaUnavailable>
  /** A landed transaction's events, if it succeeded. */
  transaction(signature: string): Effect.Effect<Outcome | undefined, SolanaUnavailable>
  /**
   * A transaction a customer signs and we pay for (ADR-0015): built here with our fee payer, handed out unsigned with a
   * token that binds its exact bytes. Only `cosign` adds the fee payer's signature, and only to those bytes.
   */
  prepare(
    ixs: ReadonlyArray<TransactionInstruction>,
    signer: PublicKey,
    options?: PrepareOptions
  ): Effect.Effect<{ readonly transaction: string; readonly token: string }, SolanaUnavailable>
  /** Simulates a prepared transaction as it stands, unsigned, and reads back `watch` as it leaves them. */
  inspect(transaction: string, watch: ReadonlyArray<PublicKey>): Effect.Effect<Simulated, SolanaUnavailable>
  /** Checks a prepared transaction came back unchanged and signed by its customer, then signs as fee payer, sends and waits. */
  cosign(transaction: string, token: string): Effect.Effect<Outcome, ProgramRejected | SolanaUnavailable | NotOurs>
}>()("luckout/Solana") {
  static readonly layer = Layer.effect(
    Solana,
    Effect.gen(function*() {
      const chain = yield* Chain
      const cluster = yield* Cluster
      const program = programAt(yield* ProgramId)
      const operator = Option.getOrUndefined(yield* keypair("SOLANA_OPERATOR_SECRET_KEY"))
      const feePayer = Option.getOrUndefined(yield* keypair("SOLANA_FEE_PAYER_SECRET_KEY"))
      const payWallet = Option.getOrUndefined(yield* keypair("SOLANA_PAY_WALLET_SECRET_KEY"))
      const priority = yield* Config.Int("SOLANA_PRIORITY_MICROLAMPORTS").pipe(Config.withDefault(DEFAULT_PRIORITY))
      // Binds a prepared transaction's bytes. Its blockhash expires in about a minute, so a restart's new secret costs nothing.
      const prepareSecret = randomBytes(32)
      const bind = (message: Buffer) => createHmac("sha256", prepareSecret).update(message).digest("base64url")

      const account = (key: PublicKey) => chain.accounts([key]).pipe(Effect.map((a) => a[0]))
      const decoded = <T>(name: "Config" | "Customer" | "Checkout", key: PublicKey) =>
        account(key).pipe(Effect.map((a) => (a && a.owner.equals(program.id) && a.data.length > 0 ? decodeAccount<T>(name, a.data) : undefined)))

      const need = <A>(key: A | undefined, name: string) =>
        key ? Effect.succeed(key) : Effect.fail(new SolanaUnavailable({ message: `${name} isn't set` }))

      const build = (ixs: ReadonlyArray<TransactionInstruction>, signers: ReadonlyArray<Keypair>) =>
        Effect.gen(function*() {
          const payer = yield* need(feePayer, "SOLANA_FEE_PAYER_SECRET_KEY")
          const { blockhash, lastValidBlockHeight } = yield* chain.blockhash
          const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: UNITS }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }),
            ...ixs
          )
          tx.sign(payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey)))
          return { tx, lastValidBlockHeight }
        })

      const outcome = (signature: string, ran: Ran) =>
        ran.error
          ? Effect.fail(rejected(ran.error, ran.logs))
          : Effect.succeed({ signature, events: decodeEvents(ran.logs, ran.inner), returnData: ran.returnData, units: ran.units })

      /** Waits for `signed` to land, sending it again now and then, until its blockhash has expired. */
      const deliver = (signed: Signed): Effect.Effect<Outcome, ProgramRejected | SolanaUnavailable | TxExpired> =>
        Effect.gen(function*() {
          const bytes = Buffer.from(signed.bytes, "base64")
          for (let tries = 0;; tries++) {
            const ran = yield* chain.landed(signed.signature)
            if (ran) return yield* outcome(signed.signature, ran)
            if ((yield* chain.blockHeight) > signed.lastValidBlockHeight) {
              // A lagging node may not have shown it yet: ask once more before calling it expired.
              const late = yield* chain.landed(signed.signature)
              if (late) return yield* outcome(signed.signature, late)
              return yield* new TxExpired({ signature: signed.signature })
            }
            if (tries % 4 === 0) {
              yield* chain.submit(bytes).pipe(Effect.catchTag("Refused", (r) => Effect.fail(rejected(r.error, r.logs))))
            }
            yield* Effect.sleep("500 millis")
          }
        })

      const send: Solana["Service"]["send"] = (ixs, signers, persist) =>
        Effect.gen(function*() {
          const keys = yield* Effect.forEach(signers, (s) =>
            s === "operator" ? need(operator, "SOLANA_OPERATOR_SECRET_KEY") : need(payWallet, "SOLANA_PAY_WALLET_SECRET_KEY"))
          const { tx, lastValidBlockHeight } = yield* build(ixs, keys)
          const signed = { signature: base58.encode(tx.signature!), bytes: tx.serialize().toString("base64"), lastValidBlockHeight }
          yield* persist(signed)
          return yield* deliver(signed).pipe(
            // Freshly signed, it can't have expired before its first send: only an hour-long outage gets here.
            Effect.catchTag("TxExpired", (e) => Effect.fail(new SolanaUnavailable({ message: `expired before landing: ${e.signature}` })))
          )
        })

      const prepare: Solana["Service"]["prepare"] = (ixs, signer, options = {}) =>
        Effect.gen(function*() {
          const payer = yield* need(feePayer, "SOLANA_FEE_PAYER_SECRET_KEY")
          if (!ixs.some((ix) => ix.keys.some((k) => k.isSigner && k.pubkey.equals(signer)))) {
            return yield* new SolanaUnavailable({ message: "the customer signs nothing in this transaction" })
          }
          const { blockhash, lastValidBlockHeight } = yield* chain.blockhash
          const all = [
            ComputeBudgetProgram.setComputeUnitLimit({ units: options.units ?? UNITS }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }),
            ...ixs
          ]
          if (options.lookupTables) {
            const tables = options.lookupTables
            return yield* Effect.try({
              try: () => {
                const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: all }).compileToV0Message([...tables])
                return { transaction: Buffer.from(new VersionedTransaction(message).serialize()).toString("base64"), token: bind(Buffer.from(message.serialize())) }
              },
              catch: (e) => new SolanaUnavailable({ message: `the transaction is too big: ${e}` })
            })
          }
          const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(...all)
          return {
            transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
            token: bind(tx.serializeMessage())
          }
        })

      // Legacy and v0 alike: the message's bytes are what the token binds and what every signature signs.
      const cosign: Solana["Service"]["cosign"] = (transaction, token) =>
        Effect.gen(function*() {
          const payer = yield* need(feePayer, "SOLANA_FEE_PAYER_SECRET_KEY")
          const tx = yield* Effect.try({
            try: () => VersionedTransaction.deserialize(Buffer.from(transaction, "base64")),
            catch: () => new NotOurs({ message: "That isn't a transaction" })
          })
          const message = Buffer.from(tx.message.serialize())
          const expected = Buffer.from(bind(message))
          const given = Buffer.from(token)
          if (given.length !== expected.length || !timingSafeEqual(given, expected)) return yield* new NotOurs({ message: "That transaction isn't the one we prepared" })
          // Every signature but ours must be there and valid: we pay only for what its customer signed.
          const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures)
          const others = signers.flatMap((key, i) => (key.equals(payer.publicKey) ? [] : [{ key, signature: tx.signatures[i]! }]))
          if (others.length === 0 || others.some((s) => !signedBy(s.key, message, s.signature))) {
            return yield* new NotOurs({ message: "That transaction isn't signed by its customer" })
          }
          tx.sign([payer])
          const lastValidBlockHeight = (yield* chain.blockHeight) + 150
          return yield* deliver({ signature: base58.encode(tx.signatures[0]!), bytes: Buffer.from(tx.serialize()).toString("base64"), lastValidBlockHeight }).pipe(
            Effect.catchTag("TxExpired", () => Effect.fail(new SolanaUnavailable({ message: "it expired before it landed; prepare it again" })))
          )
        })

      return Solana.of({
        cluster,
        program,
        operator: operator?.publicKey,
        feePayer: feePayer?.publicKey,
        payWallet: payWallet?.publicKey,
        account,
        accounts: chain.accounts,
        config: decoded<ProgramConfig>("Config", program.config).pipe(
          Effect.flatMap((c) => (c ? Effect.succeed(c) : Effect.fail(new SolanaUnavailable({ message: `the program at ${program.id.toBase58()} isn't initialized` }))))
        ),
        customer: (wallet) => decoded<Customer>("Customer", program.customer(wallet)),
        checkout: (address) => decoded<Checkout>("Checkout", address),
        simulate: (ixs) =>
          Effect.gen(function*() {
            const { tx } = yield* build(ixs, [])
            const ran = yield* chain.simulate(tx.serialize())
            return yield* outcome("simulation", ran)
          }),
        send,
        resume: deliver,
        balance: chain.balance,
        signatures: chain.signatures,
        landed: chain.landed,
        transaction: (signature) =>
          chain.landed(signature).pipe(
            Effect.map((ran) =>
              ran && !ran.error ? { signature, events: decodeEvents(ran.logs, ran.inner), returnData: ran.returnData, units: ran.units } : undefined
            )
          ),
        prepare,
        inspect: (transaction, watch) => chain.simulate(Buffer.from(transaction, "base64"), watch),
        cosign
      })
    })
  )
}

/**
 * Refuses to start a server whose keys aren't the program's: the operator must be Config's, and the Pay Wallet must own
 * Config's Pay Wallet account. Otherwise every admission, settlement or payment would fail, one checkout at a time. A
 * chain that can't be asked stops the start too, as an unreachable database does; pm2 starts it again.
 */
export const checkKeys = Effect.gen(function*() {
  const solana = yield* Solana
  const config = yield* solana.config.pipe(Effect.catch((e) => Effect.die(`couldn't read the program's Config (${e.message})`)))
  if (solana.operator && !config.operator.equals(solana.operator)) {
    return yield* Effect.die(`SOLANA_OPERATOR_SECRET_KEY is ${solana.operator.toBase58()}, but the program's operator is ${config.operator.toBase58()}`)
  }
  const pay = yield* solana.account(config.pay_wallet).pipe(Effect.orDie)
  if (solana.payWallet && pay && !new PublicKey(pay.data.subarray(32, 64)).equals(solana.payWallet)) {
    return yield* Effect.die(`SOLANA_PAY_WALLET_SECRET_KEY doesn't own the program's Pay Wallet account ${config.pay_wallet.toBase58()}`)
  }
})
