import { Api } from "@luckout/api"
import { Duration, Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"

export const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8787"

const client = (token?: string) =>
  HttpApiClient.make(Api, {
    baseUrl: apiUrl,
    transformClient: (c) => (token ? c.pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken(token))) : c)
  })

type Client = Effect.Success<ReturnType<typeof client>>

/** Fired when the server rejects the session token; the session provider signs the customer out. */
export const UNAUTHORIZED = "luckout:unauthorized"

export class TimedOut extends Error {
  constructor() {
    super("The server is taking longer than usual.")
  }
}

/**
 * One typed server call: `api((c) => c.catalog.search({ query: { q } }))`, with the session token
 * when given. Calls time out after 30 seconds unless told otherwise.
 */
export const api = <A, E>(f: (c: Client) => Effect.Effect<A, E>, token?: string, timeout: Duration.Input = "30 seconds") =>
  Effect.runPromise(
    client(token).pipe(
      Effect.flatMap(f),
      Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(new TimedOut()) }),
      Effect.provide(FetchHttpClient.layer)
    )
  ).catch((e: unknown) => {
    if (token && (e as { _tag?: string })?._tag === "Unauthorized") window.dispatchEvent(new Event(UNAUTHORIZED))
    throw e
  })

// Wallets say "User closed the window…", "User rejected…" and so on when the customer backs out.
const BACKED_OUT = /user (closed|rejected|denied|cancel)|rejected by (the )?user|cancell?ed by (the )?user|closed the window/i

/** The customer closed or declined the wallet prompt: nothing was signed, and it isn't an error. */
export const cancelled = (e: unknown) => BACKED_OUT.test(String((e as { message?: string })?.message ?? e))

/** The server's own message for a failed call, when it sent one. */
export const errorMessage = (e: unknown) => {
  const tag = (e as { _tag?: string })?._tag
  if (tag === "Unauthorized") return "Your session ended. Sign in again."
  if (cancelled(e)) return "You closed your wallet before approving, so nothing happened."
  if (/does not have enough balance/i.test(String((e as { message?: string })?.message ?? e))) {
    return "Your wallet needs a little NEAR to pay the network fee. Add some NEAR and try again."
  }
  if (e instanceof TypeError || /transport error/i.test(String((e as { message?: string })?.message))) {
    return "Can't reach Luckout right now. Check your connection and try again."
  }
  return (e as { message?: string })?.message ?? String(e)
}
