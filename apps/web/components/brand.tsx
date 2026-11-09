import Link from "next/link"

/** A voucher stub with its notch: the Luckout mark. Same shape as app/icon.svg. */
export function Mark({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <path d="M4 7a3 3 0 0 1 3-3h18a3 3 0 0 1 3 3v6a3 3 0 0 0 0 6v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 0 0-6Z" fill="#E9B949" />
      <path d="M12 10v12h8" fill="none" stroke="#13161D" strokeWidth="3" strokeLinecap="square" />
    </svg>
  )
}

export function Wordmark({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2 rounded-md" aria-label="Luckout home">
      <Mark />
      <span className="font-display text-xl">Luckout</span>
    </Link>
  )
}
