import { NearConnector } from "@hot-labs/near-connect"

export const network = process.env.NEXT_PUBLIC_NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet"
export const contractId = process.env.NEXT_PUBLIC_LUCKOUT_CONTRACT_ID || "app.luckout.testnet"
export const usdcId = process.env.NEXT_PUBLIC_USDC_CONTRACT_ID || "usdc.luckout.testnet"
const rpcUrl = network === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com"
export const explorer = (tx: string) => `https://${network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${tx}`

let connector: NearConnector | undefined

/** Browser-only NEAR Connect singleton (HOT Wallet works inside Telegram too). */
export const near = () => (connector ??= new NearConnector({ network }))

async function rpc<T>(method: string, params: object): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  }).then((r) => r.json())
  if (res.error || res.result?.error) throw new Error(JSON.stringify(res.error?.cause ?? res.error ?? res.result.error))
  return res.result
}

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

/** Luckout events logged by one transaction, and when its block was produced. */
export async function txEvents(txHash: string, signer: string) {
  const tx = await rpc<{
    receipts_outcome: Array<{ outcome: { logs: Array<string> } }>
    transaction_outcome: { block_hash: string }
  }>("tx", { tx_hash: txHash, sender_account_id: signer, wait_until: "NONE" })
  const block = await rpc<{ header: { timestamp_nanosec: string } }>("block", { block_id: tx.transaction_outcome.block_hash })
  const events = tx.receipts_outcome.flatMap((r) => r.outcome.logs)
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice(11)) as { standard: string; event: string; data: Array<unknown> })
    .filter((e) => e.standard === "luckout")
  return { events, time: new Date(Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n)) }
}

export interface Call {
  receiverId: string
  method: string
  args: object
  /** yoctoNEAR */
  deposit?: string
  tgas?: number
}

/** Signs and sends calls with the connected wallet, in one approval. */
export async function send(...calls: Array<Call>) {
  const wallet = await near().wallet()
  return wallet.signAndSendTransactions({
    transactions: calls.map((c) => ({
      receiverId: c.receiverId,
      actions: [{
        type: "FunctionCall" as const,
        params: {
          methodName: c.method,
          args: c.args,
          gas: String((c.tgas ?? 30) * 1e12),
          deposit: c.deposit ?? "0"
        }
      }]
    }))
  })
}
