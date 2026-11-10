import { Wordmark } from "@/components/brand"
import { NavShell } from "@/components/nav-shell"
import { buttonVariants } from "@/components/ui/button"
import { contractId, explorerAccount, network } from "@/lib/chain"
import { EXAMPLE_DRAW_HREF, TESTNET_SITE } from "@/lib/site"
import Link from "next/link"

const LINKS = [
  { href: "/#how", label: "How it works" },
  { href: "/#modes", label: "Modes" },
  { href: "/fair", label: "Fairness" }
]

export function SiteHeader() {
  return (
    <NavShell
      links={LINKS}
      right={<Link href="/shop" className={buttonVariants({ size: "sm" })}>Open the shop</Link>}
    />
  )
}

export function SiteFooter({ compact = false }: { compact?: boolean }) {
  const link = "font-medium hover:text-ink"
  return (
    <footer className={`relative mx-auto flex w-full max-w-[1240px] flex-wrap items-center gap-x-6 gap-y-2 px-6 pb-10 text-sm text-muted sm:px-10 ${compact ? "mt-6" : "mt-24"}`}>
      <Wordmark className="text-ink" />
      <span className="flex items-center gap-2">
        <span className={`size-2 rounded-full ${network === "testnet" ? "bg-warn" : "bg-good"}`} aria-hidden="true" />
        NEAR {network}{network === "testnet" ? ", test USDC only" : ""}
      </span>
      <Link className={link} href="/fair">Fairness</Link>
      <Link className={link} href={EXAMPLE_DRAW_HREF}>A Draw Proof</Link>
      <a className={link} href={explorerAccount(contractId)} target="_blank" rel="noreferrer">The contract</a>
      {network === "mainnet" && <a className={link} href={TESTNET_SITE}>Try the free testnet demo</a>}
      <span className="sm:ml-auto">Gift cards by Bitrefill. You always get the card.</span>
    </footer>
  )
}
