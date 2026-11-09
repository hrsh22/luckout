import { BrowserCheck } from "@/components/browser-check"
import { contractId, explorer } from "@/lib/chain"
import { usd, usdUp } from "@/lib/format"
import { cashbackPct, MAX_CASHBACK } from "@/lib/modes"
import { loadDraw } from "@/lib/proof"
import type { Metadata } from "next"
import { notFound } from "next/navigation"

type Props = { params: Promise<{ tx: string }> }

const TX = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/

const load = async (tx: string) => {
  if (!TX.test(tx)) notFound()
  return loadDraw(tx).catch((e: unknown) => ({ error: String((e as Error)?.message ?? e) }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const d = await load((await params).tx)
  if ("error" in d) return { title: "Draw Proof" }
  const paid = Number(d.draw.final_price)
  return {
    title: `Draw Proof: paid ${paid === 0 ? "nothing" : usdUp(paid)} for a ${usd(d.draw.reference_price)} card`,
    description: "Recompute this Draw yourself, straight from the NEAR chain."
  }
}

export default async function DrawProof({ params }: Props) {
  const tx = (await params).tx
  const d = await load(tx)
  if ("error" in d) {
    return (
      <main id="main" className="mx-auto w-full max-w-[1000px] px-6 pt-14 sm:px-10">
        <h1 className="font-display text-6xl font-extrabold tracking-[-0.03em]">Draw Proof</h1>
        <p role="alert" className="mt-4 font-medium text-bad">{d.error}</p>
      </main>
    )
  }
  const { draw, version, time } = d
  const ref = Number(draw.reference_price)
  const paid = Number(draw.final_price)
  const diff = paid - ref

  return (
    <main id="main" className="relative mx-auto flex w-full max-w-[1000px] flex-col gap-10 px-6 pt-14 sm:px-10">
      <div className="blob top-0 -right-40 size-[380px] bg-[#FFE1A6] opacity-70" aria-hidden="true" />
      <div className="relative flex flex-col gap-4">
        <h1 className="font-display text-[48px] leading-[0.95] font-extrabold tracking-[-0.03em] sm:text-[72px]">
          {paid === 0 ? "Paid nothing" : `Paid ${usdUp(paid)}`} for a {usd(ref)} card
        </h1>
        <p className="text-lg text-ink-soft">
          Purchase #{draw.purchase_id} by {draw.customer} on {version.name} (up to +{version.premium_bps / 100}%),{" "}
          {time.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC.
        </p>
      </div>

      <dl className={`relative grid grid-cols-2 gap-6 rounded-[2rem] p-7 sm:grid-cols-4 ${diff < 0 ? "bg-gold text-gold-ink" : "card"}`}>
        <Stat label="Price" value={usd(ref)} />
        <Stat label="Paid up front" value={usdUp(draw.max_price)} />
        <Stat label="Cashback" value={usd(draw.cashback)} />
        <Stat label={diff < 0 ? `Paid, ${usd(-diff)} below the price` : "Paid"} value={usdUp(paid)} strong />
      </dl>

      <section className="flex flex-col gap-4">
        <h2 className="font-display text-3xl font-extrabold">Check it yourself</h2>
        <ol className="list-decimal space-y-1.5 pl-5 text-ink-soft">
          <li>The block's random seed: <code className="font-mono text-sm break-all text-ink">{draw.seed}</code></li>
          <li>Random value = sha256(seed, then purchase number #{draw.purchase_id}), so Draws in the same block are independent.</li>
          <li>Roll = the first 8 bytes of the random value, modulo 10,000.</li>
          <li>The roll picks a row of the {version.name} table below. The Final Price is that share of the price, rounded up, never above what they paid up front; the rest comes back as cashback.</li>
        </ol>
        <BrowserCheck tx={tx} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-3xl font-extrabold">The {version.name} table</h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-[15px]">
            <thead className="border-b border-line text-left text-muted">
              <tr><th scope="col" className="p-4 font-medium">Rolls</th><th scope="col" className="p-4 font-medium">Chance</th><th scope="col" className="p-4 font-medium">Cashback</th></tr>
            </thead>
            <tbody>
              {version.outcomes.map((o, i) => {
                const from = version.outcomes.slice(0, i).reduce((s, x) => s + x.chance_bps, 0)
                const hit = draw.roll >= from && draw.roll < from + o.chance_bps
                return (
                  <tr key={i} className={`border-b border-line last:border-0 ${hit ? "bg-gold-soft font-semibold" : ""}`}>
                    <td className="p-4 tabular-nums">{from}–{from + o.chance_bps - 1}</td>
                    <td className="p-4 tabular-nums">{o.chance_bps / 100}%</td>
                    <td className="p-4">
                      {o.final_bps < 10_000 + version.premium_bps ? `${cashbackPct(version.premium_bps, o.final_bps)}% back` : "None"}
                      <span className="text-muted">, pays {o.final_bps / 100}% of the price</span>
                      {hit ? `, roll ${draw.roll}` : ""}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-ink-soft">
          Game Versions are immutable and every table averages exactly 105.6%. A block producer can bias the seed slightly; the{" "}
          {usd(MAX_CASHBACK)} cashback cap, the Discount Cap and Spending Limits bound what that could ever be worth.
        </p>
      </section>

      <p className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted">
        <a className="underline underline-offset-4" href={explorer(tx)} target="_blank" rel="noreferrer">The transaction on NearBlocks</a>
        <span>Contract {contractId}</span>
      </p>
    </main>
  )
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm opacity-70">{label}</dt>
      <dd className={strong ? "font-display text-4xl font-extrabold" : "text-xl font-semibold"}>{value}</dd>
    </div>
  )
}
