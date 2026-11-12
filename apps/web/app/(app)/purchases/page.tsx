"use client"

import { PurchaseRow } from "@/components/purchase-view"
import { SignInCard } from "@/components/sign-in-card"
import { buttonVariants } from "@/components/ui/button"
import { errorMessage } from "@/lib/api"
import { usd } from "@/lib/format"
import { usePurchases } from "@/lib/queries"
import { useSession } from "@/lib/session"
import Link from "next/link"
import { useState } from "react"

export default function Purchases() {
  const { accountId, token, ready } = useSession()
  const list = usePurchases(token)
  const [open, setOpen] = useState<string>()
  const delivered = list.data?.filter((p) => p.status === "delivered") ?? []
  const cashback = delivered.reduce((s, p) => s + (p.draw?.cashback ?? 0), 0)
  const free = delivered.filter((p) => p.draw?.finalPrice === 0).length

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-5xl leading-[0.95] font-extrabold tracking-[-0.03em] sm:text-[64px]">Purchases</h1>
          <p className="mt-3 text-lg text-ink-soft">Every card you've bought, its code and its Draw.</p>
        </div>
        {delivered.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <span className="pill !bg-white !px-4 !py-2 !text-sm">{delivered.length} delivered</span>
            {cashback > 0 && <span className="pill !bg-gold !px-4 !py-2 !text-sm !text-gold-ink">{usd(cashback)} cashback</span>}
            {free > 0 && <span className="pill !bg-gold-soft !px-4 !py-2 !text-sm !text-gold-ink">{free} at 100% off</span>}
          </div>
        )}
      </div>

      {ready && !accountId && <SignInCard title="Sign in to see your purchases" body="Your cards, their codes and every Draw, in one place." />}
      {list.error && <p role="alert" className="font-medium text-bad">{errorMessage(list.error)}</p>}
      {token && list.isPending && (
        <ul className="flex flex-col gap-3">{[0, 1, 2].map((i) => <li key={i} className="skeleton h-[84px] rounded-[1.75rem]" />)}</ul>
      )}
      {list.data?.length === 0 && (
        <div className="card flex flex-col items-start gap-4 p-8 sm:p-10">
          <p className="font-display text-3xl font-extrabold">No purchases yet</p>
          <p className="max-w-md text-ink-soft">Your cards and their codes will show up here the moment they're delivered.</p>
          <Link href="/shop" className={buttonVariants({ size: "lg" })}>Find a card</Link>
        </div>
      )}
      {list.data && list.data.length > 0 && (
        <ul className="flex flex-col gap-3">
          {list.data.map((p) => <PurchaseRow key={p.id} p={p} open={open === p.id} onToggle={() => setOpen(open === p.id ? undefined : p.id)} />)}
        </ul>
      )}
    </div>
  )
}
