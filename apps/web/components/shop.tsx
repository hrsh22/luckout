"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api, errorMessage, TimedOut } from "@/lib/api"
import { productImage, usd } from "@/lib/format"
import { cashbackChanceBps, type ModeInfo, modeInfo, MODES, mostLikely, pricedOutcomes, sameMode, simpleQuote } from "@/lib/modes"
import { network } from "@/lib/near"
import { useSession } from "@/lib/session"
import type { Mode, Purchase, Quote, Voucher, VoucherSummary } from "@luckout/api"
import Link from "next/link"
import { useEffect, useState } from "react"
import { PurchaseCard, usePolledPurchase } from "./purchase-card"

const SUGGESTIONS = network === "testnet" ? ["Test gift card"] : ["Amazon", "Steam", "Netflix", "Uber", "Spotify", "Airbnb"]

export function Shop() {
  const [q, setQ] = useState(SUGGESTIONS[0]!)
  const [results, setResults] = useState<ReadonlyArray<VoucherSummary>>()
  const [searching, setSearching] = useState(false)
  const [picked, setPicked] = useState<VoucherSummary>()
  const [error, setError] = useState<string>()

  const search = (query = q) => {
    setQ(query)
    setError(undefined)
    setPicked(undefined)
    setSearching(true)
    api((c) => c.catalog.search({ query: { q: query } }))
      .then(setResults, (e) => setError(errorMessage(e)))
      .finally(() => setSearching(false))
  }
  useEffect(() => search(), []) // eslint-disable-line react-hooks/exhaustive-deps

  if (picked) return <VoucherView summary={picked} back={() => setPicked(undefined)} />

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-4xl">Shop</h1>
        <p className="text-muted-foreground">Gift cards, top-ups and eSIMs from Bitrefill, paid from your Luckout balance.</p>
      </div>
      <form className="flex gap-2" onSubmit={(e) => (e.preventDefault(), search())} role="search">
        <Input className="h-12 text-base" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a brand, like Amazon or Steam" aria-label="Search gift cards" />
        <Button type="submit" size="lg" disabled={searching}>Search</Button>
      </form>
      <div className="-mt-2 flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" onClick={() => search(s)} className="bg-secondary hover:bg-border min-h-9 rounded-full px-3.5 text-sm">
            {s}
          </button>
        ))}
      </div>
      {network === "testnet" && (
        <p className="text-muted-foreground text-sm">Testnet preview: only Bitrefill test cards can be bought, with test USDC from the Balance page.</p>
      )}
      {error && <p role="alert" className="text-destructive">{error}</p>}

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-busy={searching}>
        {searching && !results && Array.from({ length: 8 }, (_, i) => <li key={i} className="bg-secondary h-44 animate-pulse rounded-xl" />)}
        {results?.map((v) => (
          <li key={v.id}>
            <button
              type="button"
              onClick={() => setPicked(v)}
              className="bg-receipt hover:border-foreground/40 focus-visible:ring-ring/50 flex h-full w-full flex-col overflow-hidden rounded-xl border text-left outline-none focus-visible:ring-3"
            >
              <Logo v={v} className="aspect-[4/3] w-full" />
              <span className="flex flex-col p-3">
                <span className="font-semibold leading-snug">{v.name}</span>
                <span className="text-muted-foreground text-sm">{v.countryCode}, {v.currency}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {results?.length === 0 && !searching && <p className="text-muted-foreground">Nothing matches "{q}". Try a brand name.</p>}
    </section>
  )
}

function Logo({ v, className }: { v: VoucherSummary; className: string }) {
  return v.image
    ? (
      <span className={`${className} flex items-center justify-center`} style={{ background: v.background ?? "#FFFFFF" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={productImage(v.image, v.background)} alt="" loading="lazy" className="h-full w-full object-contain" />
      </span>
    )
    : <span className={`${className} bg-secondary font-display flex items-center justify-center text-3xl`} aria-hidden="true">{v.name[0]}</span>
}

function VoucherView({ summary, back }: { summary: VoucherSummary; back: () => void }) {
  const { accountId, token, account, refresh, signIn } = useSession()
  const [voucher, setVoucher] = useState<Voucher>()
  const [value, setValue] = useState<string>()
  const [mode, setMode] = useState<Mode>()
  const [quote, setQuote] = useState<Quote>()
  const [quoting, setQuoting] = useState(false)
  const [idempotencyKey, setKey] = useState("")
  const [buying, setBuying] = useState(false)
  const [purchase, setPurchase] = useState<Purchase>()
  const [error, setError] = useState<string>()
  const fail = (e: unknown) => setError(errorMessage(e))
  const live = usePolledPurchase(purchase, token)

  useEffect(() => {
    api((c) => c.catalog.voucher({ params: { id: summary.id } })).then((v) => {
      setVoucher(v)
      // Preselect a mid-range amount so there's a price to look at straight away.
      setValue(v.packages[Math.floor((v.packages.length - 1) / 2)]?.value)
    }, fail)
  }, [summary.id])

  // The saved Default Mode is preselected; picking another applies to this purchase only.
  useEffect(() => {
    if (account && mode === undefined) setMode(account.default_mode)
  }, [account, mode])

  // A fresh idempotency key per selection: double clicks and retries can't buy twice.
  // Responses that arrive after the selection changed are dropped.
  useEffect(() => {
    setQuote(undefined)
    setKey(crypto.randomUUID())
    if (!voucher || !value) return
    let current = true
    const m = mode ?? "normal"
    setQuoting(true)
    setError(undefined)
    api((c) => c.catalog.quote({ query: { voucherId: voucher.id, value, ...(m === "normal" ? {} : { game: m.lucky }) } }))
      .then((q) => current && setQuote(q), (e) => current && fail(e))
      .finally(() => current && setQuoting(false))
    return () => {
      current = false
    }
  }, [voucher, value, mode])

  const buy = async () => {
    if (!voucher || !value || !token || !quote) return
    setBuying(true)
    setError(undefined)
    // Exactly what the quote showed: its mode, and the contract refuses to debit above maxPrice.
    const payload = { voucherId: voucher.id, value, mode: quote.mode, maxPrice: quote.maxPrice, idempotencyKey }
    await api((c) => c.purchases.create({ payload }), token, "150 seconds")
      .then(setPurchase, async (e) => {
        if (!(e instanceof TimedOut)) return fail(e)
        // Still running on the server: the same key returns the same purchase, then we poll it.
        await api((c) => c.purchases.create({ payload }), token).then(setPurchase, fail)
      })
    await refresh().catch(() => {})
    setBuying(false)
  }

  const pkg = voucher?.packages.find((p) => p.value === value)
  const short = quote && account ? Number(account.balance) < quote.maxPrice : false

  return (
    <section className="flex flex-col gap-6">
      <button type="button" onClick={back} className="text-muted-foreground hover:text-foreground -ml-2 self-start rounded-md px-2 py-2 text-sm">
        Back to results
      </button>
      <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr] lg:items-start">
        <div className="flex flex-col gap-8">
          <div className="flex items-center gap-4">
            <Logo v={summary} className="size-20 shrink-0 overflow-hidden rounded-xl border" />
            <div>
              <h1 className="font-display text-3xl leading-tight">{summary.name}</h1>
              <p className="text-muted-foreground">{summary.countryCode}, {summary.currency}</p>
            </div>
          </div>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-3 text-lg font-semibold">Amount</legend>
            {!voucher && !error && <div className="bg-secondary h-11 w-64 animate-pulse rounded-lg" />}
            <div className="flex flex-wrap gap-2">
              {voucher?.packages.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  aria-pressed={value === p.value}
                  onClick={() => setValue(p.value)}
                  className="aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background bg-receipt min-h-11 rounded-lg border px-4 text-sm font-medium"
                >
                  {p.value} {voucher.currency}
                  {voucher.currency !== "USD" && <span className="opacity-70">, {usd(p.priceMicroUsdc)}</span>}
                </button>
              ))}
            </div>
            {voucher?.packages.length === 0 && <p className="text-muted-foreground">This card has no fixed amounts we can sell right now.</p>}
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-3 text-lg font-semibold">How do you want to pay?</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {MODES.map((m) => (
                <ModeOption
                  key={m.name}
                  m={m}
                  price={pkg?.priceMicroUsdc}
                  selected={sameMode(mode ?? "normal", m.mode)}
                  isDefault={!!account && sameMode(account.default_mode, m.mode)}
                  onSelect={() => setMode(m.mode)}
                />
              ))}
            </div>
            <p className="text-muted-foreground text-sm">Lucky modes cost more up front, then pay cashback. Any cashback leaves you below the price, and every lucky mode averages 5.6% above it over many purchases. You always get the card.</p>
          </fieldset>
        </div>

        <aside className="bg-receipt flex flex-col gap-4 rounded-2xl border p-5 lg:sticky lg:top-24" aria-live="polite">
          {live
            ? <PurchaseCard p={live} />
            : (
              <>
                <h2 className="font-semibold">Your purchase</h2>
                {!quote && <div className={`bg-secondary h-24 rounded-lg ${quoting ? "animate-pulse" : ""}`} />}
                {quote && <Summary quote={quote} info={modeInfo(quote.mode)!} />}
                {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
                {quote && (!accountId
                  ? <Button size="lg" onClick={() => signIn().catch(fail)}>Sign in to buy</Button>
                  : !account || short
                  ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-sm">
                        {account ? `Your balance is ${usd(account.balance)}.` : "You haven't added funds yet."} You need {usd(quote.maxPrice)}.
                      </p>
                      <Link href="/wallet" className="bg-primary text-primary-foreground flex h-12 items-center justify-center rounded-lg font-medium">Add funds</Link>
                    </div>
                  )
                  : (
                    <Button size="lg" onClick={buy} disabled={buying}>
                      {buying ? "Buying… this takes a few seconds" : `Buy for ${usd(quote.maxPrice)}`}
                    </Button>
                  ))}
              </>
            )}
        </aside>
      </div>
    </section>
  )
}

function ModeOption({ m, price, selected, isDefault, onSelect }: {
  m: ModeInfo
  price: number | undefined
  selected: boolean
  isDefault: boolean
  onSelect: () => void
}) {
  const outcomes = price === undefined ? undefined : pricedOutcomes(m, simpleQuote(m, price))
  const best = outcomes?.[outcomes.length - 1]
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className="aria-pressed:border-foreground aria-pressed:ring-foreground bg-receipt flex min-h-24 flex-col gap-1 rounded-xl border p-4 text-left aria-pressed:ring-1"
    >
      <span className="flex items-baseline gap-2">
        <span className="font-display text-lg">{m.name}</span>
        <span className="text-muted-foreground text-sm">{m.premiumBps ? `+${m.premiumBps / 100}% up front` : "the price, no Draw"}</span>
        {isDefault && <span className="bg-secondary ml-auto rounded px-1.5 py-0.5 text-xs">Your default</span>}
      </span>
      <span className="text-muted-foreground text-sm leading-snug">
        {m.premiumBps === 0
          ? "Pay exactly the price."
          : outcomes && best
          ? `Pay ${usd(outcomes[0]!.price)}. ${cashbackChanceBps(m) / 100}% chance of cashback, up to ${best.price === 0 ? "all " : ""}${usd(best.cashback)} back.`
          : `${cashbackChanceBps(m) / 100}% chance of cashback, up to all of it.`}
      </span>
    </button>
  )
}

function Summary({ quote, info }: { quote: Quote; info: ModeInfo }) {
  const outcomes = pricedOutcomes(info, quote)
  const likely = mostLikely(outcomes)
  // Percentages are of what you paid only when the whole price plays.
  const whole = quote.luckyAmount === quote.referencePrice
  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex justify-between"><dt className="text-muted-foreground">Price</dt><dd className="tabular-nums">{usd(quote.referencePrice)}</dd></div>
        <div className="flex justify-between"><dt className="text-muted-foreground">Mode</dt><dd>{info.name}</dd></div>
        <div className="flex items-baseline justify-between border-t pt-2">
          <dt className="font-semibold">{quote.luckyAmount === 0 ? "You pay" : "You pay now"}</dt>
          <dd className="font-display text-2xl tabular-nums">{usd(quote.maxPrice)}</dd>
        </div>
      </dl>
      {quote.luckyAmount > 0 && (
        <>
          <div className="flex h-3 overflow-hidden rounded-full border" aria-hidden="true">
            {outcomes.map((o) => (
              <span
                key={o.price}
                style={{ width: `${o.chanceBps / 100}%` }}
                className={o.price === 0 ? "bg-gold" : o.price < quote.referencePrice ? "bg-gold-soft" : o.price === quote.referencePrice ? "bg-receipt" : "bg-foreground"}
              />
            ))}
          </div>
          <ul className="text-muted-foreground flex flex-col gap-1 text-sm">
            {outcomes.map((o) => (
              <li key={o.price} className="flex justify-between tabular-nums">
                <span>
                  {o.cashback === 0
                    ? "No cashback"
                    : o.price === 0
                    ? `All ${usd(o.cashback)} back, free`
                    : `${whole ? `${o.pct}% back: ` : ""}${usd(o.cashback)} back, you pay ${usd(o.price)}`}
                  {o === likely ? ", most likely" : ""}
                </span>
                <span>{o.chanceBps / 100}%</span>
              </li>
            ))}
          </ul>
          {quote.luckyAmount < quote.referencePrice && (
            <p className="text-muted-foreground text-sm">
              Only {usd(quote.luckyAmount)} of the price plays, so cashback tops out at {usd(outcomes[outcomes.length - 1]!.cashback)}; the
              rest is at the normal price.
            </p>
          )}
          <p className="text-muted-foreground text-sm">Any cashback lands in your balance right after delivery.</p>
        </>
      )}
    </div>
  )
}
