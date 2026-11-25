"use client"

import { ModeChip } from "@/components/purchase-view"
import { AdminTabs, ago, basescan, LastFigures, stepLabel, TONE } from "@/components/admin/shared"
import { SignInCard } from "@/components/sign-in-card"
import { NoPage } from "@/components/site-chrome"
import { Button } from "@/components/ui/button"
import { heldByAll, purchaseIdIn } from "@/lib/admin-lists"
import { api, errorMessage } from "@/lib/api"
import { explorer, explorerAccount } from "@/lib/chain"
import { dollars, limitsText, usd, usdDown, usdUp } from "@/lib/format"
import { modeName } from "@/lib/modes"
import { useSession } from "@/lib/session"
import { ADMIN_LIST_LIMIT, type AdminPurchase, type AdminUser } from "@luckout/api"
import { useQuery } from "@tanstack/react-query"
import { ArrowUpRight } from "lucide-react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { type ReactNode, useState } from "react"

// The admin's read-only Purchases and Users pages: a glance at who bought what and who holds what.
// Same gate as the Control room: the server answers admins only, everyone else sees "No page here".

/** `poll`: read again every 30 seconds. The users list doesn't: each load reads every listed customer's balance from NEAR. */
function useAdminList<A>(key: ReadonlyArray<unknown>, f: (token: string) => Promise<A>, poll: boolean) {
  const { accountId, token, ready } = useSession()
  const q = useQuery({
    queryKey: ["admin", ...key, token],
    queryFn: () => f(token!),
    enabled: !!token,
    refetchInterval: poll ? 30_000 : false,
    retry: false
  })
  const gate = ready && !accountId
    ? <SignInCard title="Sign in to continue" body="Sign in with your NEAR wallet." />
    : (q.error as { _tag?: string } | null)?._tag === "NotFound"
    ? <NoPage />
    : !q.data
    ? q.error ? <p role="alert" className="font-medium text-bad">{errorMessage(q.error)}</p> : <div className="skeleton h-96 rounded-[1.75rem]" aria-busy="true" />
    : undefined
  // A failed refresh leaves the last rows on screen, and says so.
  const stale = q.data && q.error ? <LastFigures error={q.error} /> : undefined
  return { data: q.data, gate, stale, refresh: () => void q.refetch(), refreshing: q.isFetching }
}

function Page({ title, body, children }: { title: string; body: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4">
        <AdminTabs />
        <div>
          <h1 className="font-display text-5xl leading-[0.95] font-extrabold tracking-[-0.03em]">{title}</h1>
          <p className="mt-2 text-ink-soft">{body}</p>
        </div>
      </header>
      {children}
    </div>
  )
}

function Filter({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return <input className="field max-w-md" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
}

/** label: value pairs in a purchase's or user's expanded details. */
function Facts({ items }: { items: ReadonlyArray<[string, ReactNode] | false | undefined> }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
      {items.filter((x) => !!x).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-all">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

const Ext = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium underline underline-offset-2">
    {children}
    <ArrowUpRight size={14} aria-hidden="true" />
  </a>
)

const stepTone = (step: string) =>
  step === "settled" ? TONE.good : step === "stuck" ? TONE.bad : step === "failed" || step === "rejected" ? TONE.muted : step === "waiting" || step === "restock" ? TONE.warn : TONE.busy

const matches = (q: string, ...fields: ReadonlyArray<string | undefined>) => fields.some((f) => f?.toLowerCase().includes(q.trim().toLowerCase()))

export function AdminPurchases() {
  const account = useSearchParams().get("account") ?? undefined
  const [q, setQ] = useState("")
  // A whole purchase id is asked of the server, so one older than the loaded list is still found.
  const id = purchaseIdIn(q)
  const { data, gate, stale } = useAdminList(["purchases", account, id], (token) =>
    api((c) => c.admin.purchases({ query: { ...(account ? { account } : {}), ...(id ? { id } : {}) } }), token), true)
  const shown = data?.filter((p) => matches(q, p.accountId, p.voucherName, stepLabel(p.step), modeName(p.mode), p.id)) ?? []
  // A full page may not be everything: say "latest", never "everything".
  const full = (data?.length ?? 0) >= ADMIN_LIST_LIMIT
  return (
    <Page
      title="Purchases"
      body={account
        ? <>{full ? `The latest ${ADMIN_LIST_LIMIT} purchases of` : "Everything"} <b className="text-ink">{account}</b>{full ? "" : " bought"}. <Link href="/admin/purchases" className="underline">Show everyone's</Link></>
        : `The latest ${ADMIN_LIST_LIMIT}, newest first. Open one for its details; paste a purchase id to find an older one.`}
    >
      {gate ?? (
        <>
          {stale}
          <Filter value={q} onChange={setQ} placeholder="Filter by account, card, mode, step or id" />
          <ul className="flex flex-col gap-2">
            {shown.map((p) => <PurchaseRow key={p.id} p={p} />)}
            {shown.length === 0 && <li className="text-muted">No purchases{q ? " match" : " yet"}.</li>}
          </ul>
        </>
      )}
    </Page>
  )
}

function PurchaseRow({ p }: { p: AdminPurchase }) {
  return (
    <li>
      <details className="group rounded-[1.25rem] bg-white shadow-card">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1 p-4 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 flex-1 font-semibold">{p.voucherName} {p.value}{p.currency ? ` ${p.currency}` : ""}</span>
          <span className="truncate text-sm text-muted sm:max-w-56">{p.accountId}</span>
          <ModeChip mode={p.mode} />
          {/* What the customer's own list shows for it, rounded up as charged; the details below are exact. */}
          <span className="w-20 text-right font-medium tabular-nums">{usdUp(p.paid ?? p.maxPrice ?? p.referencePrice)}</span>
          <span className={`pill ${stepTone(p.step)}`}>{stepLabel(p.step)}</span>
          <span className="w-24 text-right text-sm text-muted">{ago(p.createdAt)}</span>
        </summary>
        <div className="border-t border-soft p-4">
          <Facts
            items={[
              ["Id", p.id],
              ["Account", <Link key="a" href={`/admin/purchases?account=${encodeURIComponent(p.accountId)}`} className="underline">{p.accountId}</Link>],
              ["Mode", modeName(p.mode)],
              ["Reference price", `${dollars(p.referencePrice)} USDC`],
              p.maxPrice !== undefined && ["Max price", `${dollars(p.maxPrice)} USDC`],
              p.paid !== undefined && ["Paid", `${dollars(p.paid)} USDC`],
              p.cashback !== undefined && ["Cashback", `${dollars(p.cashback)} USDC`],
              p.error !== undefined && ["Error", <span key="e" className="text-bad">{p.error}</span>],
              ["Attempts", p.attempts],
              p.invoiceId !== undefined && ["Bitrefill invoice", p.invoiceId],
              p.payAmount !== undefined && ["Paid to Bitrefill", `${dollars(p.payAmount)} USDC from the Base Float, for all of checkout ${p.checkoutId.slice(0, 8)}…`],
              p.payTx !== undefined && ["Base payment", <Ext key="b" href={basescan(`tx/${p.payTx}`)}>{p.payTx.slice(0, 12)}…</Ext>],
              p.admitTx !== undefined && ["Admit tx", <Ext key="x" href={explorer(p.admitTx)}>{p.admitTx.slice(0, 12)}…</Ext>],
              p.settleTx !== undefined && ["Settle tx", <Ext key="s" href={explorer(p.settleTx)}>{p.settleTx.slice(0, 12)}…</Ext>],
              ["Created", new Date(p.createdAt).toLocaleString()],
              ["Updated", new Date(p.updatedAt).toLocaleString()]
            ]}
          />
        </div>
      </details>
    </li>
  )
}

export function AdminUsers() {
  // Loaded on open and on Refresh only: each load reads every listed customer's balance from NEAR, through the
  // same RPC providers that admit and confirm purchases.
  const { data, gate, stale, refresh, refreshing } = useAdminList(["users"], (token) => api((c) => c.admin.users(), token), false)
  const [q, setQ] = useState("")
  const shown = data?.filter((u) => matches(q, u.accountId, u.telegram)) ?? []
  const held = heldByAll(data ?? [])
  return (
    <Page
      title="Users"
      body={data
        ? (
          <>
            {data.length >= ADMIN_LIST_LIMIT ? `The ${ADMIN_LIST_LIMIT} most recent accounts` : `${data.length} accounts`}, holding{" "}
            {held.partial ? "at least " : ""}<b className="text-ink">{usd(held.micro)}</b> in all{held.partial ? " (NEAR didn't answer for some)" : ""}. Most recent
            buyers first.
          </>
        )
        : "Every account that signed in, bought, relayed or linked Telegram."}
    >
      {gate ?? (
        <>
          {stale}
          <div className="flex flex-wrap items-center gap-2">
            <Filter value={q} onChange={setQ} placeholder="Filter by account or Telegram name" />
            <Button variant="soft" loading={refreshing} onClick={refresh}>Refresh</Button>
          </div>
          <ul className="flex flex-col gap-2">
            {shown.map((u) => <UserRow key={u.accountId} u={u} />)}
            {shown.length === 0 && <li className="text-muted">No users{q ? " match" : " yet"}.</li>}
          </ul>
        </>
      )}
    </Page>
  )
}

function UserRow({ u }: { u: AdminUser }) {
  return (
    <li>
      <details className="rounded-[1.25rem] bg-white shadow-card">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1 p-4 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 flex-1 truncate font-semibold">{u.accountId}</span>
          {u.telegram && <span className="pill bg-lilac-soft! text-ink">TG {u.telegram}</span>}
          <span className="text-sm text-ink-soft">{u.delivered}/{u.purchases} delivered</span>
          {/* As the customer's own balance shows, rounded down; the details below are exact. */}
          <span className="w-24 text-right font-medium tabular-nums">{u.balance === undefined ? "—" : usdDown(u.balance)}</span>
          <span className="w-24 text-right text-sm text-muted">{u.lastPurchaseAt ? ago(u.lastPurchaseAt) : "no buys"}</span>
        </summary>
        <div className="border-t border-soft p-4">
          <Facts
            items={[
              ["Balance", u.balance === undefined ? "NEAR didn't answer" : `${dollars(u.balance)} USDC`],
              u.perPurchaseLimit !== undefined && u.dailyLimit !== undefined && ["Spending limits", limitsText(u.perPurchaseLimit, u.dailyLimit)],
              ["Spent on delivered cards", `${dollars(u.spent)} USDC`],
              ["Cashback received", `${dollars(u.cashback)} USDC`],
              ["Purchases", <Link key="p" href={`/admin/purchases?account=${encodeURIComponent(u.accountId)}`} className="underline">{u.purchases} ({u.delivered} delivered)</Link>],
              u.telegram !== undefined && ["Telegram", u.telegram],
              ["Checkout Email", u.checkoutEmail ? "Given" : "None yet"],
              ["Bitrefill account", u.bitrefillConnected ? "Connected" : "Not connected"],
              ["First seen", new Date(u.firstSeen).toLocaleString()],
              ["Explorer", <Ext key="x" href={explorerAccount(u.accountId)}>nearblocks</Ext>]
            ]}
          />
        </div>
      </details>
    </li>
  )
}
