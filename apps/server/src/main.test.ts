import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { KeyPair } from "near-api-js"

// A mainnet server refuses to start half-configured. It dies before building anything, so this
// runs the real entry point with a made-up .env and reads why it stopped.

const MAINNET = {
  NEAR_NETWORK: "mainnet",
  DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
  WEB_ORIGIN: "https://luckout.example",
  LUCKOUT_CONTRACT_ID: "app.luckout.near",
  OPERATOR_ACCOUNT_ID: "server.luckout.near",
  OPERATOR_PRIVATE_KEY: "ed25519:none",
  BITREFILL_API_KEY: "none",
  BITREFILL_CLIENT_ID: "none",
  BITREFILL_CLIENT_SECRET: "none",
  // Nothing reachable, in case it ever gets past the check.
  BASE_RPC_URL: "http://127.0.0.1:1",
  NEAR_RPC_URL: "http://127.0.0.1:1",
  BITREFILL_API_URL: "http://127.0.0.1:1",
  ALERT_TELEGRAM_CHAT_ID: "1",
  ADMIN_ACCOUNTS: "boss.near"
}
const refusal = (env: Record<string, string>) => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("./main.ts", import.meta.url))], {
    env: { PATH: process.env.PATH ?? "", ...MAINNET, ...env },
    encoding: "utf8",
    timeout: 30_000
  })
  assert.equal(r.status, 1)
  return /also needs (.*)/.exec(r.stdout + r.stderr)?.[1]
}

test("the operator key is checked on chain before the database is touched", () => {
  // A complete .env with a real key, and nothing reachable: it stops at the key, not at the database.
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("./main.ts", import.meta.url))], {
    env: {
      PATH: process.env.PATH ?? "",
      ...MAINNET,
      OPERATOR_PRIVATE_KEY: KeyPair.fromRandom("ed25519").toString(),
      TELEGRAM_BOT_TOKEN: "none",
      REDEMPTION_KEY: "ab".repeat(32),
      SESSION_SECRET: "x".repeat(32)
    },
    encoding: "utf8",
    timeout: 60_000
  })
  assert.equal(r.status, 1)
  assert.match(r.stdout + r.stderr, /OPERATOR_PRIVATE_KEY: couldn't read the key on chain/)
})

test("mainnet needs the bot for alerts, a 32-byte REDEMPTION_KEY and a long SESSION_SECRET", () => {
  assert.equal(
    refusal({ SESSION_SECRET: "short", REDEMPTION_KEY: "ab".repeat(31) }),
    "TELEGRAM_BOT_TOKEN, REDEMPTION_KEY as 64 hex characters, SESSION_SECRET of at least 32 characters"
  )
  assert.equal(refusal({ SESSION_SECRET: "x".repeat(32), REDEMPTION_KEY: "AB".repeat(32) }), "TELEGRAM_BOT_TOKEN", "strong keys pass")
})
