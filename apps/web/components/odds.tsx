"use client"

import { shownOutcomes, usdCents } from "@/lib/format"
import { MOST_OUTCOMES, type PricedOutcome } from "@/lib/modes"
import { slabColor } from "@/lib/palette"
import { motion } from "motion/react"

/** The outcomes as every view shows them (shownOutcomes): each outcome's price plus its cashback is the Maximum Price. */
const shown = (outcomes: ReadonlyArray<PricedOutcome>) => shownOutcomes(outcomes[0]!.price + outcomes[0]!.cashback, outcomes)

/** One bar, every outcome as the list shows it, widths exactly their chances. */
export function OddsBar({ outcomes, className = "h-3" }: { outcomes: ReadonlyArray<PricedOutcome>; className?: string }) {
  return (
    <div className={`flex gap-[3px] overflow-hidden rounded-full ${className}`} aria-hidden="true">
      {shown(outcomes).map((o) => (
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

/** Every price this purchase can end at, with its exact chance, best last: in cents that add up to what you pay now. */
export function OddsList({ outcomes, whole }: { outcomes: ReadonlyArray<PricedOutcome>; whole: boolean }) {
  const rows = shown(outcomes)
  const likely = rows.reduce((a, b) => (b.chanceBps > a.chanceBps ? b : a))
  return (
    <ul className="flex flex-col gap-1.5 text-[15px]">
      {rows.map((o) => (
        <li key={`${o.pct}-${o.cashback === 0}`} className="flex items-center gap-3">
          <span className="size-3 shrink-0 rounded-full" style={{ background: slabColor(o) }} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            {o.cashback === 0
              ? <>No cashback, you pay <b>{usdCents(o.price)}</b></>
              : o.free
              ? <><b>100% off</b>: all of it back</>
              : <>{whole && o.samePct ? `${o.pct}% back, ` : `${usdCents(o.cashback)} back, `}you pay <b>{usdCents(o.price)}</b></>}
            {o === likely && <span className="ml-2 text-sm text-muted">most likely</span>}
          </span>
          <span className="font-semibold tabular-nums">{o.chanceBps / 100}%</span>
        </li>
      ))}
      <Spacers used={rows.length} />
    </ul>
  )
}
