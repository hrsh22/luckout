import { contractId, explorerAccount, liveAverage, type Stats, view } from "@/lib/chain"
import { usd } from "@/lib/format"
import { MAX_CASHBACK } from "@/lib/modes"
import { EXAMPLE_DRAW } from "@/lib/site"
import type { Metadata } from "next"
import Link from "next/link"

export const revalidate = 60
export const metadata: Metadata = {
  title: "Is it fair?",
  description: "What Luckout's lucky buyers have actually paid, and the reserve behind every refund, read live from the contract."
}

interface Reserve { free: string; locked: string; discount_cap: string }

export default async function Fair() {
  const [stats, reserve] = await Promise.all([
    view<Stats>(contractId, "get_stats").catch(() => undefined),
    view<Reserve>(contractId, "get_reserve").catch(() => undefined)
  ])
  const avg = stats && liveAverage(stats)

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 pt-6 pb-20 sm:px-6">
      <div className="flex flex-col gap-4">
        <h1 className="font-display text-4xl sm:text-5xl">Is it fair?</h1>
        <p className="text-muted-foreground text-lg leading-relaxed">
          Every lucky mode is built to average 105.6% of the price. That 5.6% is Luckout's only revenue. Here is what lucky buyers have
          actually paid so far, read from the contract within the last minute.
        </p>
      </div>

      {!stats && <p role="alert" className="text-destructive">Couldn't reach NEAR just now. Reload in a moment.</p>}

      <section className="bg-receipt grid gap-8 rounded-2xl border p-6 sm:grid-cols-2 sm:p-8">
        <div className="flex flex-col gap-1">
          <h2 className="text-muted-foreground text-sm">Live Average</h2>
          <p className="font-display text-6xl tabular-nums">{avg === undefined ? "None yet" : `${avg.toFixed(1)}%`}</p>
          <p className="text-muted-foreground text-sm">of the price, over {stats?.lucky_settled ?? 0} settled Lucky Buys</p>
        </div>
        <div className="flex flex-col gap-1">
          <h2 className="text-muted-foreground text-sm">Promised</h2>
          <p className="font-display text-6xl tabular-nums">105.6%</p>
          <p className="text-muted-foreground text-sm">in the long run, for every mode and every size</p>
        </div>
      </section>
      <p className="text-muted-foreground leading-relaxed">
        Over a few dozen Draws the average swings a lot; over thousands it settles near 105.6%. Every Draw links to a Draw Proof you can
        recompute in your browser, like <Link href={`/draw/${EXAMPLE_DRAW}`} className="text-foreground underline underline-offset-4">this one</Link>.
      </p>

      {reserve && (
        <section className="flex flex-col gap-3">
          <h2 className="font-display text-2xl">The Cashback Reserve</h2>
          <p className="text-muted-foreground leading-relaxed">
            {usd(reserve.free)} is free and {usd(reserve.locked)} is locked for purchases in progress. Each Lucky Buy locks what its
            biggest possible cashback would cost before it starts, so every cashback is already covered. One purchase can get at most{" "}
            {usd(MAX_CASHBACK)} back, and can't cost the reserve more than {usd(reserve.discount_cap)} right now: 20% of the free reserve.
          </p>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-2xl">What the contract guarantees</h2>
        <ul className="text-muted-foreground flex list-disc flex-col gap-2 pl-5 leading-relaxed">
          <li>Every Game Version is immutable, and the contract refuses any table that doesn't average exactly 105.6%, or whose cashback could leave you above the price.</li>
          <li>The Draw runs a block after delivery is confirmed, so nobody, including us, can retry it or cancel a purchase after seeing the result.</li>
          <li>Your per-purchase and daily limits apply to every purchase, whoever submits it. The daily limit resets at 00:00 UTC.</li>
          <li>A purchase we neither deliver nor cancel can be reclaimed in full after 24 hours.</li>
        </ul>
        <p className="text-muted-foreground leading-relaxed">
          What it can't prove: that a code was delivered (Bitrefill isn't on chain), and that we buy in the mode you chose. Both are
          bounded by the most you confirmed and by your limits.
        </p>
      </section>

      <a className="text-muted-foreground text-sm underline underline-offset-4" href={explorerAccount(contractId)} target="_blank" rel="noreferrer">
        Contract {contractId} on NearBlocks
      </a>
    </main>
  )
}
