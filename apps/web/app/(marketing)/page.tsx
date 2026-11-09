import { OddsGrid } from "@/components/odds-grid"
import { buttonVariants } from "@/components/ui/button"
import { contractId, liveAverage, type Stats, view } from "@/lib/chain"
import { usd } from "@/lib/format"
import { chanceLessBps, MODES, mostLikely, pricedOutcomes, simpleQuote } from "@/lib/modes"
import { EXAMPLE_DRAW, testnet } from "@/lib/site"
import Link from "next/link"

export const revalidate = 60

const EXAMPLE = 20_000_000

const STEPS = [
  {
    title: "Add USDC",
    body:
      "Deposit USDC on NEAR, or send a token from Ethereum, Base, Solana, Bitcoin and more; NEAR Intents swaps it on the way in. Whatever you don't spend, you can withdraw."
  },
  {
    title: "Pick a card and a mode",
    body: "Choose the brand and amount, then Normal to pay exactly the price, or a lucky mode. You see the most you could pay before you confirm."
  },
  {
    title: "Get the code in seconds",
    body: "Bitrefill delivers the code. Then the contract runs the Draw and puts any refund straight back into your balance."
  }
]

const FAQ = [
  {
    q: "Do I always get the card?",
    a: "Yes. The Draw only decides how much of the price comes back to you. If Bitrefill can't deliver, the whole amount returns to your balance and there's no Draw."
  },
  {
    q: "How does Luckout make money?",
    a: "Every lucky mode is built so that, across many purchases, buyers pay 106% of the price on average. That 6% is our only revenue. Normal purchases cost exactly the price."
  },
  {
    q: "Where is my money while it's in Luckout?",
    a: "In the Luckout contract on NEAR, credited to your account, not in a company wallet. You can withdraw anything not locked in a purchase at any time. If we ever neither deliver nor cancel a purchase, you can take the full amount back yourself after 24 hours."
  },
  {
    q: "How random is the Draw?",
    a: "It uses NEAR's block randomness, mixed with the purchase number, in a step that runs a block after delivery is confirmed, so nobody can retry it. Block producers can nudge that randomness slightly, which is why each Draw's biggest possible refund is capped at a share of the reserve."
  },
  {
    q: "Can the Telegram bot spend my money?",
    a: "Only when you tap Confirm, and never above the per-purchase and daily limits you set. The contract enforces those limits on every purchase, whoever submits it."
  },
  {
    q: "Which wallets work?",
    a: "HOT, Meteor, Intear, MyNearWallet, Ledger and the other wallets in NEAR Connect. HOT also works inside Telegram."
  }
]

export default async function Home() {
  const stats = await view<Stats>(contractId, "get_stats").catch(() => undefined)
  const avg = stats && liveAverage(stats)

  return (
    <main className="flex flex-col">
      <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 pt-8 pb-20 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:pt-16">
        <div className="flex flex-col gap-6">
          <h1 className="font-display text-5xl leading-[0.95] text-balance sm:text-7xl">Checkout, but lucky.</h1>
          <p className="text-muted-foreground max-w-xl text-lg leading-relaxed text-pretty sm:text-xl">
            Gift cards, phone top-ups and eSIMs from thousands of brands, paid in USDC. Pay the price, or add a little for a fair
            chance to pay less, sometimes nothing. Either way, the card is yours.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href="/shop" className={buttonVariants({ size: "lg" })}>Open the shop</Link>
            <Link href="#modes" className={buttonVariants({ size: "lg", variant: "outline" })}>Compare the modes</Link>
          </div>
          {testnet && <p className="text-muted-foreground text-sm">Testnet preview: test USDC and Bitrefill test cards only.</p>}
        </div>
        <OddsGrid />
      </section>

      <section id="how" className="mx-auto w-full max-w-6xl scroll-mt-8 px-4 pb-20 sm:px-6">
        <h2 className="font-display mb-10 text-3xl sm:text-4xl">How a purchase works</h2>
        <ol className="grid gap-10 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="border-foreground flex flex-col gap-3 border-t-2 pt-5">
              <span className="font-display text-4xl tabular-nums" aria-hidden="true">{i + 1}</span>
              <h3 className="text-xl font-semibold">{s.title}</h3>
              <p className="text-muted-foreground leading-relaxed">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="modes" className="mx-auto w-full max-w-6xl scroll-mt-8 px-4 pb-20 sm:px-6">
        <div className="mb-8 flex max-w-2xl flex-col gap-3">
          <h2 className="font-display text-3xl sm:text-4xl">Four ways to pay for a $20 card</h2>
          <p className="text-muted-foreground leading-relaxed">
            The most likely result of every lucky mode is paying the full premium. The chance of paying less is the reason to pick one.
          </p>
        </div>
        <div className="overflow-x-auto rounded-2xl border">
          <table className="bg-receipt w-full min-w-[640px] text-left">
            <thead className="text-muted-foreground border-b text-sm">
              <tr>
                <th scope="col" className="p-4 font-medium">Mode</th>
                <th scope="col" className="p-4 font-medium">You add up to</th>
                <th scope="col" className="p-4 font-medium">Most likely you pay</th>
                <th scope="col" className="p-4 font-medium">Chance to pay less</th>
                <th scope="col" className="p-4 font-medium">Best case</th>
              </tr>
            </thead>
            <tbody>
              {MODES.map((m) => {
                const outcomes = pricedOutcomes(m, simpleQuote(m, EXAMPLE))
                const likely = mostLikely(outcomes)
                const best = outcomes[outcomes.length - 1]!
                return (
                  <tr key={m.name} className="border-b last:border-0">
                    <th scope="row" className="font-display p-4 text-lg">{m.name}</th>
                    <td className="p-4 tabular-nums">{m.premiumBps ? `${m.premiumBps / 100}%` : "Nothing"}</td>
                    <td className="p-4 tabular-nums">
                      <b>{usd(likely.price)}</b>
                      {m.premiumBps > 0 && <span className="text-muted-foreground">, {likely.chanceBps / 100}% of the time</span>}
                    </td>
                    <td className="p-4 tabular-nums">{m.premiumBps ? `${chanceLessBps(m) / 100}%` : "None"}</td>
                    <td className="p-4 tabular-nums">
                      {best.price === 0
                        ? <span className="bg-gold rounded px-1.5 py-0.5 font-semibold">Free, {best.chanceBps / 100}%</span>
                        : best.price < EXAMPLE
                        ? <span className="bg-gold-soft rounded px-1.5 py-0.5 font-semibold">{usd(best.price)}, {best.chanceBps / 100}%</span>
                        : usd(best.price)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="text-muted-foreground mt-4 max-w-2xl text-sm leading-relaxed">
          Over many purchases, every lucky mode averages 106% of the price. On big purchases the Draw applies to part of the price, and
          the rest is charged at the normal price; the shop shows exactly how much before you buy.
        </p>
      </section>

      <section className="bg-foreground text-background">
        <div className="mx-auto grid w-full max-w-6xl gap-12 px-4 py-20 sm:px-6 lg:grid-cols-[1fr_1.3fr]">
          <div className="flex flex-col gap-5">
            <h2 className="font-display text-3xl sm:text-4xl">Built to be checked, not trusted</h2>
            <p className="text-background/75 leading-relaxed">
              Your balance, your limits and every Draw live in a NEAR contract. Here is what lucky buyers have actually paid so far,
              read from it a minute ago.
            </p>
            <div className="border-background/20 flex flex-col gap-1 border-t pt-5">
              <p className="font-display text-gold text-6xl tabular-nums">{avg === undefined ? "106%" : `${avg.toFixed(1)}%`}</p>
              <p className="text-background/75 text-sm">
                {avg === undefined
                  ? "promised average, for every mode"
                  : `of the price, on average, over ${stats!.lucky_settled} Draws. Promised: 106%.`}
              </p>
            </div>
            <Link href="/fair" className="text-gold self-start text-sm font-semibold underline underline-offset-4">See the live numbers</Link>
          </div>
          <ul className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
            <Point title="Every Draw is public">
              The contract logs the seed and the roll. Anyone can recompute a Draw in their browser.{" "}
              <Link href={`/draw/${EXAMPLE_DRAW}`} className="text-gold underline underline-offset-4">See one</Link>
            </Point>
            <Point title="Nobody can retry a Draw">
              Delivery is confirmed first. The Draw runs a block later, in a step nothing can undo, not even us.
            </Point>
            <Point title="Refunds are covered before you buy">
              Each lucky purchase locks its biggest possible refund from the reserve, so the money is there whatever the result.
            </Point>
            <Point title="Limits you set">
              The contract caps every purchase at your per-purchase and daily limits, including the ones the Telegram bot makes.
            </Point>
          </ul>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <h2 className="font-display text-3xl sm:text-4xl">Or just ask in Telegram</h2>
          <p className="text-muted-foreground max-w-lg leading-relaxed">
            Link Telegram from your balance page and the Luckout bot can search, quote and prepare purchases for you. Nothing is bought
            until you tap the button, and codes arrive in your private chat.
          </p>
          <Link href="/wallet" className={`${buttonVariants({ variant: "outline" })} self-start`}>Link Telegram</Link>
        </div>
        <div className="bg-secondary flex flex-col gap-3 rounded-2xl p-5 text-[15px] sm:p-7" aria-label="Example chat with the Luckout bot">
          <p className="bg-foreground text-background self-end rounded-2xl rounded-br-sm px-4 py-2.5">A $25 Steam card, Bold</p>
          <div className="bg-receipt flex max-w-[85%] flex-col gap-3 rounded-2xl rounded-bl-sm px-4 py-3">
            <p>Steam $25: price $25.00. On Bold you pay at most $31.25. That's the most likely result; 18% of the time you pay less, down to nothing.</p>
            <div className="grid grid-cols-2 gap-2 text-sm font-medium">
              <span className="bg-secondary rounded-lg px-3 py-2 text-center">Buy for up to $31.25</span>
              <span className="bg-secondary rounded-lg px-3 py-2 text-center">Cancel</span>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-3xl px-4 pb-24 sm:px-6">
        <h2 className="font-display mb-6 text-3xl sm:text-4xl">Questions</h2>
        <div className="divide-border border-y">
          {FAQ.map((f) => (
            <details key={f.q} className="group border-b py-1 last:border-0">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-lg font-medium">
                {f.q}
                <span className="text-muted-foreground text-2xl leading-none transition-transform group-open:rotate-45" aria-hidden="true">+</span>
              </summary>
              <p className="text-muted-foreground pb-5 leading-relaxed">{f.a}</p>
            </details>
          ))}
        </div>
      </section>
    </main>
  )
}

function Point({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <li className="flex flex-col gap-2">
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="text-background/75 leading-relaxed">{children}</p>
    </li>
  )
}
