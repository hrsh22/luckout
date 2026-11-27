// The docs' illustrations: parts of the app drawn from the same pricing code the shop uses, so they never go stale
// the way screenshots do. Server-rendered and static: no client JavaScript.
import { money, type Tint, TINT } from "@/components/docs"
import { usdUp } from "@/lib/format"
import { AMPLE_RESERVE, cashbackChanceBps, cashbackPct, MODES, type ModeInfo, RECOMMENDED, simpleQuote } from "@/lib/modes"
import { modePalette, slabColor } from "@/lib/palette"
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Copy, Gift } from "lucide-react"

const mode = (name: string) => MODES.find((m) => m.name === name)!
const pay = (m: ModeInfo, price: number) => simpleQuote(m, price, AMPLE_RESERVE).maxPrice

/** A small numbered marker, matching the numbered steps beside the picture. */
const Marker = ({ n }: { n: number }) => (
  <span className="font-display grid size-6 shrink-0 place-items-center rounded-full bg-ink text-xs font-extrabold text-white" aria-hidden="true">{n}</span>
)

/** A pill in one of the site's washes: a purchase's status, a badge. */
export const Pill = ({ tint, children }: { tint: Tint; children: React.ReactNode }) => (
  <span className="inline-block rounded-full px-3 py-1 text-[13px] font-semibold whitespace-nowrap text-ink" style={{ background: TINT[tint] }}>{children}</span>
)

/** A card's page in the shop, cut down to the three choices: the amount, the mode, then Buy. */
export function CardPageMock() {
  const price = 20_000_000
  const chosen = mode(RECOMMENDED)
  return (
    <figure className="card @container mt-6 p-5 sm:p-6">
      <figcaption className="sr-only">A card's page: choose the amount, then the mode, then buy.</figcaption>
      <div aria-hidden="true">
        <div className="flex items-center gap-4">
          <span className="voucher grid aspect-[1.6] w-24 shrink-0 place-items-center rounded-2xl text-[#1D1240]" style={{ background: modePalette(chosen.mode).tile }}>
            <Gift size={26} />
          </span>
          <span>
            <span className="font-display block text-2xl leading-tight font-extrabold text-ink">A $20 gift card</span>
            <span className="mt-1 inline-block rounded-full bg-soft px-3 py-1 text-[13px] font-semibold">Works in one country</span>
          </span>
        </div>

        <p className="mt-6 flex items-center gap-2 text-sm font-semibold text-ink"><Marker n={1} />Amount</p>
        <div className="mt-2 flex gap-2">
          {[10, 20, 50].map((a) => (
            <span key={a} className={`rounded-full px-4 py-2 text-sm font-semibold ${a === 20 ? "bg-ink text-white" : "bg-soft text-ink"}`}>${a}</span>
          ))}
        </div>

        <p className="mt-6 flex items-center gap-2 text-sm font-semibold text-ink"><Marker n={2} />How do you want to pay?</p>
        <div className="mt-2 grid grid-cols-2 gap-2 @lg:grid-cols-4">
          {MODES.map((m) => {
            const pal = modePalette(m.mode)
            const on = m === chosen
            return (
              <span key={m.name} className={`relative rounded-2xl p-3 ${on ? "ring-2 ring-ink" : ""}`} style={{ background: pal.soft, color: pal.ink }}>
                {on && <span className="absolute -top-2.5 right-2 rounded-full bg-ink px-2 py-0.5 text-[11px] font-semibold text-white">Your default</span>}
                <span className="block font-semibold">{m.name}</span>
                <span className="block text-sm">Pay {usdUp(pay(m, price))}{m.premiumBps > 0 && <span className="opacity-70">, +{m.premiumBps / 100}%</span>}</span>
                <span className="mt-1 block text-xs opacity-75">{m.premiumBps > 0 ? `${cashbackChanceBps(m) / 100}% get cashback` : "Exactly the price"}</span>
              </span>
            )
          })}
        </div>

        <p className="mt-6 flex items-center gap-2 text-sm font-semibold text-ink"><Marker n={3} />Buy</p>
        <span className="mt-2 flex h-12 items-center justify-center rounded-full bg-ink font-semibold text-white">Buy for {usdUp(pay(chosen, price))}</span>
        <span className="mt-2 block text-center text-sm text-muted">You always get the card. Any cashback lands in your balance.</span>
      </div>
    </figure>
  )
}

/** One Cart, one payment, then each card on its own: its own purchase and, in a lucky mode, its own Draw. */
export function CartSplit() {
  const lines = [
    { price: 20_000_000, m: mode("Classic") },
    { price: 10_000_000, m: mode("Normal") },
    { price: 15_000_000, m: mode("Lite") }
  ]
  const total = lines.reduce((s, l) => s + pay(l.m, l.price), 0)
  return (
    <figure className="card mt-6 p-5 sm:p-6">
      <figcaption className="sr-only">
        A Cart of three cards is paid once, {usdUp(total)}, and then each card is its own purchase, with its own Draw in a lucky mode.
      </figcaption>
      <div aria-hidden="true">
        <span className="inline-flex items-center gap-2 rounded-full bg-ink px-4 py-2.5 font-semibold text-white">Pay {usdUp(total)} once, from your balance</span>
        <ul className="mt-3 ml-5 flex flex-col gap-2 border-l-2 border-line pl-4">
          {lines.map(({ price, m }) => {
            const pal = modePalette(m.mode)
            return (
              <li key={m.name} className="relative flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-2xl p-3.5 before:absolute before:top-1/2 before:-left-4 before:h-0.5 before:w-4 before:bg-line" style={{ background: pal.soft, color: pal.ink }}>
                <span className="font-semibold">{money(price)} card on {m.name}</span>
                <span className="text-sm">{usdUp(pay(m, price))}, {m.premiumBps > 0 ? "its own Draw" : "no Draw"}</span>
              </li>
            )
          })}
        </ul>
      </div>
    </figure>
  )
}

/** Where money moves: your wallet, your balance in the contract, your cards. */
export function MoneyMap() {
  const box = "rounded-[1.5rem] px-3 py-4 text-center text-sm leading-snug [&>b]:whitespace-nowrap"
  const Arrows = ({ there, back }: { there: string; back: string }) => (
    <span className="flex flex-row justify-center gap-6 text-sm font-semibold text-ink-soft @xl:flex-col @xl:gap-2">
      <span className="flex items-center gap-1.5"><ArrowDown size={16} className="@xl:hidden" /><span>{there}</span><ArrowRight size={16} className="hidden @xl:block" /></span>
      <span className="flex items-center gap-1.5"><ArrowUp size={16} className="@xl:hidden" /><ArrowLeft size={16} className="hidden @xl:block" /><span>{back}</span></span>
    </span>
  )
  return (
    <figure className="@container mt-6">
      <figcaption className="sr-only">
        You add funds from your wallet to your balance and withdraw back to it. Buying a card takes its price from your balance, and cashback and
        refunds go back into it.
      </figcaption>
      <div aria-hidden="true" className="grid items-center gap-3 @xl:grid-cols-[1fr_auto_1.25fr_auto_1fr]">
        <span className={box} style={{ background: TINT.sky }}><b className="block text-base text-ink">Your wallet</b>The one you sign in with</span>
        <Arrows there="Add funds" back="Withdraw" />
        <span className={`${box} card`}><b className="font-display block text-xl text-ink">Your balance</b>USDC held for you by the Luckout contract</span>
        <Arrows there="Buy" back="Cashback, refunds" />
        <span className={box} style={{ background: TINT.gold }}><b className="block text-base text-ink">Your cards</b>Their codes, in Purchases</span>
      </div>
    </figure>
  )
}

/**
 * Which rolls give which cashback in one mode: the rows in the table's own order, as the contract walks them
 * (final_bps_for_roll), each owning as many of the 10,000 rolls as its chance in basis points.
 */
export function RollTable({ name }: { name: string }) {
  const m = mode(name)
  let from = 0
  const rows = m.outcomes.map((o) => {
    const pct = cashbackPct(m.premiumBps, o.finalBps)
    const row = { pct, from, to: from + o.chanceBps - 1, chanceBps: o.chanceBps, color: slabColor({ pct, cashback: pct, price: 100 - pct }) }
    from += o.chanceBps
    return row
  })
  return (
    <figure className="card mt-6 p-5 sm:p-6">
      <figcaption className="font-semibold text-ink">{m.name}: which rolls give what</figcaption>
      <div className="mt-4 flex h-4 gap-[3px] overflow-hidden rounded-full" aria-hidden="true">
        {rows.map((r) => <span key={r.from} className="h-full" style={{ background: r.color, flexGrow: r.chanceBps, flexBasis: 0, minWidth: 4 }} />)}
      </div>
      <table className="mt-4 w-full text-left text-[15px]">
        <thead className="text-sm text-muted">
          <tr><th className="py-1.5 font-semibold">Roll</th><th className="py-1.5 font-semibold">Chance</th><th className="py-1.5 font-semibold">Cashback</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.from} className="border-t border-line">
              <td className="py-2 font-mono text-sm text-ink">{r.from.toLocaleString("en-US")} to {r.to.toLocaleString("en-US")}</td>
              <td className="py-2">{r.chanceBps / 100}%</td>
              <td className="py-2">
                <span className="flex items-center gap-2">
                  <span className="size-3 shrink-0 rounded-full" style={{ background: r.color }} aria-hidden="true" />
                  {r.pct === 100 ? "100% back: free" : r.pct > 0 ? `${r.pct}% back` : "No cashback"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}

/** A delivered card as Purchases shows it: the code to copy, its own Use-By Date, and the Used mark. */
export function CodeMock() {
  return (
    <figure className="card mt-6 p-5 sm:p-6">
      <figcaption className="sr-only">A delivered card: its code with a Copy button, the date to use it by, and Mark as used.</figcaption>
      <div aria-hidden="true">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-display text-2xl font-extrabold text-ink">A $20 gift card</span>
          <Pill tint="good"><Check size={13} className="mr-1 inline" />Delivered</Pill>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3 rounded-[1.25rem] bg-soft p-4">
          <span>
            <span className="block text-sm text-muted">Code</span>
            <span className="font-mono text-[15px] font-semibold tracking-wide text-ink">X7Q2-9KDA-PL4M</span>
          </span>
          <span className="flex items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-sm font-semibold text-ink shadow-card"><Copy size={14} />Copy</span>
        </div>
        <p className="mt-3 text-sm text-ink-soft">Use it by 31 Dec 2027</p>
        <span className="mt-4 inline-block rounded-full bg-soft px-4 py-2 text-sm font-semibold text-ink">Mark as used</span>
      </div>
    </figure>
  )
}
