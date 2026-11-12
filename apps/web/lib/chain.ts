// Reading the chain straight from RPC, without our server and without wallet code (ADR-0006).
export const network = process.env.NEXT_PUBLIC_NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet"
export const contractId = process.env.NEXT_PUBLIC_LUCKOUT_CONTRACT_ID || "app.luckout.testnet"
export const usdcId = process.env.NEXT_PUBLIC_USDC_CONTRACT_ID || "usdc.luckout.testnet"
/** NEAR Intents, where an EVM wallet's money waits outside Luckout (ADR-0011); fixed per network, as in the contract. */
export const intentsId = network === "mainnet" ? "intents.near" : "intents.luckout.testnet"
// Tried in order when one is down, slow or rate-limited: the same providers as the server's defaults (apps/server/src/Near.ts).
const rpcUrls = network === "mainnet"
  ? ["https://free.rpc.fastnear.com", "https://near.drpc.org"]
  : ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"]
// Transactions and blocks older than a few days live only on archival nodes.
const historyUrls = [...rpcUrls, network === "mainnet" ? "https://archival-rpc.mainnet.fastnear.com" : "https://archival-rpc.testnet.fastnear.com"]
export const explorer = (tx: string) => `https://${network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${tx}`

async function rpc<T>(method: string, params: object, urls = rpcUrls): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  let res: { result?: T & { error?: unknown }; error?: { code?: number; cause?: { name?: string } } } | undefined
  for (const url of urls) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(10_000) })
      res = r.ok ? await r.json() : res
      // Rate limited (FastNEAR's -429) or pruned history is this endpoint's answer, not the chain's: try the next.
      if (res && res.error?.code !== -429 && !/^UNKNOWN_(TRANSACTION|BLOCK)$/.test(res.error?.cause?.name ?? "")) break
    } catch {}
  }
  if (!res) throw new Error("Can't reach NEAR right now. Check your connection and try again.")
  const error = res.error ?? res.result?.error
  if (error) {
    // The raw reply stays on `cause` for debugging; people see plain words.
    throw new Error(
      res.error?.cause?.name === "UNKNOWN_TRANSACTION"
        ? "NEAR has no record of this transaction. Check the link, or try again in a minute."
        : "NEAR couldn't answer that just now. Try again in a moment.",
      { cause: error }
    )
  }
  return res.result as T
}

/** Liquid NEAR on an account, in yoctoNEAR: what pays network fees. */
export const nearBalance = (accountId: string) =>
  rpc<{ amount: string }>("query", { request_type: "view_account", finality: "optimistic", account_id: accountId }).then((r) => r.amount)

/** USDC (micro, as a string) in an account's NEAR Intents balance. */
export const intentsUsdc = (accountId: string) => view<string>(intentsId, "mt_balance_of", { account_id: accountId, token_id: `nep141:${usdcId}` })

/** The code deployed on an account (base58 of the wasm's sha256): it changes only with an upgrade. */
export const codeHash = (accountId: string) =>
  rpc<{ code_hash: string }>("query", { request_type: "view_account", finality: "final", account_id: accountId }).then((r) => r.code_hash)

/** Below this a wallet can't pay for our transactions (a deposit costs about 0.03 NEAR). */
export const MIN_GAS_NEAR = 50_000_000_000_000_000_000_000n // 0.05 NEAR

/** Reads a contract view straight from RPC, without our server (ADR-0006). */
export async function view<T>(contract: string, method: string, args: object = {}): Promise<T> {
  const r = await rpc<{ result: Array<number> }>("query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: contract,
    method_name: method,
    args_base64: btoa(JSON.stringify(args))
  })
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result)))
}

/**
 * Luckout events logged by one transaction, and when its block was produced. Only receipts our
 * contract executed successfully count, so another contract can't log a look-alike Draw.
 */
export async function txEvents(txHash: string, signer: string) {
  const tx = await rpc<{
    receipts_outcome: Array<{ outcome: { logs: Array<string>; executor_id: string; status: Record<string, unknown> } }>
    transaction_outcome: { block_hash: string }
  }>("tx", { tx_hash: txHash, sender_account_id: signer, wait_until: "NONE" }, historyUrls)
  const block = await rpc<{ header: { timestamp_nanosec: string } }>("block", { block_id: tx.transaction_outcome.block_hash }, historyUrls)
  const events = tx.receipts_outcome
    .filter((r) => r.outcome.executor_id === contractId && !("Failure" in r.outcome.status))
    .flatMap((r) => r.outcome.logs)
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice(11)) as { standard: string; event: string; data: Array<unknown> })
    .filter((e) => e.standard === "luckout")
  return { events, time: new Date(Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n)) }
}

/**
 * Why a sent transaction failed on chain, or undefined if it went through. Wallets hand back the
 * outcome even when the contract refused the call, so this must be checked before saying it worked.
 */
export const txFailure = (outcome: unknown) => {
  const failure = (outcome as { status?: { Failure?: unknown } } | undefined)?.status?.Failure
  if (failure === undefined) return undefined
  return /"ExecutionError":"(?:Smart contract panicked: )?([^"]*)"/.exec(JSON.stringify(failure))?.[1] ?? "The transaction failed on chain."
}

export const explorerAccount = (id: string) => `https://${network === "testnet" ? "testnet." : ""}nearblocks.io/address/${id}`

export interface Stats {
  lucky_settled: number
  lucky_amount_total: string
  lucky_paid_total: string
}

/** Live Average: what lucky buyers paid per 100 of price, across every settled Lucky Buy. */
export const liveAverage = (s: Stats) =>
  Number(s.lucky_amount_total) > 0 ? (Number(s.lucky_paid_total) / Number(s.lucky_amount_total)) * 100 : undefined
