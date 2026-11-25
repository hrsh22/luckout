import { Wordmark } from "@/components/brand"
import { NoPage } from "@/components/site-chrome"

// A URL no route matches: only the root layout is around it, so this brings its own Wordmark. A notFound() inside the
// app or the marketing pages uses that group's not-found instead, under the group's header.
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center px-6">
      <Wordmark />
      <NoPage />
    </main>
  )
}
