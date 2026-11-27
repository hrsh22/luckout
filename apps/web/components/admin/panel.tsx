"use client"

// TODO(phase3-admin): the control room on Solana (AdminOverview): owner actions as transactions the owner's wallet
// signs, the Pay Wallet and fee payer, the repay cap. The NEAR version is at
// `git show 9313693:apps/web/components/admin/panel.tsx`; its parts (credit, gas, treasury, relayer, controls,
// cashback-cap, refills, reserve) are parked with @ts-nocheck.

import { AdminTabs } from "@/components/admin/shared"
import { SignInCard } from "@/components/sign-in-card"
import { NoPage } from "@/components/site-chrome"
import { useIsAdmin } from "@/lib/queries"
import { useSession } from "@/lib/session"

// The admin panel (/admin). The server only answers whitelisted accounts, and everyone else sees the ordinary
// "No page here".
export function AdminPanel() {
  const { accountId, token, ready } = useSession()
  const isAdmin = useIsAdmin(token)
  if (ready && !accountId) return <SignInCard title="Sign in to continue" body="Sign in with your admin account." />
  if (!isAdmin) return <NoPage />
  return (
    <div className="flex flex-col gap-6">
      <AdminTabs />
      <p className="text-ink-soft">The control room is being rebuilt for Solana. Purchases and Users work.</p>
    </div>
  )
}
