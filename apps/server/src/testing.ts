import { address, getTransactionDecoder, lamports as kitLamports } from "@solana/kit"
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction, VersionedTransaction } from "@solana/web3.js"
import { ConfigProvider, Effect, Layer } from "effect"
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm"
import { readFileSync } from "node:fs"
import { Bitrefill } from "./Bitrefill.ts"
import { Near } from "./Near.ts"
import { base58, IDL_PROGRAM_ID, type Mode, ORAO_NETWORK_STATE, ORAO_VRF, oraoRequest, oraoTreasury, type Program, programAt } from "./Program.ts"
import { Chain, type Ran, Refused, Solana, type TxError } from "./Solana.ts"

// Fakes for tests: everything a test doesn't override dies loudly if it's called.

const unused = (what: string) => () => Effect.die(`${what} was not expected in this test`)

export const fakeNear = (overrides: Partial<Near["Service"]> = {}) =>
  Near.of({
    contractId: "app.test",
    usdcId: "usdc.test",
    operatorId: "server.test",
    operatorPublicKey: undefined,
    relayerId: undefined,
    treasuryId: undefined,
    intentsId: "intents.test",
    view: unused("near.view"),
    call: unused("near.call"),
    relay: unused("near.relay"),
    relayerCall: unused("near.relayerCall"),
    treasurySend: unused("near.treasurySend"),
    resume: unused("near.resume"),
    accessKey: unused("near.accessKey"),
    height: Effect.die("near.height was not expected in this test"),
    account: unused("near.account"),
    verifySignIn: () => Effect.succeed(false),
    ...overrides
  })

export const fakeBitrefill = (overrides: Partial<Bitrefill["Service"]> = {}) =>
  Bitrefill.of({
    guest: false,
    search: unused("bitrefill.search"),
    browse: unused("bitrefill.browse"),
    popular: unused("bitrefill.popular"),
    logo: () => ({}),
    voucher: unused("bitrefill.voucher"),
    order: unused("bitrefill.order"),
    delivery: unused("bitrefill.delivery"),
    credit: Effect.die("bitrefill.credit was not expected in this test"),
    deposit: unused("bitrefill.deposit"),
    depositState: unused("bitrefill.depositState"),
    orderLimit: () => Effect.succeed({ used: 0, reopensAt: undefined }),
    ...overrides
  })

/**
 * Bitrefill's OAuth endpoints, faked at fetch (Connect.ts). A code, or a refresh token, buys the next tokens:
 * "access-1"/"refresh-1", then "access-2"/"refresh-2"... The code's access token lasts `firstExpiresIn`
 * seconds and renewed ones 6 hours. Each refresh token works once, as at Bitrefill, and after `lapse()` none
 * does. A refresh takes 50 ms, so two at once would overlap. `calls` lists each request.
 */
export const fakeBitrefillOAuth = (firstExpiresIn = 6 * 3600) => {
  const calls: Array<{ path: string; params: URLSearchParams }> = []
  let issued = 0
  let lapsed = false
  const spent = new Set<string>()
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname
    const params = new URLSearchParams(typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body as Uint8Array))
    calls.push({ path, params })
    if (path === "/oauth/mcp/revoke") return new Response(null, { status: 200 })
    if (path !== "/oauth/mcp/token") throw new Error(`unexpected request to ${path}`)
    if (params.get("grant_type") === "refresh_token") {
      await new Promise((r) => setTimeout(r, 50))
      const old = params.get("refresh_token") ?? ""
      if (lapsed || spent.has(old)) return Response.json({ error: "invalid_grant" }, { status: 400 })
      spent.add(old)
    }
    issued++
    const expiresIn = params.get("grant_type") === "authorization_code" ? firstExpiresIn : 6 * 3600
    return Response.json({ access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: expiresIn, token_type: "Bearer" })
  }) as typeof globalThis.fetch
  return { fetch, calls, lapse: () => void (lapsed = true), grants: (type: string) => calls.filter((c) => c.params.get("grant_type") === type) }
}

// ---------- Solana on LiteSVM (ADR-0015) ----------
// The real program (programs/target/deploy/luckout.so, from `anchor build`) and ORAO's real VRF program and network
// state (programs/fixtures.sh), in-process. Only ORAO's oracles are faked: `fill` writes the filled request where
// ORAO keeps it. Each test makes its own world.

export interface SolanaWorld {
  readonly svm: LiteSVM
  readonly chain: Chain["Service"]
  readonly program: Program
  readonly owner: Keypair
  readonly operator: Keypair
  readonly feePayer: Keypair
  readonly payWallet: Keypair
  readonly mint: PublicKey
  /** The Pay Wallet's USDC account. */
  readonly payWalletUsdc: PublicKey
  /** Config for the Solana layer: these keys, this program, localnet. */
  readonly env: Record<string, string>
  /** Sends a transaction the fee payer pays, signed by anyone else too (customers, the owner); returns its signature. */
  readonly send: (ixs: ReadonlyArray<TransactionInstruction>, signers: ReadonlyArray<Keypair>) => string
  readonly tokenAccount: (owner: PublicKey, amount: bigint) => PublicKey
  readonly tokens: (account: PublicKey) => bigint
  readonly give: (account: PublicKey, amount: bigint) => void
  /** A customer who has made the one-time approval and opened their account; returns their wallet and USDC account. */
  readonly shopper: (mode?: Mode) => { readonly wallet: Keypair; readonly usdc: PublicKey }
  readonly fill: (checkout: PublicKey, round: number, randomness: Uint8Array) => void
  readonly warp: (seconds: number) => void
  /** Moves the chain past every blockhash handed out so far. */
  readonly expire: () => void
}

const ROOT = new URL("../../../programs/", import.meta.url)
const TOKEN_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")

const mintData = (authority: PublicKey) => {
  const d = Buffer.alloc(82)
  d.writeUInt32LE(1, 0)
  authority.toBuffer().copy(d, 4)
  d[44] = 6
  d[45] = 1
  return d
}

const tokenData = (mint: PublicKey, owner: PublicKey, amount: bigint) => {
  const d = Buffer.alloc(165)
  mint.toBuffer().copy(d, 0)
  owner.toBuffer().copy(d, 32)
  d.writeBigUInt64LE(amount, 64)
  d[108] = 1
  return d
}

const kitTx = getTransactionDecoder()

const txError = (e: unknown): TxError => {
  const inner = (e as { err?: () => unknown })?.err?.()
  const code = (inner as { code?: number } | undefined)?.code
  return { ...(typeof code === "number" ? { code } : {}), text: String(e) }
}

const ranFrom = (meta: TransactionMetadata, error: TxError | undefined): Ran => ({
  error,
  logs: meta.logs(),
  inner: meta.innerInstructions().flat().map((i) => i.instruction().data()),
  returnData: meta.returnData().data().length > 0 ? Buffer.from(meta.returnData().data()) : undefined,
  units: Number(meta.computeUnitsConsumed())
})

export const solanaWorld = (): SolanaWorld => {
  const svm = new LiteSVM()
  const program = programAt(IDL_PROGRAM_ID)
  svm.addProgram(address(program.id.toBase58()), readFileSync(new URL("target/deploy/luckout.so", ROOT)))
  svm.addProgram(address(ORAO_VRF.toBase58()), readFileSync(new URL("luckout/tests/fixtures/orao_vrf.so", ROOT)))
  const state = JSON.parse(readFileSync(new URL("luckout/tests/fixtures/orao_network_state.json", ROOT), "utf8"))
  const stateData = Buffer.from(state.account.data[0], "base64")
  const put = (key: PublicKey, owner: PublicKey, data: Uint8Array, lamports = 10_000_000_000n) =>
    svm.setAccount({ address: address(key.toBase58()), data, executable: false, lamports: kitLamports(lamports), programAddress: address(owner.toBase58()), space: BigInt(data.length) })
  put(ORAO_NETWORK_STATE, ORAO_VRF, stateData)

  const [owner, operator, feePayer, payWallet] = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()]
  for (const k of [owner, operator, feePayer]) svm.airdrop(address(k.publicKey.toBase58()), kitLamports(100_000_000_000n))
  svm.airdrop(address(oraoTreasury(stateData).toBase58()), kitLamports(1_000_000_000n))

  // LiteSVM deploys with no upgrade authority: make the owner the program's, as `initialize` requires.
  const pd = svm.getAccount(address(program.programData.toBase58()))
  if (!pd.exists) throw new Error("program data missing")
  const pdData = Buffer.from(pd.data)
  pdData[12] = 1
  owner.publicKey.toBuffer().copy(pdData, 13)
  svm.setAccount({ ...pd, data: pdData })

  const mint = Keypair.generate().publicKey
  put(mint, TOKEN_ID, mintData(owner.publicKey), 1_461_600n)
  const tokenAccount = (o: PublicKey, amount: bigint) => {
    const k = Keypair.generate().publicKey
    put(k, TOKEN_ID, tokenData(mint, o, amount), 2_039_280n)
    return k
  }
  const tokens = (k: PublicKey) => {
    const a = svm.getAccount(address(k.toBase58()))
    return a.exists ? Buffer.from(a.data).readBigUInt64LE(64) : 0n
  }
  const give = (k: PublicKey, amount: bigint) => {
    const a = svm.getAccount(address(k.toBase58()))
    if (!a.exists) throw new Error("no such token account")
    const d = Buffer.from(a.data)
    d.writeBigUInt64LE(d.readBigUInt64LE(64) + amount, 64)
    svm.setAccount({ ...a, data: d })
  }

  let height = 1_000
  const landed = new Map<string, Ran>()
  /** Each account's landed transactions, newest first, as getSignaturesForAddress lists them. */
  const byAccount = new Map<string, Array<string>>()
  const record = (signature: string, bytes: Uint8Array, ran: Ran) => {
    landed.set(signature, ran)
    for (const k of VersionedTransaction.deserialize(bytes).message.staticAccountKeys) {
      byAccount.set(k.toBase58(), [signature, ...(byAccount.get(k.toBase58()) ?? [])])
    }
  }
  const chain = Chain.of({
    accounts: (keys) =>
      Effect.succeed(keys.map((k) => {
        const a = svm.getAccount(address(k.toBase58()))
        return a.exists ? { owner: new PublicKey(a.programAddress), lamports: BigInt(a.lamports), data: Buffer.from(a.data) } : undefined
      })),
    blockhash: Effect.sync(() => ({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: height + 150 })),
    blockHeight: Effect.sync(() => height),
    submit: (bytes) =>
      Effect.suspend(() => {
        const signature = base58.encode(bytes.subarray(1, 65))
        if (landed.has(signature)) return Effect.void
        const res = svm.sendTransaction(kitTx.decode(bytes))
        if (res instanceof FailedTransactionMetadata) {
          return Effect.fail(new Refused({ error: txError(res.err()), logs: res.meta().logs() }))
        }
        record(signature, bytes, ranFrom(res, undefined))
        return Effect.void
      }),
    landed: (signature) => Effect.sync(() => landed.get(signature)),
    simulate: (bytes, watch = []) =>
      Effect.sync(() => {
        // As the RPC simulates: signatures unchecked, so a transaction still waiting for its signers can be tried.
        svm.withSigverify(false)
        const res = svm.simulateTransaction(kitTx.decode(bytes))
        svm.withSigverify(true)
        if (res instanceof FailedTransactionMetadata) return { ...ranFrom(res.meta(), txError(res.err())), accounts: watch.map(() => undefined) }
        const post = new Map(res.postAccounts().map((a) => [String(a.address), a]))
        return {
          ...ranFrom(res.meta(), undefined),
          accounts: watch.map((k) => {
            const now = svm.getAccount(address(k.toBase58()))
            const a = post.get(k.toBase58()) ?? (now.exists ? now : undefined)
            return a && a.lamports > 0n ? { owner: new PublicKey(a.programAddress), lamports: BigInt(a.lamports), data: Buffer.from(a.data) } : undefined
          })
        }
      }),
    balance: (k) => Effect.sync(() => BigInt(svm.getBalance(address(k.toBase58())) ?? 0n)),
    signatures: (key, limit) => Effect.sync(() => (byAccount.get(key.toBase58()) ?? []).slice(0, limit))
  })

  const send = (ixs: ReadonlyArray<TransactionInstruction>, signers: ReadonlyArray<Keypair>) => {
    const tx = new Transaction({ feePayer: feePayer.publicKey, blockhash: svm.latestBlockhash(), lastValidBlockHeight: height + 150 }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ...ixs
    )
    tx.sign(feePayer, ...signers.filter((s) => !s.publicKey.equals(feePayer.publicKey)))
    const bytes = tx.serialize()
    const res = svm.sendTransaction(kitTx.decode(bytes))
    if (res instanceof FailedTransactionMetadata) throw new Error(`${res.err()}\n${res.meta().logs().join("\n")}`)
    const signature = base58.encode(tx.signature!)
    record(signature, bytes, ranFrom(res, undefined))
    svm.expireBlockhash()
    return signature
  }

  const payWalletUsdc = tokenAccount(payWallet.publicKey, 0n)
  const ownerUsdc = tokenAccount(owner.publicKey, 10_000_000_000n)
  send([
    program.instruction("initialize", {
      owner: owner.publicKey,
      config: program.config,
      vault_authority: program.vaultAuthority,
      vault: program.vault,
      usdc_mint: mint,
      pay_wallet: payWalletUsdc,
      program: program.id,
      program_data: program.programData
    }, { operator: operator.publicKey }),
    program.instruction("fund_reserve", { owner: owner.publicKey, config: program.config, from: ownerUsdc, vault: program.vault }, { amount: 1_000_000_000n })
  ], [owner])

  const shopper = (mode: Mode = { kind: "Normal" }) => {
    const wallet = Keypair.generate()
    const usdc = tokenAccount(wallet.publicKey, 0n)
    const approve = new TransactionInstruction({
      programId: TOKEN_ID,
      keys: [
        { pubkey: usdc, isSigner: false, isWritable: true },
        { pubkey: program.vaultAuthority, isSigner: false, isWritable: false },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: false }
      ],
      data: Buffer.concat([Uint8Array.of(4), Buffer.from(new BigUint64Array([2n ** 64n - 1n]).buffer)])
    })
    send([
      approve,
      program.instruction("open", { wallet: wallet.publicKey, payer: feePayer.publicKey, config: program.config, customer: program.customer(wallet.publicKey) }, { default_mode: mode })
    ], [wallet])
    return { wallet, usdc }
  }

  const fill = (checkout: PublicKey, round: number, randomness: Uint8Array) => {
    const k = oraoRequest(checkout, round)
    const a = svm.getAccount(address(k.toBase58()))
    if (!a.exists) throw new Error("ORAO has no such request")
    const d = Buffer.from(a.data)
    // RandomnessV2::Fulfilled { client, seed, randomness }: client and seed sit where Pending kept them.
    const filled = Buffer.concat([d.subarray(0, 8), Uint8Array.of(1), d.subarray(9, 41), d.subarray(41, 73), Buffer.from(randomness)])
    svm.setAccount({ ...a, data: filled, space: BigInt(filled.length) })
  }

  const warp = (seconds: number) => {
    const c = svm.getClock()
    c.unixTimestamp += BigInt(seconds)
    c.slot += 1n
    svm.setClock(c)
  }

  const secret = (k: Keypair) => base58.encode(k.secretKey)
  return {
    svm,
    chain,
    program,
    owner,
    operator,
    feePayer,
    payWallet,
    mint,
    payWalletUsdc,
    env: {
      SOLANA_CLUSTER: "localnet",
      SOLANA_PROGRAM_ID: program.id.toBase58(),
      SOLANA_OPERATOR_SECRET_KEY: secret(operator),
      SOLANA_FEE_PAYER_SECRET_KEY: secret(feePayer),
      SOLANA_PAY_WALLET_SECRET_KEY: secret(payWallet)
    },
    send,
    tokenAccount,
    tokens,
    give,
    shopper,
    fill,
    warp,
    expire: () => {
      svm.expireBlockhash()
      height += 151
    }
  }
}

/** The Solana service over a world's LiteSVM chain, configured with its keys. */
export const solanaLayer = (world: SolanaWorld) =>
  Solana.layer.pipe(
    Layer.provide(Layer.succeed(Chain, world.chain)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(world.env)))
  )
