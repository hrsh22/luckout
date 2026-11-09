"use client"

import { GiftCard } from "@/components/gift-card"
import { errorMessage } from "@/lib/api"
import { network } from "@/lib/near"
import { rememberSummary, useSearch, voucherQuery } from "@/lib/queries"
import type { VoucherSummary } from "@luckout/api"
import { useQueryClient } from "@tanstack/react-query"
import { Search, X } from "lucide-react"
import { motion } from "motion/react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useEffect, useState } from "react"

const SUGGESTIONS = network === "testnet" ? ["Test gift card"] : ["Amazon", "Steam", "Netflix", "Uber", "Spotify", "Airbnb"]

export function Catalog() {
  const params = useSearchParams()
  const initial = params.get("q") ?? SUGGESTIONS[0]!
  const [text, setText] = useState(initial)
  const [q, setQ] = useState(initial)
  const results = useSearch(q)
  useEffect(() => {
    try {
      sessionStorage.setItem("luckout.q", q)
    } catch {}
  }, [q])

  // Search as you type, a beat after the last key; the query lives in the URL so Back returns here.
  useEffect(() => {
    const t = setTimeout(() => {
      const next = text.trim()
      if (next.length < 2 || next === q) return
      setQ(next)
      window.history.replaceState(null, "", `/shop?q=${encodeURIComponent(next)}`)
    }, 300)
    return () => clearTimeout(t)
  }, [text, q])

  const pick = (s: string) => {
    setText(s)
    setQ(s)
    window.history.replaceState(null, "", `/shop?q=${encodeURIComponent(s)}`)
  }

  return (
    <section className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <h1 className="font-display text-5xl leading-[0.95] font-extrabold tracking-[-0.03em] sm:text-[64px]">Find a card</h1>
        <p className="max-w-[52ch] text-lg text-ink-soft">
          Gift cards, phone top-ups and eSIMs from Bitrefill. Pick one, then choose to pay the price or play for cashback.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <form role="search" onSubmit={(e) => (e.preventDefault(), text.trim() && pick(text.trim()))} className="relative max-w-2xl">
          <Search size={22} className="pointer-events-none absolute top-1/2 left-5 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input
            className="field !h-16 !rounded-full !pr-14 !pl-14 !text-lg shadow-card"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search a brand, like Amazon or Steam"
            aria-label="Search gift cards"
          />
          {text && (
            <button type="button" onClick={() => setText("")} className="absolute top-1/2 right-3 grid size-10 -translate-y-1/2 place-items-center rounded-full text-muted hover:bg-soft" aria-label="Clear search">
              <X size={18} />
            </button>
          )}
        </form>
        <div className="flex flex-wrap items-center gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => pick(s)}
              aria-pressed={q.toLowerCase() === s.toLowerCase()}
              className="h-9 rounded-full bg-white/80 px-4 text-sm font-semibold text-ink-soft transition-colors hover:text-ink aria-pressed:bg-ink aria-pressed:text-white"
            >
              {s}
            </button>
          ))}
          {network === "testnet" && <span className="ml-1 text-sm text-muted">Testnet: only Bitrefill test cards can be bought.</span>}
        </div>
      </div>

      {results.error && <p role="alert" className="font-medium text-bad">{errorMessage(results.error)}</p>}

      <ul className={`grid grid-cols-2 gap-4 transition-opacity sm:grid-cols-3 lg:grid-cols-4 ${results.isPlaceholderData ? "opacity-60" : ""}`} aria-busy={results.isFetching}>
        {results.isPending && Array.from({ length: 8 }, (_, i) => (
          <li key={i} className="flex flex-col gap-3">
            <span className="skeleton aspect-[1.6] rounded-[1.25rem]" />
            <span className="skeleton h-4 w-2/3 rounded-full" />
          </li>
        ))}
        {results.data?.map((v, i) => <Tile key={v.id} v={v} index={i} />)}
      </ul>

      {results.data?.length === 0 && (
        <div className="card flex flex-col items-start gap-2 p-8">
          <p className="font-display text-2xl font-extrabold">Nothing matches "{q}"</p>
          <p className="text-ink-soft">Try the brand's name, like Amazon, Steam or Uber.</p>
        </div>
      )}
    </section>
  )
}

function Tile({ v, index }: { v: VoucherSummary; index: number }) {
  const qc = useQueryClient()
  const warm = () => qc.prefetchQuery(voucherQuery(v.id))
  return (
    <motion.li
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 30, delay: Math.min(index, 11) * 0.025 }}
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
          <span className="text-sm text-muted">{v.countryCode}, {v.currency}</span>
        </span>
      </Link>
    </motion.li>
  )
}
