import { Api } from "@luckout/api"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"

const client = HttpApiClient.make(Api, { baseUrl: process.env.NEXT_PUBLIC_API_URL })

/** One typed server call: `api((c) => c.catalog.search({ query: { q } }))`. */
export const api = <A, E>(f: (c: Effect.Success<typeof client>) => Effect.Effect<A, E>) =>
  Effect.runPromise(client.pipe(Effect.flatMap(f), Effect.provide(FetchHttpClient.layer)))
