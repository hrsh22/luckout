import assert from "node:assert/strict"
import { test } from "node:test"
import { toast } from "sonner"
import { oneAtATime } from "./utils.ts"

test("a second wallet request while one is open is refused, and the next one after it goes through", async () => {
  let ran = 0
  let finish!: (ok: boolean) => void
  const first = oneAtATime(() => new Promise<boolean>((resolve) => (ran++, (finish = resolve))))
  // Open: the second is refused without running, and says why instead of doing nothing.
  assert.equal(toast.getToasts().length, 0)
  assert.equal(await oneAtATime(async () => (ran++, true)), false)
  assert.equal(ran, 1)
  assert.match(JSON.stringify(toast.getToasts()), /request open in your wallet/)
  finish(true)
  assert.equal(await first, true)
  // Closed: the next one runs.
  assert.equal(await oneAtATime(async () => (ran++, true)), true)
  assert.equal(ran, 2)
  // A request that throws still frees the wallet.
  await assert.rejects(oneAtATime(async () => {
    throw new Error("the wallet broke")
  }))
  assert.equal(await oneAtATime(async () => true), true)
})
