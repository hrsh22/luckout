"use client"

import { SignInButton } from "@/components/app-nav"
import { AddFundsSheet } from "@/components/funds"
import { GiftCard } from "@/components/gift-card"
import { ModePicker } from "@/components/mode-picker"
import { Money } from "@/components/money"
import { OddsBar, OddsList } from "@/components/odds"
import { Progress, PurchaseResult, usePolledPurchase } from "@/components/purchase-view"
import { Button } from "@/components/ui/button"
import { api, errorMessage, TimedOut } from "@/lib/api"
import { countryName, flag, WORLDWIDE } from "@/lib/countries"
import { usd, usdUp } from "@/lib/format"
import { cashbackCapAmount, modeFromSlug, modeInfo, modeName, modeSlug, pricedOutcomes, simpleQuote } from "@/lib/modes"
import { pendingMode } from "@/lib/onboarding"
import { modePalette } from "@/lib/palette"
import { rememberViewed, useFreeReserve, useQuote, useShopStatus, useSummary, voucherQuery } from "@/lib/queries"
import { useSession } from "@/lib/session"
import { type Mode, NewPurchase, type Quote } from "@luckout/api"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import Link from "next/link"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { useEffect, useMemo, useState } from "react"

/** Back to the results this card came from, not just the empty shop. */
const lastSearch = () => {
  try {
    return sessionStorage.getItem("luckout.shop") ?? "/shop"
  } catch {
    return "/shop"
  }
}

/** Keyed on the account: signing out or switching accounts drops any purchase (and its code) on screen. */
export function VoucherPage() {
  const { accountId } = useSession()
  return <Voucher key={accountId ?? ""} />
}

function Voucher() {
  const id = decodeURIComponent(useParams<{ id: string }>().id)
  const params = useSearchParams()
  const router = useRouter()
  const qc = useQueryClient()
  const { accountId, token, account, refresh } = useSession()
  const summary = useSummary(id).data
  const voucher = useQuery(voucherQuery(id))
  const look = summary ?? voucher.data
  const packages = voucher.data?.packages ?? []
  // For the shop's "Recently viewed" row.
  useEffect(() => void (look && rememberViewed(look)), [look])

  // The choice lives in the URL, so a refresh or a shared link opens the same card, amount and mode.
  const value = params.get("value") ?? packages[Math.floor((packages.length - 1) / 2)]?.value
  const preferred = accountId ? account?.default_mode ?? pendingMode(accountId) : undefined
  const mode: Mode = modeFromSlug(params.get("mode")) ?? preferred ?? "normal"
  const choose = (next: { value?: string; mode?: Mode }) => {
    const sp = new URLSearchParams(params)
    if (next.value ?? value) sp.set("value", next.value ?? value!)
    sp.set("mode", modeSlug(next.mode ?? mode))
    window.history.replaceState(null, "", `/shop/${encodeURIComponent(id)}?${sp}`)
  }

  const pkg = packages.find((p) => p.value === value)
  const info = modeInfo(mode)!
  const quote = useQuote(id, value, mode)
  const free = useFreeReserve()
  // Shown at once from the same tables and reserve the contract uses; the server's quote replaces it in a moment.
  const shown: Quote | undefined = quote.data ??
    (pkg && (info.premiumBps === 0 || free !== undefined) ? { mode, ...simpleQuote(info, pkg.priceMicroUsdc, free ?? 0) } : undefined)

  const [round, setRound] = useState(0)
  // A fresh key per choice: double clicks and retries return the same purchase instead of buying twice.
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [id, value, modeSlug(mode), round]) // eslint-disable-line react-hooks/exhaustive-deps
  const buy = useMutation({
    mutationFn: async (q: Quote) => {
      // Exactly what the quote showed: its mode, and the contract refuses to debit above maxPrice
      // or to play a Lucky Amount other than the one shown.
      const payload = new NewPurchase({
        voucherId: id,
        value: value!,
        mode: q.mode,
        maxPrice: q.maxPrice,
        ...(q.mode === "normal" ? {} : { luckyAmount: q.luckyAmount }),
        idempotencyKey
      })
      return api((c) => c.purchases.create({ payload }), token, "150 seconds").catch((e) => {
        if (!(e instanceof TimedOut)) throw e
        // Still running on the server: the same key returns the same purchase, then we follow it.
        return api((c) => c.purchases.create({ payload }), token)
      })
    },
    onSettled: () => {
      refresh().catch(() => {})
      qc.invalidateQueries({ queryKey: ["purchases"] })
      // The reserve may have moved (or been the reason for a refusal): confirming again needs a fresh quote.
      qc.invalidateQueries({ queryKey: ["quote", id] })
    }
  })
  const live = usePolledPurchase(buy.data, token)

  if (voucher.error && !look) {
    return (
      <div className="card flex flex-col items-start gap-3 p-8">
        <p className="font-display text-3xl font-extrabold">This card didn't load</p>
        <p className="text-ink-soft">{errorMessage(voucher.error)}</p>
        <Link href="/shop" className="font-semibold underline underline-offset-4">Back to the shop</Link>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-8">
      <Link href="/shop" onClick={(e) => (e.preventDefault(), router.push(lastSearch()))} className="inline-flex items-center gap-2 self-start font-semibold text-muted hover:text-ink">
        <ArrowLeft size={18} />All cards
      </Link>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
        <div className="flex flex-col gap-10">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
            {look
              ? <GiftCard v={look} className="w-full max-w-[300px] shadow-pop sm:w-[260px]" notch={14} />
              : <span className="skeleton aspect-[1.6] w-full max-w-[300px] rounded-[1.25rem] sm:w-[260px]" />}
            <div className="flex flex-col gap-2">
              {look
                ? <h1 className="font-display text-4xl leading-[0.95] font-extrabold tracking-[-0.03em] sm:text-5xl">{look.name}</h1>
                : <span className="skeleton h-10 w-56 rounded-full" />}
              {look && (
                <>
                  <p className="self-start rounded-full bg-ink px-3 py-1 text-sm font-semibold text-white">
                    {flag(look.countryCode)} {look.countryCode === WORLDWIDE ? "Works worldwide" : `Works in ${countryName(look.countryCode, look.countryName)} only`}
                  </p>
                  <p className="text-ink-soft">Paid out in {look.currency}. Delivered as a code in seconds.</p>
                </>
              )}
            </div>
          </div>

          <section className="flex flex-col gap-4" aria-labelledby="amount">
            <h2 id="amount" className="font-display text-2xl font-extrabold">Amount</h2>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="amount">
              {voucher.isPending && [0, 1, 2, 3].map((i) => <span key={i} className="skeleton h-12 w-24 rounded-full" />)}
              {packages.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  role="radio"
                  aria-checked={value === p.value}
                  onClick={() => choose({ value: p.value })}
                  className="relative h-12 rounded-full bg-white px-5 font-semibold shadow-card transition-colors aria-checked:text-white"
                >
                  {value === p.value && (
                    <motion.span layoutId="amount-current" className="absolute inset-0 rounded-full bg-ink" transition={{ type: "spring", stiffness: 420, damping: 34 }} />
                  )}
                  <span className="relative">
                    {p.value} {voucher.data?.currency}
                    {voucher.data?.currency !== "USD" && <span className="ml-1.5 font-medium opacity-70">{usd(p.priceMicroUsdc)}</span>}
                  </span>
                </button>
              ))}
              {voucher.data?.tooSmall?.map((p) => (
                <span
                  key={p.value}
                  title="Under the $0.50 minimum purchase"
                  className="flex h-12 items-center rounded-full border-[1.5px] border-dashed border-line px-5 font-semibold text-muted"
                >
                  {p.value} {voucher.data?.currency}
                </span>
              ))}
            </div>
            {!!voucher.data?.tooSmall?.length && (
              <p className="text-sm text-muted">Dashed amounts are under our $0.50 minimum purchase, so they can't be bought here.</p>
            )}
            {voucher.data?.packages.length === 0 && <p className="text-ink-soft">This card has no fixed amounts we can sell right now.</p>}
          </section>

          <section className="flex flex-col gap-4" aria-labelledby="mode">
            <div>
              <h2 id="mode" className="font-display text-2xl font-extrabold">How do you want to pay?</h2>
              <p className="mt-1 text-ink-soft">Lucky modes cost more up front, then pay cashback in fixed slabs. Any cashback leaves you below the price.</p>
            </div>
            <ModePicker value={mode} onChange={(m) => choose({ mode: m })} price={pkg?.priceMicroUsdc} savedDefault={account?.default_mode} />
          </section>
        </div>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-28" aria-live="polite">
          <AnimatePresence mode="wait" initial={false}>
            {live
              ? <PurchaseResult key="result" p={live} onAgain={() => (buy.reset(), setRound((r) => r + 1))} />
              : buy.isPending
              ? <Buying key="buying" mode={mode} name={look?.name ?? ""} value={value ?? ""} />
              : (
                <motion.div key="receipt" exit={{ opacity: 0, scale: 0.97 }} transition={{ duration: 0.15 }}>
                  <Receipt shown={shown} exact={!!quote.data} info={info} error={buy.error ? errorMessage(buy.error) : quote.error ? errorMessage(quote.error) : undefined}>
                    {shown && look && look.countryCode !== WORLDWIDE && (
                      <p className="text-sm text-ink-soft">
                        {flag(look.countryCode)} For {countryName(look.countryCode, look.countryName)} only: it can't be used in another country's store.
                      </p>
                    )}
                    {shown && <BuyButton quote={quote.data} need={shown.maxPrice} onBuy={(q) => buy.mutate(q)} />}
                  </Receipt>
                </motion.div>
              )}
          </AnimatePresence>
        </aside>
      </div>
    </div>
  )
}

function Receipt({ shown, exact, info, error, children }: {
  shown: Quote | undefined
  exact: boolean
  info: NonNullable<ReturnType<typeof modeInfo>>
  error?: string | undefined
  children?: React.ReactNode
}) {
  const pal = modePalette(info.mode)
  if (!shown) return <div className="skeleton h-80 rounded-[1.75rem]" />
  const lucky = shown.luckyAmount > 0
  const outcomes = pricedOutcomes(info, shown)
  const best = outcomes[outcomes.length - 1]!
  return (
    <div className="card flex flex-col gap-5 p-6">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold" style={{ background: pal.soft, color: pal.ink }}>
          <span className="size-2.5 rounded-full" style={{ background: pal.solid }} />{info.name}
        </span>
        {!exact && <span className="animate-pulse text-sm text-muted">Checking the price</span>}
      </div>
      <div>
        <p className="text-ink-soft">{lucky ? "You pay now" : "You pay"}</p>
        <p className="font-display text-6xl leading-none font-extrabold tracking-[-0.03em]"><Money micro={shown.maxPrice} up /></p>
        <p className="mt-2 text-[15px] text-ink-soft">
          {lucky
            ? `The ${usd(shown.referencePrice)} price, plus ${usdUp(shown.maxPrice - shown.referencePrice)} for a chance at up to ${best.price === 0 ? "all of it" : usd(best.cashback)} back.`
            : `Exactly the price. No Draw, no cashback.`}
        </p>
      </div>
      {lucky && (
        <div className="flex flex-col gap-3">
          <OddsBar outcomes={outcomes} />
          <OddsList outcomes={outcomes} whole={shown.luckyAmount === shown.referencePrice} />
          {shown.luckyAmount < shown.referencePrice && (
            <p className="rounded-2xl bg-soft p-3 text-sm text-ink-soft">
              Only {usd(shown.luckyAmount)} of the price plays, because {shown.luckyAmount < cashbackCapAmount(info)
                ? "one purchase can use at most 20% of the Cashback Reserve, and it's small right now"
                : `one purchase gets at most ${usd(best.cashback)} back`}. The rest is at the normal price.
            </p>
          )}
        </div>
      )}
      {error && <p role="alert" className="text-sm font-medium text-bad">{error}</p>}
      {children}
      <p className="text-sm text-muted">{lucky ? "Cashback lands in your balance right after delivery. " : ""}You always get the card.</p>
    </div>
  )
}

/** One button that knows what's in the way: signing in, funds, or limits, and fixes it on the spot. */
function BuyButton({ quote, need, onBuy }: { quote: Quote | undefined; need: number; onBuy: (q: Quote) => void }) {
  const { accountId, account, accountError, refresh } = useSession()
  const shop = useShopStatus().data
  const [adding, setAdding] = useState(false)
  if (shop && !shop.open) {
    return (
      <p className="rounded-2xl bg-warn-soft p-4 text-[15px] font-medium text-warn">
        Purchases are paused for a few minutes. Your balance is safe; try again soon.
      </p>
    )
  }
  if (!accountId) return <SignInButton size="lg" label="Sign in to buy" />
  if (account === undefined && accountError) {
    return (
      <div className="flex flex-col gap-2">
        <p role="alert" className="text-sm font-medium text-bad">Couldn't read your balance. {accountError}</p>
        <Button size="lg" variant="light" onClick={() => refresh().catch(() => {})}>Try again</Button>
      </div>
    )
  }
  if (account === undefined) return <span className="skeleton h-14 rounded-full" />
  const balance = Number(account?.balance ?? 0)
  const today = account && account.day === Math.floor(Date.now() / 86_400_000) ? Number(account.spent_today) : 0
  const limit = account && need > Number(account.per_purchase_limit)
    ? `Above your ${usd(account.per_purchase_limit)} per-purchase limit.`
    : account && today + need > Number(account.daily_limit)
    ? `This would pass your ${usd(account.daily_limit)} daily limit (${usd(today)} used today).`
    : undefined

  if (balance < need) {
    return (
      <>
        <Button size="lg" variant="gold" onClick={() => setAdding(true)}>Add {usdUp(need - balance)} to buy</Button>
        <AddFundsSheet open={adding} onOpenChange={setAdding} need={need - balance} />
      </>
    )
  }
  if (limit) {
    return (
      <div className="flex flex-col gap-2 rounded-2xl bg-warn-soft p-4 text-[15px] text-warn">
        <p className="font-medium">{limit}</p>
        <Link href="/wallet#limits" className="font-semibold underline underline-offset-4">Change your limits</Link>
      </div>
    )
  }
  return (
    <Button size="lg" loading={!quote} onClick={() => quote && onBuy(quote)}>
      {quote ? `Buy for ${usdUp(quote.maxPrice)}` : "Checking the price"}
    </Button>
  )
}

function Buying({ mode, name, value }: { mode: Mode; name: string; value: string }) {
  const pal = modePalette(mode)
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      className="voucher rounded-[1.75rem] p-6"
      style={{ background: pal.tile, color: pal.ink }}
    >
      <p className="pill">{name}, {value}</p>
      <h2 className="font-display mt-4 text-5xl leading-none font-extrabold">Buying on {modeName(mode)}</h2>
      <Progress />
    </motion.div>
  )
}

