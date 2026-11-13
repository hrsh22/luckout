"use client"

import { useShopStatus } from "@/lib/queries"
import { Clock, PauseCircle } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { useEffect, useState } from "react"

/** A time of day in the viewer's own clock: "10:03 PM". */
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })

/** How long until `at` ("2h 14m"), kept current. */
function useLeft(at: number) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])
  const minutes = Math.max(1, Math.ceil((at - now) / 60_000))
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Shown across the app while purchases are paused (by an admin, in the contract by the owner, or at Bitrefill's order limit). */
export function ShopBanner() {
  const shop = useShopStatus().data
  const limit = shop?.reason === "limit" && shop.reopensAt !== undefined ? shop.reopensAt : undefined
  return (
    <AnimatePresence>
      {shop && !shop.open && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          role="status"
          className="relative mx-auto mt-4 flex w-[calc(100%-2rem)] max-w-[1160px] items-center gap-3 rounded-[1.25rem] bg-warn-soft px-5 py-3 text-[15px] font-medium text-warn sm:w-[calc(100%-5rem)]"
        >
          {limit !== undefined
            ? <><Clock size={18} className="shrink-0" aria-hidden="true" /><span>Daily order limit reached. <span className="whitespace-nowrap">Back at {clock(limit)}</span></span></>
            : <><PauseCircle size={18} className="shrink-0" aria-hidden="true" />Purchases are paused for a few minutes. Your balance is safe, and withdrawals still work.</>}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** In place of the buy button at Bitrefill's order limit: when it's back, counting down. */
export function ReopensAt({ at }: { at: number }) {
  const left = useLeft(at)
  return (
    <div role="status" className="flex h-14 items-center justify-between gap-3 rounded-full bg-warn-soft pr-6 pl-5 font-semibold text-warn">
      <span className="flex items-center gap-2.5 whitespace-nowrap"><Clock size={20} aria-hidden="true" />Back at {clock(at)}</span>
      <span className="text-sm whitespace-nowrap tabular-nums opacity-75">{left}</span>
    </div>
  )
}
