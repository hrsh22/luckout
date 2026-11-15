import { ConfigProvider, Effect, Exit, Layer } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { DbMemory, DeploymentLock } from "./Db.ts"

const start = (env: Record<string, string>) =>
  Layer.build(DeploymentLock).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))))

test("a database stays with the deployment that first used it: staging and production never share one", async () => {
  const exits = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const production = { NEAR_NETWORK: "mainnet", LUCKOUT_CONTRACT_ID: "app.luckout.near" }
    return [
      yield* Effect.exit(start(production)),
      yield* Effect.exit(start(production)),
      yield* Effect.exit(start({ NEAR_NETWORK: "mainnet", LUCKOUT_CONTRACT_ID: "app.luckout-staging.near" })),
      yield* Effect.exit(start({ NEAR_NETWORK: "testnet" }))
    ]
  })).pipe(Effect.provide(DbMemory)))
  assert.deepEqual(exits.map(Exit.isSuccess), [true, true, false, false])
})
