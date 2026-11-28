import assert from "node:assert/strict"
import { test } from "node:test"
import { onPrivy, privyWallet, type Saved, stillMaking } from "./session-rules.ts"

const alice: Saved = { accountId: "AliceWallet111", wallet: "solana", expiresAt: 2_000_000_000_000 }
const now = 1_900_000_000_000

test("the account is the Privy Solana wallet, not an external one or an Ethereum one", () => {
  const phantom = { type: "wallet", address: "Phantom111", chainType: "solana", walletClientType: "phantom" }
  const eth = { type: "wallet", address: "0xabc", chainType: "ethereum", walletClientType: "privy" }
  const privy = { type: "wallet", address: "Privy111", chainType: "solana", walletClientType: "privy" }
  assert.equal(privyWallet({ linkedAccounts: [{ type: "email", address: "a@b.c" }, phantom, eth, privy] }), "Privy111")
  assert.equal(privyWallet({ linkedAccounts: [phantom] }), undefined, "signed in with Phantom, Privy's wallet not made yet")
  assert.equal(privyWallet(null), undefined)
})

test("a saved session comes back only for the same Privy wallet, unexpired; otherwise Privy's sign-in makes a new one", () => {
  assert.equal(onPrivy({ saved: alice, wallet: alice.accountId, now }), "restore")
  assert.equal(onPrivy({ saved: alice, wallet: "BobWallet111", now }), "sign in", "someone else signed in to Privy here")
  assert.equal(onPrivy({ saved: { ...alice, expiresAt: now - 1 }, wallet: alice.accountId, now }), "sign in", "ours expired, Privy's hasn't")
  assert.equal(onPrivy({ saved: undefined, wallet: alice.accountId, now }), "sign in")
  assert.equal(onPrivy({ saved: alice, wallet: undefined, now }), "end", "signed out of Privy: ours ends too")
})

test("only the server's 'still being made' refusal is retried", () => {
  assert.ok(stillMaking({ _tag: "Unauthorized", message: "Your Solana wallet is still being made; try again in a moment" }))
  assert.ok(!stillMaking({ _tag: "Unauthorized", message: "That access token is for another app" }))
  assert.ok(!stillMaking(undefined))
})
