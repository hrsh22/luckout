import { ByteSize, Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { rateLimit } from "./RateLimit.ts"

// What every request passes through before a route sees it, whichever route that is. main.ts serves the
// routes behind it, and Edge.test.ts serves the same thing on a real HTTP server.

/**
 * The most a request body may be. The biggest thing a customer sends is a signed delegate or a signed
 * intent, under 9 kB as JSON; nothing is uploaded. Without a limit a body is read into memory whole,
 * whoever sent it, and a few large ones at once would restart the one process, purchases in progress
 * with it.
 */
export const MAX_BODY = ByteSize.kibibytes(64)

export const edge = (allowedOrigins: ReadonlyArray<string>) =>
  Layer.mergeAll(
    // Answers carry session tokens, gift card codes and balances: no browser or proxy may keep one. Listed
    // first so it wraps the others and also marks their own answers (a 429).
    HttpRouter.middleware((app) => Effect.map(app, HttpServerResponse.setHeader("cache-control", "no-store")), { global: true }),
    // Our pages send the session cookie with their calls (credentials), so only our own origins may read answers.
    HttpRouter.cors({ allowedOrigins, credentials: true }),
    // SameSite=Lax keeps the session cookie off other sites' requests, but our sibling sites (testnet., staging.)
    // count as the same site: a call that changes something must come from one of our own pages, or from no
    // page at all (a script), never from a page elsewhere.
    HttpRouter.middleware((app) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (r) => {
        const origin = r.headers.origin
        return r.method === "GET" || r.method === "HEAD" || r.method === "OPTIONS" || origin === undefined || allowedOrigins.includes(origin)
          ? app
          : Effect.succeed(HttpServerResponse.jsonUnsafe({ _tag: "Forbidden", message: "Use Luckout from its own site." }, { status: 403 }))
      }), { global: true }),
    HttpRouter.middleware(rateLimit, { global: true }),
    // Read past the limit and the read fails: the API answers 413, and /mcp its own parse error.
    HttpRouter.middleware(Effect.provideService(HttpServerRequest.MaxBodySize, MAX_BODY), { global: true })
  )
