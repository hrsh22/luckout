import { Effect, Option } from "effect"
import { HttpMiddleware, HttpServerRequest, HttpServerResponse } from "effect/http"
import { IpNetwork } from "effect/net"

// Only Caddy (on the Docker network) or a local proxy may set X-Forwarded-For; anyone
// else's header is ignored, so clients can't dodge the limit by spoofing it.
const trustedProxies = ["127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].map(IpNetwork.fromStringUnsafe)

const WINDOW_MS = 60_000
/** Requests per IP per minute. Sign-in is tighter: each challenge writes a row. */
const limitFor = (path: string) => (path.startsWith("/auth/") ? 20 : path.startsWith("/telegram/") ? 20 : 120)

// ponytail: fixed window in memory, one process; move to Redis or the proxy if we run several.
const windows = new Map<string, { count: number; resetAt: number }>()

const limit = HttpMiddleware.make((app) =>
  Effect.gen(function*() {
    const req = yield* HttpServerRequest.HttpServerRequest
    const ip = Option.getOrElse(req.remoteAddress, () => "unknown")
    const path = req.url.split("?")[0] ?? "/"
    const max = limitFor(path)
    const key = `${ip} ${max}`
    const now = Date.now()
    if (windows.size > 50_000) for (const [k, w] of windows) if (w.resetAt < now) windows.delete(k)
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
