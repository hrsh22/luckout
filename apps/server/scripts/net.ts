// Shared flags for the scripts: --network testnet|mainnet (default testnet) and --contract (default
// that network's Luckout contract). Positional arguments stay the scripts' own (`args`).
import type { KeyPairString } from "near-api-js"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { parseArgs } from "node:util"

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { network: { type: "string", default: "testnet" }, contract: { type: "string" } }
})
if (values.network !== "testnet" && values.network !== "mainnet") throw new Error(`--network must be testnet or mainnet, not ${values.network}`)
const mainnet = values.network === "mainnet"

export const args = positionals
export const network = values.network
export const contract = values.contract ?? (mainnet ? "app.luckout.near" : "app.luckout.testnet")
export const rpcUrl = mainnet ? "https://rpc.mainnet.fastnear.com" : "https://test.rpc.fastnear.com"
export const usdc = mainnet ? "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" : "usdc.luckout.testnet"
export const intents = mainnet ? "intents.near" : "intents.luckout.testnet"
export const keyOf = (accountId: string) =>
  JSON.parse(readFileSync(`${homedir()}/.near-credentials/${network}/${accountId}.json`, "utf8")).private_key as KeyPairString

/** For scripts that need testnet-only things (Bitrefill's free test card, the test-USDC faucet). */
export const testnetOnly = (why: string) => {
  if (mainnet) throw new Error(`This script runs on testnet only: ${why}. On mainnet, run scripts/verify-mainnet.ts.`)
}
