import { Effect, Option, Result } from "effect"
import { HttpMiddleware, HttpServerRequest, HttpServerResponse } from "effect/http"
import { IpNetwork, NetAddress } from "effect/net"

// Only nginx on the VM and Cloudflare in front of it may set X-Forwarded-For. The client
// is the rightmost untrusted address, so a spoofed header can't dodge the limit.
// Cloudflare's ranges: https://www.cloudflare.com/ips/ (fetched 2026-11-09).
const CLOUDFLARE = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"
]
const trustedProxies = ["127.0.0.0/8", "::1/128", ...CLOUDFLARE].map(IpNetwork.fromStringUnsafe)

const WINDOW_MS = 60_000
/**
 * Requests per IP per minute. Sign-in is tighter (each challenge writes a row), and so is the relayer
 * (it spends NEAR); a card or a quote asks Bitrefill and NEAR, with room for the shop's hover prefetch.
 */
const limitFor = (path: string) =>
  path.startsWith("/auth/") || path.startsWith("/telegram/") || path.startsWith("/relay")
    ? 20
    : path.startsWith("/catalog/") || path === "/quote"
    ? 60
    : 120

/** Who a request counts against: an IPv6 client by its /64 (one home or phone gets a whole /64), IPv4 as is. */
export const clientBucket = (ip: string) => {
  const parsed = NetAddress.ipFromString(ip)
  if (Result.isFailure(parsed)) return ip
  const a = NetAddress.toCanonical(parsed.success) // ::ffff:1.2.3.4 is 1.2.3.4
  return NetAddress.isIpv6Address(a) ? IpNetwork.format(IpNetwork.fromAddressUnsafe(a, 64)) : NetAddress.formatIp(a)
}

// ponytail: fixed window in memory, one process; move to Redis or the proxy if we run several.
const windows = new Map<string, { count: number; resetAt: number }>()
let sweptAt = 0

const limit = HttpMiddleware.make((app) =>
  Effect.gen(function*() {
    const req = yield* HttpServerRequest.HttpServerRequest
    const ip = clientBucket(Option.getOrElse(req.remoteAddress, () => "unknown"))
    const path = req.url.split("?")[0] ?? "/"
    const max = limitFor(path)
    const key = `${ip} ${max}`
    const now = Date.now()
    // Expired windows go at most once a window, not on every request.
    if (now - sweptAt > WINDOW_MS) {
      sweptAt = now
      for (const [k, w] of windows) if (w.resetAt < now) windows.delete(k)
    }
    const w = windows.get(key)
    if (!w || w.resetAt < now) windows.set(key, { count: 1, resetAt: now + WINDOW_MS })
    else if (++w.count > max) {
      return HttpServerResponse.jsonUnsafe(
        { _tag: "RateLimited", message: "Too many requests; try again in a minute." },
        { status: 429, headers: { "retry-after": String(Math.ceil((w.resetAt - now) / 1000)) } }
      )
    }
    return yield* app
  })
)

const forwarded = HttpMiddleware.xForwardedHeaders({ trustedProxies })

/** Client IP from trusted proxies, then a per-IP limit. */
export const rateLimit = HttpMiddleware.make((app) => forwarded(limit(app)))
