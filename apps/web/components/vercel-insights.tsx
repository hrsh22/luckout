"use client"

import { Analytics } from "@vercel/analytics/next"
import { SpeedInsights } from "@vercel/speed-insights/next"

/**
 * Vercel's page views and speed reports, with each address cut at its query. A query can hold what only the
 * customer should see: the one-time code Bitrefill sends back to the Wallet page, an account on an admin page.
 */
const withoutQuery = <E extends { url: string }>(event: E): E => ({ ...event, url: event.url.split(/[?#]/)[0]! })

export function VercelInsights() {
  return (
    <>
      <Analytics beforeSend={withoutQuery} />
      <SpeedInsights beforeSend={withoutQuery} />
    </>
  )
}
