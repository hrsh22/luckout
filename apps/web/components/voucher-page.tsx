"use client"

import { SignInButton } from "@/components/app-nav"
import { CheckoutEmailForm } from "@/components/checkout-email"
import { AddFundsSheet } from "@/components/funds"
import { GiftCard } from "@/components/gift-card"
import { ModePicker } from "@/components/mode-picker"
import { Money } from "@/components/money"
import { OddsBar, OddsList } from "@/components/odds"
import { Progress, PurchaseResult, usePolledPurchase } from "@/components/purchase-view"
import { RichText } from "@/components/rich-text"
import { ReopensAt } from "@/components/shop-banner"
import { Button } from "@/components/ui/button"
import { useWalletActions } from "@/lib/actions"
import { addToCart, type CartCard, cartRoom, useCart } from "@/lib/cart"
import { useCartQuote, useCheckout } from "@/lib/checkout"
import { pricedLines, purchaseRequest, spendingCheck, totals } from "@/lib/checkout-terms"
import { Quantity } from "@/components/quantity"
import { api, errorMessage, TimedOut } from "@/lib/api"
import { countryName, flag, WORLDWIDE } from "@/lib/countries"
import { usd, usdUp } from "@/lib/format"
import { modeInfo, modeName, modeSlug, pricedOutcomes, simpleQuote } from "@/lib/modes"
import { pendingMode } from "@/lib/onboarding"
import { modePalette } from "@/lib/palette"
import { rememberViewed, useCheckoutEmail, useQuote, useReserve, useShopStatus, useSummary, voucherQuery } from "@/lib/queries"
import { useSession } from "@/lib/session"
import { openingAmount, openingMode } from "@/lib/voucher-choice"
import { MAX_CART, type Mode, type Quote } from "@luckout/api"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, CalendarClock, ChevronDown, ShoppingCart, Star, Zap } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import Link from "next/link"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { type RefObject, useEffect, useMemo, useRef, useState } from "react"

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
  const asked = params.get("value")
  const value = openingAmount(asked, voucher.data?.packages)
  const preferred = accountId ? account?.default_mode ?? pendingMode(accountId) : undefined
  const { mode, unknownDefault } = openingMode(params.get("mode"), preferred)
  const choose = (next: { value?: string; mode?: Mode }) => {
    const sp = new URLSearchParams(params)
    if (next.value ?? value) sp.set("value", next.value ?? value!)
    sp.set("mode", modeSlug(next.mode ?? mode))
    window.history.replaceState(null, "", `/shop/${encodeURIComponent(id)}?${sp}`)
  }

  const pkg = packages.find((p) => p.value === value)
  // openingMode only returns modes this build knows, so this is never undefined.
  const info = modeInfo(mode)!
  const [round, setRound] = useState(0)
  // A fresh key per choice: double clicks and retries return the same purchase instead of buying twice.
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [id, value, modeSlug(mode), round]) // eslint-disable-line react-hooks/exhaustive-deps
  const buy = useMutation({
    mutationFn: async (q: Quote) => {
      // Exactly what the quote showed: its mode, and the contract refuses to debit above maxPrice
      // or to play a Lucky Amount other than the one shown.
      const payload = purchaseRequest({ voucherId: id, value: value! }, idempotencyKey, q)
      return api((c) => c.purchases.create({ payload }), token, "150 seconds").catch((e) => {
        if (!(e instanceof TimedOut)) throw e
        // Still running on the server: the same key returns the same purchase, then we follow it.
        return api((c) => c.purchases.create({ payload }), token)
      })
    },
    onSettled: () => {
      refresh().catch(() => {})
      qc.invalidateQueries({ queryKey: ["purchases"] })
      // What this email has used of Bitrefill's limits just moved.
      qc.invalidateQueries({ queryKey: ["checkout-email"] })
      // The reserve may have moved (or been the reason for a refusal): confirming again needs a fresh quote.
      qc.invalidateQueries({ queryKey: ["quote", id] })
    }
  })
  // Several of this card: one checkout, each copy with its own key (fresh per choice, like the single one's).
  const [quantity, setQuantity] = useState(1)
  const many = quantity > 1
  const keys = useMemo(() => Array.from({ length: quantity }, () => crypto.randomUUID()), [id, value, modeSlug(mode), round, quantity]) // eslint-disable-line react-hooks/exhaustive-deps
  const card: CartCard | undefined = look && value ? { voucherId: id, value, mode, name: look.name, currency: look.currency, image: look.image, background: look.background } : undefined
  const units = card && many ? keys.map((key) => ({ line: card, key })) : []
  const checkout = useCheckout()
  const cartQuote = useCartQuote(units, many && !checkout.isPending).data
  // The copies as the Cart shows a line: the reserve may put some at Normal, or let only part of each play.
  const copies = card && many ? pricedLines([{ ...card, keys }], cartQuote)[0] : undefined
  const live = usePolledPurchase(buy.data, token)
  // Not renewed while the purchase runs or its result is on screen; buying again reads a fresh one.
  const quote = useQuote(id, value, mode, !live && !buy.isPending)
  const reserve = useReserve()
  // Shown at once from the same tables and reserve the contract uses; the server's quote replaces it in a moment.
  const shown: Quote | undefined = quote.data ??
    (pkg && (info.premiumBps === 0 || reserve !== undefined) ? { mode, ...simpleQuote(info, pkg.priceMicroUsdc, reserve) } : undefined)
  const panel = useRef<HTMLElement>(null)

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
                  {voucher.data?.subtitle && <p className="text-lg text-ink-soft">{voucher.data.subtitle}</p>}
                  <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
                    {voucher.data?.rating && (
                      <span className="inline-flex items-center gap-1.5">
                        <Star size={14} className="fill-current text-ink" aria-hidden="true" />
                        <span className="font-semibold text-ink">{voucher.data.rating.value.toFixed(1)}</span>
                        from {voucher.data.rating.count.toLocaleString()} ratings on Bitrefill
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1.5"><Zap size={14} className="text-ink" aria-hidden="true" />Code in about a minute</span>
                  </p>
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
            {asked !== null && value !== undefined && value !== asked && (
              <p className="text-sm text-muted">The {asked} {voucher.data?.currency} in your link isn't sold right now, so {value} is chosen instead.</p>
            )}
          </section>

          <section className="flex flex-col gap-4" aria-labelledby="mode">
            <div>
              <h2 id="mode" className="font-display text-2xl font-extrabold">How do you want to pay?</h2>
              <p className="mt-1 text-ink-soft">Pay the price, or add a little for a chance at cashback.</p>
              {unknownDefault && <p className="mt-1 text-sm text-muted">Your default mode isn't offered on this page yet, so it opens on Normal.</p>}
            </div>
            <ModePicker value={mode} onChange={(m) => choose({ mode: m })} price={pkg?.priceMicroUsdc} savedDefault={account?.default_mode} />
          </section>

          {(voucher.data?.howToRedeem || voucher.data?.terms) && (
            <section className="flex flex-col gap-3" aria-labelledby="about">
              <h2 id="about" className="font-display text-2xl font-extrabold">Before you buy</h2>
              {voucher.data.howToRedeem && <Details title="How to redeem"><RichText text={voucher.data.howToRedeem} /></Details>}
              {voucher.data.terms && <Details title="Terms and validity"><RichText text={voucher.data.terms} list /></Details>}
            </section>
          )}
        </div>

        <aside ref={panel} className="flex flex-col gap-4 lg:sticky lg:top-28" aria-live="polite">
          <AnimatePresence mode="wait" initial={false}>
            {live
              ? <PurchaseResult key="result" p={live} onAgain={() => (buy.reset(), setRound((r) => r + 1))} />
              : buy.isPending || checkout.isPending
              ? <Buying key="buying" mode={mode} name={look?.name ?? ""} value={value ?? ""} count={quantity} />
              : (
                <motion.div key="receipt" exit={{ opacity: 0, scale: 0.97 }} transition={{ duration: 0.15 }}>
                  <Receipt
                    shown={shown}
                    exact={!!quote.data && (!many || !!cartQuote)}
                    info={info}
                    count={quantity}
                    total={many ? cartQuote && totals(cartQuote).pay : undefined}
                    copies={copies}
                    error={buy.error
                      ? errorMessage(buy.error)
                      : checkout.error
                      ? errorMessage(checkout.error)
                      : quote.error
                      ? errorMessage(quote.error)
                      : voucher.data && !value
                      ? "There's no amount of this card to buy right now."
                      // The shop's summary drew the card, but with no amount in the link there's nothing to price.
                      : voucher.error && !value
                      ? errorMessage(voucher.error)
                      : undefined}
                    retry={value
                      ? { run: () => void quote.refetch(), busy: quote.isFetching }
                      : voucher.error
                      ? { run: () => void voucher.refetch(), busy: voucher.isFetching }
                      : undefined}
                  >
                    {shown && look && (look.countryCode !== WORLDWIDE || voucher.data?.useBy) && (
                      <ul className="flex flex-col gap-1.5 text-sm text-ink-soft">
                        {look.countryCode !== WORLDWIDE && (
                          <li className="flex items-center gap-2">
                            <span className="w-4 text-center" aria-hidden="true">{flag(look.countryCode)}</span>Works in {countryName(look.countryCode, look.countryName)} only
                          </li>
                        )}
                        {voucher.data?.useBy && (
                          // Bitrefill gives no date before an order: this is the last delivered card's, said as such.
                          <li className="flex items-center gap-2">
                            <CalendarClock size={16} className="text-muted" aria-hidden="true" />
                            <span>Recent ones expire <span className="font-semibold text-ink">{new Date(voucher.data.useBy).toLocaleDateString(undefined, { dateStyle: "long" })}</span></span>
                          </li>
                        )}
                      </ul>
                    )}
                    {shown && (
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-semibold">Quantity</span>
                        <Quantity label={`Quantity of ${look?.name ?? "this card"}`} value={quantity} max={MAX_CART} onChange={setQuantity} />
                      </div>
                    )}
                    {shown && (many
                      ? (
                        <BuyButton
                          need={cartQuote ? totals(cartQuote).pay : shown.maxPrice * quantity}
                          largest={cartQuote ? totals(cartQuote).largest : shown.maxPrice}
                          label={cartQuote && `Buy ${quantity} for ${usdUp(totals(cartQuote).pay)}`}
                          onBuy={() => cartQuote && checkout.mutate(units.map((u, i) => ({ ...u, quote: cartQuote[i]! })))}
                        />
                      )
                      : (
                        <BuyButton
                          need={shown.maxPrice}
                          label={quote.data && `Buy for ${usdUp(quote.data.maxPrice)}`}
                          onBuy={() => quote.data && buy.mutate(quote.data)}
                        />
                      ))}
                    {shown && card && <AddToCart card={card} quantity={quantity} />}
                  </Receipt>
                </motion.div>
              )}
          </AnimatePresence>
        </aside>
      </div>
      {shown && !live && !buy.isPending && !checkout.isPending && (
        <JumpToBuy panel={panel} name={many ? `${quantity} × ${info.name}` : info.name} amount={many && cartQuote ? totals(cartQuote).pay : shown.maxPrice * quantity} />
      )}
    </div>
  )
}

/**
 * Phones: the price and the buy panel sit below the amounts and modes, so a bar keeps the price in sight and
 * takes you to the panel (which handles signing in, adding funds and limits). Gone once the panel is on screen.
 */
export function JumpToBuy({ panel, name, amount }: { panel: RefObject<HTMLElement | null>; name: string; amount: number }) {
  const [inView, setInView] = useState(true)
  useEffect(() => {
    const el = panel.current
    if (!el) return
    const o = new IntersectionObserver(([e]) => setInView(e!.isIntersecting), { threshold: 0.25 })
    o.observe(el)
    return () => o.disconnect()
  }, [panel])
  if (inView) return null
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/90 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur lg:hidden">
      <div className="mx-auto flex max-w-[640px] items-center justify-between gap-3">
        <div className="leading-tight">
          <p className="text-sm text-muted">{name}</p>
          <p className="font-display text-2xl font-extrabold">{usdUp(amount)}</p>
        </div>
        <Button size="lg" onClick={() => panel.current?.scrollIntoView({ behavior: "smooth", block: "center" })}>Review and buy</Button>
      </div>
    </div>
  )
}

/** One of Bitrefill's texts about the card, folded until opened. */
function Details({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="card group overflow-hidden">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5 font-semibold [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDown size={18} className="shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="border-t border-line px-5 pt-4 pb-5 break-words">{children}</div>
    </details>
  )
}

function Receipt({ shown, exact, info, count = 1, total, copies, error, retry, children }: {
  shown: Quote | undefined
  exact: boolean
  info: NonNullable<ReturnType<typeof modeInfo>>
  /** How many of the card; the price shown is for all of them (`total`, from the cart's own quote, once it's in). */
  count?: number
  total?: number | undefined
  /** Several copies, priced as a Cart line: whether the reserve put some at Normal or let only part of each play. */
  copies?: Copies | undefined
  error?: string | undefined
  /** Asks for the price again; absent when there's nothing to price. */
  retry?: { run: () => void; busy: boolean } | undefined
  children?: React.ReactNode
}) {
  const pal = modePalette(info.mode)
  if (!shown) {
    // Still loading, or no price at all: the server's quote failed with nothing to fall back on (say, the reserve
    // unread). Then its message is the answer, with a way to ask again, never an endless grey block.
    if (!error) return <div className="skeleton h-80 rounded-[1.75rem]" />
    return (
      <div className="card flex flex-col items-start gap-3 p-6">
        <p role="alert" className="font-medium text-bad">{error}</p>
        {retry && <Button variant="light" loading={retry.busy} onClick={retry.run}>Try again</Button>}
      </div>
    )
  }
  const lucky = shown.luckyAmount > 0
  // "Each" holds only while every copy plays in full; otherwise the Cart's note says what the reserve did to them.
  const differ = copies && (copies.normal || copies.plays !== undefined) ? copies : undefined
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
        <p className="font-display text-6xl leading-none font-extrabold tracking-[-0.03em]"><Money micro={total ?? shown.maxPrice * count} up /></p>
        {differ
          ? (
            <div className="mt-2 flex flex-col gap-1">
              <p className="text-[15px] font-semibold text-ink">{count} cards.</p>
              <CopiesNote priced={differ} />
            </div>
          )
          : (
            <p className="mt-2 text-[15px] text-ink-soft">
              {count > 1 && <span className="font-semibold text-ink">{count} cards. Each: </span>}
              {lucky
                ? `${count > 1 ? "the" : "The"} ${usd(shown.referencePrice)} price, plus ${usdUp(shown.maxPrice - shown.referencePrice)} for a chance at up to ${best.price === 0 ? "all of it" : usd(best.cashback)} back${count > 1 ? ", with its own Draw" : ""}.`
                : `${count > 1 ? "exactly" : "Exactly"} the price. No Draw, no cashback.`}
            </p>
          )}
      </div>
      {error && <p role="alert" className="text-sm font-medium text-bad">{error}</p>}
      {/* The action sits right under the price, so a laptop screen shows both; every outcome follows below it. */}
      <div className="flex flex-col gap-3">
        {children}
        <p className="text-sm text-muted">You always get the card.{lucky ? " Any cashback lands in your balance." : ""}</p>
      </div>
      {lucky && (
        <div className="flex flex-col gap-3 border-t border-line pt-5">
          <OddsBar outcomes={outcomes} />
          <OddsList outcomes={outcomes} whole={shown.luckyAmount === shown.referencePrice} />
          {shown.luckyAmount < shown.referencePrice && (
            <p className="rounded-2xl bg-soft p-3 text-sm text-ink-soft">
              Cashback is capped at {usd(best.cashback)} right now, so only {usd(shown.luckyAmount)} of the price plays.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/** A line as pricedLines gives it: its copies, and what the reserve did to them. */
type Copies = { readonly line: { readonly keys: ReadonlyArray<string> }; readonly normal: boolean; readonly plays: number | undefined }

/**
 * What the reserve does to a line's copies right now, in the same words on the card page and in the Cart: some bought
 * at the normal price, or only part of each playing.
 */
export function CopiesNote({ priced: { line, normal, plays } }: { priced: Copies }) {
  const many = line.keys.length > 1
  if (normal) return <p className="text-sm text-warn">The Cashback Reserve is used up right now, so {many ? "some of these are" : "this one is"} bought at the normal price.</p>
  if (plays === undefined) return null
  return (
    <p className="text-sm text-muted">
      Cashback is capped right now: {many ? `at least ${usd(plays)} of each plays` : `${usd(plays)} of it plays`}, the rest is at the normal price.
    </p>
  )
}

/** Puts this card, amount and mode in the Cart, as many as chosen; the Cart then opens to show them there. */
function AddToCart({ card, quantity }: { card: CartCard; quantity: number }) {
  const room = cartRoom(useCart())
  return (
    <Button size="lg" variant="light" disabled={quantity > room} onClick={() => addToCart(card, quantity)}>
      <ShoppingCart />
      {room === 0 ? `Your cart is full (${MAX_CART} cards)` : quantity > room ? `Your cart has room for ${room} more` : "Add to cart"}
    </Button>
  )
}

/**
 * The Add funds sheet stays outside BuyAction's branches, on the amount it opened with: a quote renewed every 20 s, a
 * balance read or the shop closing mid Top-Up must not unmount it or restart its steps. It goes when the customer
 * closes it or the Top-Up lands. `need` is what buying debits in all, `largest` the most any one card debits (the
 * per-purchase limit applies to each), and no `label` means the price is still being checked.
 */
export function BuyButton(props: { need: number; largest?: number; label: string | undefined; onBuy: () => void }) {
  const [open, setOpen] = useState(false)
  const [short, setShort] = useState(0)
  return (
    <>
      <BuyAction {...props} onAdd={(n) => (setShort(n), setOpen(true))} />
      <AddFundsSheet open={open} onOpenChange={setOpen} need={short} />
    </>
  )
}

/** One button that knows what's in the way: signing in, funds, limits, or the Checkout Email, and fixes it on the spot. */
function BuyAction({ need, largest = need, label, onBuy, onAdd }: {
  need: number
  largest?: number
  label: string | undefined
  onBuy: () => void
  onAdd: (short: number) => void
}) {
  const { accountId, account, accountError, refresh, intents, gasFree, token } = useSession()
  const actions = useWalletActions()
  const shop = useShopStatus().data
  const checkout = useCheckoutEmail(token).data
  const [raising, setRaising] = useState(false)
  if (shop && !shop.open) {
    if (shop.reason === "limit" && shop.reopensAt !== undefined) return <ReopensAt at={shop.reopensAt} />
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
  // Before the first deposit there's no account, and so no limit in the way yet.
  const { today, overPer, overDay, per, daily } = account ? spendingCheck(account, need, largest) : { today: 0, overPer: false, overDay: false, per: undefined, daily: undefined }

  if (balance < need) {
    return <Button size="lg" variant="gold" onClick={() => onAdd(need - balance)}>Add {usdUp(need - balance)} to buy</Button>
  }
  if ((overPer || overDay) && per && daily) {
    return (
      <div className="flex flex-col gap-3 rounded-2xl bg-warn-soft p-4 text-[15px] text-warn">
        {overPer && <p className="font-medium">Above your {usd(account!.per_purchase_limit)} per-purchase limit.</p>}
        {overDay && <p className="font-medium">This would pass your {usd(account!.daily_limit)} daily limit ({usd(today)} used today).</p>}
        <Button
          size="lg"
          loading={raising}
          onClick={async () => {
            setRaising(true)
            await actions.setLimits(per, daily)
            setRaising(false)
          }}
        >
          Raise to {[overPer && `${usd(per)} a purchase`, overDay && `${usd(daily)} a day`].filter(Boolean).join(", ")}
        </Button>
        <p className="text-sm">
          {intents || gasFree ? "One approval, no fee" : "One approval"}, then you can buy. Or <Link href="/wallet#limits" className="font-semibold underline underline-offset-4">set your own limits</Link>.
        </p>
      </div>
    )
  }
  // Bitrefill needs one with each card (ADR-0012): asked here once, instead of a refused purchase. Saving it brings the Buy button.
  if (checkout?.needed && !checkout.email) {
    return (
      <div className="rounded-2xl bg-soft p-4">
        <CheckoutEmailForm />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <Button size="lg" loading={!label} onClick={() => label && onBuy()}>
        {label ?? "Checking the price"}
      </Button>
      {checkout?.needed && checkout.email && (
        <p className="text-sm text-muted">
          Also emailed to <span className="font-medium break-all text-ink-soft">{checkout.email}</span>.{" "}
          <Link href="/wallet" className="underline underline-offset-2">Change</Link>
        </p>
      )}
    </div>
  )
}

function Buying({ mode, name, value, count = 1 }: { mode: Mode; name: string; value: string; count?: number }) {
  const pal = modePalette(mode)
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      className="voucher rounded-[1.75rem] p-6"
      style={{ background: pal.tile, color: pal.ink }}
    >
      <p className="pill">{count > 1 ? `${count} × ` : ""}{name}, {value}</p>
      <h2 className="font-display mt-4 text-5xl leading-none font-extrabold">Buying on {modeName(mode)}</h2>
      <Progress />
    </motion.div>
  )
}

