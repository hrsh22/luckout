import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { actions, buildDelegateAction, encodeDelegateAction, encodeSignedDelegate, KeyPair, Signature } from "near-api-js"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { DbMemory } from "./Db.ts"
import { Near, type Outcome } from "./Near.ts"
import { RelaySettings } from "@luckout/api"
import { DEFAULT_SETTINGS, refusal, Relay, USDC_REGISTRATION } from "./Relay.ts"

// The relayer pays only for our own calls, exactly as the app makes them, and checks what the
// network would refuse before it spends anything. NEAR is faked; the database is in memory.
process.env.NEAR_NETWORK = "testnet"

const APP = "app.luckout.testnet"
const USDC = "usdc.luckout.testnet"
const ALICE = "alice.testnet"
const allow = { accountId: ALICE, contractId: APP, usdcId: USDC, testnet: true }
const key = KeyPair.fromRandom("ed25519")
const stranger = KeyPair.fromRandom("ed25519")

const delegate = (
  receiverId: string,
  method: string,
  args: object,
  deposit: bigint,
  o: { sender?: string; gas?: bigint; nonce?: bigint; signer?: KeyPair; claimed?: KeyPair; extra?: boolean } = {}
) => {
  const call = actions.functionCall(method, args, o.gas ?? 30_000_000_000_000n, deposit)
  const d = buildDelegateAction({
    senderId: o.sender ?? ALICE,
    receiverId,
    actions: o.extra ? [call, call] : [call],
    nonce: o.nonce ?? 11n,
    maxBlockHeight: 1_000n,
    publicKey: (o.claimed ?? key).getPublicKey()
  })
  const sig = (o.signer ?? key).sign(createHash("sha256").update(encodeDelegateAction(d)).digest())
  const signed = { delegateAction: d, signature: new Signature({ keyType: 0, data: sig.signature }) }
  return { d, b64: Buffer.from(encodeSignedDelegate(signed as never)).toString("base64") }
}

test("only our own calls, with the exact deposit each needs, are paid for", () => {
  const ok = [
    delegate(APP, "withdraw", { amount: "5" }, 1n),
    delegate(APP, "set_default_mode", { mode: "normal" }, 1n),
    delegate(APP, "set_limits", { per_purchase: "1", daily: "1" }, 1n),
    delegate(USDC, "ft_transfer_call", { receiver_id: APP, amount: "5", msg: "" }, 1n, { gas: 100_000_000_000_000n }),
    delegate(USDC, "storage_deposit", { account_id: ALICE, registration_only: true }, USDC_REGISTRATION),
    delegate(USDC, "faucet", {}, 0n)
  ]
  for (const { d } of ok) assert.equal(refusal(d, allow), undefined, d.actions[0]!.functionCall!.methodName)

  const no = [
    delegate(APP, "withdraw", { amount: "5" }, 1n, { sender: "mallory.testnet" }),
    delegate(APP, "withdraw", { amount: "5" }, 1n, { extra: true }),
    delegate("other.testnet", "anything", {}, 0n),
    delegate(USDC, "ft_transfer_call", { receiver_id: "mallory.testnet", amount: "5", msg: "" }, 1n),
    delegate(USDC, "ft_transfer", { receiver_id: APP, amount: "5" }, 1n),
    delegate(APP, "withdraw", { amount: "5" }, 10n ** 24n),
    delegate(APP, "set_limits", { per_purchase: "1", daily: "1" }, 0n),
    delegate(USDC, "storage_deposit", { account_id: "mallory.testnet", registration_only: true }, USDC_REGISTRATION),
    delegate(USDC, "storage_deposit", { account_id: ALICE }, USDC_REGISTRATION),
    delegate(APP, "withdraw", { amount: "5" }, 1n, { gas: 300_000_000_000_000n })
  ]
  for (const { d } of no) assert.ok(refusal(d, allow), JSON.stringify(d.actions[0]!.functionCall?.methodName))
  assert.ok(refusal(delegate(USDC, "faucet", {}, 0n).d, { ...allow, testnet: false }), "no faucet on mainnet")
})

const world = (o: { relayer?: boolean; nonce?: bigint; fullAccess?: boolean; failures?: Array<string> } = {}) => {
  const relayed: Array<string> = []
  const resumed: Array<string> = []
  const outcome = (hash: string): Outcome => ({ hash, value: null, events: [], failures: o.failures ?? [] })
  const near = Near.of({
    contractId: APP,
    operatorId: "server.test",
    relayerId: o.relayer === false ? undefined : "relayer.test",
    view: <A>() => Effect.succeed(null as A),
    call: () => Effect.die("not used"),
    relay: (sd, persist) =>
      Effect.gen(function*() {
        const hash = `tx-${relayed.length + 1}`
        relayed.push(sd.delegateAction.actions[0]!.functionCall!.methodName)
        yield* persist({ hash, bytes: "" })
        return outcome(hash)
      }),
    resume: (signed) => Effect.sync(() => (resumed.push(signed.hash), outcome(signed.hash))),
    accessKey: (_, publicKey) =>
      Effect.succeed(publicKey === key.getPublicKey().toString() ? { nonce: o.nonce ?? 10n, fullAccess: o.fullAccess ?? true } : undefined),
    height: Effect.succeed(500n),
    account: () => Effect.die("not used"),
    verifySignIn: () => Effect.succeed(false)
  })
  const layer = Relay.layer.pipe(Layer.provide(Layer.succeed(Near, near)), Layer.provideMerge(DbMemory))
  const send = (b64: string) => Relay.use((r) => r.send(ALICE, b64))
  const run = <A, E>(e: Effect.Effect<A, E, Relay | SqlClient.SqlClient>) => Effect.runPromise(e.pipe(Effect.provide(layer)))
  const tag = <A, E>(e: Effect.Effect<A, E, Relay | SqlClient.SqlClient>) =>
    run(e.pipe(Effect.match({ onFailure: (err) => (err as { _tag: string; message: string }), onSuccess: () => ({ _tag: "ok", message: "" }) })))
  return { relayed, resumed, send, run, tag }
}

const withdraw = (o: Parameters<typeof delegate>[4] = {}) => delegate(APP, "withdraw", { amount: "5" }, 1n, o).b64

test("a valid call is relayed once; the same signature again gets the first result, not a second fee", async () => {
  const w = world()
  const b64 = withdraw()
  const [a, b] = await w.run(Effect.gen(function*() {
    return [yield* w.send(b64), yield* w.send(b64)]
  }))
  assert.equal(a.hash, "tx-1")
  assert.equal(b.hash, "tx-1")
  assert.deepEqual(w.relayed, ["withdraw"])
  assert.deepEqual(w.resumed, ["tx-1"])
})

test("what the network would refuse is refused before we pay", async () => {
  const cases: Array<[string, ReturnType<typeof world>, string]> = [
    ["signed by another key", world(), withdraw({ signer: stranger })],
    ["a key that isn't on the account", world(), withdraw({ signer: stranger, claimed: stranger })],
    ["a used nonce", world({ nonce: 11n }), withdraw()],
    ["a function-call key", world({ fullAccess: false }), withdraw()],
    ["not a delegate at all", world(), Buffer.from("hello").toString("base64")]
  ]
  for (const [name, w, b64] of cases) {
    const r = await w.tag(w.send(b64))
    assert.equal(r._tag, "RelayFailed", name)
    assert.deepEqual(w.relayed, [], name)
  }
})

test("a call that fails onchain says why", async () => {
  const w = world({ failures: ["Not enough unlocked balance"] })
  const r = await w.tag(w.send(withdraw()))
  assert.deepEqual([r._tag, r.message], ["RelayFailed", "Not enough unlocked balance"])
})

test("no relayer, or today's free relays used up: the wallet pays instead", async () => {
  const off = world({ relayer: false })
  assert.equal((await off.tag(off.send(withdraw())))._tag, "RelayUnavailable")
  assert.equal(await off.run(Relay.use((r) => r.available(ALICE))), false)

  const w = world()
  const r = await w.run(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    for (let i = 0; i < DEFAULT_SETTINGS.perAccountDaily; i++) {
      yield* sql`INSERT INTO relays (delegate_hash, account_id, signed_tx) VALUES (${`h${i}`}, ${ALICE}, '{}'::jsonb)`
    }
    const available = yield* Relay.use((r) => r.available(ALICE))
    const other = yield* Relay.use((r) => r.available("bob.testnet"))
    const sent = yield* w.send(withdraw()).pipe(Effect.match({ onFailure: (e) => e._tag, onSuccess: () => "ok" }))
    return { available, other, sent }
  }))
  assert.deepEqual(r, { available: false, other: true, sent: "RelayUnavailable" })
  assert.deepEqual(w.relayed, [])
})


test("the admin switch and caps apply to the next relay", async () => {
  const w = world()
  const r = await w.run(Effect.gen(function*() {
    const relay = yield* Relay
    yield* relay.configure(new RelaySettings({ enabled: false, perAccountDaily: 20, allDaily: 500 }), "admin.testnet")
    const off = yield* relay.available(ALICE)
    const sent = yield* w.send(withdraw()).pipe(Effect.match({ onFailure: (e) => e._tag, onSuccess: () => "ok" }))
    yield* relay.configure(new RelaySettings({ enabled: true, perAccountDaily: 0, allDaily: 500 }), "admin.testnet")
    const noQuota = yield* relay.available(ALICE)
    yield* relay.configure(DEFAULT_SETTINGS, "admin.testnet")
    return { off, sent, noQuota, back: yield* relay.available(ALICE), saved: yield* relay.settings }
  }))
  assert.deepEqual({ ...r, saved: { ...r.saved } }, { off: false, sent: "RelayUnavailable", noQuota: false, back: true, saved: { ...DEFAULT_SETTINGS } })
  assert.deepEqual(w.relayed, [])
})
