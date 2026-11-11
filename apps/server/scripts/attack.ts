// "What if the server or the AI agent is fully compromised?"
// This script holds the operator's key (from .env), skips our server entirely, and tries
// what an attacker would. Each attempt is refused by NEAR or by the contract.
// Usage: node --env-file=../../.env scripts/attack.ts [victim.testnet]
import { actions, Account, JsonRpcProvider, type KeyPairString, teraToGas } from "near-api-js"

const victim = process.argv[2] ?? "alice.luckout.testnet"
const contract = process.env.LUCKOUT_CONTRACT_ID ?? "app.luckout.testnet"
const operatorId = process.env.OPERATOR_ACCOUNT_ID!
const key = process.env.OPERATOR_PRIVATE_KEY as KeyPairString
if (!operatorId || !key) throw new Error("Set OPERATOR_ACCOUNT_ID and OPERATOR_PRIVATE_KEY")

const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL?.split(",")[0]?.trim() || "https://test.rpc.fastnear.com" })
const operator = new Account(operatorId, provider, key)
const view = (method: string, args: Record<string, unknown> = {}) => provider.callFunction({ contractId: contract, method, args })

type Act = { method: string; args: object; deposit?: bigint }
const attempt = async (title: string, receiverId: string, method: string | Array<Act>, args: object = {}, deposit = 0n) => {
  const acts: Array<Act> = typeof method === "string" ? [{ method, args, deposit }] : method
  try {
    await operator.signAndSendTransaction({
      receiverId,
      actions: acts.map((a) => actions.functionCall(a.method, a.args, teraToGas(Math.floor(240 / acts.length)), a.deposit ?? 0n))
    })
    console.log(`✗ ${title}: IT WORKED (this should never happen)`)
    process.exitCode = 1
  } catch (e) {
    const msg = String((e as Error).message ?? e)
    const why = /Smart contract panicked: ([^"\\]+)/.exec(msg)?.[1] ?? msg.split("\n")[0]
    console.log(`✓ ${title}\n    refused: ${why}`)
  }
}

const account = (await view("get_account", { account_id: victim })) as { balance: string; per_purchase_limit: string; daily_limit: string } | null
if (!account) throw new Error(`${victim} has no Luckout balance`)
const usd = (micro: string | number) => `$${(Number(micro) / 1e6).toFixed(2)}`
console.log(`Attacker holds ${operatorId}'s key. Victim ${victim}: balance ${usd(account.balance)}, limit ${usd(account.per_purchase_limit)} per purchase, ${usd(account.daily_limit)} per day.\n`)

await attempt(
  `Buy ${usd(Number(account.per_purchase_limit) + 1_000_000)} in one purchase (over the per-purchase limit)`,
  contract, "purchase",
  {
    customer: victim,
    reference_price: String(Number(account.per_purchase_limit) + 1_000_000),
    mode: "normal",
    order_id: `attack-${Date.now()}`,
    max_debit: "1000000000000"
  }
)
// Result shopping: confirm a delivery and, in the same transaction, a call that panics when the
// Draw went the customer's way, retrying until it doesn't. NEAR refuses multi-action transactions
// from a function-call key, and even with a full-access key the Draw runs in a later receipt.
await attempt("Bundle a confirmation with a call that reverts unlucky Draws", contract, [
  { method: "confirm_delivery", args: { purchase_id: 0 } },
  { method: "fail_purchase", args: { purchase_id: 0 } }
])
await attempt("Run a Draw directly, picking the moment", contract, "on_draw", { purchase_id: 0 })
await attempt("Withdraw the victim's balance to the attacker", contract, "withdraw", { amount: account.balance }, 1n)
await attempt("Raise the victim's Spending Limits", contract, "set_limits", { per_purchase: "1000000000000", daily: "1000000000000" }, 1n)
await attempt("Act for an EVM customer as if NEAR Intents vouched for it (ADR-0011)", contract, "on_auth", {
  signer_id: "0x53a19a03679e8d5e9253a998dcde6c71dbb002a2",
  msg: JSON.stringify({ withdraw: { amount: "1000000" } })
})
await attempt("Drain the Cashback Reserve", contract, "withdraw_reserve", { amount: "1000000" }, 1n)
await attempt("Pause the shop", contract, "set_paused", { paused: true })
await attempt("Pull the proceeds, as if it were the treasury", contract, "sweep_proceeds", { amount: "1000000" }, 1n)
await attempt("Make itself the treasury, with no daily cap", contract, "set_treasury", { treasury: operatorId, daily_cap: "1000000000000" }, 1n)
await attempt("Send the proceeds to itself through the owner's route", contract, "withdraw_proceeds", { amount: "1000000", to_treasury: true }, 1n)
await attempt("Move test USDC out of the contract directly", process.env.USDC_CONTRACT_ID ?? "usdc.luckout.testnet", "ft_transfer", { receiver_id: operatorId, amount: "1000000" }, 1n)

console.log(`\nWith only the operator's key, the most a compromised server or agent can do is buy for ${victim}, within the limits they set (with the treasury's key too, proceeds up to the owner's daily cap: ADR-0009).`)
