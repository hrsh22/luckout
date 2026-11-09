import { BrowserCheck } from "@/components/browser-check"
import { contractId, explorer } from "@/lib/chain"
import { usd } from "@/lib/format"
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
    title: `Draw Proof: paid ${paid === 0 ? "nothing" : usd(paid)} for a ${usd(d.draw.reference_price)} card`,
    description: "Recompute this Draw yourself, straight from the NEAR chain."
  }
}

export default async function DrawProof({ params }: Props) {
  const tx = (await params).tx
  const d = await load(tx)
  if ("error" in d) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 pt-6 pb-20 sm:px-6">
        <h1 className="font-display text-4xl">Draw Proof</h1>
        <p role="alert" className="text-destructive mt-4">{d.error}</p>
      </main>
    )
  }
  const { draw, version, time } = d
  const ref = Number(draw.reference_price)
  const paid = Number(draw.final_price)
  const diff = paid - ref

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 pt-6 pb-20 sm:px-6">
      <div className="flex flex-col gap-3">
        <h1 className="font-display text-4xl sm:text-5xl">
          {paid === 0 ? "Paid nothing" : `Paid ${usd(paid)}`} for a {usd(ref)} card
        </h1>
        <p className="text-muted-foreground">
          Purchase #{draw.purchase_id} by {draw.customer} on {version.name} (up to +{version.premium_bps / 100}%),{" "}
          {time.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC.
        </p>
      </div>

      <dl className="bg-receipt grid grid-cols-2 gap-6 rounded-2xl border p-6 sm:grid-cols-4">
        <Stat label="Price" value={usd(ref)} />
        <Stat label="Most they could pay" value={usd(draw.max_price)} />
        <Stat label="Paid" value={usd(paid)} strong />
        <Stat label={diff < 0 ? "Below the price" : diff > 0 ? "Above the price" : "Difference"} value={usd(Math.abs(diff))} />
      </dl>

      <section className="flex flex-col gap-4">
        <h2 className="font-display text-2xl">Check it yourself</h2>
        <ol className="text-muted-foreground list-decimal space-y-1.5 pl-5 leading-relaxed">
          <li>The block's random seed: <code className="text-foreground break-all">{draw.seed}</code></li>
          <li>Random value = sha256(seed, then purchase number #{draw.purchase_id}), so Draws in the same block are independent.</li>
          <li>Roll = the first 8 bytes of the random value, modulo 10,000.</li>
          <li>The roll picks a row of the {version.name} table below. The Final Price is that share of the price, rounded up, never above the most they could pay.</li>
        </ol>
        <BrowserCheck tx={tx} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-2xl">The {version.name} table</h2>
        <div className="overflow-x-auto rounded-xl border">
          <table className="bg-receipt w-full text-sm">
            <thead className="text-muted-foreground border-b text-left">
              <tr><th scope="col" className="p-3 font-medium">Rolls</th><th scope="col" className="p-3 font-medium">Chance</th><th scope="col" className="p-3 font-medium">Pays</th></tr>
            </thead>
            <tbody>
              {version.outcomes.map((o, i) => {
                const from = version.outcomes.slice(0, i).reduce((s, x) => s + x.chance_bps, 0)
                const hit = draw.roll >= from && draw.roll < from + o.chance_bps
                return (
                  <tr key={i} className={`border-b last:border-0 ${hit ? "bg-gold font-semibold" : ""}`}>
                    <td className="p-3 tabular-nums">{from}–{from + o.chance_bps - 1}</td>
                    <td className="p-3 tabular-nums">{o.chance_bps / 100}%</td>
                    <td className="p-3">{o.final_bps / 100}% of the price{hit ? `, roll ${draw.roll}` : ""}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Game Versions are immutable and every table averages exactly 106%. A block producer can bias the seed slightly; the Discount
          Cap and Spending Limits bound what that could ever be worth.
        </p>
      </section>

      <p className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <a className="underline underline-offset-4" href={explorer(tx)} target="_blank" rel="noreferrer">The transaction on NearBlocks</a>
        <span>Contract {contractId}</span>
      </p>
    </main>
  )
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className={`tabular-nums ${strong ? "font-display text-3xl" : "text-xl font-semibold"}`}>{value}</dd>
    </div>
  )
}
