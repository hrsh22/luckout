"use client"

import { type Category, type Mode, type Purchase, type PurchasePage, type Transfer, type TransferPhase, VoucherSummary } from "@luckout/api"
import { type InfiniteData, keepPreviousData, type QueryClient, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "./api"
import { programInfo } from "./chain"
import { modeSlug, type ReserveView } from "./modes"
import { withNewest } from "./purchase-poll"
import { markedSince } from "@/lib/used"

// Every server read goes through here, so the catalog, a card and its history share one cache:
// going back to results is instant, and hovering a card has already fetched it.

/** What the customer filtered the shop by; nothing set lists every card. */
export interface ShopFilters {
  readonly q: string
  readonly country: string
  readonly category: Category | ""
}

export const browseKey = (f: ShopFilters, near = false) => ["browse", f.q.trim().toLowerCase(), f.country || (near ? "near" : ""), f.category]
export const popularKey = (f: Pick<ShopFilters, "country" | "category">) => ["popular", f.country, f.category]

/**
 * The catalog a page at a time; the server caches pages, so scrolling back is cheap. `near`, with no country, asks
 * for the visitor's own: the page says which it was.
 */
export const useBrowse = (f: ShopFilters, near = false) =>
  useInfiniteQuery({
    queryKey: browseKey(f, near),
    queryFn: ({ pageParam }) =>
      api((c) =>
        c.catalog.browse({
          query: {
            ...(f.q.trim() ? { q: f.q.trim() } : {}),
            ...(f.country ? { country: f.country } : near ? { near: "1" as const } : {}),
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
    queryKey: popularKey(f),
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

export const useQuote = (voucherId: string, value: string | undefined, mode: Mode, active = true) =>
  useQuery({
    queryKey: ["quote", voucherId, value, modeSlug(mode)],
    queryFn: () =>
      api((c) => c.catalog.quote({ query: { voucherId, value: value!, ...(mode === "normal" ? {} : { game: mode.lucky }) } })),
    // Off, it keeps its last quote and isn't polled; turned on again, a stale one is read at once.
    enabled: !!value && active,
    // The reserve and Bitrefill's price move: while the page is in sight the quote is renewed as it goes stale, and
    // at once on coming back to the tab, so Buy sends the terms on screen, not ones from minutes ago.
    // ponytail: a visible tab nobody looks at keeps asking, one quote simulation per 20 s and one Bitrefill price lookup a
    // minute (the server reuses a quote's price for up to a minute, or its last one, up to an hour old, while lookups
    // are busy); refetch on the Buy click instead if RPC load ever matters.
    staleTime: 20_000,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true
  })

/**
 * The program's public state (GET /program): Game Versions, reserve, Cashback Cap, smallest Lucky Checkout and the
 * Live Average figures. The server reads it at most every 30 seconds.
 */
export const useProgram = () =>
  useQuery({
    queryKey: ["program"],
    queryFn: () => programInfo(),
    staleTime: 30_000
  })

/** The Free Reserve and the most Cashback one card can pay now: they shape every Lucky Amount. Undefined until read. */
export const useReserve = () =>
  useQuery({
    queryKey: ["program"],
    queryFn: () => programInfo(),
    staleTime: 30_000,
    select: (p): ReserveView => ({ free: p.reserve.free, max_cashback: p.reserve.maxCashback })
  }).data

const pending = (p: Purchase) => p.status === "pending" || p.status === "waiting"
const fresh = (p: Purchase) => Date.now() - new Date(p.createdAt).getTime() < 15 * 60_000

/**
 * The customer's purchases, newest first, a page of 100 at a time. While one on the first page is in progress, the
 * newest page alone is read again: every 4 s, or every minute once the only open ones are over 15 minutes old
 * (stuck). Older pages are history; re-reading every loaded page each time would pass the 120-a-minute limit.
 */
export const usePurchases = (token: string | undefined) => {
  const qc = useQueryClient()
  const list = useInfiniteQuery({
    queryKey: ["purchases", token],
    queryFn: ({ pageParam }) => api((c) => c.purchases.list({ query: pageParam ? { before: pageParam } : {} }), token),
    initialPageParam: "",
    getNextPageParam: (last) => last.next,
    enabled: !!token
  })
  const open = list.data?.pages[0]?.items.filter(pending) ?? []
  const every = open.length === 0 ? false : open.some(fresh) ? 4000 : 60_000
  // Not under "purchases": what re-reads the whole list after a buy or a cancel needn't read this page twice.
  useQuery({
    queryKey: ["purchases-newest", token],
    queryFn: async () => {
      const started = Date.now()
      const newest = await api((c) => c.purchases.list({ query: {} }), token)
      // Read before a card was marked used or unused: it would put the old state back. The next read brings the rest.
      if (!markedSince(started)) qc.setQueryData<InfiniteData<PurchasePage, string>>(["purchases", token], (d) => d && { ...d, pages: withNewest(d.pages, newest) })
      return newest
    },
    enabled: every !== false,
    refetchInterval: every
  })
  return list
}

/**
 * The Checkout Email Bitrefill gets with each card (ADR-0012). `needed` is false where buying takes none (testnet,
 * or they connected their own Bitrefill account: `bitrefill`, missing where connecting isn't offered).
 */
export const useCheckoutEmail = (token: string | undefined) =>
  useQuery({
    queryKey: ["checkout-email", token],
    queryFn: () => api((c) => c.purchases.checkoutEmail(), token),
    enabled: !!token,
    staleTime: 5 * 60_000
  })

/** Saves the Checkout Email; the server checks it and answers with what it kept. */
export const useSaveCheckoutEmail = (token: string | undefined) => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (email: string) => api((c) => c.purchases.setCheckoutEmail({ payload: { email } }), token),
    onSuccess: (saved) => qc.setQueryData(["checkout-email", token], saved)
  })
}

/** Whether Telegram is linked (in Privy; the server reads it at sign-in) and the bot to open. */
export const useTelegram = (token: string | undefined) =>
  useQuery({
    queryKey: ["telegram", token],
    queryFn: () => api((c) => c.telegram.status(), token),
    enabled: !!token,
    refetchOnWindowFocus: true
  })

/** Phases where the customer's money is still moving, or waiting on them: polled often. */
export const ACTIVE_PHASES: ReadonlySet<TransferPhase> = new Set(["awaiting-transfer", "incomplete", "swapping"])

/** Top-Ups 1Click has (or that we know were paid) and is delivering: not a quote still waiting for its transfer, nor one paid short. */
export const arriving = (list: ReadonlyArray<Transfer>) =>
  list.filter((t) => t.phase === "swapping" || (t.phase === "awaiting-transfer" && !!t.depositTx))

/**
 * The customer's 1Click Top-Ups (still moving, or ended in the last day), from the server so they survive a closed
 * tab. Checked often while one is moving.
 */
export const useTransfers = (token: string | undefined) =>
  useQuery({
    queryKey: ["transfers", token],
    queryFn: () => api((c) => c.topup.transfers(), token),
    enabled: !!token,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (q.state.data?.some((t) => ACTIVE_PHASES.has(t.phase)) ? 8000 : 60_000)
  })

/** Whether the signed-in account may open the admin panel; decides the menu link. */
export const useIsAdmin = (token: string | undefined) =>
  useQuery({
    queryKey: ["admin-me", token],
    queryFn: () => api((c) => c.admin.me(), token).then(() => true, () => false),
    enabled: !!token,
    staleTime: Infinity
  }).data === true

/** Whether purchases can start: an admin may have stopped sales, the owner paused the program, or Bitrefill's order limit is reached. */
export const useShopStatus = () =>
  useQuery({
    queryKey: ["shop-status"],
    queryFn: () => api((c) => c.status()),
    staleTime: 20_000,
    // At the order limit, checked again just after the time it reopens.
    refetchInterval: (q) => Math.min(60_000, Math.max(5_000, (q.state.data?.reopensAt ?? Infinity) - Date.now() + 2_000))
  })
