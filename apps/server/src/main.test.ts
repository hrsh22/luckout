import { NodeHttpServer } from "@effect/platform-node"
import { BitrefillUnavailable, CatalogApi, ProgramInfo, SystemApi } from "@luckout/api"
import { Cause, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { MODES } from "../../web/lib/modes.ts"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { Keypair } from "@solana/web3.js"
import { Bitrefill, NO_SUCH_VOUCHER } from "./Bitrefill.ts"
import { CatalogHandlers, readProgram, SystemHandlers } from "./main.ts"
import { base58 } from "./Program.ts"
import { Purchases } from "./Purchases.ts"
import { Sales } from "./Sales.ts"
import { Chain, checkKeys } from "./Solana.ts"
import { Telegram } from "./Telegram.ts"
import { fakeBitrefill, solanaLayer, solanaWorld } from "./testing.ts"

// A mainnet server refuses to start half-configured. It dies before building anything, so this
// runs the real entry point with a made-up .env and reads why it stopped.

const secret = () => base58.encode(Keypair.generate().secretKey)
const MAINNET = {
  SOLANA_CLUSTER: "mainnet",
  DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
  WEB_ORIGIN: "https://luckout.example",
  SOLANA_PROGRAM_ID: Keypair.generate().publicKey.toBase58(),
  SOLANA_OPERATOR_SECRET_KEY: secret(),
  SOLANA_FEE_PAYER_SECRET_KEY: secret(),
  SOLANA_PAY_WALLET_SECRET_KEY: secret(),
  PRIVY_APP_ID: "none",
  BITREFILL_API_KEY: "none",
  BITREFILL_CLIENT_ID: "none",
  BITREFILL_CLIENT_SECRET: "none",
  // Nothing reachable, in case it ever gets past the check.
  SOLANA_RPC_URL: "http://127.0.0.1:1",
  BITREFILL_API_URL: "http://127.0.0.1:1",
  ALERT_TELEGRAM_CHAT_ID: "1",
  ADMIN_ACCOUNTS: "boss"
}
const start = (env: Record<string, string>) => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("./main.ts", import.meta.url))], {
    env: { PATH: process.env.PATH ?? "", ...MAINNET, ...env },
    encoding: "utf8",
    timeout: 60_000
  })
  assert.equal(r.status, 1)
  return r.stdout + r.stderr
}
const refusal = (env: Record<string, string>) => /also needs (.*)/.exec(start(env))?.[1]

test("SOLANA_CLUSTER=mainnet needs the bot for alerts, a 32-byte REDEMPTION_KEY and a long SESSION_SECRET", () => {
  assert.equal(
    refusal({ SESSION_SECRET: "short", REDEMPTION_KEY: "ab".repeat(31) }),
    "TELEGRAM_BOT_TOKEN, REDEMPTION_KEY as 64 hex characters, SESSION_SECRET of at least 32 characters"
  )
  assert.equal(refusal({ SESSION_SECRET: "x".repeat(32), REDEMPTION_KEY: "AB".repeat(32) }), "TELEGRAM_BOT_TOKEN", "strong keys pass")
  assert.equal(
    refusal({ SESSION_SECRET: "x".repeat(32), REDEMPTION_KEY: "ab".repeat(32), TELEGRAM_BOT_TOKEN: "none", SOLANA_RPC_URL: "", SOLANA_PAY_WALLET_SECRET_KEY: "" }),
    "SOLANA_RPC_URL, SOLANA_PAY_WALLET_SECRET_KEY",
    "a paid RPC and every key of ours"
  )
})

test("the keys are checked against the program before the database is touched", () => {
  // A complete .env, and nothing reachable: it stops at reading the program's Config, not at the database.
  const out = start({ TELEGRAM_BOT_TOKEN: "none", REDEMPTION_KEY: "ab".repeat(32), SESSION_SECRET: "x".repeat(32) })
  assert.match(out, /couldn't read the program's Config/)
})

test("checkKeys refuses an operator, or a Pay Wallet, that isn't the program's", async () => {
  const world = solanaWorld()
  const check = (env: Record<string, string>) => Effect.runPromiseExit(checkKeys.pipe(Effect.provide(solanaLayer({ ...world, env: { ...world.env, ...env } }))))
  assert.equal((await check({}))._tag, "Success", "the world's own keys")
  const operator = Keypair.generate()
  const wrong = await check({ SOLANA_OPERATOR_SECRET_KEY: base58.encode(operator.secretKey) })
  assert.ok(wrong._tag === "Failure")
  assert.match(String(Cause.squash(wrong.cause)), new RegExp(`SOLANA_OPERATOR_SECRET_KEY is ${operator.publicKey.toBase58()}, but the program's operator is ${world.operator.publicKey.toBase58()}`))
  const payWallet = await check({ SOLANA_PAY_WALLET_SECRET_KEY: secret() })
  assert.ok(payWallet._tag === "Failure")
  assert.match(String(Cause.squash(payWallet.cause)), /SOLANA_PAY_WALLET_SECRET_KEY doesn't own the program's Pay Wallet account/)
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

test("the program's public state: its Game Versions are the web app's mode tables, and the Cashback Cap as the program applies it", async () => {
  const world = solanaWorld()
  const p = await Effect.runPromise(readProgram.pipe(Effect.provide(solanaLayer(world))))
  assert.equal(p.cluster, "localnet")
  assert.equal(p.programId, world.program.id.toBase58())
  assert.equal(p.usdcMint, world.mint.toBase58())
  // The shop prices each mode at once from lib/modes.ts; the program decides the real price. They must agree.
  assert.deepEqual(
    p.versions.map((v, n) => ({ mode: { lucky: n }, name: v.name, premiumBps: v.premiumBps, outcomes: [...v.outcomes].sort((a, b) => a.finalBps - b.finalBps) })),
    MODES.slice(1).map((m) => ({ ...m, outcomes: [...m.outcomes].sort((a, b) => a.finalBps - b.finalBps) }))
  )
  assert.equal(p.reserve.free, 1_000_000_000, "the world's $1,000 reserve")
  assert.equal(p.reserve.locked, 0)
  const { fixed, reserveBps } = p.reserve.cashbackCap
  assert.equal(p.reserve.maxCashback, Math.min(fixed ?? Infinity, Math.floor(p.reserve.free * reserveBps / 10_000)))
  assert.equal(p.minLuckyCheckout, 2_500_000)
  assert.deepEqual(p.stats, { luckySettled: 0, luckyAmountTotal: 0, luckyPaidTotal: 0 })
})

test("/program needs no sign-in, and every visitor shares one read for 30 seconds", async () => {
  const world = solanaWorld()
  let reads = 0
  const chain = Chain.of({ ...world.chain, accounts: (keys) => Effect.suspend(() => (reads++, world.chain.accounts(keys))) })
  const { handler, dispose } = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HttpApi.make("luckout").add(SystemApi)).pipe(
      Layer.provide(SystemHandlers),
      Layer.provide([
        solanaLayer({ ...world, chain }),
        Layer.succeed(SqlClient.SqlClient, {} as SqlClient.SqlClient),
        Layer.succeed(Sales, {} as Sales["Service"]),
        Layer.succeed(Telegram, {} as Telegram["Service"]),
        NodeHttpServer.layerHttpServices
      ])
    ),
    { disableLogger: true }
  )
  try {
    const first = await handler(new Request("http://luckout.test/program"))
    assert.equal(first.status, 200)
    const body = Schema.decodeUnknownSync(ProgramInfo)(await first.json())
    assert.equal(body.versions.length, 3)
    const before = reads
    assert.equal((await handler(new Request("http://luckout.test/program"))).status, 200)
    assert.equal(reads, before, "the second visitor got the cached read")
  } finally {
    await dispose()
  }
})
