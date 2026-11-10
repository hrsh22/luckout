import assert from "node:assert/strict"
import { test } from "node:test"
import { otherNetworkAccounts } from "./Near.ts"

// A server refuses to start when its .env names accounts from the other network.

test("a mainnet .env with a testnet account is caught, and the reverse", () => {
  assert.deepEqual(
    otherNetworkAccounts("mainnet", {
      LUCKOUT_CONTRACT_ID: "app.luckout.near",
      USDC_CONTRACT_ID: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      TREASURY_ACCOUNT_ID: "treasury.luckout.testnet",
      ADMIN_ACCOUNTS: "boss.near, luckout.testnet"
    }),
    ["TREASURY_ACCOUNT_ID=treasury.luckout.testnet", "ADMIN_ACCOUNTS=luckout.testnet"]
  )
  assert.deepEqual(otherNetworkAccounts("testnet", { OPERATOR_ACCOUNT_ID: "server.luckout.near" }), ["OPERATOR_ACCOUNT_ID=server.luckout.near"])
  assert.deepEqual(otherNetworkAccounts("testnet", { LUCKOUT_CONTRACT_ID: "app.luckout.testnet", RELAYER_ACCOUNT_ID: undefined }), [])
})
