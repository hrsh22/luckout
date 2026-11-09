"use client"

import { Wordmark } from "@/components/brand"
import { Button } from "@/components/ui/button"

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-6 px-6">
      <Wordmark />
      <h1 className="font-display text-6xl leading-none font-extrabold tracking-[-0.03em]">This page didn't load</h1>
      <p className="text-lg text-ink-soft">
        Something failed while loading it. Your balance and purchases are safe in the contract. Try again, and if it keeps happening,
        reload the page.
      </p>
      <Button size="lg" className="self-start" onClick={reset}>Try again</Button>
    </main>
  )
}
