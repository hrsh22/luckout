"use client"

import { Avatar, shortAccount } from "@/components/avatar"
import { Money } from "@/components/money"
import { NavShell } from "@/components/nav-shell"
import { Button, buttonVariants } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { api, errorMessage } from "@/lib/api"
import { network } from "@/lib/near"
import { useSession } from "@/lib/session"
import { Menu } from "@base-ui/react/menu"
import { ACTIVE_PHASES, useIsAdmin, useTransfers } from "@/lib/queries"
import { ChevronDown, Copy, LoaderCircle, LogOut, MonitorSmartphone, ReceiptText, RotateCw, ShieldCheck, Wallet } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

const LINKS = [
  { href: "/shop", label: "Shop" },
  { href: "/purchases", label: "Purchases" },
  { href: "/wallet", label: "Wallet" }
]

export function AppNav() {
  const { accountId, account, accountError, ready, refresh } = useSession()
  return (
    <NavShell
      links={LINKS}
      right={accountId
        ? (
          <>
            {account === undefined && accountError
              ? (
                <button
                  type="button"
                  title={`Couldn't read your balance. ${accountError}`}
                  aria-label="Couldn't read your balance. Try again"
                  onClick={() => refresh().catch(() => {})}
                  className="flex h-10 items-center gap-2 rounded-full bg-bad-soft px-4 text-sm font-semibold text-bad"
                >
                  <RotateCw size={16} aria-hidden="true" />Retry
                </button>
              )
              : (
                <Link
                  href="/wallet"
                  title="Your Luckout balance"
                  className="flex h-10 items-center gap-2 rounded-full bg-gold-soft px-4 text-sm font-semibold text-gold-ink transition-colors hover:bg-gold/40"
                >
                  <Wallet size={16} aria-hidden="true" />
                  {account === undefined ? <span className="skeleton h-4 w-12 rounded-full" /> : <Money micro={account?.balance ?? 0} down />}
                  <Arriving />
                </Link>
              )}
            <AccountMenu id={accountId} />
          </>
        )
        : ready && <SignInButton size="sm" />}
    />
  )
}

/**
 * The one sign-in button: it asks which kind of wallet (NEAR, or EVM through NEAR Intents, ADR-0011),
 * then says which step the wallet is on. Where there's no room to show why sign-in stopped (the nav,
 * the receipt), it says so in a toast.
 */
export function SignInButton({ size = "md", label = "Sign in", onDone, inline = false }: {
  size?: "sm" | "md" | "lg"
  label?: string
  onDone?: () => void
  /** The page shows signInError itself. */
  inline?: boolean
}) {
  const { signIn, signing, ready } = useSession()
  const go = (kind: "near" | "evm") =>
    signIn(kind).then((problem) => {
      if (!problem) return onDone?.()
      if (!inline) problem.cancelled ? toast(problem.message) : toast.error(problem.message)
    })
  const item = "flex min-h-14 cursor-pointer flex-col justify-center rounded-2xl px-4 py-2 outline-none select-none data-[highlighted]:bg-soft"
  return (
    <Menu.Root>
      <Menu.Trigger className={buttonVariants({ size })} disabled={!ready || !!signing} aria-busy={!!signing || undefined}>
        {signing && <LoaderCircle className="animate-spin" />}
        {signing === "wallet" ? "Choose a wallet" : signing === "message" ? "Sign the message in your wallet" : label}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} align="start" className="z-40">
          <Menu.Popup className="w-72 origin-[var(--transform-origin)] rounded-[1.75rem] bg-white p-2 shadow-pop outline-none transition-[scale,opacity] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
            <Menu.Item className={item} onClick={() => void go("near")}>
              <span className="font-semibold">NEAR wallet</span>
              <span className="text-sm text-muted">HOT, Meteor, Intear and more</span>
            </Menu.Item>
            <Menu.Item className={item} onClick={() => void go("evm")}>
              <span className="font-semibold">EVM wallet</span>
              <span className="text-sm text-muted">MetaMask, Rabby, Coinbase and more. No NEAR needed.</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

function AccountMenu({ id }: { id: string }) {
  const { signOut, token } = useSession()
  const isAdmin = useIsAdmin(token)
  const router = useRouter()
  const [everywhere, setEverywhere] = useState(false)
  const item =
    "flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl px-3 text-[15px] font-medium outline-none select-none data-[highlighted]:bg-soft"
  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          className="flex h-10 min-w-0 items-center gap-2 rounded-full bg-soft py-1 pr-3 pl-1 font-semibold transition-colors hover:bg-[#ebe9f3] data-[popup-open]:bg-[#ebe9f3]"
          aria-label={`Account ${id}`}
        >
          <Avatar id={id} size={32} />
          <span className="hidden max-w-[9rem] truncate text-sm sm:block">{shortAccount(id)}</span>
          <ChevronDown size={16} className="text-muted" aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={10} align="end" className="z-40">
            <Menu.Popup className="w-72 origin-[var(--transform-origin)] rounded-[1.75rem] bg-white p-2 shadow-pop outline-none transition-[scale,opacity] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
              <div className="flex items-center gap-3 px-3 pt-2 pb-3">
                <Avatar id={id} size={40} />
                <div className="min-w-0">
                  <p className="truncate font-semibold" title={id}>{shortAccount(id)}</p>
                  <p className="text-sm text-muted">{/^0x/.test(id) ? `EVM wallet · NEAR ${network}` : `NEAR ${network}`}</p>
                </div>
              </div>
              <Menu.Item className={item} onClick={() => navigator.clipboard.writeText(id).then(() => toast.success("Account copied"))}>
                <Copy size={18} className="text-muted" />Copy account
              </Menu.Item>
              <Menu.Item className={item} onClick={() => router.push("/wallet")}>
                <Wallet size={18} className="text-muted" />Wallet and limits
              </Menu.Item>
              <Menu.Item className={item} onClick={() => router.push("/purchases")}>
                <ReceiptText size={18} className="text-muted" />Your purchases
              </Menu.Item>
              {isAdmin && (
                <Menu.Item className={item} onClick={() => router.push("/admin")}>
                  <ShieldCheck size={18} className="text-muted" />Admin
                </Menu.Item>
              )}
              <Menu.Separator className="mx-3 my-1 h-px bg-line" />
              <Menu.Item className={`${item} text-bad`} onClick={() => signOut().then(() => router.push("/shop"))}>
                <LogOut size={18} />Sign out
              </Menu.Item>
              <Menu.Item className={`${item} text-bad`} onClick={() => setEverywhere(true)}>
                <MonitorSmartphone size={18} />Sign out everywhere
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <SignOutEverywhere open={everywhere} onOpenChange={setEverywhere} />
    </>
  )
}

/** Ends every session of this account, on every device (a lost phone, a shared computer), then signs out here too. */
function SignOutEverywhere({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { signOut, token } = useSession()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Sign out everywhere?"
      description="Every device signed in to this account is signed out, this one included. Your balance and purchases stay as they are."
    >
      <div className="flex flex-col gap-2">
        <Button size="lg" variant="danger" loading={busy} onClick={async () => {
          setBusy(true)
          try {
            await api((c) => c.session.signOutEverywhere(), token)
            toast.success("Signed out everywhere")
            onOpenChange(false)
            await signOut()
            router.push("/shop")
          } catch (e) {
            toast.error(errorMessage(e))
          }
          setBusy(false)
        }}>
          Sign out everywhere
        </Button>
        <Button size="lg" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
      </div>
    </Sheet>
  )
}

/** "+$2.50" while a top-up is on its way into the balance, so it never looks like it vanished. */
function Arriving() {
  const { token, refresh } = useSession()
  const qc = useQueryClient()
  const transfers = useTransfers(token)
  const list = transfers.data ?? []
  // Only money 1Click has and is delivering: not a quote still waiting for its transfer, nor one paid short.
  const coming = list.filter((t) => t.direction === "in" && (t.phase === "swapping" || t.phase === "moving" || (t.phase === "awaiting-transfer" && t.depositTx)))
  // When a transfer lands or is sent back, the balances it changed are read again (this is on every page).
  const settled = list.filter((t) => !ACTIVE_PHASES.has(t.phase)).map((t) => `${t.depositAddress}:${t.phase}`).join()
  const seen = useRef<string | undefined>(undefined)
  const loaded = transfers.data !== undefined
  useEffect(() => {
    if (!loaded) return
    if (seen.current !== undefined && seen.current !== settled) {
      void refresh().catch(() => {})
      void qc.invalidateQueries({ queryKey: ["held"] })
    }
    seen.current = settled
  }, [loaded, settled, refresh])
  if (coming.length === 0) return null
  const total = coming.reduce((sum, t) => sum + t.usdc, 0)
  return (
    <span className="font-medium opacity-70" title={`${coming.length === 1 ? "A top-up is" : `${coming.length} top-ups are`} on its way into your balance`}>
      +<Money micro={total} />
    </span>
  )
}
