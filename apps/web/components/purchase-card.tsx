"use client"

import { api } from "@/lib/api"
import { safeLink, usd } from "@/lib/format"
import { modeName } from "@/lib/modes"
import { explorer } from "@/lib/near"
import type { Purchase } from "@luckout/api"
import Link from "next/link"
import { useEffect, useState } from "react"

/** Follows a pending purchase until it settles, so the page never shows a stale "pending". */
export function usePolledPurchase(p: Purchase | undefined, token: string | undefined) {
  const [live, setLive] = useState(p)
  useEffect(() => setLive(p), [p])
  useEffect(() => {
    if (!live || live.status !== "pending" || !token) return
    const t = setTimeout(() => {
      api((c) => c.purchases.get({ params: { id: live.id } }), token).then(setLive, () => {})
    }, 4000)
    return () => clearTimeout(t)
  }, [live, token])
  return live
}

const STATUS: Record<Purchase["status"], string> = {
  pending: "In progress",
  delivered: "Delivered",
  failed: "Refunded",
  rejected: "Not bought"
}

/** One purchase: the card, what it cost, the Draw, and the code (owner only). */
export function PurchaseCard({ p }: { p: Purchase }) {
  const lucky = p.draw !== undefined
  const paid = p.draw ? p.draw.finalPrice : p.referencePrice
  const diff = paid - p.referencePrice
  const text = (k: string) => (typeof p.redemption?.[k] === "string" ? (p.redemption[k] as string) : undefined)
  const code = text("code")
  const pin = text("pin")
  const link = safeLink(text("link"))
  const instructions = text("instructions")

  return (
    <article className="bg-receipt flex flex-col gap-4 rounded-xl border p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{p.voucherName}, {p.value}</h3>
          <p className="text-muted-foreground text-sm">
            {new Date(p.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}, {modeName(p.mode)}
          </p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${p.status === "pending" ? "bg-secondary animate-pulse" : "bg-secondary"}`}>
          {STATUS[p.status]}
        </span>
      </div>

      {p.status === "pending" && (
        <p className="text-muted-foreground text-sm">Bitrefill is delivering the code. This page updates by itself.</p>
      )}

      {p.status === "delivered" && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="text-lg">You paid <b className="font-display tabular-nums">{usd(paid)}</b></p>
          {lucky && diff < 0 && (
            <span className={`${paid === 0 ? "bg-gold" : "bg-gold-soft"} rounded px-2 py-0.5 text-sm font-semibold`}>
              {paid === 0 ? "Free" : `${usd(-diff)} less than the price`}
            </span>
          )}
          {lucky && diff === 0 && <span className="text-muted-foreground text-sm">exactly the price</span>}
          {lucky && diff > 0 && <span className="text-muted-foreground text-sm">{usd(diff)} above the price of {usd(p.referencePrice)}</span>}
        </div>
      )}
      {p.draw && p.draw.refund > 0 && <p className="text-muted-foreground text-sm">{usd(p.draw.refund)} cashback went to your balance.</p>}
      {p.error && <p className="text-muted-foreground text-sm">{p.error}</p>}

      {(code || pin || link) && (
        <div className="bg-background flex flex-col gap-2 rounded-lg border p-3">
          {code && <Secret label="Code" value={code} />}
          {pin && <Secret label="PIN" value={pin} />}
          {link && <a href={link} target="_blank" rel="noreferrer noopener" className="text-sm break-all underline underline-offset-4">Open the voucher</a>}
          {instructions && <p className="text-muted-foreground text-sm">{instructions}</p>}
        </div>
      )}

      {(p.admitTx || p.settleTx) && (
        <p className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {p.draw && p.settleTx && <Link className="text-foreground underline underline-offset-4" href={`/draw/${p.settleTx}`}>Draw Proof (roll {p.draw.roll})</Link>}
          {p.admitTx && <a className="underline underline-offset-4" href={explorer(p.admitTx)} target="_blank" rel="noreferrer">Purchase transaction</a>}
          {p.settleTx && <a className="underline underline-offset-4" href={explorer(p.settleTx)} target="_blank" rel="noreferrer">{lucky ? "Draw transaction" : "Delivery transaction"}</a>}
        </p>
      )}
    </article>
  )
}

function Secret({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-muted-foreground text-xs">{label}</p>
        <p className="font-display text-lg break-all select-all">{value}</p>
      </div>
      <button
        type="button"
        onClick={() => navigator.clipboard.writeText(value).then(() => (setCopied(true), setTimeout(() => setCopied(false), 2000)))}
        className="bg-secondary hover:bg-border min-h-10 shrink-0 rounded-lg px-3 text-sm font-medium"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  )
}
