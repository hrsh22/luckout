"use client"

import { useEffect, useState } from "react"

/** A moment in the reader's own time zone. A server render can't know it, so it shows UTC until the browser takes over. */
export function LocalTime({ iso, options }: { iso: string; options: Intl.DateTimeFormatOptions }) {
  const [local, setLocal] = useState(false)
  useEffect(() => setLocal(true), [])
  const d = new Date(iso)
  return <time dateTime={iso}>{local ? d.toLocaleString(undefined, options) : `${d.toLocaleString("en-US", { ...options, timeZone: "UTC" })} UTC`}</time>
}

/** When daily limits reset (00:00 UTC), in the reader's own time. */
export function DailyReset() {
  const next = new Date()
  next.setUTCHours(24, 0, 0, 0)
  return <LocalTime iso={next.toISOString()} options={{ timeStyle: "short" }} />
}
