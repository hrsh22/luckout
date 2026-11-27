import { shortAccount } from "@/components/avatar"
import { BrowserCheck } from "@/components/browser-check"
import { LocalTime } from "@/components/local-time"
import { errorMessage } from "@/lib/api"
import { explorer, explorerAccount } from "@/lib/chain"
import { ORAO_VRF } from "@/lib/draw"
import { backText, usd, usdDown, usdUp } from "@/lib/format"
import { cashbackPct } from "@/lib/modes"
import { loadProof, NotOnChain, pickDraw, SIGNATURE } from "@/lib/proof"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { cache } from "react"
import { PurchasesLink } from "./purchases-link"

/** `card`: which Draw, when the transaction finished several of a Checkout's cards (ADR-0013). */
type Props = { params: Promise<{ tx: string }>; searchParams: Promise<{ card?: string }> }

const cardOf = async (searchParams: Props["searchParams"]) => {
  const c = (await searchParams).card
  return c && /^\d{1,2}$/.test(c) ? Number(c) : undefined
}

// Once per request: generateMetadata and the page share it.
const load = cache(async (tx: string, card: number | undefined) => {
  if (!SIGNATURE.test(tx)) notFound()
  // No such transaction, Draw or card is a 404; Solana not answering keeps the page, with its words.
  const proof = await loadProof(tx).catch((e: unknown) => (e instanceof NotOnChain ? notFound() : { error: errorMessage(e) }))
  if ("error" in proof) return proof
  const draw = pickDraw(proof, card)
  return draw ? { proof, draw } : notFound()
})

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const d = await load((await params).tx, await cardOf(searchParams))
  if ("error" in d) return { title: "Draw Proof" }
  const paid = d.draw.finalPrice
  return {
    title: `Draw Proof: ${paid === 0 ? "100% off" : `paid ${usdUp(paid)} for`} a ${usd(d.draw.referencePrice)} card`,
    description: "Recompute this Draw yourself, from ORAO's randomness on Solana to the cashback."
  }
}

const external = "underline underline-offset-4 hover:text-ink"

export default async function DrawProofPage({ params, searchParams }: Props) {
  const tx = (await params).tx
  const d = await load(tx, await cardOf(searchParams))
  if ("error" in d) {
    return (
      <main id="main" className="mx-auto w-full max-w-[1000px] px-6 pt-14 sm:px-10">
        <h1 className="font-display text-6xl font-extrabold tracking-[-0.03em]">Draw Proof</h1>
        <p role="alert" className="mt-4 font-medium text-bad">{d.error}</p>
      </main>
    )
  }
  const { proof, draw } = d
  const { version, request } = draw
  const ref = draw.referencePrice
  const paid = draw.finalPrice
  // Below the price by a whole cent or more, rounded down: a saving is never shown as more than it is, nor as $0.00.
  const below = ref - paid >= 10_000
  // When only part of the price played (the Lucky Amount), the table's shares are of that part, not of the whole price.
  const part = draw.luckyAmount < ref
  const code = "font-mono text-sm break-all text-ink"

  return (
    <main id="main" className="relative mx-auto flex w-full max-w-[1000px] flex-col gap-10 px-6 pt-14 sm:px-10">
      <div className="blob top-0 -right-40 size-[380px] bg-[#FFE1A6] opacity-70" aria-hidden="true" />
      <PurchasesLink />
      <div className="relative flex flex-col gap-4">
        {proof.cluster !== "mainnet" && (
          <p className="pill self-start !bg-warn-soft">On Solana {proof.cluster}, with test money</p>
        )}
        <h1 className="font-display text-[48px] leading-[0.95] font-extrabold tracking-[-0.03em] sm:text-[72px]">
          {paid === 0 ? "100% off" : `Paid ${usdUp(paid)} for`} a {usd(ref)} card
        </h1>
        <p className="text-lg text-ink-soft">
          Card {draw.card + 1} of a Checkout by <span title={draw.customer}>{shortAccount(draw.customer)}</span>, on {version.name} (up to +
          {version.premiumBps / 100}%)
          {proof.time !== undefined && (
            <>, <LocalTime iso={new Date(proof.time * 1000).toISOString()} options={{ dateStyle: "medium", timeStyle: "short" }} /></>
          )}
          .{part && ` Only ${usd(draw.luckyAmount)} of the price played; the rest was bought at the price.`}
        </p>
      </div>

      <dl className={`relative grid grid-cols-2 gap-6 rounded-[2rem] p-7 sm:grid-cols-4 ${below ? "bg-gold text-gold-ink" : "card"}`}>
        <Stat label="Price" value={usd(ref)} />
        <Stat label="Paid up front" value={usdUp(draw.maxPrice)} />
        <Stat label="Cashback" value={usdDown(draw.cashback)} />
        <Stat label={below ? `Paid, ${usdDown(ref - paid)} below the price` : "Paid"} value={usdUp(paid)} strong />
      </dl>

      <section className="flex flex-col gap-4">
        <h2 className="font-display text-3xl font-extrabold">What this proves</h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {[
            "Delivery came first. The step that confirmed this card also asked ORAO for its randomness, and nothing can undo a confirmation.",
            "Neither Luckout nor the customer chose the randomness. ORAO's oracles filled it in, at an address only this Checkout and round lead to.",
            "Anyone can finish a Draw. Finishing only reads ORAO's stored value, so doing it again changes nothing.",
            "A request can be replaced only if ORAO never filled it in: after an hour, anyone can ask again under the next round. A filled request is final."
          ].map((t) => <li key={t} className="card p-6 text-ink-soft">{t}</li>)}
        </ul>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="font-display text-3xl font-extrabold">Check it yourself</h2>
        <ol className="list-decimal space-y-1.5 pl-5 text-ink-soft">
          <li>
            Seed = sha256("luckout-draw", the Checkout <code className={code}>{draw.checkout}</code>, round {draw.round}).
            {draw.round > 0 && ` Round ${draw.round}: ORAO didn't fill in the earlier request, so it was asked again.`}
          </li>
          <li>
            ORAO's request is the account ORAO's program keeps at that seed: <code className={code}>{request.address}</code>. The program reads
            randomness only from there, and only once ORAO has filled it in.
          </li>
          <li>The randomness: the 64 bytes ORAO's oracles filled in, as that account still holds them.</li>
          <li>Random value = sha256(randomness, then this card's index in its Checkout, {draw.card}), so cards drawn together are independent.</li>
          <li>Roll = the first 8 bytes of the random value, modulo 10,000.</li>
          <li>
            The roll picks a row of the {version.name} table below.{" "}
            {part
              ? `That row's share applies to the ${usd(draw.luckyAmount)} that played, and the remainder is paid at the price. The Final Price is their sum`
              : "The Final Price is that share of the price"}
            , rounded up, never above what was paid up front; the difference comes back as cashback.
          </li>
        </ol>
        <BrowserCheck draw={draw} />
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
                const from = version.outcomes.slice(0, i).reduce((s, x) => s + x.chanceBps, 0)
                const hit = draw.roll >= from && draw.roll < from + o.chanceBps
                return (
                  <tr key={i} className={`border-b border-line last:border-0 ${hit ? "bg-gold-soft font-semibold" : ""}`}>
                    <td className="p-4 tabular-nums">{from}–{from + o.chanceBps - 1}</td>
                    <td className="p-4 tabular-nums">{o.chanceBps / 100}%</td>
                    <td className="p-4">
                      {o.finalBps < 10_000 + version.premiumBps ? `${cashbackPct(version.premiumBps, o.finalBps)}% back` : "None"}
                      <span className="text-muted">, pays {o.finalBps / 100}% of {part ? "the part that played" : "the price"}</span>
                      {hit ? `, roll ${draw.roll}` : ""}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-ink-soft">Game Versions can't be changed once added, and every table averages exactly 105.6%.</p>
      </section>

      {proof.draws.length > 1 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-display text-3xl font-extrabold">Drawn in the same transaction</h2>
          <ul className="flex flex-wrap gap-2">
            {proof.draws.map((o) => (
              <li key={o.card}>
                <Link
                  href={`/draw/${tx}?card=${o.card}`}
                  aria-current={o.card === draw.card ? "page" : undefined}
                  className={`pill ${o.card === draw.card ? "!bg-ink !text-white" : "hover:!bg-line"}`}
                >
                  Card {o.card + 1}: {o.cashback > 0 ? backText(o.cashback) : "no cashback"}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-3xl font-extrabold">What it can't prove</h2>
        <p className="max-w-[64ch] text-ink-soft">
          That the card was delivered: Bitrefill isn't on Solana, so the proof starts where Luckout confirmed delivery. A card that isn't
          delivered gets no Draw, and its full price goes back to the customer's balance. And ORAO could hold back a value to force a new
          request. The Cashback Cap limits what any one Draw can pay, which bounds what that could ever be worth.
        </p>
      </section>

      <section className="flex flex-col gap-2 text-sm text-muted">
        <h2 className="sr-only">On Solana Explorer</h2>
        <a className={external} href={explorer(tx)} target="_blank" rel="noreferrer">The transaction that finished this Draw</a>
        {request.requestedBy && (
          <a className={external} href={explorer(request.requestedBy)} target="_blank" rel="noreferrer">
            The transaction that confirmed delivery and asked ORAO for randomness
          </a>
        )}
        <a className={external} href={explorerAccount(request.address)} target="_blank" rel="noreferrer">ORAO's request account</a>
        {request.filledBy.map((s, i) => (
          <a key={s} className={external} href={explorer(s)} target="_blank" rel="noreferrer">
            ORAO's oracle transaction {i + 1} of {request.filledBy.length}
            {i === request.filledBy.length - 1 && request.filledBy.length > 1 ? ", which completed it" : ""}
          </a>
        ))}
        <a className={external} href={explorerAccount(proof.programId)} target="_blank" rel="noreferrer">The Luckout program</a>
        <a className={external} href={explorerAccount(ORAO_VRF)} target="_blank" rel="noreferrer">ORAO's VRF program</a>
      </section>
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
