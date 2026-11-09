"use client"

import { usd, usdUp } from "@/lib/format"
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react"
import { useEffect } from "react"

/**
 * A dollar amount that counts to its new value, so a balance change is seen, not just swapped.
 * `up` marks an amount the customer pays: it rounds up to the cent.
 */
export function Money({ micro, className, up = false }: { micro: number | string; className?: string; up?: boolean }) {
  const target = Number(micro)
  const value = useMotionValue(target)
  const text = useTransform(value, (v) => (up ? usdUp : usd)(Math.round(v)))
  const reduce = useReducedMotion()

  useEffect(() => {
    const run = animate(value, target, { duration: reduce ? 0 : 0.7, ease: [0.2, 0.9, 0.25, 1] })
    return () => run.stop()
  }, [target, reduce, value])

  return <motion.span className={className}>{text}</motion.span>
}
