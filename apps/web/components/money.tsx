"use client"

import { usd } from "@/lib/format"
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react"
import { useEffect } from "react"

/** A dollar amount that counts to its new value, so a balance change is seen, not just swapped. */
export function Money({ micro, className }: { micro: number | string; className?: string }) {
  const target = Number(micro)
  const value = useMotionValue(target)
  const text = useTransform(value, (v) => usd(Math.round(v)))
  const reduce = useReducedMotion()

  useEffect(() => {
    const run = animate(value, target, { duration: reduce ? 0 : 0.7, ease: [0.2, 0.9, 0.25, 1] })
    return () => run.stop()
  }, [target, reduce, value])

  return <motion.span className={className}>{text}</motion.span>
}
