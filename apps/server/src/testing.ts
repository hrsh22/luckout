import { Effect } from "effect"
import { Base } from "./Base.ts"
import { Bitrefill } from "./Bitrefill.ts"
import { Near } from "./Near.ts"

// Fakes for tests: everything a test doesn't override dies loudly if it's called.

const unused = (what: string) => () => Effect.die(`${what} was not expected in this test`)

export const fakeNear = (overrides: Partial<Near["Service"]> = {}) =>
  Near.of({
    contractId: "app.test",
    usdcId: "usdc.test",
    operatorId: "server.test",
    relayerId: undefined,
    treasuryId: undefined,
    intentsId: "intents.test",
    view: unused("near.view"),
    call: unused("near.call"),
    relay: unused("near.relay"),
    relayerCall: unused("near.relayerCall"),
    treasurySend: unused("near.treasurySend"),
    resume: unused("near.resume"),
    accessKey: unused("near.accessKey"),
    height: Effect.die("near.height was not expected in this test"),
    account: unused("near.account"),
    verifySignIn: () => Effect.succeed(false),
    ...overrides
  })

export const fakeBitrefill = (overrides: Partial<Bitrefill["Service"]> = {}) =>
  Bitrefill.of({
    search: unused("bitrefill.search"),
    browse: unused("bitrefill.browse"),
    popular: unused("bitrefill.popular"),
    voucher: unused("bitrefill.voucher"),
    order: unused("bitrefill.order"),
    delivery: unused("bitrefill.delivery"),
    credit: Effect.die("bitrefill.credit was not expected in this test"),
    deposit: unused("bitrefill.deposit"),
    depositState: unused("bitrefill.depositState"),
    ...overrides
  })

export const fakeBase = (overrides: Partial<Base["Service"]> = {}) =>
  Base.of({
    configured: true,
    address: Effect.die("base.address was not expected in this test"),
    balances: Effect.die("base.balances was not expected in this test"),
    prepare: unused("base.prepare"),
    sign: unused("base.sign"),
    send: unused("base.send"),
    status: unused("base.status"),
    ...overrides
  })
