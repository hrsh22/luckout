"use client"

import { Avatar, shortAccount } from "@/components/avatar"
import { Money } from "@/components/money"
import { NavShell } from "@/components/nav-shell"
import { Button } from "@/components/ui/button"
import { cartCount, openCart, useCart } from "@/lib/cart"
import { CartDrawer } from "@/components/cart-drawer"
import { AnimatePresence, motion } from "motion/react"
import { Sheet } from "@/components/ui/sheet"
import { api, errorMessage } from "@/lib/api"
import { cluster } from "@/lib/chain"
import { useSession } from "@/lib/session"
import { Menu } from "@base-ui/react/menu"
import { ACTIVE_PHASES, arriving, useIsAdmin, useTransfers } from "@/lib/queries"
import { usd } from "@/lib/format"
import type { Transfer, TransferPhase } from "@luckout/api"
import { useExportWallet } from "@privy-io/react-auth/solana"
import { ChevronDown, Copy, KeyRound, LoaderCircle, LogOut, MonitorSmartphone, ReceiptText, RotateCw, ShieldCheck, ShoppingCart, Wallet } from "lucide-react"
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
      right={
        <>
          <CartButton />
          {accountId
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
        </>
      }
    />
  )
}

/** The Cart, always in the same place: its count, and the drawer it opens. The count pops when it changes. */
function CartButton() {
  const n = cartCount(useCart())
  return (
    <>
      <button
        type="button"
        onClick={openCart}
        aria-label={n === 0 ? "Cart, empty" : `Cart, ${n} ${n === 1 ? "card" : "cards"}`}
        className="relative grid size-10 shrink-0 place-items-center rounded-full bg-soft transition-colors hover:bg-[#ebe9f3]"
      >
        <ShoppingCart size={18} aria-hidden="true" />
        <AnimatePresence initial={false}>
          {n > 0 && (
            <motion.span
              key={n}
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 520, damping: 22 }}
              className="absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center rounded-full bg-ink px-1 text-xs font-bold text-white"
            >
              {n}
            </motion.span>
          )}
        </AnimatePresence>
      </button>
      <CartDrawer />
    </>
  )
}

/**
 * The one sign-in button: it opens Privy's window (email, Google, Telegram or a Solana wallet, ADR-0015). Where
 * there's no room to show why sign-in stopped (the nav, the receipt), it says so in a toast.
 */
export function SignInButton({ size = "md", label = "Sign in", onDone, inline = false }: {
  size?: "sm" | "md" | "lg"
  label?: string
  onDone?: () => void
  /** The page shows signInError itself. */
  inline?: boolean
}) {
  const { signIn, signing, ready } = useSession()
  const go = () =>
    signIn().then((problem) => {
      if (!problem) return onDone?.()
      if (!inline) problem.cancelled ? toast(problem.message) : toast.error(problem.message)
    })
  return (
    <Button size={size} disabled={!ready || signing} aria-busy={signing || undefined} onClick={() => void go()}>
      {signing && <LoaderCircle className="animate-spin" />}
      {signing ? "Signing in" : label}
    </Button>
  )
}

function AccountMenu({ id }: { id: string }) {
  const { signOut, token } = useSession()
  const { exportWallet } = useExportWallet()
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
                  <p className="text-sm text-muted">Solana {cluster}</p>
                </div>
              </div>
              <Menu.Item className={item} onClick={() => navigator.clipboard.writeText(id).then(() => toast.success("Address copied"))}>
                <Copy size={18} className="text-muted" />Copy address
              </Menu.Item>
              <Menu.Item className={item} onClick={() => router.push("/wallet")}>
                <Wallet size={18} className="text-muted" />Wallet and limits
              </Menu.Item>
              <Menu.Item className={item} onClick={() => router.push("/purchases")}>
                <ReceiptText size={18} className="text-muted" />Your purchases
              </Menu.Item>
              {/* The wallet is theirs (ADR-0015): Privy shows the key in its own window, which this page can't read. */}
              <Menu.Item className={item} onClick={() => void exportWallet({ address: id }).catch((e: unknown) => toast.error(errorMessage(e)))}>
                <KeyRound size={18} className="text-muted" />Export your key
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

/** Where a Top-Up went, said wherever the customer is. Keyed by the Top-Up, so the top-up form's own toast isn't doubled. */
const landed = (t: Transfer, toWallet: () => void) => {
  const amount = usd(t.usdc)
  const look = { id: t.depositAddress, action: { label: "Wallet", onClick: toWallet } }
  // Delivered to their Deposit Address, from where the server moves it into the Balance within a couple of minutes.
  if (t.phase === "done") toast.success(`Your ${amount} top-up arrived`, { id: t.depositAddress, description: "It moves into your balance in a minute or two." })
  else if (t.phase === "refunded") toast.error(`Your ${amount} top-up didn't go through`, { ...look, description: "1Click sent it back. Wallet shows where it is." })
}

/** "+$2.50" while a top-up is on its way into the balance, so it never looks like it vanished. */
function Arriving() {
  const { token, refresh } = useSession()
  const router = useRouter()
  const transfers = useTransfers(token)
  const coming = arriving(transfers.data ?? [])
  // When a transfer lands or is sent back, the balances it changed are read again (this is on every page), and a
  // Top-Up says where it went: the customer needn't have waited on the top-up form for it.
  const phases = useRef<Map<string, TransferPhase>>(undefined)
  useEffect(() => {
    const list = transfers.data
    if (!list) return
    const before = phases.current
    phases.current = new Map(list.map((t) => [t.depositAddress, t.phase]))
    // Only what changed while we watched: nothing is announced on page load.
    const ended = before ? list.filter((t) => ACTIVE_PHASES.has(before.get(t.depositAddress)!) && !ACTIVE_PHASES.has(t.phase)) : []
    if (ended.length === 0) return
    void refresh().catch(() => {})
    for (const t of ended) landed(t, () => router.push("/wallet"))
  }, [transfers.data, refresh, router])
  if (coming.length === 0) return null
  const total = coming.reduce((sum, t) => sum + t.usdc, 0)
  return (
    <span className="font-medium opacity-70" title={`${coming.length === 1 ? "A top-up is" : `${coming.length} top-ups are`} on its way into your balance`}>
      +<Money micro={total} />
    </span>
  )
}
