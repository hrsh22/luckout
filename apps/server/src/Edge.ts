import { ByteSize, Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/http"
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
    HttpRouter.cors({ allowedOrigins }),
    HttpRouter.middleware(rateLimit, { global: true }),
    // Read past the limit and the read fails: the API answers 413, and /mcp its own parse error.
    HttpRouter.middleware(Effect.provideService(HttpServerRequest.MaxBodySize, MAX_BODY), { global: true })
  )
