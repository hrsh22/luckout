/**
 * The Luckout program's interface (ADR-0015), driven by its IDL (programs/idl/luckout.json, copied from
 * `anchor build`): instruction builders, account and event decoders, error messages, and the addresses the
 * program derives. Borsh coding is done here, for the types the IDL uses.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

type IdlType = string | { vec: IdlType } | { option: IdlType } | { array: [IdlType, number] } | { defined: { name: string } }
interface IdlField { readonly name: string; readonly type: IdlType }
interface IdlTypeDef {
  readonly name: string
  readonly type:
    | { readonly kind: "struct"; readonly fields?: ReadonlyArray<IdlField> }
    | { readonly kind: "enum"; readonly variants: ReadonlyArray<{ readonly name: string; readonly fields?: ReadonlyArray<IdlType | IdlField> }> }
}
interface IdlInstruction {
  readonly name: string
  readonly discriminator: ReadonlyArray<number>
  readonly accounts: ReadonlyArray<{ readonly name: string; readonly writable?: boolean; readonly signer?: boolean; readonly optional?: boolean; readonly address?: string }>
  readonly args: ReadonlyArray<IdlField>
  readonly returns?: IdlType
}
interface Idl {
  readonly address: string
  readonly instructions: ReadonlyArray<IdlInstruction>
  readonly accounts: ReadonlyArray<{ readonly name: string; readonly discriminator: ReadonlyArray<number> }>
  readonly events: ReadonlyArray<{ readonly name: string; readonly discriminator: ReadonlyArray<number> }>
  readonly errors: ReadonlyArray<{ readonly code: number; readonly name: string; readonly msg?: string }>
  readonly types: ReadonlyArray<IdlTypeDef>
}

export const idl: Idl = JSON.parse(readFileSync(new URL("../../../programs/idl/luckout.json", import.meta.url), "utf8"))
const types = new Map(idl.types.map((t) => [t.name, t]))

/** An enum value: its variant, and the variant's fields (a tuple or a struct) if it has any. */
export interface Variant { readonly kind: string; readonly fields?: ReadonlyArray<unknown> | Readonly<Record<string, unknown>> }

const INT: Record<string, [bytes: number, big: boolean]> = {
  u8: [1, false], u16: [2, false], u32: [4, false], i32: [4, false], u64: [8, true], i64: [8, true], u128: [16, true]
}

export const encode = (type: IdlType, value: unknown, out: Array<Uint8Array>): void => {
  if (typeof type === "string") {
    const int = INT[type]
    if (int) {
      const b = Buffer.alloc(int[0])
      if (type === "u8") b.writeUInt8(Number(value))
      else if (type === "u16") b.writeUInt16LE(Number(value))
      else if (type === "u32") b.writeUInt32LE(Number(value))
      else if (type === "i32") b.writeInt32LE(Number(value))
      else if (type === "u64") b.writeBigUInt64LE(BigInt(value as bigint))
      else if (type === "i64") b.writeBigInt64LE(BigInt(value as bigint))
      else { b.writeBigUInt64LE(BigInt(value as bigint) & 0xffffffffffffffffn); b.writeBigUInt64LE(BigInt(value as bigint) >> 64n, 8) }
      out.push(b)
    } else if (type === "bool") out.push(Uint8Array.of(value ? 1 : 0))
    else if (type === "pubkey") out.push((value as PublicKey).toBuffer())
    else if (type === "string" || type === "bytes") {
      const bytes = type === "string" ? Buffer.from(value as string) : Buffer.from(value as Uint8Array)
      encode("u32", bytes.length, out)
      out.push(bytes)
    } else throw new Error(`IDL type ${type} isn't supported`)
  } else if ("vec" in type) {
    const items = value as ReadonlyArray<unknown>
    encode("u32", items.length, out)
    for (const item of items) encode(type.vec, item, out)
  } else if ("option" in type) {
    if (value === null || value === undefined) out.push(Uint8Array.of(0))
    else { out.push(Uint8Array.of(1)); encode(type.option, value, out) }
  } else if ("array" in type) {
    const [inner, len] = type.array
    if (inner === "u8") {
      const bytes = Buffer.from(value as Uint8Array)
      if (bytes.length !== len) throw new Error(`expected ${len} bytes, got ${bytes.length}`)
      out.push(bytes)
    } else for (const item of value as ReadonlyArray<unknown>) encode(inner, item, out)
  } else {
    const def = types.get(type.defined.name)
    if (!def) throw new Error(`IDL type ${type.defined.name} is missing`)
    if (def.type.kind === "struct") {
      for (const f of def.type.fields ?? []) encode(f.type, (value as Record<string, unknown>)[f.name], out)
    } else {
      const v = value as Variant
      const i = def.type.variants.findIndex((x) => x.name === v.kind)
      if (i < 0) throw new Error(`${def.name} has no variant ${v.kind}`)
      out.push(Uint8Array.of(i))
      const fields = def.type.variants[i]!.fields ?? []
      fields.forEach((f, j) =>
        typeof f === "object" && "name" in f
          ? encode(f.type, (v.fields as Record<string, unknown>)[f.name], out)
          : encode(f as IdlType, (v.fields as ReadonlyArray<unknown>)[j], out)
      )
    }
  }
}

class Reader {
  at = 0
  readonly buf: Buffer
  constructor(buf: Buffer) {
    this.buf = buf
  }
  take(n: number) {
    if (this.at + n > this.buf.length) throw new Error("account data is too short")
    const b = this.buf.subarray(this.at, this.at + n)
    this.at += n
    return b
  }
}

export const decode = (type: IdlType, r: Reader): unknown => {
  if (typeof type === "string") {
    const int = INT[type]
    if (int) {
      const b = r.take(int[0])
      if (type === "u8") return b.readUInt8()
      if (type === "u16") return b.readUInt16LE()
      if (type === "u32") return b.readUInt32LE()
      if (type === "i32") return b.readInt32LE()
      if (type === "u64") return b.readBigUInt64LE()
      if (type === "i64") return b.readBigInt64LE()
      return b.readBigUInt64LE() | (b.readBigUInt64LE(8) << 64n)
    }
    if (type === "bool") return r.take(1)[0] === 1
    if (type === "pubkey") return new PublicKey(r.take(32))
    if (type === "string" || type === "bytes") {
      const bytes = Buffer.from(r.take(r.take(4).readUInt32LE()))
      return type === "string" ? bytes.toString("utf8") : bytes
    }
    throw new Error(`IDL type ${type} isn't supported`)
  }
  if ("vec" in type) return Array.from({ length: r.take(4).readUInt32LE() }, () => decode(type.vec, r))
  if ("option" in type) return r.take(1)[0] === 1 ? decode(type.option, r) : null
  if ("array" in type) {
    const [inner, len] = type.array
    return inner === "u8" ? Buffer.from(r.take(len)) : Array.from({ length: len }, () => decode(inner, r))
  }
  const def = types.get(type.defined.name)
  if (!def) throw new Error(`IDL type ${type.defined.name} is missing`)
  if (def.type.kind === "struct") return Object.fromEntries((def.type.fields ?? []).map((f) => [f.name, decode(f.type, r)]))
  const variant = def.type.variants[r.take(1)[0]!]
  if (!variant) throw new Error(`${def.name}: unknown variant`)
  const fields = variant.fields ?? []
  if (fields.length === 0) return { kind: variant.name }
  const named = typeof fields[0] === "object" && "name" in fields[0]
  return {
    kind: variant.name,
    fields: named
      ? Object.fromEntries((fields as ReadonlyArray<IdlField>).map((f) => [f.name, decode(f.type, r)]))
      : (fields as ReadonlyArray<IdlType>).map((f) => decode(f, r))
  }
}

const decodeWith = (type: IdlType, data: Uint8Array) => decode(type, new Reader(Buffer.from(data)))

// ---------- the program's types, as decoded ----------

/** Normal, or Lucky on a Game Version. */
export type Mode = { readonly kind: "Normal" } | { readonly kind: "Lucky"; readonly fields: readonly [number] }
export const normal: Mode = { kind: "Normal" }
export const lucky = (version: number): Mode => ({ kind: "Lucky", fields: [version] })
export const gameVersionOf = (m: Mode) => (m.kind === "Lucky" ? m.fields[0] : undefined)

export type CardStatus = "Pending" | "Drawing" | "Delivered" | "Failed" | "Reclaimed"

export interface Card {
  readonly mode: Mode
  readonly reference_price: bigint
  readonly lucky_amount: bigint
  readonly max_price: bigint
  readonly locked: bigint
  readonly status: { readonly kind: CardStatus }
  readonly cashback: bigint
  readonly round: number
}

export interface GameVersion {
  readonly name: string
  readonly premium_bps: number
  readonly outcomes: ReadonlyArray<{ readonly final_bps: number; readonly chance_bps: number }>
}

export interface Config {
  readonly layout: number
  readonly owner: PublicKey
  readonly pending_owner: PublicKey | null
  readonly operator: PublicKey
  readonly usdc_mint: PublicKey
  readonly vault: PublicKey
  readonly pay_wallet: PublicKey
  readonly paused: boolean
  readonly cashback_cap: { readonly fixed: bigint | null; readonly reserve_bps: number }
  readonly min_lucky_checkout: bigint
  readonly free_reserve: bigint
  readonly locked_reserve: bigint
  readonly proceeds: bigint
  readonly repay_daily_cap: bigint
  readonly repay_day: bigint
  readonly repaid_today: bigint
  readonly lucky_settled: bigint
  readonly lucky_amount_total: bigint
  readonly lucky_paid_total: bigint
  readonly versions: ReadonlyArray<GameVersion>
}

export interface Customer {
  readonly layout: number
  readonly wallet: PublicKey
  readonly balance: bigint
  readonly per_purchase_limit: bigint
  readonly daily_limit: bigint
  readonly default_mode: Mode
  readonly day: bigint
  readonly spent_today: bigint
  readonly premiums_paid: bigint
  readonly cashback_received: bigint
  readonly checkouts: bigint
}

export interface Checkout {
  readonly layout: number
  readonly customer: PublicKey
  readonly number: bigint
  readonly payer: PublicKey
  readonly created_at: bigint
  readonly rounds: number
  readonly requested_at: bigint
  readonly cards: ReadonlyArray<Card>
}

export interface Quote {
  readonly mode: Mode
  readonly reference_price: bigint
  readonly lucky_amount: bigint
  readonly max_price: bigint
}

/** A Draw Proof, as the program records it (`emit_cpi!`). */
export interface DrawEvent {
  readonly checkout: PublicKey
  readonly customer: PublicKey
  readonly card: number
  readonly round: number
  readonly seed: Buffer
  readonly request: PublicKey
  readonly randomness: Buffer
  readonly random: Buffer
  readonly roll: number
  readonly game_version: number
  readonly reference_price: bigint
  readonly lucky_amount: bigint
  readonly max_price: bigint
  readonly final_bps: number
  readonly final_price: bigint
  readonly cashback: bigint
}

// ---------- addresses ----------

/** The program id `anchor build` made the IDL for (devnet and tests). Staging and production name their own. */
export const IDL_PROGRAM_ID = new PublicKey(idl.address)
export const ORAO_VRF = new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y")
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")

const u64le = (n: bigint) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(n)
  return b
}
export const ORAO_NETWORK_STATE = PublicKey.findProgramAddressSync([Buffer.from("orao-vrf-network-configuration")], ORAO_VRF)[0]
/** ORAO's request account for a Checkout's `round`th request. */
export const oraoRequest = (checkout: PublicKey, round: number) =>
  PublicKey.findProgramAddressSync([Buffer.from("orao-vrf-randomness-request"), drawSeed(checkout, round)], ORAO_VRF)[0]

/** One deployment of the program: its addresses, and instructions addressed to it. */
export const programAt = (id: PublicKey) => {
  const pda = (...seeds: Array<Buffer | Uint8Array>) => PublicKey.findProgramAddressSync(seeds, id)[0]
  return {
    id,
    config: pda(Buffer.from("config")),
    /** Owns the Vault, and is the delegate each Deposit Address approves once. */
    vaultAuthority: pda(Buffer.from("vault")),
    vault: pda(Buffer.from("vault-usdc")),
    eventAuthority: pda(Buffer.from("__event_authority")),
    programData: PublicKey.findProgramAddressSync([id.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0],
    customer: (wallet: PublicKey) => pda(Buffer.from("customer"), wallet.toBuffer()),
    checkout: (wallet: PublicKey, number: bigint) => pda(Buffer.from("checkout"), wallet.toBuffer(), u64le(number)),
    instruction: (name: string, accounts: Readonly<Record<string, PublicKey | undefined>>, args: Readonly<Record<string, unknown>> = {}) =>
      instruction(id, name, accounts, args)
  }
}
export type Program = ReturnType<typeof programAt>

/** The seed of a Checkout's `round`th randomness request, as `game::draw_seed` makes it. */
export const drawSeed = (checkout: PublicKey, round: number) =>
  createHash("sha256").update(Buffer.concat([Buffer.from("luckout-draw"), checkout.toBuffer(), Uint8Array.of(round)])).digest()

/** ORAO's treasury, which `settle` and `request_again` pay the request fee to: bytes 40..72 of its network state. */
export const oraoTreasury = (networkState: Uint8Array) => new PublicKey(networkState.subarray(40, 72))

/** ORAO's filled-in randomness, if the request account at hand holds it (ORAO's `RandomnessV2`, `Fulfilled`). */
export const filledRandomness = (request: Uint8Array): Buffer | undefined =>
  request.length >= 137 && request[8] === 1 ? Buffer.from(request.subarray(73, 137)) : undefined

// ---------- instructions, accounts, events, errors ----------

/**
 * One program instruction: accounts by their IDL names (an optional one left out is passed as the program id,
 * which Anchor reads as None; fixed addresses fill themselves in), arguments by theirs.
 */
const instruction = (
  programId: PublicKey,
  name: string,
  accounts: Readonly<Record<string, PublicKey | undefined>>,
  args: Readonly<Record<string, unknown>> = {}
): TransactionInstruction => {
  const def = idl.instructions.find((i) => i.name === name)
  if (!def) throw new Error(`the program has no instruction ${name}`)
  const keys = def.accounts.map((a) => {
    const pubkey = accounts[a.name] ?? (a.address ? new PublicKey(a.address) : a.optional ? programId : undefined)
    if (!pubkey) throw new Error(`${name}: account ${a.name} is missing`)
    const absent = a.optional === true && accounts[a.name] === undefined
    return { pubkey, isWritable: !absent && a.writable === true, isSigner: !absent && a.signer === true }
  })
  const out: Array<Uint8Array> = [Uint8Array.from(def.discriminator)]
  for (const arg of def.args) encode(arg.type, args[arg.name], out)
  return new TransactionInstruction({ programId, keys, data: Buffer.concat(out) })
}

const startsWith = (data: Uint8Array, prefix: ReadonlyArray<number>) => prefix.every((b, i) => data[i] === b)

export const decodeAccount = <T>(name: "Config" | "Customer" | "Checkout", data: Uint8Array): T => {
  const def = idl.accounts.find((a) => a.name === name)!
  if (!startsWith(data, def.discriminator)) throw new Error(`not a ${name} account`)
  return decodeWith({ defined: { name } }, data.subarray(8)) as T
}

/** An instruction's return value (`quote_many`), from the transaction's return data. */
export const decodeReturn = <T>(name: string, data: Uint8Array): T => {
  const returns = idl.instructions.find((i) => i.name === name)?.returns
  if (!returns) throw new Error(`${name} returns nothing`)
  return decodeWith(returns, data) as T
}

export interface ProgramEvent { readonly name: string; readonly data: Record<string, unknown> }

const decodeEvent = (bytes: Uint8Array): ProgramEvent | undefined => {
  const e = idl.events.find((ev) => startsWith(bytes, ev.discriminator))
  return e ? { name: e.name, data: decodeWith({ defined: { name: e.name } }, bytes.subarray(8)) as Record<string, unknown> } : undefined
}

/** Anchor's tag in front of an `emit_cpi!` event (the self-call's instruction data). */
const EVENT_CPI_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]

/**
 * The program's events in a transaction: `emit!` ones from its logs ("Program data: …"), and `emit_cpi!` ones
 * (the Draw Proofs) from the data of its inner self-calls, which long logs can't cut off.
 */
export const decodeEvents = (logs: ReadonlyArray<string>, innerData: ReadonlyArray<Uint8Array>): Array<ProgramEvent> => [
  ...logs.filter((l) => l.startsWith("Program data: ")).flatMap((l) => {
    const e = decodeEvent(Buffer.from(l.slice("Program data: ".length), "base64"))
    return e ? [e] : []
  }),
  ...innerData.filter((d) => startsWith(d, EVENT_CPI_TAG)).flatMap((d) => {
    const e = decodeEvent(d.subarray(8))
    return e ? [e] : []
  })
]

/** The program's own message for one of its error codes (6000 and up). */
export const programError = (code: number) => idl.errors.find((e) => e.code === code)

// ---------- base58, for keys and signatures ----------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

export const base58 = {
  encode: (bytes: Uint8Array) => {
    let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"))
    let out = ""
    while (n > 0n) {
      out = B58[Number(n % 58n)] + out
      n /= 58n
    }
    for (const b of bytes) {
      if (b !== 0) break
      out = "1" + out
    }
    return out
  },
  decode: (text: string) => {
    let n = 0n
    for (const ch of text) {
      const i = B58.indexOf(ch)
      if (i < 0) throw new Error("not base58")
      n = n * 58n + BigInt(i)
    }
    let hex = n === 0n ? "" : n.toString(16)
    if (hex.length % 2) hex = "0" + hex
    const lead = /^1*/.exec(text)![0].length
    return Buffer.concat([Buffer.alloc(lead), Buffer.from(hex, "hex")])
  }
}
