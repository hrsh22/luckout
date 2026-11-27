// Checks an owner transaction before the owner's wallet sees it. The server builds every one (only it can have our fee
// payer co-sign), so a server that was broken into could otherwise slip its own key in as the new owner, operator or
// Pay Wallet, or add an instruction of its own that the owner's signature would carry. Each one must be exactly the
// instruction the admin asked for, to the program this site was built for, with nothing else but compute settings and
// the opening of a USDC account at our fee payer's cost. No `@/` imports, so `node --test` can load it.

import type { OwnerAction } from "@luckout/api"
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token"
import { address, getAddressEncoder, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit"

/** The program this site was built for: NEXT_PUBLIC_SOLANA_PROGRAM_ID, or the devnet program the IDL names. */
export const PROGRAM_ID = process.env.NEXT_PUBLIC_SOLANA_PROGRAM_ID || "4Tziwbh1vEDremxPViXgEa91FP3Nv4hUyNmLXMzRK2Z3"

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111"

const u64 = (n: number) => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true)
  return [...b]
}
const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]
const key = (a: string) => [...getAddressEncoder().encode(address(a))]
const option = (bytes: Array<number> | undefined) => (bytes ? [1, ...bytes] : [0])

/** The instruction's data, as Anchor codes it: sha256("global:<name>")'s first 8 bytes, then the arguments in Borsh. */
export async function instructionData(action: OwnerAction): Promise<Uint8Array> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${action._tag}`)))
  const args = action._tag === "set_paused"
    ? [action.paused ? 1 : 0]
    : action._tag === "set_cashback_cap"
    ? [...option(action.fixed === null ? undefined : u64(action.fixed)), ...u32(action.reserveBps)]
    : action._tag === "set_repay_cap"
    ? u64(action.daily)
    : action._tag === "set_min_lucky_checkout" || action._tag === "fund_reserve" || action._tag === "withdraw_reserve" || action._tag === "withdraw_proceeds"
    ? u64(action.amount)
    : action._tag === "set_operator"
    ? key(action.operator)
    : action._tag === "propose_owner"
    ? option(action.newOwner === null ? undefined : key(action.newOwner))
    : [] // set_pay_wallet and accept_owner take none
  return Uint8Array.from([...hash.subarray(0, 8), ...args])
}

const same = (a: ArrayLike<number> | undefined, b: ArrayLike<number>) => !!a && a.length === b.length && Array.from(b).every((x, i) => a[i] === x)

/**
 * Why `transaction` (base64, as the server prepared it) isn't safe for `signer` to sign for `action`, or undefined if it
 * is. `mint` is the program's USDC, for the Pay Wallet's USDC account.
 */
export async function ownerTxProblem(transaction: string, action: OwnerAction, signer: string, mint: string): Promise<string | undefined> {
  const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Encoder().encode(transaction)).messageBytes)
  // Ours are legacy: every account in plain sight, none from a lookup table.
  if (message.version !== "legacy") return "it isn't a plain transaction"
  const keys = message.staticAccounts
  if (keys[0] === signer) return "it would make your wallet pay its fee"
  const ours = message.instructions.filter((ix) => keys[ix.programAddressIndex] === PROGRAM_ID)
  for (const ix of message.instructions) {
    const program = keys[ix.programAddressIndex]
    if (program === PROGRAM_ID || program === COMPUTE_BUDGET) continue
    // Opening a USDC account (CreateIdempotent), funded by our fee payer.
    if (program === ASSOCIATED_TOKEN_PROGRAM_ADDRESS && same(ix.data, [1]) && keys[ix.accountIndices?.[0] ?? -1] === keys[0]) continue
    return `it also calls ${program}`
  }
  if (ours.length !== 1) return `it has ${ours.length} instructions for the program, not 1`
  const ix = ours[0]!
  if (!same(ix.data, await instructionData(action))) return "its instruction isn't the one you asked for"
  const accounts = (ix.accountIndices ?? []).map((i) => keys[i])
  if (accounts[0] !== signer) return "it's for another signer"
  if (action._tag === "set_pay_wallet") {
    const [usdc] = await findAssociatedTokenPda({ owner: address(action.payWallet), mint: address(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS })
    if (accounts[2] !== usdc) return "it names another Pay Wallet"
  }
  return undefined
}
