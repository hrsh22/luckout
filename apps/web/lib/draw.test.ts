import assert from "node:assert/strict"
import { test } from "node:test"
import { verify } from "./draw.ts"

// The first testnet Draw: tx 77EAmNVpwoqL62byNaPmES54vJmRMChfzL5LrMb8NxFQ on app.luckout.testnet.
const jackpot = {
  name: "Jackpot",
  premium_bps: 5000,
  outcomes: [{ final_bps: 0, chance_bps: 1000 }, { final_bps: 5000, chance_bps: 1500 }, { final_bps: 10000, chance_bps: 2800 }, { final_bps: 15000, chance_bps: 4700 }]
}
const event = {
  purchase_id: 0,
  customer: "alice.luckout.testnet",
  game_version: 2,
  reference_price: "6000000",
  lucky_amount: "6000000",
  max_price: "9000000",
  seed: "508e58c111c794905b24e9b3286a71a3c675e14ae8f412c6a98e1bc706ab510c",
  random: "01de7648033d12c60e9648769b729dce840c57bb72fe195f043034491bd04f8d",
  roll: 8993,
  final_bps: 15000,
  final_price: "9000000",
  cashback: "0"
}

test("a real testnet Draw recomputes exactly", async () => {
  const checks = await verify(event, jackpot)
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks))
})

test("a tampered Draw is caught", async () => {
  const checks = await verify({ ...event, roll: 12, final_price: "0", cashback: "9000000" }, jackpot)
  assert.deepEqual(checks.filter((c) => !c.ok).map((c) => c.label), ["Roll", "Final Price", "Cashback"])
})
