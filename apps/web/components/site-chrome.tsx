import { Wordmark } from "@/components/brand"
import { NavShell } from "@/components/nav-shell"
import { buttonVariants } from "@/components/ui/button"
import { cluster, explorerAccount, programInfo } from "@/lib/chain"
import { EXAMPLE_DRAW_HREF } from "@/lib/site"
import Link from "next/link"
import { Suspense } from "react"

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
        <span className={`size-2 rounded-full ${cluster === "mainnet" ? "bg-good" : "bg-warn"}`} aria-hidden="true" />
        Solana {cluster}{cluster === "mainnet" ? "" : ", test cards only"}
      </span>
      <Link className={link} href="/fair">Fairness</Link>
      {EXAMPLE_DRAW_HREF && <Link className={link} href={EXAMPLE_DRAW_HREF}>A Draw Proof</Link>}
      <Suspense fallback={null}>
        <ProgramLink className={link} />
      </Suspense>
      <span className="sm:ml-auto">Gift cards sourced from Bitrefill, which isn't affiliated with Luckout. You always get the card.</span>
    </footer>
  )
}

/** The program on Solana Explorer, once the server has said which it is; nothing while it can't. */
async function ProgramLink({ className }: { className: string }) {
  const program = await programInfo("10 seconds").catch(() => undefined)
  return program
    ? <a className={className} href={explorerAccount(program.programId)} target="_blank" rel="noreferrer">The program</a>
    : null
}

/**
 * "No page here", without a header: the root not-found adds the Wordmark, while one inside the app or the marketing
 * layout sits under that layout's own. Admin pages show it to everyone else, so they read as any missing page.
 */
export function NoPage() {
  return (
    <div className="flex max-w-xl flex-col gap-6 py-10">
      <h1 className="font-display text-6xl leading-none font-extrabold tracking-[-0.03em]">No page here</h1>
      <p className="text-lg text-ink-soft">The link may be mistyped, or the page has moved.</p>
      <div className="flex flex-wrap gap-3">
        <Link href="/shop" className={buttonVariants({ size: "lg" })}>Go to the shop</Link>
        <Link href="/" className={buttonVariants({ size: "lg", variant: "light" })}>About Luckout</Link>
      </div>
    </div>
  )
}
