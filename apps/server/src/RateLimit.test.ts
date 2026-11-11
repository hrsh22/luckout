import assert from "node:assert/strict"
import { test } from "node:test"
import { clientBucket } from "./RateLimit.ts"

// A client can't dodge the limit by rotating through its own IPv6 /64.

test("IPv6 counts by /64, IPv4-mapped addresses as IPv4, anything else as given", () => {
  assert.equal(clientBucket("2001:db8:0:1:aaaa::1"), "2001:db8:0:1::/64")
  assert.equal(clientBucket("2001:DB8:0:1:ffff:1:2:3"), "2001:db8:0:1::/64")
  assert.notEqual(clientBucket("2001:db8:0:2::1"), clientBucket("2001:db8:0:1::1"))
  assert.equal(clientBucket("::ffff:203.0.113.9"), "203.0.113.9")
  assert.equal(clientBucket("203.0.113.9"), "203.0.113.9")
  assert.equal(clientBucket("unknown"), "unknown")
})
