import type { OwnerAction } from "@luckout/api"
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token"
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64Decoder,
  getTransactionEncoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash
} from "@solana/kit"
import assert from "node:assert/strict"
import { test } from "node:test"
// The server's own encoder, driven by the program's IDL: what the panel accepts must be what the server builds.
import { IDL_PROGRAM_ID, programAt } from "../../server/src/Program.ts"
import { ownerTxProblem, PROGRAM_ID } from "./owner-tx.ts"

type Ix = ReturnType<ReturnType<typeof programAt>["instruction"]>
const Key = IDL_PROGRAM_ID.constructor as new (s: string) => typeof IDL_PROGRAM_ID
const program = programAt(new Key(PROGRAM_ID))

// Real keys that are nobody's wallet.
const owner = "Vote111111111111111111111111111111111111111"
const feePayer = "Stake11111111111111111111111111111111111111"
const attacker = "SysvarC1ock11111111111111111111111111111111"
const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"

const role = (k: Ix["keys"][number]) =>
  k.isSigner ? (k.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : k.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY
const kit = (ix: Ix): Instruction => ({
  programAddress: address(ix.programId.toBase58()),
  accounts: ix.keys.map((k) => ({ address: address(k.pubkey.toBase58()), role: role(k) })),
  data: new Uint8Array(ix.data)
})
const raw = (programAddress: string, accounts: ReadonlyArray<[string, AccountRole]>, data: ReadonlyArray<number>): Instruction => ({
  programAddress: address(programAddress),
  accounts: accounts.map(([a, r]) => ({ address: address(a), role: r })),
  data: Uint8Array.from(data)
})
const computeLimit = raw("ComputeBudget111111111111111111111111111111", [], [2, 0x80, 0x1a, 0x06, 0])
const openUsdc = (funder: string, wallet: string, usdc: string) =>
  raw("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", [
    [funder, AccountRole.WRITABLE_SIGNER],
    [usdc, AccountRole.WRITABLE],
    [wallet, AccountRole.READONLY],
    [mint, AccountRole.READONLY],
    ["11111111111111111111111111111111", AccountRole.READONLY],
    [tokenProgram, AccountRole.READONLY]
  ], [1])

/** A transaction as the server's `prepare` makes it, base64. */
const wire = (ixs: ReadonlyArray<Instruction>, payer = owner) =>
  getBase64Decoder().decode(getTransactionEncoder().encode(compileTransaction(pipe(
    createTransactionMessage({ version: "legacy" }),
    (m) => setTransactionMessageFeePayer(address(payer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k" as Blockhash, lastValidBlockHeight: 0n }, m),
    (m) => appendTransactionMessageInstructions([computeLimit, ...ixs], m)
  ))))

const k = (a: string) => new Key(a)
const ownerOnly = { owner: k(owner), config: program.config }
const payout = (amount: number) => program.instruction("withdraw_reserve", { ...ownerOnly, vault: program.vault, vault_authority: program.vaultAuthority, to: k(attacker) }, { amount: BigInt(amount) })

const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111"
/** An upgrade as Admin.ts builds it. */
const upgrade = (o: { buffer?: string; spill?: string; authority?: string; programData?: string; data?: ReadonlyArray<number> } = {}) =>
  raw(LOADER, [
    [o.programData ?? program.programData.toBase58(), AccountRole.WRITABLE],
    [PROGRAM_ID, AccountRole.WRITABLE],
    [o.buffer ?? attacker, AccountRole.WRITABLE],
    [o.spill ?? owner, AccountRole.WRITABLE],
    ["SysvarRent111111111111111111111111111111111", AccountRole.READONLY],
    ["SysvarC1ock11111111111111111111111111111111", AccountRole.READONLY],
    [o.authority ?? owner, AccountRole.READONLY_SIGNER]
  ], o.data ?? [3, 0, 0, 0])

test("every owner action the server builds passes, byte for byte", async () => {
  const [payWalletUsdc] = await findAssociatedTokenPda({ owner: address(attacker), mint: address(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const cases: ReadonlyArray<[OwnerAction, ReadonlyArray<Instruction>]> = [
    [{ _tag: "set_paused", paused: true }, [kit(program.instruction("set_paused", ownerOnly, { paused: true }))]],
    [{ _tag: "set_paused", paused: false }, [kit(program.instruction("set_paused", ownerOnly, { paused: false }))]],
    [{ _tag: "set_cashback_cap", fixed: 50_000_000, reserveBps: 2_000 }, [kit(program.instruction("set_cashback_cap", ownerOnly, { fixed: 50_000_000n, reserve_bps: 2_000 }))]],
    [{ _tag: "set_cashback_cap", fixed: null, reserveBps: 5_000 }, [kit(program.instruction("set_cashback_cap", ownerOnly, { fixed: null, reserve_bps: 5_000 }))]],
    [{ _tag: "set_repay_cap", daily: 500_000_000 }, [kit(program.instruction("set_repay_cap", ownerOnly, { daily: 500_000_000n }))]],
    [{ _tag: "set_min_lucky_checkout", amount: 2_500_000 }, [kit(program.instruction("set_min_lucky_checkout", ownerOnly, { amount: 2_500_000n }))]],
    [{ _tag: "fund_reserve", amount: 7 }, [kit(program.instruction("fund_reserve", { ...ownerOnly, from: k(attacker), vault: program.vault }, { amount: 7n }))]],
    [{ _tag: "withdraw_reserve", amount: 2 ** 40 }, [openUsdc(owner, owner, attacker), kit(payout(2 ** 40))]],
    [{ _tag: "set_operator", operator: attacker }, [kit(program.instruction("set_operator", ownerOnly, { operator: k(attacker) }))]],
    [{ _tag: "set_pay_wallet", payWallet: attacker }, [openUsdc(owner, attacker, payWalletUsdc), kit(program.instruction("set_pay_wallet", { ...ownerOnly, pay_wallet: k(payWalletUsdc) }))]],
    [{ _tag: "propose_owner", newOwner: attacker }, [kit(program.instruction("propose_owner", ownerOnly, { new_owner: k(attacker) }))]],
    [{ _tag: "propose_owner", newOwner: null }, [kit(program.instruction("propose_owner", ownerOnly, { new_owner: null }))]],
    [{ _tag: "accept_owner" }, [kit(program.instruction("accept_owner", { new_owner: k(owner), config: program.config }))]],
    [{ _tag: "set_guardian", guardian: attacker }, [kit(program.instruction("set_guardian", ownerOnly, { guardian: k(attacker) }))]],
    [{ _tag: "set_guardian", guardian: null }, [kit(program.instruction("set_guardian", ownerOnly, { guardian: null }))]],
    [{ _tag: "upgrade", buffer: attacker }, [upgrade()]]
  ]
  for (const [action, ixs] of cases) assert.equal(await ownerTxProblem(wire(ixs), action, owner, mint), undefined, action._tag)
  const withdraw = kit(program.instruction("withdraw_proceeds", { ...ownerOnly, vault: program.vault, vault_authority: program.vaultAuthority, to: k(attacker) }, { amount: 5n }))
  assert.equal(await ownerTxProblem(wire([withdraw]), { _tag: "withdraw_proceeds", amount: 5, to: "payWallet" }, owner, mint), undefined)
})

test("a transaction that isn't exactly what the admin asked for is refused before the wallet sees it", async () => {
  const pause = kit(program.instruction("set_paused", ownerOnly, { paused: true }))
  const refuse = async (ixs: ReadonlyArray<Instruction>, action: OwnerAction, match: RegExp, payer = owner) =>
    assert.match((await ownerTxProblem(wire(ixs, payer), action, owner, mint)) ?? "passed", match)

  await refuse([kit(program.instruction("set_operator", ownerOnly, { operator: k(attacker) }))], { _tag: "set_operator", operator: feePayer }, /isn't the one you asked for/)
  await refuse([kit(program.instruction("propose_owner", ownerOnly, { new_owner: k(attacker) }))], { _tag: "propose_owner", newOwner: null }, /isn't the one you asked for/)
  await refuse([pause], { _tag: "set_paused", paused: false }, /isn't the one you asked for/)
  await refuse([kit(payout(100))], { _tag: "withdraw_reserve", amount: 10 }, /isn't the one you asked for/)
  // The owner's signature carried into a transfer of their own USDC, or into a look-alike program.
  await refuse([pause, raw(tokenProgram, [[attacker, AccountRole.WRITABLE], [feePayer, AccountRole.WRITABLE], [owner, AccountRole.READONLY_SIGNER]], [3, 1, 0, 0, 0, 0, 0, 0, 0])], { _tag: "set_paused", paused: true }, /also calls Tokenkeg/)
  await refuse([{ ...pause, programAddress: address(attacker) }], { _tag: "set_paused", paused: true }, /also calls SysvarC1ock/)
  await refuse([openUsdc(attacker, owner, attacker), kit(payout(10))], { _tag: "withdraw_reserve", amount: 10 }, /also calls ATokenGP/)
  await refuse([pause, pause], { _tag: "set_paused", paused: true }, /2 instructions/)
  await refuse([pause], { _tag: "set_paused", paused: true }, /another wallet pay its fee/, feePayer)
  // The owner's wallet signs alone: a second signer could be anyone's key the server holds.
  await refuse([pause, raw("ComputeBudget111111111111111111111111111111", [[attacker, AccountRole.READONLY_SIGNER]], [2, 0x80, 0x1a, 0x06, 0])], { _tag: "set_paused", paused: true }, /besides your wallet's/)
  await refuse([kit(program.instruction("set_pay_wallet", { ...ownerOnly, pay_wallet: k(feePayer) }))], { _tag: "set_pay_wallet", payWallet: attacker }, /another Pay Wallet/)
  await refuse([kit(program.instruction("set_paused", { owner: k(attacker), config: program.config }, { paused: true }))], { _tag: "set_paused", paused: true }, /another signer/)
  // An upgrade must be exactly one upgrade of this program, from the buffer the admin checked.
  const up = { _tag: "upgrade", buffer: attacker } as const
  await refuse([upgrade({ buffer: feePayer })], up, /another buffer/)
  await refuse([upgrade({ spill: feePayer })], up, /rent elsewhere/)
  await refuse([upgrade({ authority: feePayer })], up, /another signer/)
  await refuse([upgrade({ programData: feePayer })], up, /another program/)
  await refuse([upgrade({ data: [4, 0, 0, 0] })], up, /isn't one upgrade/)
  await refuse([upgrade(), raw(tokenProgram, [[attacker, AccountRole.WRITABLE], [feePayer, AccountRole.WRITABLE], [owner, AccountRole.READONLY_SIGNER]], [3, 1, 0, 0, 0, 0, 0, 0, 0])], up, /isn't one upgrade/)
  await refuse([upgrade()], up, /another wallet pay its fee/, feePayer)
})
