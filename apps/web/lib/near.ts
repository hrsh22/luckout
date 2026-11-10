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

const toTransaction = (c: Call) => ({
  receiverId: c.receiverId,
  actions: [{
    type: "FunctionCall" as const,
    params: { methodName: c.method, args: c.args, gas: String((c.tgas ?? 30) * 1e12), deposit: c.deposit ?? "0" }
  }]
})

/** The connected wallet, refusing if it has switched to another account than the one signed in, so nothing is signed by surprise. */
async function walletOn(expected: string) {
  const wallet = await near().wallet()
  const current = (await wallet.getAccounts())[0]?.accountId
  if (current !== expected) {
    throw new Error(`Your wallet is now on ${current ?? "no account"}, not ${expected}. Sign in again with the account you want to use.`)
  }
  return wallet
}

/** Signs and sends calls with the connected wallet, in one approval. The wallet pays the network fee. */
export async function send(expected: string, ...calls: Array<Call>) {
  return (await walletOn(expected)).signAndSendTransactions({ transactions: calls.map(toTransaction) })
}

/** Whether the connected wallet can sign without sending (NEP-366), so our relayer can send and pay. */
export const canSignForRelay = () =>
  near().wallet().then((w) => w.manifest.features?.signDelegateActions === true, () => false)

/**
 * Signs calls in one approval without sending them, for our relayer to send and pay for (ADR-0008).
 * Each comes back as base64 of a borsh SignedDelegate.
 */
export async function signForRelay(expected: string, ...calls: Array<Call>) {
  const wallet = await walletOn(expected)
  const { signedDelegateActions } = await wallet.signDelegateActions({ signerId: expected, delegateActions: calls.map(toTransaction) })
  // near-connect types these as base64 strings; some wallets wrap them as { borshSerializedBase64 }.
  return (signedDelegateActions as Array<unknown>).map((s) => {
    const b64 = typeof s === "string" ? s : (s as { borshSerializedBase64?: unknown })?.borshSerializedBase64
    if (typeof b64 !== "string") throw new Error("This wallet signed in a format Luckout can't relay")
    return b64
  })
}
