// Live check of the treasury on testnet (ADR-0009), signing the way the server does (Near.treasurySend):
// - a pull the token can't deliver (treasury not registered on USDC) puts the proceeds and the cap back;
// - the treasury registers itself, then pulls 1 USDC: proceeds go down, the treasury's USDC goes up;
// - a pull past the owner's daily cap is refused and moves nothing.
// Needs TREASURY_ACCOUNT_ID's key in ~/.near-credentials/testnet. Usage: node scripts/treasury.ts
import { ConfigProvider, Effect } from "effect"
import { actions, teraToGas } from "near-api-js"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { ContractRejected, Near } from "../src/Near.ts"

const treasury = process.env.TREASURY_ACCOUNT_ID ?? "treasury.luckout.testnet"
const key = JSON.parse(readFileSync(`${homedir()}/.near-credentials/testnet/${treasury}.json`, "utf8")).private_key as string
const env = { ...(process.env as Record<string, string>), NEAR_NETWORK: "testnet", TREASURY_ACCOUNT_ID: treasury, TREASURY_PRIVATE_KEY: key }

await Effect.runPromise(Effect.gen(function*() {
  const near = yield* Near
  const state = Effect.all({
    proceeds: near.view<{ proceeds: string }>("get_reserve").pipe(Effect.map((r) => BigInt(r.proceeds))),
    config: near.view<{ treasury: string; sweep_daily_cap: string; swept_today: string }>("get_config"),
    usdc: near.view<string>("ft_balance_of", { account_id: treasury }, near.usdcId).pipe(Effect.map(BigInt))
  })
  const pull = (amount: bigint) =>
    near.treasurySend(near.contractId, [actions.functionCall("sweep_proceeds", { amount: String(amount) }, teraToGas("60"), 1n)], () => Effect.void)

  const start = yield* state
  assert.equal(start.config.treasury, treasury, "the contract must point at this treasury")
  console.log(`Treasury ${treasury}: ${Number(start.usdc) / 1e6} USDC. Proceeds ${Number(start.proceeds) / 1e6}, cap ${Number(start.config.sweep_daily_cap) / 1e6}/day, ${Number(start.config.swept_today) / 1e6} pulled today.`)

  const registered = (yield* near.view<unknown>("storage_balance_of", { account_id: treasury }, near.usdcId)) !== null
  if (!registered) {
    const o = yield* pull(1_000_000n)
    const after = yield* state
    assert.ok(o.failures.length > 0, "the transfer to an unregistered account fails")
    assert.equal(after.proceeds, start.proceeds, "and the proceeds come back")
    assert.equal(after.config.swept_today, start.config.swept_today, "and so does the cap")
    console.log(`✔ A pull the token couldn't deliver put the proceeds and the cap back (${o.hash})`)
    const bounds = yield* near.view<{ min: string }>("storage_balance_bounds", {}, near.usdcId)
    yield* near.treasurySend(
      near.usdcId,
      [actions.functionCall("storage_deposit", { account_id: treasury, registration_only: true }, teraToGas("10"), BigInt(bounds.min))],
      () => Effect.void
    )
    console.log("✔ The treasury registered itself on USDC")
  }

  const before = yield* state
  const o = yield* pull(1_000_000n)
  const after = yield* state
  assert.equal(o.failures.length, 0, o.failures.join("; "))
  assert.equal(after.proceeds, before.proceeds - 1_000_000n)
  assert.equal(after.usdc, before.usdc + 1_000_000n)
  console.log(`✔ Pulled 1 USDC of proceeds into the treasury (${o.hash})`)

  // Past whichever binds first: today's cap, or the proceeds themselves.
  const left = BigInt(after.config.sweep_daily_cap) - BigInt(after.config.swept_today)
  const capBinds = left < after.proceeds
  const refused = yield* pull((capBinds ? left : after.proceeds) + 1n).pipe(Effect.flip)
  assert.ok(refused instanceof ContractRejected && (capBinds ? /daily cap/ : /Exceeds proceeds/).test(refused.message), String(refused))
  const end = yield* state
  assert.equal(end.proceeds, after.proceeds, "nothing moved")
  console.log(`✔ A pull past ${capBinds ? "today's cap" : "the proceeds"} was refused: "${refused.message}"`)
}).pipe(
  Effect.provide(Near.layer),
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))
))
