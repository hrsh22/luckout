import { cn } from "cn"
import Link from "next/link"

/** The Luckout mark: a cat in a shopping cart. Same image as app/icon.png. */
export function Mark({ className = "size-7" }: { className?: string }) {
  return <img src="/logo.png" alt="" aria-hidden="true" className={cn("rounded-lg", className)} />
}

export function Wordmark({ href = "/", className }: { href?: string; className?: string }) {
  return (
    <Link href={href} className={cn("flex shrink-0 items-center gap-2 rounded-full", className)} aria-label="Luckout home">
      <Mark />
      <span className="font-display text-[22px] font-extrabold tracking-tight">luckout</span>
    </Link>
  )
}
