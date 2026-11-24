import { Effect, Option, Result } from "effect"
import { HttpMiddleware, HttpServerRequest, HttpServerResponse } from "effect/http"
import { IpNetwork, NetAddress } from "effect/net"

// Only nginx on the VM may tell us who connected: it appends the address it saw to X-Forwarded-For, so the
// last entry is the one to believe and nothing left of it is (a caller writes those entries itself).
const NGINX = ["127.0.0.0/8", "::1/128"].map(IpNetwork.fromStringUnsafe)
// Cloudflare's ranges: https://www.cloudflare.com/ips/ (fetched 2026-11-09).
const CLOUDFLARE = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"
].map(IpNetwork.fromStringUnsafe)

/**
 * The client's address. `hop` is who connected to nginx. When that is Cloudflare, the client is whoever
 * Cloudflare says connected to it: CF-Connecting-IP, which Cloudflare writes itself on every request it
 * passes on. Cloudflare's ranges also carry other customers' traffic (a Worker calling our API), so an
 * X-Forwarded-For entry that came through them proves nothing; every Worker shares the one address
 * Cloudflare gives them. Any other `hop` connected to us directly and is the client itself.
 */
export const clientAddress = (hop: string, cfConnectingIp: string | undefined) => {
  const at = NetAddress.ipFromString(hop)
  if (Result.isFailure(at) || !CLOUDFLARE.some((range) => IpNetwork.contains(range, NetAddress.toCanonical(at.success)))) return hop
  const client = cfConnectingIp?.trim() ?? ""
  return Result.isSuccess(NetAddress.ipFromString(client)) ? client : hop
}

const WINDOW_MS = 60_000
/**
 * The path as the router will match it. The router (effect's FindMyWay, default options) drops the query,
 * percent-decodes, collapses repeated slashes, drops a trailing slash and ignores case; a limit chosen
 * from the raw path could be sidestepped with "/AUTH/challenge" or "//auth/challenge".
 */
const routePath = (url: string) => {
  const raw = (url.startsWith("/") ? url : url.replace(/^https?:\/\/.*?\//, "/")).split(/[?;#]/)[0] || "/"
  let path = raw
  try {
    path = decodeURI(raw)
  } catch {
    // Malformed encoding: the router answers 404, so the class doesn't matter.
  }
  path = path.replace(/\/\/+/g, "/")
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1)
  return path.toLowerCase()
}

/**
 * Requests per IP per minute. Sign-in is tighter (each challenge writes a row), and so is the relayer
 * (it spends NEAR), and so is building a swap's transaction (each asks Jupiter, whose limit is per key, and
 * simulates on Solana); a card, a search or a quote asks Bitrefill and NEAR, with room for the shop's hover prefetch.
 */
export const limitFor = (url: string) => {
  const path = routePath(url)
  return path.startsWith("/auth/") || path.startsWith("/telegram/") || path.startsWith("/relay") || path === "/topup/swap-tx" ||
      path.startsWith("/solana-pay/")
    ? 20
    : path === "/catalog" || path.startsWith("/catalog/") || path === "/quote" || path === "/browse" || path === "/mcp"
    ? 60
    : 120
}

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
    const ip = clientBucket(clientAddress(Option.getOrElse(req.remoteAddress, () => "unknown"), req.headers["cf-connecting-ip"]))
    const max = limitFor(req.url)
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

const forwarded = HttpMiddleware.xForwardedHeaders({ trustedProxies: NGINX })

/** The address nginx saw, then a per-IP limit on the client behind it. */
export const rateLimit = HttpMiddleware.make((app) => forwarded(limit(app)))
