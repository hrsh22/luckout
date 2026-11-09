import { NearConnector } from "@hot-labs/near-connect"
import { network } from "./chain"

export * from "./chain"

let connector: NearConnector | undefined

/** Browser-only NEAR Connect singleton (HOT Wallet works inside Telegram too). */
export const near = () => (connector ??= new NearConnector({ network }))

export interface Call {
  receiverId: string
  method: string
  args: object
  /** yoctoNEAR */
  deposit?: string
  tgas?: number
}

/**
 * Signs and sends calls with the connected wallet, in one approval. Refuses if the wallet has
 * switched to a different account than the one signed in, so nothing is signed by surprise.
 */
export async function send(expected: string, ...calls: Array<Call>) {
  const wallet = await near().wallet()
  const current = (await wallet.getAccounts())[0]?.accountId
  if (current !== expected) {
    throw new Error(`Your wallet is now on ${current ?? "no account"}, not ${expected}. Sign in again with the account you want to use.`)
  }
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
