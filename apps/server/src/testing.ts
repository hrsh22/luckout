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
    guest: false,
    search: unused("bitrefill.search"),
    browse: unused("bitrefill.browse"),
    popular: unused("bitrefill.popular"),
    logo: () => ({}),
    voucher: unused("bitrefill.voucher"),
    order: unused("bitrefill.order"),
    delivery: unused("bitrefill.delivery"),
    credit: Effect.die("bitrefill.credit was not expected in this test"),
    deposit: unused("bitrefill.deposit"),
    depositState: unused("bitrefill.depositState"),
    orderLimit: () => Effect.succeed({ used: 0, reopensAt: undefined }),
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
    pay: unused("base.pay"),
    ...overrides
  })

/**
 * Bitrefill's OAuth endpoints, faked at fetch (Connect.ts). A code, or a refresh token, buys the next tokens:
 * "access-1"/"refresh-1", then "access-2"/"refresh-2"... The code's access token lasts `firstExpiresIn`
 * seconds and renewed ones 6 hours. Each refresh token works once, as at Bitrefill, and after `lapse()` none
 * does. A refresh takes 50 ms, so two at once would overlap. `calls` lists each request.
 */
export const fakeBitrefillOAuth = (firstExpiresIn = 6 * 3600) => {
  const calls: Array<{ path: string; params: URLSearchParams }> = []
  let issued = 0
  let lapsed = false
  const spent = new Set<string>()
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname
    const params = new URLSearchParams(typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body as Uint8Array))
    calls.push({ path, params })
    if (path === "/oauth/mcp/revoke") return new Response(null, { status: 200 })
    if (path !== "/oauth/mcp/token") throw new Error(`unexpected request to ${path}`)
    if (params.get("grant_type") === "refresh_token") {
      await new Promise((r) => setTimeout(r, 50))
      const old = params.get("refresh_token") ?? ""
      if (lapsed || spent.has(old)) return Response.json({ error: "invalid_grant" }, { status: 400 })
      spent.add(old)
    }
    issued++
    const expiresIn = params.get("grant_type") === "authorization_code" ? firstExpiresIn : 6 * 3600
    return Response.json({ access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: expiresIn, token_type: "Bearer" })
  }) as typeof globalThis.fetch
  return { fetch, calls, lapse: () => void (lapsed = true), grants: (type: string) => calls.filter((c) => c.params.get("grant_type") === type) }
}
