"use client"

import { isNotFound } from "@/lib/api"
import { voucherQuery } from "@/lib/queries"
import { useQuery } from "@tanstack/react-query"
import { notFound, useParams } from "next/navigation"
import type { ReactNode } from "react"

/**
 * A card id Bitrefill doesn't sell (a mistyped or old link) shows the not-found page, not "try again": an outage still
 * reaches the card page's own error. Reads the card page's own query, so nothing is fetched twice.
 */
export function MissingCard({ children }: { children: ReactNode }) {
  const id = decodeURIComponent(useParams<{ id: string }>().id)
  const { error } = useQuery(voucherQuery(id))
  if (isNotFound(error)) notFound()
  return children
}
