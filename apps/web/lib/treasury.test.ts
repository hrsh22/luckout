import assert from "node:assert/strict"
import { test } from "node:test"
import { ourAccounts, treasuryMode } from "./treasury.ts"

test("our accounts are the contract's siblings, so the panel never takes them from the server", () => {
  assert.deepEqual(ourAccounts("app.luckout.near"), { contract: "app.luckout.near", operator: "server.luckout.near", relayer: "relayer.luckout.near", treasury: "treasury.luckout.near" })
  assert.equal(ourAccounts("app.staging.luckout.near")?.treasury, "treasury.staging.luckout.near")
  assert.equal(ourAccounts("app.luckout.testnet")?.operator, "server.luckout.testnet")
  assert.equal(ourAccounts("luckout.testnet"), undefined, "a contract named otherwise: the panel can't tell, so it names none")
})

test("a treasury the server names that isn't ours is refused, never offered as the fix", () => {
  const ours = "treasury.luckout.near"
  // The server (or anything altering its replies) names another account: the owner is never asked to point the contract at it.
  assert.equal(treasuryMode({ accountId: "attacker.near", contractTreasury: ours, dailyCap: 2_500_000_000 }, ours), "server-differs")
  assert.equal(treasuryMode({ accountId: "attacker.near", contractTreasury: "attacker.near", dailyCap: 0 }, ours), "server-differs")
  // The contract points elsewhere, the server is ours: pointing it at ours is the fix.
  assert.equal(treasuryMode({ accountId: ours, contractTreasury: "old.near", dailyCap: 0 }, ours), "mismatch")
  assert.equal(treasuryMode({ accountId: ours, dailyCap: 0 }, ours), "mismatch", "no treasury set yet")
  assert.equal(treasuryMode({ accountId: ours, contractTreasury: ours, dailyCap: 40_000_000 }, ours), "auto")
  assert.equal(treasuryMode({ accountId: ours, contractTreasury: ours, dailyCap: 0 }, ours), "manual")
  assert.equal(treasuryMode({ dailyCap: 0 }, ours), "none", "the server has no treasury key")
  assert.equal(treasuryMode({ accountId: ours, contractTreasury: ours, dailyCap: 0 }, undefined), "unknown")
})
