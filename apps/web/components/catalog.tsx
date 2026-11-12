"use client"

import { GiftCard } from "@/components/gift-card"
import { errorMessage } from "@/lib/api"
import { COUNTRIES, countryName, flag } from "@/lib/countries"
import { network } from "@/lib/near"
import { rememberSummary, type ShopFilters, useBrowse, usePopular, viewedCards, voucherQuery } from "@/lib/queries"
import { CATEGORIES, type Category, type VoucherSummary } from "@luckout/api"
import { useQueryClient } from "@tanstack/react-query"
import { Search, X } from "lucide-react"
import { motion } from "motion/react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { type ReactNode, useEffect, useRef, useState } from "react"

const CATEGORY_NAMES: Record<Category, string> = {
  shopping: "Shopping",
  food: "Food",
  games: "Games",
  entertainment: "Entertainment",
  travel: "Travel"
}
const isCategory = (c: string | null): c is Category => !!c && (CATEGORIES as ReadonlyArray<string>).includes(c)

/** The shop's address for a set of filters, so Back and shared links keep them ("all": every country, chosen). */
const shopUrl = (f: ShopFilters, everyCountry: boolean) => {
  const p = new URLSearchParams()
  if (f.q.trim()) p.set("q", f.q.trim())
  if (f.country) p.set("country", f.country)
  else if (everyCountry) p.set("country", "all")
  if (f.category) p.set("category", f.category)
  return p.size ? `/shop?${p}` : "/shop"
}

/**
 * The catalog. A card only works in its own country, so until the customer picks one, the shop shows the
 * visitor's own (with cards for their region or worldwide), saying so; "All countries" is one choice away.
 */
export function Catalog() {
  const params = useSearchParams()
  const urlCountry = params.get("country")
  // Whether the customer has chosen a country (or every country): then it's never chosen for them.
  const picked = useRef(urlCountry !== null)
  const [filters, setFilters] = useState<ShopFilters>(() => ({
    q: params.get("q") ?? "",
    country: /^[A-Z]{2}$/.test(urlCountry ?? "") ? urlCountry! : "",
    category: isCategory(params.get("category")) ? params.get("category") as Category : ""
  }))
  const [text, setText] = useState(filters.q)
  const results = useBrowse(filters)
  const items = results.data?.pages.flatMap((p) => p.items) ?? []

  const update = (next: Partial<ShopFilters>) =>
    setFilters((f) => {
      const merged = { ...f, ...next }
      window.history.replaceState(null, "", shopUrl(merged, picked.current))
      try {
        // A card's Back link returns to the same view.
        sessionStorage.setItem("luckout.shop", shopUrl(merged, picked.current))
      } catch {}
      return merged
    })

  // Search as you type, a beat after the last key; clearing it lists everything again.
  useEffect(() => {
    const t = setTimeout(() => {
      const next = text.trim()
      if (next === filters.q || (next.length === 1)) return
      update({ q: next })
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  // More cards as the end of the list comes into view.
  const end = useRef<HTMLDivElement>(null)
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = results
  useEffect(() => {
    const el = end.current
    if (!el || !hasNextPage) return
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage()
    }, { rootMargin: "600px" })
    seen.observe(el)
    return () => seen.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  const filtered = !!(filters.q || filters.country || filters.category)

  // Above the full list unless the customer is searching: what they opened lately, and the brands people
  // buy most where they are. Testnet sells only test cards, so it has no popular ones.
  const popularOn = network !== "testnet" && !filters.q
  const popular = usePopular(filters, popularOn)
  // Not isLoading: it depends on fetching, which differs between the server render and the first client one.
  const popularPending = popularOn && popular.isPending
  const popularItems = popular.data?.items ?? []
  const near = popular.data?.country
  // The visitor's own country, once known, unless they chose one (or every country) themselves.
  useEffect(() => {
    if (near && !picked.current && !filters.country) {
      picked.current = true
      update({ country: near })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near])
  // Read after mount: the server render has no browser storage.
  const [viewed, setViewed] = useState<Array<VoucherSummary>>([])
  useEffect(() => setViewed(viewedCards()), [])
  // Not while the visitor's own country is on its way: it filters the shop, which would hide this row a moment later.
  const countryComing = popularOn && !picked.current && (popularPending || !!near)
  const showViewed = !filtered && !countryComing && viewed.length > 0
  const shelves = !filters.q && (showViewed || popularPending || popularItems.length > 0)

  return (
    <section className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <h1 className="font-display text-5xl leading-[0.95] font-extrabold tracking-[-0.03em] sm:text-[64px]">Find a card</h1>
        <p className="max-w-[56ch] text-lg text-ink-soft">
          Gift cards from Bitrefill for stores around the world. Each card works only in its own country, so pick yours, then choose to
          pay the price or play for cashback.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex max-w-3xl flex-col gap-3 sm:flex-row">
          <form role="search" onSubmit={(e) => (e.preventDefault(), update({ q: text.trim() }))} className="relative flex-1">
            <Search size={22} className="pointer-events-none absolute top-1/2 left-5 -translate-y-1/2 text-muted" aria-hidden="true" />
            <input
              className="field !h-16 !rounded-full !pr-14 !pl-14 !text-lg shadow-card"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Search a brand, like Amazon or Steam"
              aria-label="Search gift cards"
            />
            {text && (
              <button
                type="button"
                onClick={() => (setText(""), update({ q: "" }))}
                className="absolute top-1/2 right-3 grid size-10 -translate-y-1/2 place-items-center rounded-full text-muted hover:bg-soft"
                aria-label="Clear search"
              >
                <X size={18} />
              </button>
            )}
          </form>
          <label className="relative sm:w-64">
            <span className="sr-only">Country the card is for</span>
            <select
              className="field !h-16 w-full cursor-pointer appearance-none !rounded-full !pr-10 !pl-5 !text-base shadow-card"
              value={filters.country}
              onChange={(e) => ((picked.current = true), update({ country: e.target.value }))}
            >
              <option value="">🌐 All countries</option>
              {/* Node and browsers name a few places differently ("Falkland Islands (Islas Malvinas)"); either is fine. */}
              {COUNTRIES.map((c) => <option key={c.code} value={c.code} suppressHydrationWarning>{flag(c.code)} {c.name}</option>)}
            </select>
            <span className="pointer-events-none absolute top-1/2 right-5 -translate-y-1/2 text-muted" aria-hidden="true">▾</span>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Category">
          {(["", ...CATEGORIES] as const).map((c) => (
            <button
              key={c || "all"}
              type="button"
              onClick={() => update({ category: c })}
              aria-pressed={filters.category === c}
              className="h-9 rounded-full bg-white/80 px-4 text-sm font-semibold text-ink-soft transition-colors hover:text-ink aria-pressed:bg-ink aria-pressed:text-white"
            >
              {c ? CATEGORY_NAMES[c] : "All"}
            </button>
          ))}
          {network === "testnet" && <span className="ml-1 text-sm text-muted">Testnet: only Bitrefill test cards can be bought.</span>}
        </div>
        {filters.country && (
          <p className="text-sm text-ink-soft">
            Cards that work in {flag(filters.country)} {countryName(filters.country)}, including ones that work across a region or worldwide.
          </p>
        )}
      </div>

      {shelves && (
        <>
          {showViewed && <Shelf title="Recently viewed" items={viewed} />}
          {popularPending
            ? <Shelf title="Popular" />
            : popularItems.length > 0 && (
              <Shelf
                title={near ? `Popular in ${flag(near)} ${countryName(near)}` : "Popular worldwide"}
                items={popularItems}
                dim={popular.isPlaceholderData}
                action={!filters.country && near && (
                  <button
                    type="button"
                    onClick={() => update({ country: near })}
                    className="h-9 rounded-full bg-white/80 px-4 text-sm font-semibold text-ink-soft transition-colors hover:text-ink"
                  >
                    Show only cards for {flag(near)} {countryName(near)}
                  </button>
                )}
              />
            )}
          <h2 className="font-display text-2xl font-extrabold">All cards</h2>
        </>
      )}

      {results.error && <p role="alert" className="font-medium text-bad">{errorMessage(results.error)}</p>}

      <ul className={`grid grid-cols-2 gap-4 transition-opacity sm:grid-cols-3 lg:grid-cols-4 ${results.isPlaceholderData ? "opacity-60" : ""}`} aria-busy={results.isFetching}>
        {results.isPending && Array.from({ length: 8 }, (_, i) => (
          <li key={i} className="flex flex-col gap-3">
            <span className="skeleton aspect-[1.6] rounded-[1.25rem]" />
            <span className="skeleton h-4 w-2/3 rounded-full" />
          </li>
        ))}
        {items.map((v, i) => <Tile key={v.id} v={v} index={i} />)}
      </ul>

      {results.isSuccess && !results.isPlaceholderData && items.length === 0 && !hasNextPage && (
        <div className="card flex flex-col items-start gap-3 p-8">
          <p className="font-display text-2xl font-extrabold">No cards match</p>
          <p className="text-ink-soft">
            {filters.country ? `Bitrefill may not sell cards for ${countryName(filters.country)} that we can deliver yet. ` : ""}
            Try another search, country or category.
          </p>
          {filtered && (
            <button type="button" onClick={() => (setText(""), (picked.current = true), update({ q: "", country: "", category: "" }))} className="font-semibold underline underline-offset-4">
              Show every card
            </button>
          )}
        </div>
      )}

      <div ref={end} className="flex justify-center">
        {hasNextPage && (
          <button
            type="button"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
            className="h-11 rounded-full bg-white/80 px-6 text-sm font-semibold text-ink-soft shadow-card hover:text-ink disabled:opacity-60"
          >
            {isFetchingNextPage ? "Loading more cards…" : "Show more cards"}
          </button>
        )}
      </div>
    </section>
  )
}

const SHELF_ITEM = "w-40 shrink-0 snap-start sm:w-48 lg:w-auto"

/** A row of cards: it scrolls sideways on small screens and wraps into rows of six on wide ones. Without items, a placeholder. */
function Shelf({ title, action, items, dim = false }: { title: string; action?: ReactNode; items?: ReadonlyArray<VoucherSummary>; dim?: boolean }) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="font-display text-2xl font-extrabold">{title}</h2>
        {action}
      </div>
      <ul
        className={`-mx-4 -my-2 flex snap-x scroll-px-4 gap-4 overflow-x-auto px-4 py-2 transition-opacity sm:-mx-10 sm:scroll-px-10 sm:px-10 lg:mx-0 lg:grid lg:grid-cols-6 lg:overflow-visible lg:px-0 ${dim ? "opacity-60" : ""}`}
        aria-busy={!items}
      >
        {items
          ? items.map((v, i) => <Tile key={v.id} v={v} index={i} className={SHELF_ITEM} />)
          : Array.from({ length: 6 }, (_, i) => (
            <li key={i} className={`flex flex-col gap-3 ${SHELF_ITEM}`}>
              <span className="skeleton aspect-[1.6] rounded-[1.25rem]" />
              <span className="skeleton h-4 w-2/3 rounded-full" />
            </li>
          ))}
      </ul>
    </section>
  )
}

function Tile({ v, index, className }: { v: VoucherSummary; index: number; className?: string }) {
  const qc = useQueryClient()
  const warm = () => qc.prefetchQuery(voucherQuery(v.id))
  return (
    <motion.li
      className={className}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 30, delay: Math.min(index % 24, 11) * 0.025 }}
    >
      <Link
        href={`/shop/${encodeURIComponent(v.id)}`}
        onClick={() => rememberSummary(qc, v)}
        onPointerEnter={warm}
        onFocus={warm}
        className="group flex flex-col gap-3 rounded-[1.25rem] outline-none"
      >
        <GiftCard v={v} className="shadow-card transition-transform duration-200 group-hover:-translate-y-1 group-hover:rotate-[-1.5deg] group-focus-visible:ring-4 group-focus-visible:ring-lilac/50" />
        <span className="px-1">
          <span className="block leading-snug font-semibold">{v.name}</span>
          <span className="text-sm text-ink-soft">
            {flag(v.countryCode)} {countryName(v.countryCode, v.countryName)} · {v.currency}
          </span>
        </span>
      </Link>
    </motion.li>
  )
}
