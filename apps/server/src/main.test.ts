import { NodeHttpServer } from "@effect/platform-node"
import { BitrefillUnavailable, CatalogApi } from "@luckout/api"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { Bitrefill, NO_SUCH_VOUCHER } from "./Bitrefill.ts"
import { CatalogHandlers } from "./main.ts"
import { Purchases } from "./Purchases.ts"
import { fakeBitrefill } from "./testing.ts"

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

test("mainnet needs the bot for alerts, a 32-byte REDEMPTION_KEY and a long SESSION_SECRET", () => {
  assert.equal(
    refusal({ SESSION_SECRET: "short", REDEMPTION_KEY: "ab".repeat(31) }),
    "TELEGRAM_BOT_TOKEN, REDEMPTION_KEY as 64 hex characters, SESSION_SECRET of at least 32 characters"
  )
  assert.equal(refusal({ SESSION_SECRET: "x".repeat(32), REDEMPTION_KEY: "AB".repeat(32) }), "TELEGRAM_BOT_TOKEN", "strong keys pass")
})

// The catalog endpoints exactly as main.ts handles them, with Bitrefill faked.
test("a card's page answers 404 for a card Bitrefill doesn't sell, and 503 when its price can't be had", async () => {
  const asked: Array<unknown> = []
  const { handler, dispose } = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HttpApi.make("luckout").add(CatalogApi)).pipe(
      Layer.provide(CatalogHandlers),
      Layer.provide([
        Layer.succeed(Bitrefill, fakeBitrefill({
          voucher: (id, options) => {
            asked.push(options)
            return Effect.fail(new BitrefillUnavailable({ message: id === "made-up" ? NO_SUCH_VOUCHER : "Prices are busy right now; try again in a minute" }))
          }
        })),
        Layer.succeed(Purchases, { useBy: () => Effect.succeed(undefined) } as unknown as Purchases["Service"]),
        NodeHttpServer.layerHttpServices
      ])
    ),
    { disableLogger: true }
  )
  try {
    const missing = await handler(new Request("http://luckout.test/catalog/made-up"))
    const busy = await handler(new Request("http://luckout.test/catalog/amazon-us"))
    assert.equal(missing.status, 404)
    assert.equal(busy.status, 503)
    assert.match((await busy.json() as { message: string }).message, /busy/)
    assert.deepEqual(asked, [{ page: true }, { page: true }], "the page asks for a price it may keep 10 minutes")
  } finally {
    await dispose()
  }
})
