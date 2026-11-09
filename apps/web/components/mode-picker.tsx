"use client"

import { OddsBar } from "@/components/odds"
import { usd } from "@/lib/format"
import { cashbackChanceBps, MODES, pricedOutcomes, RECOMMENDED, sameMode, simpleQuote } from "@/lib/modes"
import { modePalette } from "@/lib/palette"
import type { Mode } from "@luckout/api"
import { Check, LoaderCircle } from "lucide-react"
import { motion } from "motion/react"

/**
 * The four ways to pay, as tiles in their own colours. With a price, each tile says what you'd pay
 * now and the most you could get back; without one, it shows the odds for any purchase.
 */
export function ModePicker({ value, onChange, price, savedDefault, saving, label = "How do you want to pay?" }: {
  value: Mode
  onChange: (m: Mode) => void
  /** Reference Price in micro-USDC, when a card and amount are chosen. */
  price?: number | undefined
  /** The account's saved Default Mode, marked on its tile. */
  savedDefault?: Mode | undefined
  /** A mode being saved right now shows a spinner. */
  saving?: Mode | undefined
  label?: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-3 sm:grid-cols-2">
      {MODES.map((m) => {
        const selected = sameMode(value, m.mode)
        const p = modePalette(m.mode)
        const example = price ?? 20_000_000
        const outcomes = pricedOutcomes(m, simpleQuote(m, example))
        const best = outcomes[outcomes.length - 1]!
        const chance = cashbackChanceBps(m) / 100
        return (
          <motion.button
            key={m.name}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(m.mode)}
            whileTap={{ scale: 0.98 }}
            className="relative flex min-h-[148px] flex-col overflow-hidden rounded-[1.75rem] p-5 text-left transition-shadow outline-none focus-visible:ring-4 focus-visible:ring-lilac/40"
            style={{
              background: selected ? p.tile : "#fff",
              color: selected ? p.ink : undefined,
              boxShadow: selected ? "0 24px 40px -28px rgb(22 18 43 / 0.55)" : "var(--shadow-card)"
            }}
          >
            <span className="flex items-center gap-2">
              <span className="size-3 rounded-full" style={{ background: selected ? p.ink : p.solid }} aria-hidden="true" />
              <span className="font-display text-2xl font-extrabold">{m.name}</span>
              {savedDefault && sameMode(savedDefault, m.mode)
                ? <span className="pill ml-1" style={{ background: selected ? "rgb(255 255 255 / 0.55)" : p.soft, color: p.ink }}>Your default</span>
                : m.name === RECOMMENDED && (
                  <span className="pill ml-1" style={{ background: selected ? "rgb(255 255 255 / 0.55)" : p.soft, color: p.ink }}>Recommended</span>
                )}
              <span className="ml-auto grid size-7 place-items-center rounded-full" style={{ background: selected ? p.ink : "var(--color-soft)" }} aria-hidden="true">
                {saving && sameMode(saving, m.mode)
                  ? <LoaderCircle size={16} className="animate-spin" color={selected ? "#fff" : undefined} />
                  : selected && <Check size={16} strokeWidth={3} color="#fff" />}
              </span>
            </span>
            <span className={`mt-1 text-[15px] ${selected ? "opacity-80" : "text-ink-soft"}`}>
              {m.premiumBps === 0
                ? price ? `Pay ${usd(example)}, exactly the price` : "Exactly the price, no Draw"
                : price ? `Pay ${usd(outcomes[0]!.price)} now, +${m.premiumBps / 100}%` : `+${m.premiumBps / 100}% up front`}
            </span>
            <span className="mt-auto pt-4">
              {m.premiumBps === 0
                ? <span className={`text-sm ${selected ? "opacity-80" : "text-muted"}`}>No cashback, no surprises.</span>
                : (
                  <>
                    <OddsBar outcomes={outcomes} className="h-2" />
                    <span className={`mt-2 block text-sm ${selected ? "opacity-85" : "text-muted"}`}>
                      <b className="font-semibold">{chance}%</b> get cashback, up to {best.price === 0 ? `all ${usd(best.cashback)}` : usd(best.cashback)}
                      {price ? "" : " on a $20 card"}
                    </span>
                  </>
                )}
            </span>
          </motion.button>
        )
      })}
    </div>
  )
}
