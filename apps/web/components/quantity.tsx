"use client"

import { cn } from "cn"
import { Minus, Plus } from "lucide-react"

/** − n +, for how many of a card. `max` caps it (the Cart's room); at `min` the minus is off (removing is its own button). */
export function Quantity({ value, onChange, max, min = 1, label, size = "md", disabled = false, className }: {
  value: number
  onChange: (n: number) => void
  max: number
  min?: number
  /** Names the card, for screen readers: "Quantity of Swiggy 50 INR". */
  label: string
  size?: "sm" | "md"
  disabled?: boolean
  className?: string
}) {
  const button = cn(
    "grid place-items-center rounded-full text-ink transition-colors hover:bg-white disabled:pointer-events-none disabled:opacity-35",
    size === "sm" ? "size-8 [&_svg]:size-4" : "size-10 [&_svg]:size-[18px]"
  )
  return (
    <div role="group" aria-label={label} className={cn("inline-flex items-center rounded-full bg-soft p-1", size === "sm" ? "gap-0.5" : "gap-1", className)}>
      <button type="button" className={button} aria-label="One fewer" disabled={disabled || value <= min} onClick={() => onChange(value - 1)}>
        <Minus />
      </button>
      <output aria-live="polite" className={cn("text-center font-semibold tabular-nums", size === "sm" ? "w-6 text-sm" : "w-8")}>{value}</output>
      <button type="button" className={button} aria-label="One more" disabled={disabled || value >= max} onClick={() => onChange(value + 1)}>
        <Plus />
      </button>
    </div>
  )
}
