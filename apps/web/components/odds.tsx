"use client"

import { usd, usdUp } from "@/lib/format"
import { MOST_OUTCOMES, mostLikely, type PricedOutcome } from "@/lib/modes"
import { motion } from "motion/react"

/** Gold deepens with the cashback: pale for 10% back, full gold for free. No cashback stays ink. */
export const slabColor = (o: PricedOutcome) =>
  o.cashback === 0 ? "rgb(22 18 43 / 0.12)" : o.price === 0 ? "#FF9F1C" : ["#FFEBB0", "#FFE08A", "#FFD466", "#FFC53D", "#FFB21F"][Math.min(4, Math.round(o.pct / 10) - 1)]!

/** One bar, every outcome, widths exactly their chances. */
export function OddsBar({ outcomes, className = "h-3" }: { outcomes: ReadonlyArray<PricedOutcome>; className?: string }) {
  return (
    <div className={`flex gap-[3px] overflow-hidden rounded-full ${className}`} aria-hidden="true">
      {outcomes.map((o) => (
        <motion.span
          key={`${o.pct}-${o.cashback === 0}`}
          layout
          className="h-full rounded-full first:rounded-l-full"
          style={{ background: slabColor(o), flexGrow: o.chanceBps, flexBasis: 0, minWidth: 4 }}
          transition={{ type: "spring", stiffness: 300, damping: 32 }}
        />
      ))}
    </div>
  )
}

/** Empty rows up to the longest table, so a shorter one (Jackpot) keeps the same height. */
export const Spacers = ({ used }: { used: number }) =>
  Array.from({ length: Math.max(0, MOST_OUTCOMES - used) }, (_, i) => (
    <li key={`spacer-${i}`} aria-hidden="true" className="invisible">&nbsp;</li>
  ))

/** Every price this purchase can end at, with its exact chance, best last. */
export function OddsList({ outcomes, whole }: { outcomes: ReadonlyArray<PricedOutcome>; whole: boolean }) {
  const likely = mostLikely(outcomes)
  return (
    <ul className="flex flex-col gap-1.5 text-[15px]">
      {outcomes.map((o) => (
        <li key={`${o.pct}-${o.cashback === 0}`} className="flex items-center gap-3">
          <span className="size-3 shrink-0 rounded-full" style={{ background: slabColor(o) }} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            {o.cashback === 0
              ? <>No cashback, you pay <b>{usdUp(o.price)}</b></>
              : o.price === 0
              ? <><b>Free</b>, all {usd(o.cashback)} back</>
              : <>{whole ? `${o.pct}% back, ` : `${usd(o.cashback)} back, `}you pay <b>{usdUp(o.price)}</b></>}
            {o === likely && <span className="ml-2 text-sm text-muted">most likely</span>}
          </span>
          <span className="font-semibold tabular-nums">{o.chanceBps / 100}%</span>
        </li>
      ))}
      <Spacers used={outcomes.length} />
    </ul>
  )
}
