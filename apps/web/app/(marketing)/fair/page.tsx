import { DailyReset } from "@/components/local-time"
import { api } from "@/lib/api"
import { codeHash, contractId, explorerAccount, liveAverage, type Stats, view } from "@/lib/chain"
import { usd } from "@/lib/format"
import { EXAMPLE_DRAW_HREF } from "@/lib/site"
import type { Metadata } from "next"
import Link from "next/link"

export const revalidate = 60
export const metadata: Metadata = {
  title: "Is it fair?",
  description: "What Luckout's lucky buyers have actually paid, and the reserve behind every cashback, read live from the contract."
}

interface Reserve { free: string; locked: string; max_cashback: string }

export default async function Fair() {
  const [stats, reserve, code, tee] = await Promise.all([
    view<Stats>(contractId, "get_stats").catch(() => undefined),
    view<Reserve>(contractId, "get_reserve").catch(() => undefined),
    codeHash(contractId).catch(() => undefined),
    api((c) => c.attestation(), undefined, "10 seconds").catch(() => undefined)
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
        recompute in your browser, like <Link href={EXAMPLE_DRAW_HREF} className="font-semibold text-ink underline underline-offset-4">this one</Link>.
      </p>

      {reserve && (
        <section className="card flex flex-col gap-4 p-8">
          <h2 className="font-display text-3xl font-extrabold">The Cashback Reserve</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <Figure label="Free" value={usd(reserve.free)} />
            <Figure label="Locked for purchases in progress" value={usd(reserve.locked)} />
            <Figure label="Most cashback one purchase can get now" value={usd(reserve.max_cashback)} />
          </div>
          <p className="text-ink-soft">
            Each lucky buy locks what its biggest possible cashback would cost before it starts, so every cashback is already covered. One
            purchase gets at most the lower of a fixed amount and a share of what's free, so the reserve always outlasts a run of luck.
          </p>
        </section>
      )}

      <section className="flex flex-col gap-4">
        <h2 className="font-display text-3xl font-extrabold">What the contract guarantees</h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {[
            "Every Game Version is immutable, and the contract refuses any table that doesn't average exactly 105.6%, or whose cashback could leave you above the price.",
            "The Draw runs a block after delivery is confirmed, so nobody, including us, can retry it or cancel a purchase after seeing the result.",
            <>Your per-purchase and daily limits apply to every purchase, whoever submits it. The daily limit resets every day at <DailyReset />.</>,
            "A purchase we neither deliver nor cancel can be reclaimed in full after 24 hours."
          ].map((t, i) => <li key={i} className="card p-6 text-ink-soft">{t}</li>)}
        </ul>
        <p className="max-w-[64ch] text-ink-soft">
          What it can't prove: that a code was delivered (Bitrefill isn't on chain), and that we buy in the mode you chose. Both are bounded
          by the most you confirmed and by your limits. And Luckout can upgrade the contract: every upgrade is a public transaction, and it
          changes the code hash below.
        </p>
        {code && (
          <p className="max-w-[64ch] text-ink-soft">
            Code hash <code className="font-mono text-sm break-all text-ink">{code}</code>. Build the contract from{" "}
            <a href="https://github.com/hrsh22/luckout" className="font-semibold text-ink underline underline-offset-4" target="_blank" rel="noreferrer">its source</a>{" "}
            with <code className="font-mono text-sm text-ink">cargo near build reproducible-wasm</code> and you get the same hash.
          </p>
        )}
      </section>

      {tee && (
        <section className="card flex flex-col gap-4 p-8">
          <h2 className="font-display text-3xl font-extrabold">The assistant's AI runs in a verified enclave</h2>
          <p className="max-w-[64ch] text-ink-soft">
            The Telegram assistant's model, <code className="font-mono text-sm text-ink">{tee.model}</code>, runs on NEAR AI Cloud inside a
            secure enclave. Every hour our server checks that with a fresh nonce: NVIDIA verifies the GPUs, Intel verifies the CPU enclave,
            and the enclave's signing key must be bound into both. Every reply must carry that key's signature over exactly what we sent
            and got back, or the assistant doesn't send it. Without a passing check, the assistant stays offline.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <Figure label="Latest check" value={tee.ok ? "Passed" : "Failed"} />
            <Figure label="Replies verified since the server started" value={String(tee.replies.verified)} />
            <Figure label="Replies withheld" value={String(tee.replies.refused)} />
          </div>
          <ul className="grid gap-1 text-ink-soft">
            {tee.checks.map((c) => (
              <li key={c.name}>
                <span aria-hidden="true" className={c.ok ? "text-good" : "text-bad"}>{c.ok ? "✓" : "✗"}</span>{" "}
                <span className="sr-only">{c.ok ? "Passed:" : "Failed:"}</span>
                {c.name}
              </li>
            ))}
          </ul>
          <p className="text-sm break-all text-muted">
            Checked {new Date(tee.checkedAt).toUTCString()} with nonce <code className="font-mono">{tee.nonce}</code>. Model signing key{" "}
            <code className="font-mono">{tee.modelKeys.join(", ")}</code>.{" "}
            <a href="https://docs.near.ai/cloud/verification" className="font-semibold text-ink underline underline-offset-4" target="_blank" rel="noreferrer">How NEAR AI attestation works</a>
          </p>
        </section>
      )}

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
