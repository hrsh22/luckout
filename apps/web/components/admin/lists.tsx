"use client"

import { NoPage } from "@/components/admin/panel"
import { AdminTabs, ago, TONE } from "@/components/admin/shared"
import { SignInCard } from "@/components/sign-in-card"
import { api, errorMessage } from "@/lib/api"
import { explorer, explorerAccount } from "@/lib/chain"
import { limitsText, usd } from "@/lib/format"
import { modeName } from "@/lib/modes"
import { useSession } from "@/lib/session"
import type { AdminPurchase, AdminUser } from "@luckout/api"
import { useQuery } from "@tanstack/react-query"
import { ArrowUpRight } from "lucide-react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { type ReactNode, useState } from "react"

// The admin's read-only Purchases and Users pages: a glance at who bought what and who holds what.
// Same gate as the Control room: the server answers admins only, everyone else sees "No page here".

function useAdminList<A>(key: ReadonlyArray<unknown>, f: (token: string) => Promise<A>) {
  const { accountId, token, ready } = useSession()
  const q = useQuery({ queryKey: ["admin", ...key, token], queryFn: () => f(token!), enabled: !!token, refetchInterval: 30_000, retry: false })
  const gate = ready && !accountId
    ? <SignInCard title="Sign in to continue" body="Sign in with your NEAR wallet." />
    : (q.error as { _tag?: string } | null)?._tag === "NotFound"
    ? <NoPage />
    : !q.data
    ? q.error ? <p role="alert" className="font-medium text-bad">{errorMessage(q.error)}</p> : <div className="skeleton h-96 rounded-[1.75rem]" aria-busy="true" />
    : undefined
  return { data: q.data, gate, error: q.error }
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
  const { data, gate } = useAdminList(["purchases", account], (token) =>
    api((c) => c.admin.purchases({ query: account ? { account } : {} }), token))
  const [q, setQ] = useState("")
  const shown = data?.filter((p) => matches(q, p.accountId, p.voucherName, p.step, p.id)) ?? []
  return (
    <Page
      title="Purchases"
      body={account ? <>Everything <b className="text-ink">{account}</b> bought. <Link href="/admin/purchases" className="underline">Show everyone's</Link></> : "The latest 300, newest first. Open one for its details."}
    >
      {gate ?? (
        <>
          <Filter value={q} onChange={setQ} placeholder="Filter by account, card, step or id" />
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
          <span className="min-w-0 flex-1 font-semibold">{p.voucherName} {p.value}</span>
          <span className="truncate text-sm text-muted sm:max-w-56">{p.accountId}</span>
          <span className="text-sm text-ink-soft">{modeName(p.mode)}</span>
          <span className="w-20 text-right font-medium tabular-nums">{usd(p.paid ?? p.maxPrice ?? p.referencePrice)}</span>
          <span className={`pill ${stepTone(p.step)}`}>{p.step}</span>
          <span className="w-24 text-right text-sm text-muted">{ago(p.createdAt)}</span>
        </summary>
        <div className="border-t border-soft p-4">
          <Facts
            items={[
              ["Id", p.id],
              ["Account", <Link key="a" href={`/admin/purchases?account=${encodeURIComponent(p.accountId)}`} className="underline">{p.accountId}</Link>],
              ["Reference price", usd(p.referencePrice)],
              p.maxPrice !== undefined && ["Max price", usd(p.maxPrice)],
              p.paid !== undefined && ["Paid", usd(p.paid)],
              p.cashback !== undefined && ["Cashback", usd(p.cashback)],
              p.error !== undefined && ["Error", <span key="e" className="text-bad">{p.error}</span>],
              ["Attempts", p.attempts],
              p.invoiceId !== undefined && ["Bitrefill invoice", p.invoiceId],
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
  const { data, gate } = useAdminList(["users"], (token) => api((c) => c.admin.users(), token))
  const [q, setQ] = useState("")
  const shown = data?.filter((u) => matches(q, u.accountId, u.telegram)) ?? []
  const held = data?.reduce((s, u) => s + (u.balance ?? 0), 0) ?? 0
  return (
    <Page
      title="Users"
      body={data ? <>{data.length} accounts, holding <b className="text-ink">{usd(held)}</b> in all. Most recent buyers first.</> : "Every account that signed in, bought, relayed or linked Telegram."}
    >
      {gate ?? (
        <>
          <Filter value={q} onChange={setQ} placeholder="Filter by account or Telegram name" />
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
          <span className="w-24 text-right font-medium tabular-nums">{u.balance === undefined ? "—" : usd(u.balance)}</span>
          <span className="w-24 text-right text-sm text-muted">{u.lastPurchaseAt ? ago(u.lastPurchaseAt) : "no buys"}</span>
        </summary>
        <div className="border-t border-soft p-4">
          <Facts
            items={[
              ["Balance", u.balance === undefined ? "NEAR didn't answer" : usd(u.balance)],
              u.perPurchaseLimit !== undefined && u.dailyLimit !== undefined && ["Spending limits", limitsText(u.perPurchaseLimit, u.dailyLimit)],
              ["Spent on delivered cards", usd(u.spent)],
              ["Cashback received", usd(u.cashback)],
              ["Purchases", <Link key="p" href={`/admin/purchases?account=${encodeURIComponent(u.accountId)}`} className="underline">{u.purchases} ({u.delivered} delivered)</Link>],
              u.telegram !== undefined && ["Telegram", u.telegram],
              ["First seen", new Date(u.firstSeen).toLocaleString()],
              ["Explorer", <Ext key="x" href={explorerAccount(u.accountId)}>nearblocks</Ext>]
            ]}
          />
        </div>
      </details>
    </li>
  )
}
