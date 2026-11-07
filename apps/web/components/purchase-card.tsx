import type { Purchase } from "@luckout/api"
import { modeName, usd } from "@/lib/format"
import { explorer } from "@/lib/near"

/** One purchase: the voucher, what it cost, the Draw, and the code (owner only). */
export function PurchaseCard({ p }: { p: Purchase }) {
  const lucky = p.draw !== undefined
  const paid = p.draw ? p.draw.finalPrice : p.referencePrice
  const diff = paid - p.referencePrice
  const text = (k: string) => (typeof p.redemption?.[k] === "string" ? (p.redemption[k] as string) : undefined)
  const code = text("code") ?? text("pin")
  const link = text("link")
  const instructions = text("instructions")

  return (
    <article className="bg-card flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-heading font-semibold">{p.voucherName} · {p.value}</p>
          <p className="text-muted-foreground text-xs">{new Date(p.createdAt).toLocaleString()} · {modeName(p.mode)}</p>
        </div>
        <span className="bg-secondary rounded-full px-2 py-0.5 text-xs capitalize">{p.status}</span>
      </div>

      {p.status === "delivered" && (
        <p className="text-lg">
          You paid <b className="tabular-nums">{usd(paid)}</b>
          {lucky && diff < 0 && <span className="text-accent-foreground bg-accent ml-2 rounded px-1.5 py-0.5 text-sm font-semibold">{usd(-diff)} less than the price</span>}
          {lucky && diff === 0 && <span className="text-muted-foreground ml-2 text-sm">exactly the price</span>}
          {lucky && diff > 0 && <span className="text-muted-foreground ml-2 text-sm">{usd(diff)} above the price</span>}
        </p>
      )}
      {p.draw && p.draw.refund > 0 && (
        <p className="text-muted-foreground text-sm">{usd(p.draw.refund)} went back to your balance.</p>
      )}
      {p.error && <p className="text-muted-foreground text-sm">{p.error}</p>}

      {(code || link) && (
        <div className="bg-background rounded-lg border p-3">
          <p className="text-muted-foreground text-xs">Your voucher</p>
          {code && <p className="font-mono text-lg break-all select-all">{code}</p>}
          {link && <a href={link} target="_blank" rel="noreferrer" className="text-sm break-all underline">{link}</a>}
          {instructions && <p className="text-muted-foreground mt-1 text-xs">{instructions}</p>}
        </div>
      )}

      {(p.admitTx || p.settleTx) && (
        <p className="text-muted-foreground flex flex-wrap gap-x-4 text-xs">
          {p.admitTx && <a className="underline" href={explorer(p.admitTx)} target="_blank" rel="noreferrer">Purchase transaction</a>}
          {p.settleTx && <a className="underline" href={explorer(p.settleTx)} target="_blank" rel="noreferrer">{lucky ? "Draw transaction" : "Delivery transaction"}</a>}
          {p.draw && <span>roll {p.draw.roll} of 10,000</span>}
        </p>
      )}
    </article>
  )
}
