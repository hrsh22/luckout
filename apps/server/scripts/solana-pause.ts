// Pauses the program at once with the guardian's key (ADR-0015, deploy/README.md): new Checkouts stop, while settling,
// Draws, Reclaims, deposits and withdrawals go on. Only the owner resumes, from the Admin panel. The guardian pays
// this transaction's fee, so it holds a little SOL.
//
//   RPC_URL=… PROGRAM_ID=… GUARDIAN_KEY=~/.luckout/solana-staging-guardian.json node apps/server/scripts/solana-pause.ts
import { ComputeBudgetProgram, Connection, Keypair, PublicKey } from "@solana/web3.js"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { decodeAccount, programAt, type Config } from "../src/Program.ts"
import { sendAndWait } from "./send.ts"

const need = (k: string) => process.env[k] || (() => { throw new Error(`set ${k}`) })()
const conn = new Connection(need("RPC_URL"), "confirmed")
const program = programAt(new PublicKey(need("PROGRAM_ID")))
const guardian = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(need("GUARDIAN_KEY").replace(/^~/, homedir()), "utf8"))))
const config = async () => decodeAccount<Config>("Config", (await conn.getAccountInfo(program.config))!.data)

const before = await config()
if (!before.guardian.equals(guardian.publicKey) && !before.owner.equals(guardian.publicKey)) {
  throw new Error(`${guardian.publicKey.toBase58()} isn't the guardian (${before.guardian.toBase58()}) or the owner`)
}
if (before.paused) {
  console.log("already paused")
  process.exit(0)
}
// Mainnet drops transactions without a priority fee when it's busy; a pause pays more to land first.
const price = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(process.env.MICROLAMPORTS ?? 200_000) })
const sig = await sendAndWait(conn, [price, program.instruction("pause", { guardian: guardian.publicKey, config: program.config })], [guardian])
console.log(`paused: ${sig}, now ${(await config()).paused ? "paused" : "NOT paused"}`)
