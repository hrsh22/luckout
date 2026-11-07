import { NearConnector } from "@hot-labs/near-connect"

export const network = process.env.NEXT_PUBLIC_NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet"
export const contractId = process.env.NEXT_PUBLIC_LUCKOUT_CONTRACT_ID || "app.luckout.testnet"
export const usdcId = process.env.NEXT_PUBLIC_USDC_CONTRACT_ID || "usdc.luckout.testnet"
const rpcUrl = network === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com"
export const explorer = (tx: string) => `https://${network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${tx}`

let connector: NearConnector | undefined

/** Browser-only NEAR Connect singleton (HOT Wallet works inside Telegram too). */
export const near = () => (connector ??= new NearConnector({ network }))

/** Reads a contract view straight from RPC, without our server (ADR-0006). */
export async function view<T>(contract: string, method: string, args: object = {}): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "optimistic",
        account_id: contract,
        method_name: method,
        args_base64: btoa(JSON.stringify(args))
      }
    })
  }).then((r) => r.json())
  if (res.error || res.result?.error) throw new Error(res.error?.data ?? res.result.error)
  return JSON.parse(new TextDecoder().decode(new Uint8Array(res.result.result)))
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
