import assert from "node:assert/strict"
import { test } from "node:test"
import * as FindMyWay from "effect/http/FindMyWay"
import { clientBucket, limitFor } from "./RateLimit.ts"

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
    "/catalog": 60, "/catalog/:id": 60, "/quote": 60, "/browse": 60, "/mcp": 60,
    "/telegram": 120, "/purchases": 120, "/purchases/:id": 120
  }
  for (const route of Object.keys(limits)) router.on("GET", route as `/${string}`, route)
  const variants = (path: string) => [
    path, path.toUpperCase(), `/${path}`, `${path}/`, `${path}?x=1`, `${path};x=1`, `${path}#x`,
    // The last slash doubled, and the first letter percent-encoded ("/%61uth/challenge").
    path.replace(/\/(?=[^/]*$)/, "//"), `/%${path.charCodeAt(1).toString(16)}${path.slice(2)}`, `http://host${path}`
  ]
  for (const path of ["/auth/challenge", "/auth/verify-evm", "/telegram/link-code", "/relay", "/relay/intent", "/catalog", "/catalog/amazon-us", "/quote", "/browse", "/mcp", "/telegram", "/purchases", "/purchases/abc"]) {
    for (const url of variants(path)) {
      const route = router.find("GET", url)?.handler
      assert.ok(route, `the router matches ${url}`)
      assert.equal(limitFor(url), limits[route], `${url} is limited as ${route}`)
    }
  }
  assert.equal(limitFor("/"), 120)
  assert.equal(limitFor("/%E0%A4%A"), 120, "malformed encoding doesn't throw")
})
