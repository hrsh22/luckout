"use client"

import { useShopStatus } from "@/lib/queries"
import { PauseCircle } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"

/** Shown across the app while purchases are paused (by an admin, or in the contract by the owner). */
export function ShopBanner() {
  const shop = useShopStatus().data
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
          <PauseCircle size={18} className="shrink-0" aria-hidden="true" />
          Purchases are paused for a few minutes. Your balance is safe, and withdrawals still work.
        </motion.div>
      )}
    </AnimatePresence>
  )
}
