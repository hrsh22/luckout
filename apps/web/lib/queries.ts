"use client"

import type { Mode, Purchase, VoucherSummary } from "@luckout/api"
import { keepPreviousData, type QueryClient, useQuery } from "@tanstack/react-query"
import { api } from "./api"
import { modeSlug } from "./modes"

// Every server read goes through here, so the catalog, a card and its history share one cache:
// going back to results is instant, and hovering a card has already fetched it.

export const searchQuery = (q: string) => ({
  queryKey: ["search", q.trim().toLowerCase()],
  queryFn: () => api((c) => c.catalog.search({ query: { q } })),
  staleTime: 5 * 60_000
})
export const useSearch = (q: string) => useQuery({ ...searchQuery(q), placeholderData: keepPreviousData })

export const voucherQuery = (id: string) => ({
  queryKey: ["voucher", id],
  queryFn: () => api((c) => c.catalog.voucher({ params: { id } })),
  staleTime: 60_000
})

/** The search result that led to a card: it carries the logo, which a card fetched directly may not. */
export const rememberSummary = (qc: QueryClient, v: VoucherSummary) => qc.setQueryData(["summary", v.id], v)
export const useSummary = (id: string) =>
  useQuery<VoucherSummary | null>({ queryKey: ["summary", id], queryFn: () => null, staleTime: Infinity })

export const useQuote = (voucherId: string, value: string | undefined, mode: Mode) =>
  useQuery({
    queryKey: ["quote", voucherId, value, modeSlug(mode)],
    queryFn: () =>
      api((c) => c.catalog.quote({ query: { voucherId, value: value!, ...(mode === "normal" ? {} : { game: mode.lucky }) } })),
    enabled: !!value,
    // The reserve and Bitrefill's price move; a quote older than this is fetched again before buying.
    staleTime: 20_000
  })

const pending = (p: Purchase) => p.status === "pending"

export const usePurchases = (token: string | undefined) =>
  useQuery({
    queryKey: ["purchases", token],
    queryFn: () => api((c) => c.purchases.list(), token),
    enabled: !!token,
    refetchInterval: (q) => (q.state.data?.some(pending) ? 4000 : false)
  })

/** While `waiting` (the customer is off in Telegram tapping Start), check every 2 s until linked. */
export const useTelegram = (token: string | undefined, waiting = false) =>
  useQuery({
    queryKey: ["telegram", token],
    queryFn: () => api((c) => c.telegram.status(), token),
    enabled: !!token,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (waiting && !q.state.data?.linked ? 2000 : false)
  })

/** Whether the signed-in account may open the admin panel; decides the menu link. */
export const useIsAdmin = (token: string | undefined) =>
  useQuery({
    queryKey: ["admin-me", token],
    queryFn: () => api((c) => c.admin.me(), token).then(() => true, () => false),
    enabled: !!token,
    staleTime: Infinity
  }).data === true
