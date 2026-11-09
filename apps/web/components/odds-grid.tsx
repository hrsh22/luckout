"use client"

import { usd } from "@/lib/format"
import { MODES, pricedOutcomes, simpleQuote } from "@/lib/modes"
import { useState } from "react"

const PRICE = 20_000_000
const LUCKY = MODES.filter((m) => m.premiumBps > 0)

/** What one outcome looks like: gold for less than the price, ink for more. */
const tone = (price: number) =>
  price === 0
    ? "bg-gold border-gold"
    : price < PRICE
    ? "bg-gold-soft border-gold"
    : price === PRICE
    ? "bg-receipt border-foreground/40"
    : "bg-foreground border-foreground"

const label = (price: number) =>
  price === 0 ? "paid nothing" : price < PRICE ? `paid ${usd(price)}` : price === PRICE ? `paid ${usd(price)}, the price` : `paid ${usd(price)}`

/** The honest odds, drawn: 100 buyers of a $20 card, each square what one of them paid. */
export function OddsGrid() {
  const [index, setIndex] = useState(2)
  const m = LUCKY[index]!
  const outcomes = pricedOutcomes(m, simpleQuote(m, PRICE))
  const cells = outcomes.flatMap((o) => Array.from({ length: o.chanceBps / 100 }, () => o.price))

  return (
    <figure className="bg-receipt border-border flex w-full max-w-[480px] flex-col gap-5 justify-self-center rounded-2xl border p-5 lg:justify-self-end shadow-[0_1px_0_#E2DCCB,0_18px_40px_-24px_rgba(19,22,29,0.35)] sm:p-7">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <figcaption className="text-lg leading-snug">
          100 people buy a <b>$20 card</b> on
        </figcaption>
        <div role="radiogroup" aria-label="Mode" className="bg-secondary flex rounded-full p-1">
          {LUCKY.map((x, i) => (
            <button
              key={x.name}
              type="button"
              role="radio"
              aria-checked={i === index}
              onClick={() => setIndex(i)}
              className="aria-checked:bg-foreground aria-checked:text-background focus-visible:ring-ring/50 min-h-9 rounded-full px-3.5 text-sm font-medium transition-colors outline-none focus-visible:ring-3"
            >
              {x.name}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-10 gap-1 sm:gap-1.5" aria-hidden="true">
        {cells.map((price, i) => (
          <span
            key={i}
            className={`aspect-square rounded-[3px] border transition-colors duration-300 ${tone(price)}`}
            style={{ transitionDelay: `${i * 4}ms` }}
          />
        ))}
      </div>

      <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
        {outcomes.map((o) => (
          <li key={o.price} className="flex items-center gap-2">
            <span className={`size-3 shrink-0 rounded-[2px] border ${tone(o.price)}`} aria-hidden="true" />
            <span><b className="tabular-nums">{o.chanceBps / 100}</b> {label(o.price)}</span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-sm">
        On {m.name} you add up to {m.premiumBps / 100}%. Every one of them gets the card.
      </p>
    </figure>
  )
}
