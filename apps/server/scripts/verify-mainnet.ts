// Checks the mainnet claims in docs/evidence/mainnet.json against the chains themselves, with no keys:
// - every settled buy: `purchase` and `confirm_delivery` both succeeded on the contract, the ids and
//   amounts in their arguments match, and the contract still shows the purchase Delivered at that price;
// - a customer's USDC deposit (NEP-141 `ft_transfer_call`, relayed with NEP-366);
// - one Bitrefill credit refill, leg by leg: treasury → 1Click deposit address (NEAR), 1Click's
//   settlement into our Base wallet (Base), the Chain Signatures `sign` call, and the Base wallet's
//   payment of the Bitrefill invoice, which must be exactly the transaction that `sign` signed.
// Exits 1 if anything doesn't match.
// Usage: node scripts/verify-mainnet.ts [--contract app.luckout.near] [--evidence docs/evidence/mainnet.json]
import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { createPublicClient, http, keccak256, serializeTransaction } from "viem"
import { base } from "viem/chains"

type Evidence = {
  contract: string
  operator: string
  buys: Array<{ purchase: number; admit: string; settle: string }>
  deposit: { hash: string; sender: string }
  refill: {
    id: string
    treasury: string
    send: string
    depositAddress: string
    amountIn: string
    amountOut: string
    baseWallet: string
    sign: string
    payment: `0x${string}`
    invoice: string
    payAddress: string
  }
}
type Call = { method_name: string; args: string }
type Action = { FunctionCall?: Call; Delegate?: { delegate_action: { receiver_id: string; actions: Array<Action> } } }
type Tx = {
  status: { SuccessValue?: string; Failure?: unknown }
  transaction: { signer_id: string; receiver_id: string; actions: Array<Action> }
  receipts_outcome: Array<{ outcome: { executor_id: string; status: Record<string, unknown>; logs: Array<string> } }>
}

const here = new URL("../../../", import.meta.url).pathname
const { values } = parseArgs({ options: { contract: { type: "string" }, evidence: { type: "string", default: `${here}docs/evidence/mainnet.json` } } })
const ev = JSON.parse(readFileSync(values.evidence, "utf8")) as Evidence
const contract = values.contract ?? ev.contract
const NEAR_RPC = "https://archival-rpc.mainnet.fastnear.com"
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
const nearblocks = (h: string) => `https://nearblocks.io/txns/${h}`
const basescan = (h: string) => `https://basescan.org/tx/${h}`
const baseClient = createPublicClient({ chain: base, transport: http() })

let failed = 0
const check = (ok: boolean, what: string) => {
  if (!ok) {
    failed++
    console.log(`  ✘ ${what}`)
  }
  return ok
}

const rpc = async <A>(method: string, params: unknown): Promise<A> => {
  for (let i = 0; ; i++) {
    const r = await fetch(NEAR_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
    const j = await r.json().catch(() => null)
    if (j?.result) return j.result as A
    if (i === 4) throw new Error(`${method}: ${JSON.stringify(j?.error ?? r.status)}`)
    await new Promise((s) => setTimeout(s, 1000 * (i + 1)))
  }
}
const tx = (hash: string, sender: string) => rpc<Tx>("tx", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" })
const view = async <A>(account_id: string, method_name: string, args: unknown) => {
  const r = await rpc<{ result: Array<number> }>("query", {
    request_type: "call_function", finality: "final", account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString("base64")
  })
  return JSON.parse(Buffer.from(r.result).toString()) as A
}
const fn = (t: Tx, i = 0) => {
  const c = t.transaction.actions[i]?.FunctionCall
  return c ? { method: c.method_name, args: JSON.parse(Buffer.from(c.args, "base64").toString()) } : undefined
}
const succeeded = (t: Tx) => t.status.SuccessValue !== undefined && t.receipts_outcome.every((r) => !("Failure" in r.outcome.status))
const usd = (micro: string | number) => `$${(Number(micro) / 1e6).toFixed(2)}`

const config = await view<{ operator: string; usdc: string }>(contract, "get_config", {})
console.log(`Luckout mainnet evidence, checked ${new Date().toISOString()}`)
console.log(`contract ${contract}, operator ${config.operator}, USDC ${config.usdc}`)
check(config.operator === ev.operator, `operator is ${config.operator}, evidence says ${ev.operator}`)

// ---------- settled buys ----------
console.log(`\nSettled buys (${ev.buys.length}): purchase → confirm_delivery, then get_purchase now`)
let verified = 0
for (const b of ev.buys) {
  const before = failed
  const [admit, settle, now] = await Promise.all([
    tx(b.admit, ev.operator), tx(b.settle, ev.operator),
    view<{ customer: string; mode: unknown; reference_price: string; status: string; cashback: string } | null>(contract, "get_purchase", { purchase_id: b.purchase })
  ])
  const a = fn(admit), s = fn(settle)
  check(succeeded(admit) && admit.transaction.receiver_id === contract && a?.method === "purchase", `#${b.purchase}: ${b.admit} isn't a successful purchase on ${contract}`)
  check(Number(Buffer.from(admit.status.SuccessValue ?? "", "base64").toString()) === b.purchase, `#${b.purchase}: purchase returned another id`)
  check(succeeded(settle) && settle.transaction.receiver_id === contract && s?.method === "confirm_delivery" && s.args.purchase_id === b.purchase, `#${b.purchase}: ${b.settle} isn't a successful confirm_delivery of it`)
  check(now?.status === "Delivered" && now.reference_price === a?.args.reference_price && now.customer === a?.args.customer, `#${b.purchase}: the contract shows ${JSON.stringify(now)}`)
  if (failed === before) verified++
  console.log(`${failed === before ? "✔" : "✘"} #${String(b.purchase).padEnd(2)} ${usd(a?.args.reference_price ?? 0)} ${JSON.stringify(now?.mode)} cashback ${usd(now?.cashback ?? 0)}  ${nearblocks(b.admit)}  ${nearblocks(b.settle)}`)
}
console.log(`${verified}/${ev.buys.length} buys verified on ${contract}`)

// ---------- NEP-141 deposit ----------
console.log("\nUSDC deposit (NEP-141 ft_transfer_call, relayed as a NEP-366 meta transaction)")
{
  const d = await tx(ev.deposit.hash, ev.deposit.sender)
  const inner = d.transaction.actions[0]?.Delegate?.delegate_action
  const c = inner?.actions[0]?.FunctionCall
  const args = c ? JSON.parse(Buffer.from(c.args, "base64").toString()) : {}
  const credited = d.receipts_outcome.some((r) => r.outcome.executor_id === contract && r.outcome.logs.some((l) => l.includes('"event":"deposit"')))
  const ok = check(succeeded(d) && inner?.receiver_id === config.usdc && c?.method_name === "ft_transfer_call" && args.receiver_id === contract && credited, `${ev.deposit.hash} isn't a credited USDC deposit`)
  console.log(`${ok ? "✔" : "✘"} ${usd(args.amount ?? 0)} by ${d.transaction.receiver_id}, gas paid by ${d.transaction.signer_id}  ${nearblocks(ev.deposit.hash)}`)
}

// ---------- one refill, leg by leg ----------
const r = ev.refill
console.log(`\nBitrefill credit refill ${r.id}: treasury → 1Click → Base wallet → Bitrefill invoice`)
{
  const send = await tx(r.send, r.treasury)
  const transfer = send.transaction.actions.map((_, i) => fn(send, i)).find((c) => c?.method === "ft_transfer")
  const ok = check(succeeded(send) && send.transaction.receiver_id === config.usdc && transfer?.args.receiver_id === r.depositAddress && transfer?.args.amount === r.amountIn, `${r.send} isn't the treasury's payment to the 1Click deposit address`)
  console.log(`${ok ? "✔" : "✘"} 1. ${r.treasury} paid ${usd(r.amountIn)} USDC to 1Click deposit address ${r.depositAddress.slice(0, 8)}…  ${nearblocks(r.send)}`)
}
const status = await (await fetch(`https://1click.chaindefuser.com/v0/status?depositAddress=${r.depositAddress}`)).json()
const delivery = status.swapDetails?.destinationChainTxHashes?.find((h: { hash: string }) => h.hash.startsWith("0x"))?.hash as `0x${string}` | undefined
{
  const ok = check(status.status === "SUCCESS" && status.quoteResponse?.quoteRequest?.recipient?.toLowerCase() === r.baseWallet.toLowerCase() && status.swapDetails?.amountOut === r.amountOut && status.swapDetails?.originChainTxHashes?.some((h: { hash: string }) => h.hash === r.send), `1Click reports ${status.status} for ${r.depositAddress}`)
  console.log(`${ok ? "✔" : "✘"} 2. 1Click settled: ${status.status}, ${usd(status.swapDetails?.amountOut ?? 0)} USDC to our Base wallet ${r.baseWallet}  https://explorer.near-intents.org/transactions/${r.depositAddress}`)
}
const transferred = async (hash: `0x${string}`, from: string | undefined, to: string, amount: string) => {
  const receipt = await baseClient.getTransactionReceipt({ hash })
  const topic = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`
  return receipt.status === "success" && receipt.logs.some((l) =>
    l.address.toLowerCase() === USDC_BASE && l.topics[0] === TRANSFER && (from === undefined || l.topics[1] === topic(from)) && l.topics[2] === topic(to) && BigInt(l.data) === BigInt(amount))
}
{
  const ok = check(delivery !== undefined && await transferred(delivery, undefined, r.baseWallet, r.amountOut), `no Base transfer of ${usd(r.amountOut)} USDC into ${r.baseWallet}`)
  console.log(`${ok ? "✔" : "✘"} 3. ${usd(r.amountOut)} USDC arrived in the Base wallet  ${basescan(delivery ?? "?")}`)
}
{
  const sign = await tx(r.sign, r.treasury)
  const payload = fn(sign)?.args.request?.payload_v2?.Ecdsa as string | undefined
  const p = await baseClient.getTransaction({ hash: r.payment })
  if (p.type !== "eip1559") throw new Error(`${r.payment} is a ${p.type} transaction; Base.ts sends eip1559`)
  const unsigned = keccak256(serializeTransaction({
    type: "eip1559", chainId: p.chainId, nonce: p.nonce, gas: p.gas, maxFeePerGas: p.maxFeePerGas, maxPriorityFeePerGas: p.maxPriorityFeePerGas,
    to: p.to, value: p.value, data: p.input, accessList: p.accessList
  }))
  const ok4 = check(succeeded(sign) && sign.transaction.receiver_id === "v1.signer" && `0x${payload}` === unsigned, `${r.sign} didn't sign ${r.payment}`)
  console.log(`${ok4 ? "✔" : "✘"} 4. ${r.treasury} signed the Base payment through Chain Signatures (v1.signer; payload = its hash ${unsigned.slice(0, 10)}…)  ${nearblocks(r.sign)}`)
  const ok5 = check(p.from.toLowerCase() === r.baseWallet.toLowerCase() && await transferred(r.payment, r.baseWallet, r.payAddress, r.amountOut), `${r.payment} isn't the wallet's ${usd(r.amountOut)} payment to ${r.payAddress}`)
  console.log(`${ok5 ? "✔" : "✘"} 5. The Base wallet paid ${usd(r.amountOut)} USDC to Bitrefill invoice ${r.invoice} (address ${r.payAddress})  ${basescan(r.payment)}`)
}

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
