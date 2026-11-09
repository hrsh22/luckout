"use client"

import { motion } from "motion/react"

/** Each page settles in the same way, so moving around the app reads as one surface. */
export default function Template({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      className="flex flex-1 flex-col"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 30 }}
    >
      {children}
    </motion.div>
  )
}
