import { Wordmark } from "@/components/brand"
import Link from "next/link"

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-6 px-4">
      <Wordmark />
      <h1 className="font-display text-4xl">No page here</h1>
      <p className="text-muted-foreground">The link may be mistyped, or the page has moved.</p>
      <div className="flex gap-4">
        <Link href="/shop" className="underline underline-offset-4">Go to the shop</Link>
        <Link href="/" className="underline underline-offset-4">About Luckout</Link>
      </div>
    </main>
  )
}
