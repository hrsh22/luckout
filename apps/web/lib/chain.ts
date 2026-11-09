// Reading the chain straight from RPC, without our server and without wallet code (ADR-0006).
export const network = process.env.NEXT_PUBLIC_NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet"
export const contractId = process.env.NEXT_PUBLIC_LUCKOUT_CONTRACT_ID || "app.luckout.testnet"
export const usdcId = process.env.NEXT_PUBLIC_USDC_CONTRACT_ID || "usdc.luckout.testnet"
const rpcUrl = network === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com"
export const explorer = (tx: string) => `https://${network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${tx}`

async function rpc<T>(method: string, params: object): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  }).then((r) => r.json())
  if (res.error || res.result?.error) throw new Error(JSON.stringify(res.error?.cause ?? res.error ?? res.result.error))
  return res.result
}

/** Liquid NEAR on an account, in yoctoNEAR: what pays network fees. */
export const nearBalance = (accountId: string) =>
  rpc<{ amount: string }>("query", { request_type: "view_account", finality: "optimistic", account_id: accountId }).then((r) => r.amount)

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
  }>("tx", { tx_hash: txHash, sender_account_id: signer, wait_until: "NONE" })
  const block = await rpc<{ header: { timestamp_nanosec: string } }>("block", { block_id: tx.transaction_outcome.block_hash })
  const events = tx.receipts_outcome
    .filter((r) => r.outcome.executor_id === contractId && !("Failure" in r.outcome.status))
    .flatMap((r) => r.outcome.logs)
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice(11)) as { standard: string; event: string; data: Array<unknown> })
    .filter((e) => e.standard === "luckout")
  return { events, time: new Date(Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n)) }
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
