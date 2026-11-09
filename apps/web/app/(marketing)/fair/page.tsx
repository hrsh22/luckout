import { contractId, explorerAccount, liveAverage, type Stats, view } from "@/lib/chain"
import { usd } from "@/lib/format"
import { MAX_CASHBACK } from "@/lib/modes"
import { EXAMPLE_DRAW } from "@/lib/site"
import type { Metadata } from "next"
import Link from "next/link"

export const revalidate = 60
export const metadata: Metadata = {
  title: "Is it fair?",
  description: "What Luckout's lucky buyers have actually paid, and the reserve behind every cashback, read live from the contract."
}

interface Reserve { free: string; locked: string; discount_cap: string }

export default async function Fair() {
  const [stats, reserve] = await Promise.all([
    view<Stats>(contractId, "get_stats").catch(() => undefined),
    view<Reserve>(contractId, "get_reserve").catch(() => undefined)
  ])
  const avg = stats && liveAverage(stats)

  return (
    <main id="main" className="relative mx-auto flex w-full max-w-[1000px] flex-col gap-10 px-6 pt-14 sm:px-10">
      <div className="blob top-0 -right-40 size-[380px] bg-[#CDBEFF] opacity-60" aria-hidden="true" />
      <div className="relative">
        <h1 className="font-display text-[56px] leading-[0.93] font-extrabold tracking-[-0.03em] sm:text-[80px]">Is it fair?</h1>
        <p className="mt-6 max-w-[56ch] text-lg text-ink-soft">
          Every lucky mode is built to average 105.6% of the price. That 5.6% is Luckout's only revenue. Here is what lucky buyers have
          actually paid so far, read from the contract within the last minute.
        </p>
      </div>

      {!stats && <p role="alert" className="font-medium text-bad">Couldn't reach NEAR just now. Reload in a moment.</p>}

      <section className="relative grid gap-4 sm:grid-cols-2">
        <div className="relative overflow-hidden rounded-[2.25rem] bg-ink p-8 text-white">
          <div className="blob -top-20 -right-10 size-64 bg-gold opacity-35" aria-hidden="true" />
          <h2 className="relative text-white/70">Live Average</h2>
          <p className="font-display relative mt-1 text-7xl font-extrabold text-gold">{avg === undefined ? "None yet" : `${avg.toFixed(1)}%`}</p>
          <p className="relative mt-2 text-white/70">of the price, over {stats?.lucky_settled ?? 0} settled lucky buys</p>
        </div>
        <div className="card p-8">
          <h2 className="text-ink-soft">Promised</h2>
          <p className="font-display mt-1 text-7xl font-extrabold">105.6%</p>
          <p className="mt-2 text-ink-soft">in the long run, for every mode and every size</p>
        </div>
      </section>
      <p className="max-w-[64ch] text-ink-soft">
        Over a few dozen Draws the average swings a lot; over thousands it settles near 105.6%. Every Draw links to a Draw Proof you can
        recompute in your browser, like <Link href={`/draw/${EXAMPLE_DRAW}`} className="font-semibold text-ink underline underline-offset-4">this one</Link>.
      </p>

      {reserve && (
        <section className="card flex flex-col gap-4 p-8">
          <h2 className="font-display text-3xl font-extrabold">The Cashback Reserve</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <Figure label="Free" value={usd(reserve.free)} />
            <Figure label="Locked for purchases in progress" value={usd(reserve.locked)} />
            <Figure label="Most one purchase can cost it now" value={usd(reserve.discount_cap)} />
          </div>
          <p className="text-ink-soft">
            Each lucky buy locks what its biggest possible cashback would cost before it starts, so every cashback is already covered. One
            purchase can get at most {usd(MAX_CASHBACK)} back, and can't cost the reserve more than 20% of what's free.
          </p>
        </section>
      )}

      <section className="flex flex-col gap-4">
        <h2 className="font-display text-3xl font-extrabold">What the contract guarantees</h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {[
            "Every Game Version is immutable, and the contract refuses any table that doesn't average exactly 105.6%, or whose cashback could leave you above the price.",
            "The Draw runs a block after delivery is confirmed, so nobody, including us, can retry it or cancel a purchase after seeing the result.",
            "Your per-purchase and daily limits apply to every purchase, whoever submits it. The daily limit resets at 00:00 UTC.",
            "A purchase we neither deliver nor cancel can be reclaimed in full after 24 hours."
          ].map((t) => <li key={t} className="card p-6 text-ink-soft">{t}</li>)}
        </ul>
        <p className="max-w-[64ch] text-ink-soft">
          What it can't prove: that a code was delivered (Bitrefill isn't on chain), and that we buy in the mode you chose. Both are bounded
          by the most you confirmed and by your limits.
        </p>
      </section>

      <a className="self-start text-sm font-medium text-muted underline underline-offset-4 hover:text-ink" href={explorerAccount(contractId)} target="_blank" rel="noreferrer">
        Contract {contractId} on NearBlocks
      </a>
    </main>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[1.5rem] bg-soft p-5">
      <p className="text-sm text-muted">{label}</p>
      <p className="font-display mt-1 text-3xl font-extrabold">{value}</p>
    </div>
  )
}
