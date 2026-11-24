import assert from "node:assert/strict"
import { test } from "node:test"
import { TransferReverted } from "./evm.ts"
import { landed } from "./solana.ts"

type Status = { err: unknown; confirmationStatus?: string } | null

/** Solana as the loop sees it: recent statuses in turn, block heights in turn, and what a search of past transactions finds. */
const chain = (o: { statuses: Array<Status>; heights?: Array<number>; history?: Status }) => {
  const asked = { history: 0 }
  const connection = {
    getSignatureStatuses: async (_: Array<string>, config?: { searchTransactionHistory?: boolean }) => {
      if (config?.searchTransactionHistory) asked.history++
      return { context: { slot: 0 }, value: [config?.searchTransactionHistory ? o.history ?? null : o.statuses.length > 1 ? o.statuses.shift()! : o.statuses[0]!] }
    },
    getBlockHeight: async () => (o.heights && o.heights.length > 1 ? o.heights.shift()! : o.heights?.[0] ?? 0)
  }
  return { connection: connection as unknown as Parameters<typeof landed>[0], asked }
}

const LAST_VALID = 449_400_607

test("a transaction that confirms has landed; one that failed on chain moved nothing and may be sent again", async () => {
  assert.equal(await landed(chain({ statuses: [{ err: null, confirmationStatus: "confirmed" }] }).connection, "sig", LAST_VALID), "sig")
  await assert.rejects(landed(chain({ statuses: [{ err: { InstructionError: [2, "Custom"] } }] }).connection, "sig", LAST_VALID), TransferReverted)
})

test("past its blockhash, unseen: the ledger's history decides, so a transfer the RPC missed is never sent twice", async () => {
  const missed = chain({ statuses: [null], heights: [LAST_VALID + 10], history: { err: null, confirmationStatus: "finalized" } })
  assert.equal(await landed(missed.connection, "sig", LAST_VALID), "sig", "it landed after all")
  assert.equal(missed.asked.history, 1)
  await assert.rejects(landed(chain({ statuses: [null], heights: [LAST_VALID + 10] }).connection, "sig", LAST_VALID), TransferReverted, "nowhere: it can never land")
})

test("a block height that is really the slot doesn't end the wait: it keeps checking until the transaction confirms", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  // Reown's RPC answering with the slot, about 22 million ahead, then the transaction confirming.
  const slow = chain({ statuses: [null, null, { err: null, confirmationStatus: "confirmed" }], heights: [LAST_VALID + 22_000_000] })
  let result: string | undefined
  void landed(slow.connection, "sig", LAST_VALID).then((s) => (result = s))
  for (let i = 0; i < 5 && result === undefined; i++) {
    await new Promise((r) => setImmediate(r))
    t.mock.timers.tick(2000)
  }
  assert.equal(result, "sig")
  assert.equal(slow.asked.history, 0, "never judged expired")
})

test("three minutes after sending, an unseen transaction is judged by the ledger even when the height can't be trusted", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const never = chain({ statuses: [null], heights: [LAST_VALID + 22_000_000] })
  let error: unknown
  void landed(never.connection, "sig", LAST_VALID).catch((e) => (error = e))
  // Checked every 2 s: well within 200 checks.
  for (let i = 0; i < 200 && error === undefined; i++) {
    await new Promise((r) => setImmediate(r))
    t.mock.timers.tick(2000)
  }
  assert.ok(error instanceof TransferReverted)
  assert.equal(never.asked.history, 1)
})
