import assert from "node:assert/strict"
import { test } from "node:test"
import { authCallIntent, moveInIntent } from "@luckout/api"
import { contractId, usdcId } from "./chain.ts"
import { asIntent, restoreOutcome, type Saved } from "./session-rules.ts"

const alice: Saved = { accountId: "alice.near", wallet: "near", expiresAt: 2_000_000_000_000 }
const bob: Saved = { accountId: "0xb0b", wallet: "evm", expiresAt: 2_000_000_000_000 }

test("a saved session comes back only if the wallet is still on it, and a late answer never undoes a sign-in made meanwhile", () => {
  assert.equal(restoreOutcome(alice, alice, false, "alice.near"), "restore")
  assert.equal(restoreOutcome(alice, alice, false, "carol.near"), "end", "the wallet moved to another account")
  assert.equal(restoreOutcome(alice, alice, false, undefined), "end", "the wallet is gone, or couldn't be asked")
  // The NEAR connector answered after 8 s, and the customer had signed in with another wallet by then.
  assert.equal(restoreOutcome(alice, bob, false, "alice.near"), "keep", "Bob's newer session is neither replaced nor forgotten")
  assert.equal(restoreOutcome(alice, alice, true, "alice.near"), "keep", "already signed in: nothing to restore")
  assert.equal(restoreOutcome(undefined, bob, false, undefined), "keep", "nothing was saved at first, and Bob's sign-in since is kept")
  assert.equal(restoreOutcome(alice, undefined, false, "alice.near"), "end", "signed out elsewhere meanwhile: not brought back")
  assert.equal(restoreOutcome(undefined, undefined, false, undefined), "end")
})

test("an EVM or Solana wallet signs the contract call a NEAR wallet would send, as a NEAR Intents payload, and nothing else", () => {
  const account = "0xb0b"
  const withdraw = { receiverId: contractId, method: "withdraw", args: { amount: "5000000" }, deposit: "1", tgas: 60 }
  assert.deepEqual(asIntent(account, withdraw), authCallIntent(contractId, { withdraw: { amount: "5000000" } }))
  const deposit = (msg: string) => ({ receiverId: usdcId, method: "ft_transfer_call", args: { receiver_id: contractId, amount: "20000000", msg }, deposit: "1" })
  assert.deepEqual(asIntent(account, deposit("")), moveInIntent({ usdcId, contractId, account, amount: "20000000", mode: undefined }))
  // A first deposit carries Welcome's pick.
  assert.deepEqual(asIntent(account, deposit(JSON.stringify({ mode: { lucky: 1 } }))), moveInIntent({ usdcId, contractId, account, amount: "20000000", mode: { lucky: 1 } }))
  // Anything else is refused before the wallet is asked.
  assert.throws(() => asIntent(account, { ...deposit(""), args: { receiver_id: "someone.near", amount: "20000000", msg: "" } }), /can't do that/)
  assert.throws(() => asIntent(account, deposit("{}")), /can't do that/)
  assert.throws(() => asIntent(account, { receiverId: contractId, method: "withdraw_reserve", args: { amount: "1" } }), /can't do that/)
  assert.throws(() => asIntent(account, { receiverId: usdcId, method: "storage_deposit", args: {} }), /can't do that/)
})
