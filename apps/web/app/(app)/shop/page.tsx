"use client"

import { Shop } from "@/components/shop"
import { useSession } from "@/lib/session"

export default function ShopPage() {
  // Keyed on the account: signing out or switching accounts clears any purchase on screen.
  const { accountId } = useSession()
  return <Shop key={accountId ?? "signed-out"} />
}
