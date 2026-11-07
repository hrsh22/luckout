"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api, errorMessage } from "@/lib/api"
import { MODES, sameMode, usd } from "@/lib/format"
import { network } from "@/lib/near"
import { useSession } from "@/lib/session"
import type { Mode, Purchase, Quote, Voucher, VoucherSummary } from "@luckout/api"
import Link from "next/link"
import { useEffect, useState } from "react"
import { PurchaseCard } from "./purchase-card"

export function Shop() {
  const { token, account, refresh, signIn } = useSession()
  const [q, setQ] = useState(network === "testnet" ? "test gift card" : "amazon")
  const [results, setResults] = useState<ReadonlyArray<VoucherSummary>>()
  const [voucher, setVoucher] = useState<Voucher>()
  const [value, setValue] = useState<string>()
  const [mode, setMode] = useState<Mode>()
  const [quote, setQuote] = useState<Quote>()
  const [purchase, setPurchase] = useState<Purchase>()
  const [idempotencyKey, setKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const fail = (e: unknown) => setError(errorMessage(e))

  const search = () => {
    setError(undefined)
    setVoucher(undefined)
    api((c) => c.catalog.search({ query: { q } })).then(setResults, fail)
  }
  useEffect(search, []) // eslint-disable-line react-hooks/exhaustive-deps

  // The saved Default Mode is preselected; picking another applies to this purchase only.
  useEffect(() => {
    if (account && mode === undefined) setMode(account.default_mode)
  }, [account, mode])

  const open = (id: string) => {
    setError(undefined)
    setValue(undefined)
    setPurchase(undefined)
    api((c) => c.catalog.voucher({ params: { id } })).then(setVoucher, fail)
  }

  // A fresh idempotency key per selection: double clicks and retries can't buy twice.
  useEffect(() => {
    setQuote(undefined)
    setKey(crypto.randomUUID())
    if (!voucher || !value) return
    const m = mode ?? "normal"
    api((c) =>
      c.catalog.quote({ query: { voucherId: voucher.id, value, ...(m === "normal" ? {} : { game: m.lucky }) } })
    ).then(setQuote, fail)
  }, [voucher, value, mode])

  const buy = async () => {
    if (!voucher || !value || !token || !quote) return
    setBusy(true)
    setError(undefined)
    // Exactly what the quote showed: explicit mode, and the contract refuses to debit above maxPrice.
    await api((c) => c.purchases.create({ payload: { voucherId: voucher.id, value, mode: mode ?? "normal", maxPrice: quote.maxPrice, idempotencyKey } }), token)
      .then(setPurchase, fail)
    await refresh().catch(() => {})
    setBusy(false)
  }

  const short = quote && account ? Number(account.balance) < quote.maxPrice : false

  return (
    <section className="flex flex-col gap-6">
      <form className="flex gap-2" onSubmit={(e) => (e.preventDefault(), search())}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search gift cards" aria-label="Search gift cards" />
        <Button type="submit" variant="outline">Search</Button>
      </form>
      {network === "testnet" && (
        <p className="text-muted-foreground -mt-4 text-xs">Testnet: only Bitrefill test vouchers can be bought, paid in test USDC.</p>
      )}
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}

      {!voucher && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {results?.map((v) => (
            <li key={v.id}>
              <button type="button" onClick={() => open(v.id)} className="bg-card hover:bg-secondary w-full rounded-xl border p-3 text-left">
                <span className="font-heading font-semibold">{v.name}</span>
                <span className="text-muted-foreground ml-2 text-sm">{v.countryCode} · {v.currency}</span>
              </button>
            </li>
          ))}
          {results?.length === 0 && <li className="text-muted-foreground text-sm">Nothing found.</li>}
        </ul>
      )}

      {voucher && (
        <div className="flex flex-col gap-5">
          <button type="button" onClick={() => setVoucher(undefined)} className="text-muted-foreground self-start text-sm">← All results</button>
          <h2 className="font-heading text-2xl font-bold">{voucher.name}</h2>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-muted-foreground mb-2 text-sm">Amount</legend>
            <div className="flex flex-wrap gap-2">
              {voucher.packages.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  aria-pressed={value === p.value}
                  onClick={() => setValue(p.value)}
                  className="aria-pressed:border-foreground aria-pressed:bg-secondary rounded-lg border px-3 py-2 text-sm"
                >
                  {p.value} {voucher.currency} <span className="text-muted-foreground">· {usd(p.priceMicroUsdc)}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-muted-foreground mb-2 text-sm">How lucky do you feel?</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {MODES.map((m) => (
                <button
                  key={m.name}
                  type="button"
                  aria-pressed={sameMode(mode ?? "normal", m.mode)}
                  onClick={() => setMode(m.mode)}
                  className="aria-pressed:border-foreground aria-pressed:bg-secondary rounded-xl border p-3 text-left"
                >
                  <span className="font-heading font-semibold">{m.name}</span>
                  {m.premium && <span className="text-muted-foreground ml-1 text-sm">{m.premium}</span>}
                  {account && sameMode(account.default_mode, m.mode) && <span className="text-muted-foreground ml-2 text-xs">default</span>}
                  <span className="text-muted-foreground block text-sm">{m.line}</span>
                </button>
              ))}
            </div>
            <p className="text-muted-foreground text-xs">Every lucky mode averages 6% above the price. You always get the voucher.</p>
          </fieldset>

          {quote && (
            <div className="bg-card flex flex-col gap-3 rounded-xl border p-4">
              <p>
                {quote.luckyAmount === 0
                  ? <>You pay <b>{usd(quote.referencePrice)}</b>.</>
                  : <>You pay at most <b>{usd(quote.maxPrice)}</b>, and maybe much less. Any refund lands in your balance right after delivery.</>}
              </p>
              {quote.luckyAmount > 0 && quote.luckyAmount < quote.referencePrice && (
                <p className="text-muted-foreground text-sm">The draw applies to {usd(quote.luckyAmount)} of this price; the rest is at the normal price.</p>
              )}
              {!token
                ? <Button onClick={() => signIn().catch(fail)}>Sign in to buy</Button>
                : !account || short
                ? <Link href="/wallet" className="text-sm underline">Add funds to buy ({account ? `balance ${usd(account.balance)}` : "no balance yet"})</Link>
                : <Button onClick={buy} disabled={busy}>{busy ? "Buying…" : `Buy for up to ${usd(quote.maxPrice)}`}</Button>}
            </div>
          )}

          {purchase && <PurchaseCard p={purchase} />}
        </div>
      )}
    </section>
  )
}
