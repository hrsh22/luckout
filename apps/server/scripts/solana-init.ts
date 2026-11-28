// Sets up a freshly deployed program (deploy/README.md): opens the Pay Wallet's USDC account and calls `initialize`,
// signed by the program's upgrade authority, who becomes the owner. Prints the result; changes nothing if the
// program is already set up. The owner's key is read from a file on this machine and never goes to the server.
//
//   RPC_URL=… PROGRAM_ID=… OWNER_KEY=~/.luckout/solana-staging-owner.json OPERATOR=<address> PAY_WALLET=<address> \
//     [GUARDIAN=<address>] node apps/server/scripts/solana-init.ts [--send]
//
// Without --send it only simulates, including an initialize with a token that isn't USDC, which a mainnet build
// must refuse. GUARDIAN names the key that can only pause (`solana-pause.ts`), here or on a program already set up.
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token"
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { decodeAccount, programAt, type Config } from "../src/Program.ts"
import { sendAndWait } from "./send.ts"

const need = (k: string) => process.env[k] || (() => { throw new Error(`set ${k}`) })()
const USDC = new PublicKey(process.env.USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
const conn = new Connection(need("RPC_URL"), "confirmed")
const program = programAt(new PublicKey(need("PROGRAM_ID")))
const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(need("OWNER_KEY").replace(/^~/, homedir()), "utf8"))))
const operator = new PublicKey(need("OPERATOR"))
const payWallet = new PublicKey(need("PAY_WALLET"))
const guardian = process.env.GUARDIAN ? new PublicKey(process.env.GUARDIAN) : undefined
const send = process.argv.includes("--send")
// Mainnet drops transactions without a priority fee when it's busy.
const price = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(process.env.MICROLAMPORTS ?? 20_000) })

const initialize = (mint: PublicKey) =>
  program.instruction("initialize", {
    owner: owner.publicKey,
    config: program.config,
    vault_authority: program.vaultAuthority,
    vault: program.vault,
    usdc_mint: mint,
    pay_wallet: getAssociatedTokenAddressSync(mint, payWallet),
    program: program.id,
    program_data: program.programData
  }, { operator })
const openPayWallet = (mint: PublicKey) => createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, getAssociatedTokenAddressSync(mint, payWallet), payWallet, mint)

const simulate = async (ixs: Array<TransactionInstruction>) => {
  const tx = new Transaction().add(price, ...ixs)
  tx.feePayer = owner.publicKey
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash
  tx.sign(owner)
  const r = await conn.simulateTransaction(tx)
  return r.value.err ? `refused: ${(r.value.logs ?? []).find((l) => /Error Message|failed/.test(l)) ?? JSON.stringify(r.value.err)}` : "ok"
}

const info = await conn.getAccountInfo(program.id)
if (!info?.executable) throw new Error(`no program at ${program.id.toBase58()}: deploy it first`)
const pd = await conn.getAccountInfo(program.programData)
const authority = pd && pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)) : undefined
console.log(`program ${program.id.toBase58()}, upgrade authority ${authority?.toBase58() ?? "none"}`)
if (!authority?.equals(owner.publicKey)) throw new Error(`OWNER_KEY is ${owner.publicKey.toBase58()}, not the upgrade authority`)
console.log(`owner ${owner.publicKey.toBase58()} has ${(await conn.getBalance(owner.publicKey)) / 1e9} SOL`)

const existing = await conn.getAccountInfo(program.config)
if (!existing) {
  // A made-up mint: a mainnet build must refuse anything but USDC.
  if (USDC.equals(new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"))) {
    const fake = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB") // USDT
    console.log(`initialize with USDT instead of USDC: ${await simulate([openPayWallet(fake), initialize(fake)])}`)
  }
  console.log(`initialize with USDC: ${await simulate([openPayWallet(USDC), initialize(USDC)])}`)
  if (!send) process.exit(0)
  const sig = await sendAndWait(conn, [price, openPayWallet(USDC), initialize(USDC)], [owner])
  console.log(`initialized: ${sig}`)
}
let config = decodeAccount<Config>("Config", (await conn.getAccountInfo(program.config))!.data)
if (guardian && !config.guardian.equals(guardian)) {
  const name = program.instruction("set_guardian", { owner: owner.publicKey, config: program.config }, { guardian })
  console.log(`name the guardian ${guardian.toBase58()}: ${await simulate([name])}`)
  if (send) {
    console.log(`guardian named: ${await sendAndWait(conn, [price, name], [owner])}`)
    config = decodeAccount<Config>("Config", (await conn.getAccountInfo(program.config))!.data)
  }
}
console.log({
  owner: config.owner.toBase58(),
  operator: config.operator.toBase58(),
  usdc: config.usdc_mint.toBase58(),
  vault: config.vault.toBase58(),
  payWalletUsdc: config.pay_wallet.toBase58(),
  paused: config.paused,
  guardian: config.guardian.equals(PublicKey.default) ? null : config.guardian.toBase58(),
  minLuckyCheckout: Number(config.min_lucky_checkout) / 1e6,
  repayDailyCap: Number(config.repay_daily_cap) / 1e6
})
