// Phase 1's last check (docs/solana-migration.md): a 15-card Lucky Checkout on devnet, settled and drawn from
// ORAO's devnet oracles. Uses the program deployed at the IDL's address and a test USDC mint of our own.
// Keys and state live in ~/.luckout (solana-devnet-*.json), never in the repo. Run after `anchor build`:
//   node apps/server/scripts/solana-devnet.ts
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
  sendAndConfirmTransaction
} from "@solana/web3.js"
import {
  createAccount,
  createApproveInstruction,
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo
} from "@solana/spl-token"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"

const idl = JSON.parse(readFileSync(new URL("../../../programs/target/idl/luckout.json", import.meta.url), "utf8"))
const PROGRAM = new PublicKey(idl.address)
const VRF = new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y")
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")
const USDC = 1_000_000n
const conn = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed")
const dir = `${homedir()}/.luckout`
const statePath = `${dir}/solana-devnet-state.json`
const state: Record<string, string> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {}
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 })

function key(name: string): Keypair {
  const path = `${dir}/solana-devnet-${name}.json`
  if (!existsSync(path)) writeFileSync(path, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 })
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))))
}
const pda = (...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0]

// Borsh, enough for our instructions.
const u8 = (n: number) => Buffer.from([n])
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
const vec = (items: Buffer[]) => Buffer.concat([u32(items.length), ...items])
const option = (b?: Buffer) => (b ? Buffer.concat([u8(1), b]) : u8(0))
type Mode = "normal" | { lucky: number }
const mode = (m: Mode) => (m === "normal" ? u8(0) : Buffer.concat([u8(1), u32(m.lucky)]))

/** Builds an instruction from the IDL: accounts by name, a missing optional one as the program id. */
function ix(name: string, accounts: Record<string, PublicKey | undefined>, args: Buffer = Buffer.alloc(0)): TransactionInstruction {
  const def = idl.instructions.find((i: { name: string }) => i.name === name)
  const keys = def.accounts.map((a: { name: string; writable?: boolean; signer?: boolean; optional?: boolean; address?: string }) => {
    const pubkey = accounts[a.name] ?? (a.address ? new PublicKey(a.address) : a.optional ? PROGRAM : undefined)
    if (!pubkey) throw new Error(`${name}: no ${a.name}`)
    return { pubkey, isWritable: !!a.writable && !pubkey.equals(PROGRAM), isSigner: !!a.signer }
  })
  return { programId: PROGRAM, keys, data: Buffer.concat([Buffer.from(def.discriminator), args]) }
}

async function send(ixs: TransactionInstruction[], signers: Keypair[], label: string) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs)
  const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" })
  const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
  console.log(`${label}: ${sig} (${t?.meta?.computeUnitsConsumed} CU)`)
  return sig
}

/** Balance, and the next Checkout number, from a Customer account (its Default Mode is 1 or 5 bytes). */
async function customerState(k: PublicKey) {
  const d = (await conn.getAccountInfo(k))!.data
  const after = 66 + (d[66] === 0 ? 1 : 5)
  return { balance: d.readBigUInt64LE(42), cashback: d.readBigUInt64LE(after + 24), checkouts: d.readBigUInt64LE(after + 32) }
}

const owner = key("deployer") // owner, upgrade authority and fee payer
const operator = key("operator")
const shopper = key("customer")
const payWalletOwner = key("pay-wallet")
const config = pda(Buffer.from("config"))
const vaultAuthority = pda(Buffer.from("vault"))
const vault = pda(Buffer.from("vault-usdc"))
const customer = pda(Buffer.from("customer"), shopper.publicKey.toBuffer())
const networkState = PublicKey.findProgramAddressSync([Buffer.from("orao-vrf-network-configuration")], VRF)[0]

console.log(`program ${PROGRAM.toBase58()}, owner ${owner.publicKey.toBase58()} (${(await conn.getBalance(owner.publicKey)) / 1e9} SOL)`)
if (!(await conn.getAccountInfo(PROGRAM))?.executable) throw new Error("Deploy the program first")

if (!state.mint) state.mint = (await createMint(conn, owner, owner.publicKey, null, 6)).toBase58()
const mint = new PublicKey(state.mint)
if (!state.payWallet) state.payWallet = (await createAccount(conn, owner, mint, payWalletOwner.publicKey, Keypair.generate())).toBase58()
const payWallet = new PublicKey(state.payWallet)
save()

if (!(await conn.getAccountInfo(config))) {
  const programData = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], LOADER)[0]
  await send([ix("initialize", { owner: owner.publicKey, config, vault_authority: vaultAuthority, vault, usdc_mint: mint, pay_wallet: payWallet, program: PROGRAM, program_data: programData }, operator.publicKey.toBuffer())], [owner], "initialize")
  const ownerUsdc = await getOrCreateAssociatedTokenAccount(conn, owner, mint, owner.publicKey)
  await mintTo(conn, owner, mint, ownerUsdc.address, owner, 1_000n * USDC)
  await send([ix("fund_reserve", { owner: owner.publicKey, config, from: ownerUsdc.address, vault }, u64(1_000n * USDC))], [owner], "fund reserve")
}

// The customer's one-time approval and their account, then money arriving at the Deposit Address.
const deposit = await getOrCreateAssociatedTokenAccount(conn, owner, mint, shopper.publicKey)
if (!(await conn.getAccountInfo(customer))) {
  await send(
    [
      createApproveInstruction(deposit.address, vaultAuthority, shopper.publicKey, 2n ** 64n - 1n),
      ix("open", { wallet: shopper.publicKey, payer: owner.publicKey, config, customer }, mode({ lucky: 1 }))
    ],
    [owner, shopper],
    "approve + open"
  )
}
await mintTo(conn, owner, mint, deposit.address, owner, 120n * USDC)
await send([ix("deposit_for", { config, customer, source: deposit.address, vault, vault_authority: vaultAuthority })], [owner], "deposit_for")

// 15 cards of 6 USDC on the Default Mode (Classic).
const before = await customerState(customer)
const number = before.checkouts
const checkout = pda(Buffer.from("checkout"), shopper.publicKey.toBuffer(), u64(number))
const cards = Array.from({ length: 15 }, () => Buffer.concat([u64(6n * USDC), option(), u64(2n ** 64n - 1n), option()]))
await send([ix("admit", { operator: operator.publicKey, payer: owner.publicKey, config, customer, checkout }, Buffer.concat([u64(number), vec(cards)]))], [owner, operator], "admit 15 cards")

const seed = createHash("sha256").update(Buffer.concat([Buffer.from("luckout-draw"), checkout.toBuffer(), u8(0)])).digest()
const request = PublicKey.findProgramAddressSync([Buffer.from("orao-vrf-randomness-request"), seed], VRF)[0]
const treasury = new PublicKey((await conn.getAccountInfo(networkState))!.data.subarray(40, 72))
const all = Buffer.from([...Array(15).keys()])
const settled = Date.now()
await send(
  [ix("settle", { operator: operator.publicKey, payer: owner.publicKey, config, customer, checkout, vault, vault_authority: vaultAuthority, pay_wallet: payWallet, checkout_payer: owner.publicKey, vrf: VRF, network_state: networkState, treasury, request }, Buffer.concat([vec([...all].map(u8)), vec([])]))],
  [owner, operator],
  "settle (15 delivered, ORAO request)"
)
console.log(`Pay Wallet now holds ${(await getAccount(conn, payWallet)).amount / USDC} USDC`)

// ORAO's oracles fill the request in by themselves; anyone then finishes the Draw.
for (;;) {
  const d = (await conn.getAccountInfo(request))?.data
  if (d && d[8] === 1) break
  if (Date.now() - settled > 120_000) throw new Error("ORAO didn't fill the request in 2 minutes")
  await new Promise((r) => setTimeout(r, 1_000))
}
console.log(`ORAO filled the request in ${((Date.now() - settled) / 1000).toFixed(1)} s`)
await send(
  [ix("finish_draw", { config, customer, checkout, randomness: request, checkout_payer: owner.publicKey, event_authority: pda(Buffer.from("__event_authority")), program: PROGRAM }, u8(0))],
  [owner],
  "finish 15 Draws"
)
const after = await customerState(customer)
console.log(`cashback ${(after.cashback - before.cashback)} base units; Checkout closed: ${!(await conn.getAccountInfo(checkout))}`)
