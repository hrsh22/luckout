"use client"

import { charged, PurchaseRow } from "@/components/purchase-view"
import { SignInCard } from "@/components/sign-in-card"
import { buttonVariants } from "@/components/ui/button"
import { errorMessage } from "@/lib/api"
import { usdDown } from "@/lib/format"
import { usePurchases } from "@/lib/queries"
import { useSession } from "@/lib/session"
import { firstShelf, onShelf, type Shelf, shelfCounts } from "@/lib/used"
import { type Purchase } from "@luckout/api"
import { ArrowLeft, Check } from "lucide-react"
import { motion } from "motion/react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Suspense, useState } from "react"

export default function Page() {
  return (
    <Suspense>
      <Purchases />
    </Suspense>
  )
}

const SHELVES: ReadonlyArray<[Shelf, string]> = [["unused", "Unused"], ["used", "Used"], ["all", "All"]]

function Purchases() {
  const { accountId, token, ready } = useSession()
  const list = usePurchases(token)
  const [open, setOpen] = useState<string>()
  const [picked, setPicked] = useState<Shelf>()
  // Cards marked used or unused on this shelf stay on it until the customer picks another, so the card they just marked
  // doesn't jump out from under them (its toast has Undo), and neither does the shelf when its last card goes.
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set())
  // Right after a checkout: just its cards, filling in as each arrives (the list keeps checking while any is on its way).
  const order = useSearchParams().get("order")
  const all = list.data?.pages.flatMap((p) => p.items)
  const ordered = order ? all?.filter((p) => p.checkoutId === order) : undefined
  if (ordered && ordered.length > 0) return <Order cards={ordered} open={open} setOpen={setOpen} />
  const purchases = all
  const delivered = purchases?.filter((p) => p.status === "delivered") ?? []
  const cashback = delivered.reduce((s, p) => s + (p.draw?.cashback ?? 0), 0)
  const free = delivered.filter((p) => p.draw?.finalPrice === 0).length
  // Older purchases not loaded yet aren't in these totals: say so with a "+".
  const more = list.hasNextPage ? "+" : ""
  const counts = shelfCounts(purchases ?? [])
  const shelf = picked ?? firstShelf(counts)
  const shown = purchases?.filter((p) => onShelf(p, shelf) || kept.has(p.id))
  const pick = (s: Shelf) => (setPicked(s), setKept(new Set()))
  const keep = (id: string) => (setPicked((s) => s ?? shelf), setKept((k) => new Set(k).add(id)))

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-5xl leading-[0.95] font-extrabold tracking-[-0.03em] sm:text-[64px]">Purchases</h1>
          <p className="mt-3 text-lg text-ink-soft">Every card you've bought, its code and its Draw. Refunded ones are under All.</p>
        </div>
        {delivered.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <span className="pill !bg-white !px-4 !py-2 !text-sm">{delivered.length}{more} delivered</span>
            {cashback > 0 && <span className="pill !bg-gold !px-4 !py-2 !text-sm !text-gold-ink">{usdDown(cashback)}{more} cashback</span>}
            {free > 0 && <span className="pill !bg-gold-soft !px-4 !py-2 !text-sm !text-gold-ink">{free}{more} at 100% off</span>}
          </div>
        )}
      </div>

      {ready && !accountId && <SignInCard title="Sign in to see your purchases" body="Your cards, their codes and every Draw, in one place." />}
      {list.error && <p role="alert" className="font-medium text-bad">{errorMessage(list.error)}</p>}
      {token && list.isPending && (
        <ul className="flex flex-col gap-3">{[0, 1, 2].map((i) => <li key={i} className="skeleton h-[84px] rounded-[1.75rem]" />)}</ul>
      )}
      {purchases?.length === 0 && (
        <div className="card flex flex-col items-start gap-4 p-8 sm:p-10">
          <p className="font-display text-3xl font-extrabold">No purchases yet</p>
          <p className="max-w-md text-ink-soft">Your cards and their codes will show up here the moment they're delivered.</p>
          <Link href="/shop" className={buttonVariants({ size: "lg" })}>Find a card</Link>
        </div>
      )}
      {purchases && purchases.length > 0 && (
        <div className="flex flex-col gap-4">
          <div role="group" aria-label="Show cards" className="flex rounded-full bg-white/80 p-1 sm:self-start">
            {SHELVES.map(([s, label]) => (
              <button
                key={s}
                type="button"
                aria-pressed={shelf === s}
                onClick={() => pick(s)}
                className="group relative flex h-10 flex-1 items-center justify-center gap-2 rounded-full px-4 text-sm font-semibold text-ink-soft transition-colors hover:text-ink aria-pressed:text-white sm:flex-none sm:px-5"
              >
                {shelf === s && <motion.span layoutId="shelf" className="absolute inset-0 rounded-full bg-ink" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
                <span className="relative">{label}</span>
                <span className="relative min-w-6 rounded-full bg-soft px-1.5 py-px text-xs tabular-nums text-muted group-aria-pressed:bg-white/15 group-aria-pressed:text-white">
                  {counts[s]}{more}
                </span>
              </button>
            ))}
          </div>
          {shown && shown.length > 0
            ? (
              <ul className="flex flex-col gap-3">
                {shown.map((p) => <PurchaseRow key={p.id} p={p} open={open === p.id} onToggle={() => setOpen(open === p.id ? undefined : p.id)} onUsed={keep} />)}
              </ul>
            )
            : (
              <div className="card flex flex-col items-start gap-2 p-6 sm:p-8">
                <p className="font-display text-2xl font-extrabold">{shelf === "used" ? "No used cards yet" : "Nothing left to use"}</p>
                <p className="max-w-md text-ink-soft">
                  {shelf === "used"
                    ? "Open a card and tap Mark as used once you've used it. It moves here, code and all."
                    : counts.used > 0
                    ? "Every card you have is marked used. They're under Used, codes and all."
                    : "No cards to use right now."}
                </p>
              </div>
            )}
        </div>
      )}
      {list.hasNextPage && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
            className="h-11 rounded-full bg-white/80 px-6 text-sm font-semibold text-ink-soft shadow-card hover:text-ink disabled:opacity-60"
          >
            {list.isFetchingNextPage ? "Loading older purchases…" : "Show older purchases"}
          </button>
        </div>
      )}
    </div>
  )
}

/** One checkout's cards, right after paying: how many are ready, then each card, its code and its Draw. */
function Order({ cards, open, setOpen }: { cards: ReadonlyArray<Purchase>; open: string | undefined; setOpen: (id: string | undefined) => void }) {
  const ready = cards.filter((p) => p.status === "delivered").length
  const done = cards.every((p) => p.status !== "pending" && p.status !== "waiting")
  const waiting = cards.some((p) => p.status === "waiting")
  return (
    <div className="flex flex-col gap-8">
      <Link href="/purchases" className="inline-flex items-center gap-2 self-start font-semibold text-muted hover:text-ink">
        <ArrowLeft size={18} />All purchases
      </Link>
      <div className="card flex flex-col gap-4 p-6 sm:p-8">
        <span className={`grid size-12 place-items-center rounded-full ${done ? "bg-good-soft text-good" : "bg-soft text-ink-soft"}`}>
          {done ? <Check size={24} /> : <span className="size-3 animate-pulse rounded-full bg-current" />}
        </span>
        <div>
          <h1 className="font-display text-4xl leading-tight font-extrabold sm:text-5xl">
            {done ? (ready === cards.length ? "Your cards are ready" : "Your order is done") : "Your cards are on their way"}
          </h1>
          <p className="mt-2 text-lg text-ink-soft">
            {ready} of {cards.length} ready.{" "}
            {done
              ? ready < cards.length ? "Any card that couldn't be delivered went back to your balance in full." : "Open a card for its code."
              : waiting
              // A checkout's cards wait together: all already paid (admitted), or none yet.
              ? cards.some((p) => p.status === "waiting" && charged(p))
                ? "We're topping up our gift card supply first. Any card that can't be delivered returns its full amount to your balance."
                : "We're topping up our gift card supply first; you're only charged once it's ready."
              : "Codes show up here as each card arrives, usually within a minute."}
          </p>
        </div>
      </div>
      <ul className="flex flex-col gap-3">
        {cards.map((p) => <PurchaseRow key={p.id} p={p} open={open === p.id} onToggle={() => setOpen(open === p.id ? undefined : p.id)} />)}
      </ul>
    </div>
  )
}
