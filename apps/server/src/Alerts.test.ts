import { ConfigProvider, Effect, Layer, Logger } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { Alerts } from "./Alerts.ts"
import { DbMemory } from "./Db.ts"

// Telegram is faked at fetch: each call takes the next answer (an HTTP status, or "down" for no answer).
const TOKEN = "123456:not-a-real-token"

test("an alert Telegram didn't take is sent again next time; a delivered one isn't repeated within the hour", async () => {
  const answers: Array<number | "down"> = ["down", 500, 200]
  const sent: Array<string> = []
  const logs: Array<string> = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)).text)
    const a = answers.shift() ?? 200
    if (a === "down") throw new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/sendMessage`)
    return new Response("{}", { status: a })
  }) as typeof fetch
  const layer = Alerts.layer.pipe(
    Layer.provide(DbMemory),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { TELEGRAM_BOT_TOKEN: TOKEN, ALERT_TELEGRAM_CHAT_ID: "42", NEAR_NETWORK: "testnet" } }))),
    Layer.provideMerge(Logger.layer([Logger.make((o) => void logs.push(JSON.stringify(o.message)))]))
  )
  try {
    await Effect.runPromise(Effect.gen(function*() {
      const alerts = yield* Alerts
      for (let i = 0; i < 4; i++) yield* alerts.admin("the treasury is empty")
    }).pipe(Effect.provide(layer)))
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(sent.length, 3, "no answer, then a 500, then delivered; the fourth is the same alert within the hour")
  assert.equal(logs.filter((l) => l.includes("alert delivery failed")).length, 2)
  assert.ok(logs.some((l) => l.includes("HTTP 500")))
  assert.ok(!logs.some((l) => l.includes(TOKEN) || l.includes("api.telegram.org")), "never the token or the URL")
})
