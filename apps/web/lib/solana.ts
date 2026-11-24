"use client"

// Solana wallets (ADR-0011) through the same Reown AppKit modal as EVM wallets (lib/evm.ts), loaded only when
// someone picks one. A Solana customer's account is their key in hex, which is also their NEAR Intents account.
// The wallet signs messages as raw bytes (sign-in, and intents as NEAR Intents' raw_ed25519) and, for a Top-Up,
// sends its own SOL or tokens on Solana: the only fee a Solana customer pays.

import { solanaAccountId, solanaAddress } from "@luckout/api"
import type { Provider } from "@reown/appkit-adapter-solana"
import { load, projectId, TransferReverted } from "./evm"
import { blockhashExpired, type ReownBalance } from "./holdings"

/** Solana mainnet, as AppKit and Reown's balance and RPC services name it. */
export const SOLANA_CHAIN = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
const RPC = `https://rpc.walletconnect.org/v1/?chainId=${SOLANA_CHAIN}&projectId=${projectId}`

const idOf = (a: { address?: string | undefined; isConnected?: boolean } | undefined) =>
  a?.isConnected && a.address ? solanaAccountId(a.address) : undefined

/** The connected wallet's account (its key in hex), once AppKit has reconnected one from an earlier visit. */
export async function solanaAccount() {
  const { modal } = await load()
  await modal.ready()
  // ponytail: polls up to 5 s while AppKit reconnects; subscribe to the account's status if that ever shows.
  for (let i = 0; i < 20 && ["reconnecting", "connecting"].includes(modal.getAccount("solana")?.status ?? ""); i++) {
    await new Promise((r) => setTimeout(r, 250))
  }
  return idOf(modal.getAccount("solana"))
}

/** Opens the picker on Solana wallets; resolves with the account once connected, or throws if it was closed first. */
export async function connectSolana(): Promise<string> {
  const { modal } = await load()
  const now = idOf(modal.getAccount("solana"))
  if (now) return now
  return new Promise((resolve, reject) => {
    let opened = false
    const stop = [
      modal.subscribeAccount((a) => {
        const id = idOf(a)
        if (!id) return
        stop.forEach((s) => s())
        void modal.close()
        resolve(id)
      }, "solana"),
      modal.subscribeState((s) => {
        if (s.open) opened = true
        else if (opened && !idOf(modal.getAccount("solana"))) {
          stop.forEach((f) => f())
          reject(new Error("User closed the wallet picker"))
        }
      })
    ]
    void modal.open({ namespace: "solana" })
  })
}

/** Calls `onChange` when the wallet switches to another account or disconnects (undefined); not while it reconnects. */
export async function watchSolana(onChange: (accountId: string | undefined) => void) {
  const { modal } = await load()
  return modal.subscribeAccount((a) => {
    if (a.status === "connected") onChange(idOf(a))
    else if (a.status === "disconnected") onChange(undefined)
  }, "solana")
}

/** The wallet, refusing if it has switched to another account than the one signed in. */
async function walletOn(expected: string) {
  const { modal } = await load()
  const now = idOf(modal.getAccount("solana"))
  const provider = modal.getProvider<Provider>("solana")
  if (now !== expected || !provider) {
    const on = now ? solanaAddress(now) : "no account"
    throw new Error(`Your wallet is now on ${on}, not ${solanaAddress(expected)}. Sign in again with the account you want to use.`)
  }
  return provider
}

/** The signed-in account's ed25519 signature over the text, as raw bytes (what NEAR Intents and our server check). */
export async function signSolana(expected: string, message: string) {
  return (await walletOn(expected)).signMessage(new TextEncoder().encode(message))
}

const rpc = async <A>(method: string, params: Array<unknown>): Promise<A> => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
  const body = (await r.json()) as { result?: A; error?: { message: string } }
  if (!r.ok || body.error || body.result === undefined) throw new Error(`Solana: ${body.error?.message ?? `HTTP ${r.status}`}`)
  return body.result
}

/** The wallet's SOL and its holdings of these tokens (mints), in the shape of Reown's balance lookup (which has none for Solana). */
export async function solanaBalances(address: string, mints: ReadonlyArray<string>): Promise<ReadonlyArray<ReownBalance>> {
  type TokenAccounts = { value: Array<{ account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmountString: string } } } } } }> }
  const [lamports, ...tokens] = await Promise.all([
    rpc<{ value: number }>("getBalance", [address]),
    ...mints.map((mint) => rpc<TokenAccounts>("getTokenAccountsByOwner", [address, { mint }, { encoding: "jsonParsed" }]))
  ])
  return [
    { symbol: "SOL", chainId: SOLANA_CHAIN, address: null, quantity: { numeric: String(lamports.value / 1e9) } },
    ...tokens.flatMap((t) => t.value).map(({ account: { data: { parsed: { info } } } }) => ({
      symbol: "",
      chainId: SOLANA_CHAIN,
      address: `${SOLANA_CHAIN}:${info.mint}`,
      quantity: { numeric: info.tokenAmount.uiAmountString }
    }))
  ]
}

/**
 * Sends `amount` (base units) of a token (`contract` is its mint), or SOL without one, from the wallet; the fee, and
 * the rent for the deposit address's token account when it has none yet, on the wallet. `onSent` gets the signature
 * once the wallet has sent it: from then on it may land, so the caller must not offer to send it again unless this
 * throws TransferReverted.
 */
export async function sendFromSolana(expected: string, o: { contract?: string | undefined; decimals?: number | undefined; to: string; amount: string }, onSent?: (signature: string) => void) {
  const provider = await walletOn(expected)
  const { Connection, PublicKey, SystemProgram, Transaction } = await import("@solana/web3.js")
  const connection = new Connection(RPC, "confirmed")
  const from = new PublicKey(solanaAddress(expected))
  const to = new PublicKey(o.to)
  const tx = new Transaction()
  if (!o.contract) tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: BigInt(o.amount) }))
  else {
    if (o.decimals === undefined) throw new Error("Luckout doesn't know this token's decimals. Nothing was sent.")
    const spl = await import("@solana/spl-token")
    const mint = new PublicKey(o.contract)
    const source = spl.getAssociatedTokenAddressSync(mint, from)
    const target = spl.getAssociatedTokenAddressSync(mint, to, true)
    tx.add(
      spl.createAssociatedTokenAccountIdempotentInstruction(from, target, to, mint),
      spl.createTransferCheckedInstruction(source, mint, target, from, BigInt(o.amount), o.decimals)
    )
  }
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed")
  tx.feePayer = from
  tx.recentBlockhash = blockhash
  const signature = await provider.sendTransaction(tx, connection)
  onSent?.(signature)
  return landed(connection, signature, lastValidBlockHeight)
}

/**
 * Signs and sends a transaction Luckout built for this wallet: a swap-paid Top-Up's (ADR-0014), which the wallet shows
 * before it's approved. `onSent` and TransferReverted as for sendFromSolana.
 */
export async function sendSolanaTransaction(expected: string, built: { transaction: string; lastValidBlockHeight: number }, onSent?: (signature: string) => void) {
  const provider = await walletOn(expected)
  const { Connection, VersionedTransaction } = await import("@solana/web3.js")
  const connection = new Connection(RPC, "confirmed")
  const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(built.transaction), (c) => c.charCodeAt(0)))
  // Built for the wallet signed in, as its fee payer: one for any other is refused before the wallet is asked.
  if (tx.message.staticAccountKeys[0]?.toBase58() !== solanaAddress(expected)) throw new Error("That transaction isn't for this wallet. Nothing was sent.")
  const signature = await provider.sendTransaction(tx, connection)
  onSent?.(signature)
  return landed(connection, signature, built.lastValidBlockHeight)
}

/** Follows a sent transaction until it confirms (its signature), or throws TransferReverted once it can never land. */
async function landed(connection: import("@solana/web3.js").Connection, signature: string, lastValidBlockHeight: number) {
  const sentAt = Date.now()
  // Polled, not subscribed: Reown's RPC answers over HTTP only.
  for (;;) {
    const [status] = (await connection.getSignatureStatuses([signature])).value
    if (status?.err) throw new TransferReverted()
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature
    // Its blockhash expired unseen: it can never land now. Before saying nothing left the wallet, ask the ledger and
    // not only the RPC's recent statuses, which can miss a transfer that did land (staging, 2026-11-19).
    if (!status && blockhashExpired(await connection.getBlockHeight("confirmed"), lastValidBlockHeight, Date.now() - sentAt)) {
      const [found] = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value
      if (found && !found.err) return signature
      throw new TransferReverted()
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}
