import assert from "node:assert/strict"
import { test } from "node:test"
import * as FindMyWay from "effect/http/FindMyWay"
import { Effect, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { clientAddress, clientBucket, limitFor, rateLimit } from "./RateLimit.ts"

// A client can't dodge the limit by rotating through its own IPv6 /64.

test("IPv6 counts by /64, IPv4-mapped addresses as IPv4, anything else as given", () => {
  assert.equal(clientBucket("2001:db8:0:1:aaaa::1"), "2001:db8:0:1::/64")
  assert.equal(clientBucket("2001:DB8:0:1:ffff:1:2:3"), "2001:db8:0:1::/64")
  assert.notEqual(clientBucket("2001:db8:0:2::1"), clientBucket("2001:db8:0:1::1"))
  assert.equal(clientBucket("::ffff:203.0.113.9"), "203.0.113.9")
  assert.equal(clientBucket("203.0.113.9"), "203.0.113.9")
  assert.equal(clientBucket("unknown"), "unknown")
})

// The limiter must classify a URL the way the router will match it, or a tight limit can be
// sidestepped by changing the path's case, slashes or encoding.

test("a URL is limited as the route the router matches it to, whatever its case, slashes or encoding", () => {
  const router = FindMyWay.make<string>()
  const limits: Record<string, number> = {
    "/auth/challenge": 20, "/auth/verify": 20, "/auth/verify-evm": 20,
    "/telegram/link-code": 20, "/telegram/unlink": 20, "/relay": 20, "/relay/intent": 20,
    "/topup/swap-tx": 20, "/solana-pay/:depositAddress": 20, "/topup/quote": 120,
    "/catalog": 60, "/catalog/:id": 60, "/quote": 60, "/browse": 60, "/mcp": 60,
    "/telegram": 120, "/purchases": 120, "/purchases/:id": 120
  }
  for (const route of Object.keys(limits)) router.on("GET", route as `/${string}`, route)
  const variants = (path: string) => [
    path, path.toUpperCase(), `/${path}`, `${path}/`, `${path}?x=1`, `${path};x=1`, `${path}#x`,
    // The last slash doubled, and the first letter percent-encoded ("/%61uth/challenge").
    path.replace(/\/(?=[^/]*$)/, "//"), `/%${path.charCodeAt(1).toString(16)}${path.slice(2)}`, `http://host${path}`
  ]
  for (const path of ["/auth/challenge", "/auth/verify-evm", "/telegram/link-code", "/relay", "/relay/intent", "/catalog", "/catalog/amazon-us", "/quote", "/browse", "/mcp", "/telegram", "/purchases", "/purchases/abc", "/topup/swap-tx", "/solana-pay/7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj", "/topup/quote"]) {
    for (const url of variants(path)) {
      const route = router.find("GET", url)?.handler
      assert.ok(route, `the router matches ${url}`)
      assert.equal(limitFor(url), limits[route], `${url} is limited as ${route}`)
    }
  }
  assert.equal(limitFor("/"), 120)
  assert.equal(limitFor("/%E0%A4%A"), 120, "malformed encoding doesn't throw")
})

// Behind Cloudflare, the client is whoever Cloudflare says connected to it, never an address the caller
// wrote into X-Forwarded-For: Cloudflare's own ranges also carry other customers' traffic (a Worker
// calling our API), and those callers write the left of that header themselves.

/** How a request for `path` is answered when nginx (on loopback) passes it on with these headers. */
const answered = (path: string, headers: Record<string, string>) =>
  Effect.runPromise(
    rateLimit(Effect.succeed(HttpServerResponse.empty({ status: 204 }))).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(`http://api.test${path}`, { method: "POST", headers })).modify({ remoteAddress: Option.some("127.0.0.1") })
      ),
      Effect.map((response) => response.status)
    )
  )
/** Cloudflare's edge, as nginx reports its peer; and the one address every Worker's call to another zone carries. */
const EDGE = "172.71.10.20"
const WORKER = "2a06:98c0:3600::103"

test("a caller on Cloudflare's own network can't choose who its requests count against", async () => {
  // A Worker on someone else's zone calls sign-in 25 times, each time claiming a new address.
  const statuses: Array<number> = []
  for (let i = 0; i < 25; i++) {
    statuses.push(await answered("/auth/challenge", { "x-forwarded-for": `198.51.100.${i}, ${WORKER}, ${EDGE}`, "cf-connecting-ip": WORKER }))
  }
  assert.deepEqual(statuses, [...Array(20).fill(204), ...Array(5).fill(429)], "all 25 counted as one caller")

  // The same Worker claims a customer's address until it is limited; the customer isn't.
  const victim = "203.0.113.77"
  for (let i = 0; i < 25; i++) await answered("/telegram/link-code", { "x-forwarded-for": `${victim}, ${WORKER}, ${EDGE}`, "cf-connecting-ip": WORKER })
  assert.equal(await answered("/auth/challenge", { "x-forwarded-for": `${victim}, ${EDGE}`, "cf-connecting-ip": victim }), 204)
})

test("visitors behind one Cloudflare address are limited apart, and Cloudflare's header counts for nothing on a direct connection", async () => {
  // Two visitors arrive through the same Cloudflare edge: one using up its limit leaves the other alone.
  const through = (visitor: string) => answered("/relay", { "x-forwarded-for": `${visitor}, ${EDGE}`, "cf-connecting-ip": visitor })
  for (let i = 0; i < 20; i++) assert.equal(await through("198.51.100.201"), 204)
  assert.equal(await through("198.51.100.201"), 429)
  assert.equal(await through("198.51.100.202"), 204)

  // Someone who reaches nginx without Cloudflare writes CF-Connecting-IP themselves: it changes nothing.
  const direct: Array<number> = []
  for (let i = 0; i < 25; i++) direct.push(await answered("/auth/verify", { "x-forwarded-for": `203.0.113.${i}, 198.51.100.210`, "cf-connecting-ip": `203.0.113.${i}` }))
  assert.deepEqual(direct, [...Array(20).fill(204), ...Array(5).fill(429)])
})

test("the client is Cloudflare's CF-Connecting-IP behind Cloudflare, and the connecting address otherwise", () => {
  // Through Cloudflare: its header, whatever X-Forwarded-For said.
  assert.equal(clientAddress(EDGE, "198.51.100.7"), "198.51.100.7")
  assert.equal(clientAddress("2606:4700:10::ac43:1", "2001:db8:0:1::5"), "2001:db8:0:1::5")
  assert.equal(clientAddress(`::ffff:${EDGE}`, "198.51.100.7"), "198.51.100.7")
  // Straight to our server, not through Cloudflare: the header is the caller's own words.
  assert.equal(clientAddress("198.51.100.9", "203.0.113.77"), "198.51.100.9")
  assert.equal(clientAddress("127.0.0.1", "203.0.113.77"), "127.0.0.1")
  // Cloudflare without a usable header: Cloudflare's own address, never something further left.
  assert.equal(clientAddress(EDGE, undefined), EDGE)
  assert.equal(clientAddress(EDGE, "not-an-address"), EDGE)
  assert.equal(clientAddress("unknown", "198.51.100.7"), "unknown")
})
