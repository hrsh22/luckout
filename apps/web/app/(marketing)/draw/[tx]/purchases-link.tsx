"use client"

import { ArrowLeft } from "lucide-react"
import Link from "next/link"
import { useEffect, useState } from "react"

/**
 * Back to their purchases, for a signed-in customer checking their own Draw; a visitor from a shared link gets none.
 * Reads the session the Web App saved (STORAGE in lib/session.tsx) instead of importing it: this page loads no wallet code.
 */
export function PurchasesLink() {
  const [signedIn, setSignedIn] = useState(false)
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("luckout.session") ?? "null") as { expiresAt?: number } | null
      setSignedIn((saved?.expiresAt ?? 0) > Date.now())
    } catch {}
  }, [])
  if (!signedIn) return null
  return (
    <Link href="/purchases" className="relative -mb-6 inline-flex items-center gap-2 self-start font-semibold text-muted hover:text-ink">
      <ArrowLeft size={18} aria-hidden="true" />Your purchases
    </Link>
  )
}
