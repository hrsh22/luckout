import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { actions, buildDelegateAction, encodeDelegateAction, encodeSignedDelegate, KeyPair, Signature } from "near-api-js"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { DbMemory } from "./Db.ts"
import { fakeNear } from "./testing.ts"
import { Near, NearUnavailable, type Outcome, TxExpired } from "./Near.ts"
import { type AuthAction, authCallIntent, intentPayload, intentSignature, moveInIntent, mtTransferArgs, RelaySettings, type SignedIntent, transferIntent } from "@luckout/api"
import { Alerts } from "./Alerts.ts"
import { randomBytes } from "node:crypto"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { refusal, Relay, RELAY_DEFAULTS, USDC_REGISTRATION } from "./Relay.ts"

// The relayer pays only for our own calls, exactly as the app makes them, and checks what the
// network would refuse before it spends anything. NEAR is faked; the database is in memory.
process.env.NEAR_NETWORK = "testnet"

const APP = "app.luckout.testnet"
const USDC = "usdc.luckout.testnet"
const ALICE = "alice.testnet"
const allow = { accountId: ALICE, contractId: APP, usdcId: USDC, intentsId: "intents.test", testnet: true }
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"
const SEND_BACK = { receiverId: "d".repeat(64), token: BASE_USDC, amount: "120132" }
const key = KeyPair.fromRandom("ed25519")
const stranger = KeyPair.fromRandom("ed25519")

/** What `get_purchase` answers for these purchases (id to customer). */
const purchase = (purchases: Record<number, string> | undefined, args: Record<string, unknown> | undefined) => {
  const customer = purchases?.[Number(args?.purchase_id)]
  return customer ? { customer } : null
}
/** Admin alerts land in `into`; "hang" never finishes sending one, like a Telegram that doesn't answer. */
const alertsInto = (into: Array<string> | "hang" = []) =>
  Layer.succeed(Alerts, Alerts.of({ admin: (t) => (into === "hang" ? Effect.never : Effect.sync(() => void into.push(t))), customer: () => Effect.succeed(true) }))
const NEAR_DOWN = new NearUnavailable({ message: "view: fetch failed" })

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

test("a NEAR wallet's send-back is paid for only as quoted: that address, token and amount, with 1 yoctoNEAR", () => {
  const quoted = { ...allow, sendBack: SEND_BACK }
  const mt = (args: object, deposit = 1n) => delegate("intents.test", "mt_transfer", args, deposit).d
  assert.equal(refusal(mt(mtTransferArgs(SEND_BACK)), quoted), undefined)
  const { amount, receiver_id, token_id } = mtTransferArgs(SEND_BACK)
  assert.equal(refusal(mt({ amount, receiver_id, token_id }), quoted), undefined, "keys in another order (the NEAR CLI sorts them)")
  const no: Array<[string, ReturnType<typeof mt>, typeof allow]> = [
    ["never quoted", mt(mtTransferArgs(SEND_BACK)), allow],
    ["more than quoted", mt(mtTransferArgs({ ...SEND_BACK, amount: "120133" })), quoted],
    ["another token", mt(mtTransferArgs({ ...SEND_BACK, token: `nep141:${USDC}` })), quoted],
    ["someone else", mt(mtTransferArgs({ ...SEND_BACK, receiverId: "mallory.near" })), quoted],
    ["with a memo", mt({ ...mtTransferArgs(SEND_BACK), memo: "x" }), quoted],
    ["no deposit", mt(mtTransferArgs(SEND_BACK), 0n), quoted]
  ]
  for (const [name, d, a] of no) assert.ok(refusal(d, a), name)
})

const world = (o: {
  relayer?: boolean
  nonce?: bigint
  fullAccess?: boolean
  failures?: Array<string>
  held?: string
  /** The relayer's first transaction is saved, never reaches NEAR, and has expired by the time it's resumed. */
  lostOnce?: boolean
  /** The caller's Luckout account (null: none yet); by default one with 1,000 USDC. */
  account?: { balance: string } | null
  /** Purchases on the contract, by id: whose each is. */
  purchases?: Record<number, string>
  alerts?: Array<string> | "hang"
  /** NEAR's RPC doesn't answer the reads before a relay. */
  nearDown?: boolean
} = {}) => {
  const relayed: Array<string> = []
  const resumed: Array<string> = []
  const outcome = (hash: string): Outcome => ({ hash, value: null, events: [], failures: o.failures ?? [] })
  const near = fakeNear({
    contractId: APP,
    usdcId: USDC,
    relayerId: o.relayer === false ? undefined : "relayer.test",
    view: <A>(method: string, args?: Record<string, unknown>) =>
      Effect.succeed((
        method === "mt_balance_of"
          ? (o.held ?? "0")
          : method === "get_account"
          ? (o.account === undefined ? { balance: "1000000000" } : o.account)
          : method === "get_purchase"
          ? purchase(o.purchases, args)
          : null
      ) as A),
    relay: (sd, persist) =>
      Effect.gen(function*() {
        const hash = `tx-${relayed.length + 1}`
        relayed.push(sd.delegateAction.actions[0]!.functionCall!.methodName)
        yield* persist({ hash, bytes: "" })
        if (o.lostOnce && relayed.length === 1) return yield* new NearUnavailable({ message: "send: timed out" })
        return outcome(hash)
      }),
    resume: (signed) =>
      o.lostOnce && signed.hash === "tx-1"
        ? Effect.fail(new TxExpired({ hash: signed.hash }))
        : Effect.sync(() => (resumed.push(signed.hash), outcome(signed.hash))),
    accessKey: (_, publicKey) =>
      o.nearDown
        ? Effect.fail(NEAR_DOWN)
        : Effect.succeed(publicKey === key.getPublicKey().toString() ? { nonce: o.nonce ?? 10n, fullAccess: o.fullAccess ?? true } : undefined),
    height: Effect.succeed(500n)
  })
  const layer = Relay.layer.pipe(Layer.provide([Layer.succeed(Near, near), alertsInto(o.alerts)]), Layer.provideMerge(DbMemory))
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

test("a padded copy of a signed call is refused, so it can't dodge the dedupe", async () => {
  const w = world()
  const padded = Buffer.concat([Buffer.from(withdraw(), "base64"), Buffer.from([0])]).toString("base64")
  assert.equal((await w.tag(w.send(padded)))._tag, "RelayFailed")
  assert.deepEqual(w.relayed, [])
})

test("parallel requests can't all pass the cap before one is saved", async () => {
  const w = world()
  const tags = await w.run(Effect.gen(function*() {
    yield* Relay.use((r) => r.configure(new RelaySettings({ enabled: true, perAccountDaily: 1, allDaily: 500 }), "admin.testnet"))
    const sends = [11n, 12n, 13n, 14n, 15n].map((nonce) =>
      w.send(withdraw({ nonce })).pipe(Effect.match({ onFailure: (e) => e._tag, onSuccess: () => "ok" })))
    return yield* Effect.all(sends, { concurrency: "unbounded" })
  }))
  assert.deepEqual(w.relayed, ["withdraw"])
  assert.deepEqual(tags.toSorted(), ["RelayUnavailable", "RelayUnavailable", "RelayUnavailable", "RelayUnavailable", "ok"])
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
    for (let i = 0; i < RELAY_DEFAULTS.testnet.perAccountDaily; i++) {
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
    yield* relay.configure(RELAY_DEFAULTS.testnet, "admin.testnet")
    return { off, sent, noQuota, back: yield* relay.available(ALICE), saved: yield* relay.settings }
  }))
  assert.deepEqual({ ...r, saved: { ...r.saved } }, { off: false, sent: "RelayUnavailable", noQuota: false, back: true, saved: { ...RELAY_DEFAULTS.testnet } })
  assert.deepEqual(w.relayed, [])
})

// ---------- EVM wallets: signed NEAR Intents payloads (ADR-0011) ----------

const evmKey = privateKeyToAccount(generatePrivateKey())
const EVM = evmKey.address.toLowerCase()
const INTENTS = "intents.luckout.testnet"

const signIntent = async (intent: object, nonce = randomBytes(32).toString("base64")): Promise<SignedIntent> => {
  const payload = intentPayload({ signer: EVM, intentsId: INTENTS, deadline: new Date(Date.now() + 600_000), nonce, intents: [intent] })
  return { standard: "erc191", payload, signature: intentSignature(await evmKey.signMessage({ message: payload })) }
}

const intentWorld = (o: {
  nonceUsed?: boolean
  intentsUsdc?: string
  balance?: string
  /** No Luckout account yet. */
  noAccount?: boolean
  purchases?: Record<number, string>
  lostOnce?: boolean
  broke?: boolean
  nearDown?: boolean
} = {}) => {
  const sent: Array<{ receiver: string; method: string; args: unknown }> = []
  const near = fakeNear({
    contractId: APP,
    usdcId: USDC,
    intentsId: INTENTS,
    relayerId: "relayer.test",
    view: <A>(method: string, args?: Record<string, unknown>) =>
      o.nearDown ? Effect.fail(NEAR_DOWN) : Effect.succeed((
        method === "is_nonce_used"
          ? (o.nonceUsed ?? false)
          : method === "mt_balance_of"
          ? (o.intentsUsdc ?? "1000000000")
          : method === "get_account"
          ? (o.noAccount ? null : { balance: o.balance ?? "1000000000" })
          : method === "get_purchase"
          ? purchase(o.purchases, args)
          : null
      ) as A),
    relayerCall: (receiver, method, args, persist) =>
      Effect.gen(function*() {
        const hash = `tx-${sent.length + 1}`
        sent.push({ receiver, method, args })
        yield* persist({ hash, bytes: "" })
        if (o.broke) return yield* new NearUnavailable({ message: "send: NotEnoughBalanceError: Not enough balance for relayer.test (balance: 1, cost: 2)" })
        if (o.lostOnce && sent.length === 1) return yield* new NearUnavailable({ message: "send: timed out" })
        return { hash, value: null, events: [], failures: [] }
      }),
    resume: (signed) =>
      o.lostOnce && signed.hash === "tx-1"
        ? Effect.fail(new TxExpired({ hash: signed.hash }))
        : Effect.succeed({ hash: signed.hash, value: null, events: [], failures: [] })
  })
  const layer = Relay.layer.pipe(Layer.provide([Layer.succeed(Near, near), alertsInto()]), Layer.provideMerge(DbMemory))
  const run = <A, E>(e: Effect.Effect<A, E, Relay | SqlClient.SqlClient>) => Effect.runPromise(e.pipe(Effect.provide(layer)))
  const tag = <A, E>(e: Effect.Effect<A, E, Relay | SqlClient.SqlClient>) =>
    run(e.pipe(Effect.match({ onFailure: (err) => (err as { _tag: string; message: string }), onSuccess: () => ({ _tag: "ok", message: "" }) })))
  const send = (s: SignedIntent, counted = true) => Relay.use((r) => r.sendIntent(EVM, s, { counted }))
  return { sent, run, tag, send }
}

const moveIn = (amount = "5000000") => moveInIntent({ usdcId: USDC, contractId: APP, account: EVM, amount })

test("an EVM customer's signed intent goes to NEAR Intents once; the same payload again gets the first result", async () => {
  const w = intentWorld()
  const s = await signIntent(moveIn())
  const [a, b] = await w.run(Effect.gen(function*() {
    return [yield* w.send(s), yield* w.send(s)]
  }))
  assert.equal(a.hash, "tx-1")
  assert.equal(b.hash, "tx-1")
  assert.equal(w.sent.length, 1)
  assert.deepEqual(w.sent[0], { receiver: INTENTS, method: "execute_intents", args: { signed: [s] } })
})

test("a used nonce, a forged signature or someone else's account is refused before we pay", async () => {
  const used = intentWorld({ nonceUsed: true })
  assert.equal((await used.tag(used.send(await signIntent(moveIn()))))._tag, "RelayFailed")
  assert.equal(used.sent.length, 0)

  const w = intentWorld()
  const s = await signIntent(moveIn())
  const forged = { ...s, payload: s.payload.replace("5000000", "6000000") }
  assert.equal((await w.tag(w.send(forged)))._tag, "RelayFailed")
  const theirs = await w.tag(Relay.use((r) => r.sendIntent("0x" + "3".repeat(40), s)))
  assert.equal(theirs._tag, "RelayFailed")
  assert.equal(w.sent.length, 0)
})

test("a transfer pays only a withdrawal quoted for this account, for exactly its amount", async () => {
  const w = intentWorld()
  const address = "c".repeat(64)
  const transfer = (amount: string) => transferIntent({ receiverId: address, token: `nep141:${USDC}`, amount })
  const before = await w.tag(w.send(await signIntent(transfer("2000000"))))
  assert.equal(before._tag, "RelayFailed", "not quoted yet")
  const results = await w.run(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO intents_swaps (deposit_address, account_id, direction, usdc) VALUES (${address}, ${EVM}, 'out', 2000000)`
    const more = yield* Effect.flip(w.send(yield* Effect.promise(() => signIntent(transfer("3000000")))))
    const exact = yield* w.send(yield* Effect.promise(() => signIntent(transfer("2000000"))))
    return { more: more._tag, exact: exact.hash }
  }))
  assert.deepEqual(results, { more: "RelayFailed", exact: "tx-1" })
})

test("a send-back is paid for, EVM intent or NEAR call, only when quoted for this account and the token is there", async () => {
  // EVM: a transfer intent of the held token, exactly as quoted.
  const w = intentWorld()
  const address = "e".repeat(64)
  const back = (token: string) => transferIntent({ receiverId: address, token, amount: "120132" })
  const evm = await w.run(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO intents_swaps (deposit_address, account_id, direction, usdc, origin_asset, origin_amount)
               VALUES (${address}, ${EVM}, 'back', 0, ${BASE_USDC}, '120132')`
    const usdc = yield* Effect.flip(w.send(yield* Effect.promise(() => signIntent(back(`nep141:${USDC}`)))))
    const ok = yield* w.send(yield* Effect.promise(() => signIntent(back(BASE_USDC))))
    return { usdc: usdc._tag, ok: ok.hash }
  }))
  assert.deepEqual(evm, { usdc: "RelayFailed", ok: "tx-1" })

  // NEAR wallet: its own mt_transfer call on intents.near.
  const quote = Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO intents_swaps (deposit_address, account_id, direction, usdc, origin_asset, origin_amount)
               VALUES (${SEND_BACK.receiverId}, ${ALICE}, 'back', 0, ${BASE_USDC}, '120132')`
  })
  const call = delegate("intents.test", "mt_transfer", mtTransferArgs(SEND_BACK), 1n).b64
  const unquoted = world({ held: "120132" })
  assert.equal((await unquoted.tag(unquoted.send(call)))._tag, "RelayFailed", "not quoted")
  const gone = world({ held: "120131" })
  assert.equal((await gone.tag(Effect.andThen(quote, gone.send(call))))._tag, "RelayFailed", "no longer all there")
  const there = world({ held: "120132" })
  await there.run(Effect.andThen(quote, there.send(call)))
  assert.deepEqual([unquoted.relayed, gone.relayed, there.relayed], [[], [], ["mt_transfer"]])
})

test("daily caps count intents too; a Top-Up's own move-in neither counts nor uses them up", async () => {
  const w = intentWorld()
  const tags = await w.run(Effect.gen(function*() {
    yield* Relay.use((r) => r.configure(new RelaySettings({ enabled: true, perAccountDaily: 1, allDaily: 500 }), "admin.testnet"))
    const own = yield* w.send(yield* Effect.promise(() => signIntent(moveIn("3000000"))), false)
    const one = yield* w.send(yield* Effect.promise(() => signIntent(moveIn("1000000"))))
    const capped = yield* Effect.flip(w.send(yield* Effect.promise(() => signIntent(moveIn("2000000")))))
    return [own.hash, one.hash, capped._tag]
  }))
  assert.deepEqual(tags, ["tx-1", "tx-2", "RelayUnavailable"])
})

test("switching the relayer off stops a Top-Up's own move-in too", async () => {
  const w = intentWorld()
  const tag = await w.run(Effect.gen(function*() {
    yield* Relay.use((r) => r.configure(new RelaySettings({ enabled: false, perAccountDaily: 5, allDaily: 50 }), "admin.testnet"))
    return (yield* Effect.flip(w.send(yield* Effect.promise(() => signIntent(moveIn())), false)))._tag
  }))
  assert.equal(tag, "RelayUnavailable")
  assert.equal(w.sent.length, 0)
})

test("an intent that would fail for want of money is refused before we pay", async () => {
  const poor = intentWorld({ intentsUsdc: "4999999" })
  assert.equal((await poor.tag(poor.send(await signIntent(moveIn("5000000")))))._tag, "RelayFailed")
  const broke = intentWorld({ balance: "999999" })
  const withdraw = authCallIntent(APP, { withdraw: { amount: "1000000" } })
  assert.equal((await broke.tag(broke.send(await signIntent(withdraw))))._tag, "RelayFailed")
  assert.equal(poor.sent.length + broke.sent.length, 0)
})

// ---------- free relays go to calls that can run, and everyone's share is watched ----------

test("a NEAR wallet's call on our contract is paid for only when it can run there; refused, it uses up no free relay", async () => {
  // No Luckout account yet: a setting, a withdrawal and a reclaim can't run, and are refused for free. Enabling USDC
  // and the first deposit, its first relays, go through on the two free relays it has.
  const fresh = world({ account: null })
  const r = await fresh.run(Effect.gen(function*() {
    yield* Relay.use((r) => r.configure(new RelaySettings({ enabled: true, perAccountDaily: 2, allDaily: 2 }), "admin.testnet"))
    const refused: Array<string> = []
    for (
      const b64 of [
        delegate(APP, "set_default_mode", { mode: "normal" }, 1n).b64,
        delegate(APP, "set_limits", { per_purchase: "1", daily: "1" }, 1n).b64,
        withdraw(),
        delegate(APP, "reclaim", { purchase_id: 7 }, 0n).b64
      ]
    ) refused.push((yield* Effect.flip(fresh.send(b64))).message)
    const register = yield* fresh.send(delegate(USDC, "storage_deposit", { account_id: ALICE, registration_only: true }, USDC_REGISTRATION).b64)
    const deposit = yield* fresh.send(delegate(USDC, "ft_transfer_call", { receiver_id: APP, amount: "5000000", msg: "" }, 1n, { gas: 100_000_000_000_000n }).b64)
    return { refused, ok: [register.hash, deposit.hash] }
  }))
  assert.deepEqual(r.refused.map((m) => /Deposit first/.test(m)), [true, true, true, false])
  assert.match(r.refused[3]!, /isn't a purchase of yours/)
  assert.deepEqual(r.ok, ["tx-1", "tx-2"], "the refusals left both free relays")
  assert.deepEqual(fresh.relayed, ["storage_deposit", "ft_transfer_call"])

  // 5 USDC in Luckout: no withdrawal of more, or of nothing; no reclaim of someone else's purchase. Its own, yes.
  const funded = world({ account: { balance: "5000000" }, purchases: { 7: ALICE, 8: "mallory.testnet" } })
  const tags = await funded.run(Effect.all([
    delegate(APP, "withdraw", { amount: "5000001" }, 1n).b64,
    delegate(APP, "withdraw", { amount: "0" }, 1n).b64,
    delegate(APP, "withdraw", { amount: "lots" }, 1n).b64,
    delegate(APP, "retry_draw", { purchase_id: 8 }, 0n).b64,
    delegate(APP, "reclaim", { purchase_id: "7" }, 0n).b64,
    delegate(APP, "reclaim", { purchase_id: 7 }, 0n).b64,
    delegate(APP, "withdraw", { amount: "5000000" }, 1n).b64
  ].map((b64) => funded.send(b64).pipe(Effect.match({ onFailure: (e) => e._tag, onSuccess: () => "ok" })))))
  assert.deepEqual(tags, ["RelayFailed", "RelayFailed", "RelayFailed", "RelayFailed", "RelayFailed", "ok", "ok"])
  assert.deepEqual(funded.relayed, ["reclaim", "withdraw"])
})

test("an EVM or Solana customer's call on our contract is paid for only when it can run there; their first move-in always is", async () => {
  const fresh = intentWorld({ noAccount: true })
  const actions: Array<AuthAction> = [
    { set_default_mode: { mode: "normal" } },
    { set_limits: { per_purchase: "1", daily: "1" } },
    { withdraw: { amount: "1000000" } },
    { reclaim: { purchase_id: 7 } },
    { retry_draw: { purchase_id: 7 } }
  ]
  const r = await fresh.run(Effect.gen(function*() {
    yield* Relay.use((r) => r.configure(new RelaySettings({ enabled: true, perAccountDaily: 1, allDaily: 1 }), "admin.testnet"))
    const refused: Array<string> = []
    for (const action of actions) refused.push((yield* Effect.flip(fresh.send(yield* Effect.promise(() => signIntent(authCallIntent(APP, action)))))).message)
    // The move-in that creates the account, on the one free relay the refusals didn't use.
    const first = yield* fresh.send(yield* Effect.promise(() => signIntent(moveIn())))
    return { refused, first: first.hash }
  }))
  assert.deepEqual(r.refused.map((m) => /Deposit first|isn't a purchase of yours/.test(m)), [true, true, true, true, true])
  assert.equal(r.first, "tx-1")
  assert.equal(fresh.sent.length, 1)

  const funded = intentWorld({ purchases: { 7: EVM, 8: "0x" + "9".repeat(40) } })
  const own = await funded.tag(funded.send(await signIntent(authCallIntent(APP, { reclaim: { purchase_id: 7 } }))))
  const theirs = await funded.tag(funded.send(await signIntent(authCallIntent(APP, { retry_draw: { purchase_id: 8 } }))))
  assert.deepEqual([own._tag, theirs._tag], ["ok", "RelayFailed"])
  assert.equal(funded.sent.length, 1)
})

test("once the free relays for everyone are used up, an admin hears it once, not on every refusal", async () => {
  const alerts: Array<string> = []
  const w = world({ alerts })
  const r = await w.run(Effect.gen(function*() {
    const relay = yield* Relay
    // One account using up its own share is no news.
    yield* relay.configure(new RelaySettings({ enabled: true, perAccountDaily: 1, allDaily: 500 }), "admin.testnet")
    yield* w.send(withdraw({ nonce: 11n }))
    const own = (yield* Effect.flip(w.send(withdraw({ nonce: 12n }))))._tag
    const afterOwn = alerts.length
    // Everyone's share used up: refused for everyone, and said once, however often it's asked.
    yield* relay.configure(new RelaySettings({ enabled: true, perAccountDaily: 20, allDaily: 1 }), "admin.testnet")
    const everyone = [(yield* Effect.flip(w.send(withdraw({ nonce: 13n }))))._tag, (yield* Effect.flip(w.send(withdraw({ nonce: 14n }))))._tag]
    const others = yield* relay.available("bob.testnet")
    yield* Effect.sleep("20 millis") // the alert goes on its own fiber
    return { own, afterOwn, everyone, others }
  }))
  assert.deepEqual(r, { own: "RelayUnavailable", afterOwn: 0, everyone: ["RelayUnavailable", "RelayUnavailable"], others: false })
  assert.equal(alerts.length, 1)
  assert.match(alerts[0]!, /All 1 free relays/)
})

// ---------- a gas floor, and a relay whose own transaction expired ----------

test("a call signed with too little gas to run is refused: its deposit would be refunded to the customer, not to us", () => {
  const register = (gas: bigint) => delegate(USDC, "storage_deposit", { account_id: ALICE, registration_only: true }, USDC_REGISTRATION, { gas }).d
  assert.match(refusal(register(29_000_000_000_000n), allow) ?? "", /too little gas/)
  assert.match(refusal(register(1n), allow) ?? "", /too little gas/)
  assert.match(refusal(delegate(APP, "withdraw", { amount: "5" }, 1n, { gas: 1n }).d, allow) ?? "", /too little gas/)
  assert.equal(refusal(register(30_000_000_000_000n), allow), undefined, "30 Tgas is what the app gives it")
})

test("a relay whose own transaction expired before NEAR took it is sent afresh on the next try, and doesn't use up a free relay", async () => {
  const w = world({ lostOnce: true })
  const b64 = withdraw()
  const r = await w.run(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // One free relay a day: the try that never ran mustn't be the one that uses it.
    yield* Relay.use((r) => r.configure(new RelaySettings({ enabled: true, perAccountDaily: 1, allDaily: 500 }), "admin.testnet"))
    const first = yield* Effect.flip(w.send(b64))
    const second = yield* w.send(b64)
    const third = yield* w.send(b64)
    const rows = yield* sql<{ hash: string }>`SELECT signed_tx->>'hash' AS hash FROM relays`
    return { first: first.message, second: second.hash, third: third.hash, rows: rows.map((x) => x.hash) }
  }))
  assert.match(r.first, /didn't answer in time/)
  assert.equal(r.second, "tx-2", "the same signed call, in a new relayer transaction")
  assert.equal(r.third, "tx-2", "and from then on that's its one result")
  assert.deepEqual(w.relayed, ["withdraw", "withdraw"])
  assert.deepEqual(r.rows, ["tx-2"], "the dead one is forgotten")
})

test("a Top-Up's move-in whose relayer transaction expired unsent is sent again on the next pass", async () => {
  const w = intentWorld({ lostOnce: true })
  const s = await signIntent(moveIn())
  const r = await w.run(Effect.gen(function*() {
    const first = yield* Effect.flip(w.send(s, false))
    const second = yield* w.send(s, false)
    return { first: first.message, second: second.hash }
  }))
  assert.match(r.first, /didn't answer in time/, "the message TopUp keeps a move-in waiting on")
  assert.equal(r.second, "tx-2")
  assert.equal(w.sent.length, 2)
})

test("telling an admin that everyone's free relays are used never holds up a relay: the alert goes on its own", async () => {
  const w = world({ alerts: "hang" })
  const r = await w.run(Effect.gen(function*() {
    yield* Relay.use((r) => r.configure(new RelaySettings({ enabled: true, perAccountDaily: 20, allDaily: 1 }), "admin.testnet"))
    yield* w.send(withdraw({ nonce: 11n }))
    // Each would wait on the alert (and the next relay on it, behind the one-at-a-time lock) if it were sent in line.
    const refused = (nonce: bigint) => Effect.flip(w.send(withdraw({ nonce }))).pipe(Effect.timeout("2 seconds"), Effect.map((e) => e._tag))
    return [yield* refused(12n), yield* refused(13n)]
  }))
  assert.deepEqual(r, ["RelayUnavailable", "RelayUnavailable"])
})

test("NEAR not answering a read before the relay says nothing was sent, not that it may still go through", async () => {
  const delegated = world({ nearDown: true })
  const a = await delegated.tag(delegated.send(withdraw()))
  const intents = intentWorld({ nearDown: true })
  const b = await intents.tag(intents.send(await signIntent(moveIn()), false))
  for (const e of [a, b]) {
    assert.equal(e._tag, "RelayFailed")
    assert.match(e.message, /nothing was sent/)
    assert.doesNotMatch(e.message, /may still go through/)
    // What TopUp keeps a Top-Up's move-in waiting on, to try again next pass.
    assert.match(e.message, /didn't answer/)
  }
  assert.deepEqual([delegated.relayed, intents.sent], [[], []])
})

test("NEAR refusing the relayer for want of NEAR is 'can't pay right now', not 'NEAR didn't answer': nothing ran", async () => {
  const w = intentWorld({ broke: true })
  const e = await w.tag(w.send(await signIntent(moveIn()), false))
  // A Top-Up's move-in waits for the relayer on this, and logs it, instead of retrying silently as if it may have run.
  assert.equal(e._tag, "RelayUnavailable")
  assert.doesNotMatch(e.message, /didn't answer/)
})
