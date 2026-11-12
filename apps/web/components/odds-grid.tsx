"use client"

import { slabColor, Spacers } from "@/components/odds"
import { usd, usdUp } from "@/lib/format"
import { MODES, type PricedOutcome, pricedOutcomes, simpleQuote } from "@/lib/modes"
import { modePalette } from "@/lib/palette"
import { motion } from "motion/react"
import { useState } from "react"

const PRICE = 20_000_000
const LUCKY = MODES.filter((m) => m.premiumBps > 0)

const label = (o: PricedOutcome, whole: boolean) =>
  o.price === 0
    ? "got it all back: 100% off"
    : o.cashback > 0
    ? `got ${whole ? `${o.pct}%` : usd(o.cashback)} back, paid ${usdUp(o.price)}`
    : `no cashback, paid ${usdUp(o.price)}`

/** The odds, drawn: 100 buyers of a $20 card with all of it in the Draw, each dot what one of them paid. */
export function OddsGrid() {
  const [index, setIndex] = useState(1)
  const m = LUCKY[index]!
  const pal = modePalette(m.mode)
  const q = simpleQuote(m, PRICE, Number.MAX_SAFE_INTEGER)
  const outcomes = pricedOutcomes(m, q)
  const cells = outcomes.flatMap((o) => Array.from({ length: o.chanceBps / 100 }, () => o))

  return (
    <figure className="card grid gap-8 p-6 sm:p-8 lg:grid-cols-[minmax(0,340px)_1fr] lg:items-center">
      <div className="grid grid-cols-10 gap-1.5" aria-hidden="true">
        {cells.map((o, i) => (
          <motion.span
            key={i}
            className="aspect-square rounded-full"
            initial={false}
            animate={{ backgroundColor: slabColor(o), scale: o.price === 0 ? 1.12 : 1 }}
            transition={{ duration: 0.35, delay: i * 0.004 }}
          />
        ))}
      </div>

      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <figcaption className="font-display text-3xl font-extrabold">100 people buy a $20 card</figcaption>
          <div role="radiogroup" aria-label="Mode" className="flex rounded-full bg-soft p-1">
            {LUCKY.map((x, i) => (
              <button
                key={x.name}
                type="button"
                role="radio"
                aria-checked={i === index}
                onClick={() => setIndex(i)}
                className="relative h-9 rounded-full px-4 text-sm font-semibold transition-colors aria-checked:text-white"
              >
                {i === index && <motion.span layoutId="odds-mode" className="absolute inset-0 rounded-full bg-ink" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
                <span className="relative">{x.name}</span>
              </button>
            ))}
          </div>
        </div>
        <ul className="grid gap-2 text-[15px] sm:grid-cols-2">
          {outcomes.map((o) => (
            <li key={`${o.pct}-${o.cashback === 0}`} className="flex items-center gap-2">
              <span className="size-3 shrink-0 rounded-full" style={{ background: slabColor(o) }} aria-hidden="true" />
              <span><b>{o.chanceBps / 100}</b> {label(o, q.luckyAmount === PRICE)}</span>
            </li>
          ))}
          <Spacers used={outcomes.length} />
        </ul>
        <p className="rounded-2xl p-4 text-[15px]" style={{ background: pal.soft, color: pal.ink }}>
          Each pays {m.premiumBps / 100}% extra up front, and every one of them gets the card. All modes average 105.6% of the price.
        </p>
      </div>
    </figure>
  )
}
