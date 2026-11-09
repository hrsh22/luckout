"use client"

import { Wordmark } from "@/components/brand"
import { Button } from "@/components/ui/button"

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-6 px-4">
      <Wordmark />
      <h1 className="font-display text-4xl">This page didn't load</h1>
      <p className="text-muted-foreground">
        Something failed while loading it. Your balance and purchases are safe in the contract. Try again, and if it keeps happening,
        reload the page.
      </p>
      <Button className="self-start" onClick={reset}>Try again</Button>
    </main>
  )
}
