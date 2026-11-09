import { Wordmark } from "@/components/brand"
import { buttonVariants } from "@/components/ui/button"
import Link from "next/link"

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-6 px-6">
      <Wordmark />
      <h1 className="font-display text-6xl leading-none font-extrabold tracking-[-0.03em]">No page here</h1>
      <p className="text-lg text-ink-soft">The link may be mistyped, or the page has moved.</p>
      <div className="flex flex-wrap gap-3">
        <Link href="/shop" className={buttonVariants({ size: "lg" })}>Go to the shop</Link>
        <Link href="/" className={buttonVariants({ size: "lg", variant: "light" })}>About Luckout</Link>
      </div>
    </main>
  )
}
