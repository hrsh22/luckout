import { Wordmark } from "@/components/brand"
import { buttonVariants } from "@/components/ui/button"
import { contractId, explorerAccount } from "@/lib/chain"
import { EXAMPLE_DRAW, testnet } from "@/lib/site"
import Link from "next/link"

export function SiteHeader() {
  return (
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-5 sm:px-6">
      <Wordmark />
      <nav className="flex items-center gap-1 text-sm sm:gap-2" aria-label="Main">
        <Link href="/#how" className="text-muted-foreground hover:text-foreground hidden rounded-md px-3 py-2 sm:block">How it works</Link>
        <Link href="/fair" className="text-muted-foreground hover:text-foreground hidden rounded-md px-3 py-2 sm:block">Fairness</Link>
        <Link href="/shop" className={buttonVariants()}>Open the shop</Link>
      </nav>
    </header>
  )
}

export function SiteFooter() {
  const link = "text-muted-foreground hover:text-foreground"
  return (
    <footer className="border-border mt-auto border-t">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-12 sm:grid-cols-[1.5fr_1fr_1fr] sm:px-6">
        <div className="flex flex-col gap-3">
          <Wordmark />
          <p className="text-muted-foreground max-w-xs text-sm">
            Gift cards, top-ups and eSIMs from Bitrefill, paid in USDC on NEAR.
          </p>
          {testnet && (
            <p className="text-muted-foreground max-w-xs text-sm">
              This is the testnet preview: balances are test USDC and only Bitrefill test cards can be bought.
            </p>
          )}
        </div>
        <nav className="flex flex-col gap-2 text-sm" aria-label="Shop">
          <p className="font-semibold">Shop</p>
          <Link className={link} href="/shop">Browse cards</Link>
          <Link className={link} href="/purchases">Your purchases</Link>
          <Link className={link} href="/wallet">Balance and limits</Link>
        </nav>
        <nav className="flex flex-col gap-2 text-sm" aria-label="Fairness">
          <p className="font-semibold">Check our work</p>
          <Link className={link} href="/fair">Live Average and reserve</Link>
          <Link className={link} href={`/draw/${EXAMPLE_DRAW}`}>An example Draw Proof</Link>
          <a className={link} href={explorerAccount(contractId)} target="_blank" rel="noreferrer">The contract on NearBlocks</a>
        </nav>
      </div>
    </footer>
  )
}
