"use client"

import { Avatar, shortAccount } from "@/components/avatar"
import { Money } from "@/components/money"
import { NavShell } from "@/components/nav-shell"
import { Button } from "@/components/ui/button"
import { network } from "@/lib/near"
import { useSession } from "@/lib/session"
import { Menu } from "@base-ui/react/menu"
import { useIsAdmin } from "@/lib/queries"
import { ChevronDown, Copy, LogOut, ReceiptText, ShieldCheck, Wallet } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

const LINKS = [
  { href: "/shop", label: "Shop" },
  { href: "/purchases", label: "Purchases" },
  { href: "/wallet", label: "Wallet" }
]

export function AppNav() {
  const { accountId, account, ready } = useSession()
  return (
    <NavShell
      links={LINKS}
      right={accountId
        ? (
          <>
            <Link
              href="/wallet"
              title="Your Luckout balance"
              className="flex h-10 items-center gap-2 rounded-full bg-gold-soft px-4 text-sm font-semibold text-gold-ink transition-colors hover:bg-gold/40"
            >
              <Wallet size={16} aria-hidden="true" />
              {account === undefined ? <span className="skeleton h-4 w-12 rounded-full" /> : <Money micro={account?.balance ?? 0} />}
            </Link>
            <AccountMenu id={accountId} />
          </>
        )
        : ready && <SignInButton size="sm" />}
    />
  )
}

/**
 * The one sign-in button: it says which step the wallet is on. Where there's no room to show why
 * sign-in stopped (the nav, the receipt), it says so in a toast.
 */
export function SignInButton({ size = "md", label = "Sign in", onDone, inline = false }: {
  size?: "sm" | "md" | "lg"
  label?: string
  onDone?: () => void
  /** The page shows signInError itself. */
  inline?: boolean
}) {
  const { signIn, signing, ready } = useSession()
  return (
    <Button
      size={size}
      loading={!!signing}
      disabled={!ready}
      onClick={() =>
        signIn().then((problem) => {
          if (!problem) return onDone?.()
          if (!inline) problem.cancelled ? toast(problem.message) : toast.error(problem.message)
        })}
    >
      {signing === "wallet" ? "Choose a wallet" : signing === "message" ? "Sign the message in your wallet" : label}
    </Button>
  )
}

function AccountMenu({ id }: { id: string }) {
  const { signOut, token } = useSession()
  const isAdmin = useIsAdmin(token)
  const router = useRouter()
  const item =
    "flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl px-3 text-[15px] font-medium outline-none select-none data-[highlighted]:bg-soft"
  return (
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
                <p className="text-sm text-muted">NEAR {network}</p>
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
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
