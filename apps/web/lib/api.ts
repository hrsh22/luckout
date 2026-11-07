import { Api } from "@luckout/api"
import { Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"

const client = (token?: string) =>
  HttpApiClient.make(Api, {
    baseUrl: process.env.NEXT_PUBLIC_API_URL || "http://localhost:8787",
    transformClient: (c) => (token ? c.pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken(token))) : c)
  })

type Client = Effect.Success<ReturnType<typeof client>>

/** One typed server call: `api((c) => c.catalog.search({ query: { q } }))`, with the session token when given. */
export const api = <A, E>(f: (c: Client) => Effect.Effect<A, E>, token?: string) =>
  Effect.runPromise(client(token).pipe(Effect.flatMap(f), Effect.provide(FetchHttpClient.layer)))

/** The server's own message for a failed call, when it sent one. */
export const errorMessage = (e: unknown) =>
  (e as { message?: string })?.message ?? String(e)
