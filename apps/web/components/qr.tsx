"use client"

import { useMemo } from "react"
import { renderSVG } from "uqr"

/** A QR code for an address, so it can be scanned from a phone wallet or an exchange app. */
export function Qr({ value, size = 168, label }: { value: string; size?: number; label: string }) {
  // uqr draws plain rects from the encoded bits; the value itself never lands in the markup.
  const svg = useMemo(() => renderSVG(value, { border: 1 }), [value])
  return (
    <div
      role="img"
      aria-label={label}
      className="shrink-0 overflow-hidden rounded-2xl bg-white p-2 shadow-card [&>svg]:size-full"
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
