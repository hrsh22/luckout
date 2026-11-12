"use client"

import { dollars, toMicro } from "@/lib/format"

/** An amount field with quick picks. Everything stays in micro-USDC except what's typed. */
export function AmountField({ value, onChange, picks, label }: {
  value: string
  onChange: (v: string) => void
  picks: ReadonlyArray<{ label: string; micro: number }>
  label: string
}) {
  return (
    <div className="flex flex-col gap-3">
      <label className="relative block">
        <span className="sr-only">{label}</span>
        <span className="font-display pointer-events-none absolute top-1/2 left-5 -translate-y-1/2 text-3xl font-extrabold text-muted">$</span>
        <input
          className="field font-display !h-14 !rounded-[1.25rem] !pl-11 !text-3xl !font-extrabold"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))}
          aria-invalid={value !== "" && !(toMicro(value) > 0)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        {picks.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => onChange(dollars(p.micro))}
            aria-pressed={toMicro(value) === p.micro}
            className="h-9 rounded-full bg-soft px-4 text-sm font-semibold transition-colors hover:bg-[#ebe9f3] aria-pressed:bg-ink aria-pressed:text-white"
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  )
}
