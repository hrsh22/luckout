"use client"

import { type Category, type Mode, type Purchase, type TransferPhase, VoucherSummary } from "@luckout/api"
import { keepPreviousData, type QueryClient, useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { api } from "./api"
import { contractId, view } from "./chain"
import { modeSlug } from "./modes"

// Every server read goes through here, so the catalog, a card and its history share one cache:
// going back to results is instant, and hovering a card has already fetched it.

/** What the customer filtered the shop by; nothing set lists every card. */
export interface ShopFilters {
  readonly q: string
  readonly country: string
  readonly category: Category | ""
}

/** The catalog a page at a time; the server caches pages, so scrolling back is cheap. */
export const useBrowse = (f: ShopFilters) =>
  useInfiniteQuery({
    queryKey: ["browse", f.q.trim().toLowerCase(), f.country, f.category],
    queryFn: ({ pageParam }) =>
      api((c) =>
        c.catalog.browse({
          query: {
            ...(f.q.trim() ? { q: f.q.trim() } : {}),
            ...(f.country ? { country: f.country } : {}),
            ...(f.category ? { category: f.category } : {}),
            ...(pageParam ? { start: pageParam } : {})
          }
        })
      ),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData
  })

/** Popular cards for the chosen country, or for the visitor's own when none is chosen (the server knows it). */
export const usePopular = (f: Pick<ShopFilters, "country" | "category">, enabled: boolean) =>
  useQuery({
    queryKey: ["popular", f.country, f.category],
    queryFn: () =>
      api((c) => c.catalog.popular({ query: { ...(f.country ? { country: f.country } : {}), ...(f.category ? { category: f.category } : {}) } })),
    enabled,
    staleTime: 10 * 60_000,
    placeholderData: keepPreviousData
  })

const VIEWED = "luckout.viewed"
/** Cards opened lately in this browser, newest first; kept on this device only. */
export const viewedCards = (): Array<VoucherSummary> => {
  try {
    return (JSON.parse(localStorage.getItem(VIEWED) ?? "[]") as Array<VoucherSummary>).map((v) => new VoucherSummary(v))
  } catch {
    return []
  }
}
export const rememberViewed = ({ id, name, countryCode, countryName, currency, image, background }: VoucherSummary) => {
  try {
    const card = { id, name, countryCode, countryName, currency, image, background }
    localStorage.setItem(VIEWED, JSON.stringify([card, ...viewedCards().filter((v) => v.id !== id)].slice(0, 6)))
  } catch {}
}

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

/** The Free Reserve (micro-USDC), straight from the chain: its Discount Cap shapes every Lucky Amount. Undefined until read. */
export const useFreeReserve = () =>
  useQuery({
    queryKey: ["free-reserve"],
    queryFn: () => view<{ free: string }>(contractId, "get_reserve").then((r) => r.free),
    staleTime: 60_000
  }).data

const pending = (p: Purchase) => p.status === "pending" || p.status === "waiting"
const fresh = (p: Purchase) => Date.now() - new Date(p.createdAt).getTime() < 15 * 60_000

/** Every 4 s while a purchase is in progress; once the only open ones are over 15 minutes old (stuck), every minute. */
export const usePurchases = (token: string | undefined) =>
  useQuery({
    queryKey: ["purchases", token],
    queryFn: () => api((c) => c.purchases.list(), token),
    enabled: !!token,
    refetchInterval: (q) => {
      const open = q.state.data?.filter(pending) ?? []
      return open.length === 0 ? false : open.some(fresh) ? 4000 : 60_000
    }
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

/** Phases where the customer's money is still moving, or waiting on them: polled often. */
export const ACTIVE_PHASES: ReadonlySet<TransferPhase> = new Set(["awaiting-transfer", "incomplete", "swapping", "moving"])

/**
 * The customer's Top-Ups and withdrawals through NEAR Intents (still moving, or ended in the last day),
 * from the server so they survive a closed tab. Checked often while one is moving.
 */
export const useTransfers = (token: string | undefined) =>
  useQuery({
    queryKey: ["transfers", token],
    queryFn: () => api((c) => c.topup.transfers(), token),
    enabled: !!token,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (q.state.data?.some((t) => ACTIVE_PHASES.has(t.phase)) ? 8000 : 60_000)
  })

/** What else is in the customer's NEAR Intents account: 1Click's change and refunds, in the token paid with. */
export const useHeld = (token: string | undefined) =>
  useQuery({
    queryKey: ["held", token],
    queryFn: () => api((c) => c.topup.held(), token),
    enabled: !!token,
    refetchOnWindowFocus: true
  })

/** Whether the signed-in account may open the admin panel; decides the menu link. */
export const useIsAdmin = (token: string | undefined) =>
  useQuery({
    queryKey: ["admin-me", token],
    queryFn: () => api((c) => c.admin.me(), token).then(() => true, () => false),
    enabled: !!token,
    staleTime: Infinity
  }).data === true

/** Whether purchases can start: an admin may have stopped sales, or the owner paused the contract. */
export const useShopStatus = () =>
  useQuery({
    queryKey: ["shop-status"],
    queryFn: () => api((c) => c.status()),
    staleTime: 20_000,
    refetchInterval: 60_000
  })
