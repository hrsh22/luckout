import { HeroArt } from "@/components/hero-art"
import { OddsGrid } from "@/components/odds-grid"
import { buttonVariants } from "@/components/ui/button"
import { contractId, liveAverage, network, type Stats, view } from "@/lib/chain"
import { usd, usdUp } from "@/lib/format"
import { cashbackChanceBps, MAX_CASHBACK, MODES, pricedOutcomes, RECOMMENDED, simpleQuote } from "@/lib/modes"
import { modePalette } from "@/lib/palette"
import { EXAMPLE_DRAW_HREF } from "@/lib/site"
import { Lock, Repeat2, ShieldCheck, SlidersHorizontal } from "lucide-react"
import Link from "next/link"

export const revalidate = 60

const EXAMPLE = 20_000_000

const STEPS = [
  { title: "Add USDC", body: "Deposit USDC on NEAR, or send a token from Ethereum, Base, Solana, Bitcoin and more. Withdraw what you don't spend.", bg: "#E2F4FF" },
  { title: "Pick a card and a mode", body: "Pay exactly the price, or a little more up front for a chance at cashback. You see every outcome before you buy.", bg: "#EEE8FF" },
  { title: "Get the code, then the Draw", body: "Bitrefill delivers the code in seconds. Then the contract runs the Draw and any cashback lands in your balance.", bg: "#FFF3CF" }
]

const FAQ = [
  { q: "Do I always get the card?", a: "Yes. The Draw only decides how much cashback you get. If Bitrefill can't deliver, the whole amount returns to your balance and there's no Draw." },
  { q: "How does Luckout make money?", a: "Every lucky mode is built so that, across many purchases, buyers pay 105.6% of the price on average. That 5.6% is our only revenue. Normal purchases cost exactly the price." },
  {
    q: "Where is my money while it's in Luckout?",
    a: "In the Luckout contract on NEAR, credited to your account, not in a company wallet. You can withdraw anything not locked in a purchase at any time. If we ever neither deliver nor cancel a purchase, you can take the full amount back yourself after 24 hours."
  },
  {
    q: "How random is the Draw?",
    a: `It uses NEAR's block randomness, mixed with the purchase number, in a step that runs a block after delivery is confirmed, so nobody can retry it. Block producers can nudge that randomness slightly, which is why one Draw can pay back at most ${usd(MAX_CASHBACK)}, and never more than a share of the reserve.`
  },
  { q: "Can the Telegram bot spend my money?", a: "Only when you tap Confirm, and never above the per-purchase and daily limits you set. The contract enforces those limits on every purchase, whoever submits it." },
  { q: "Which wallets work?", a: "NEAR wallets (HOT, Meteor, Intear, Ledger and the others in NEAR Connect; HOT also works inside Telegram), and EVM wallets like MetaMask and Rabby, which need no NEAR at all: Luckout pays every NEAR fee." }
]

export default async function Home() {
  // Read again at most every 60 s (revalidate above).
  const stats = await view<Stats>(contractId, "get_stats").catch(() => undefined)
  const avg = stats && liveAverage(stats)

  return (
    <main id="main" className="relative">
      <div className="blob top-10 right-[8%] size-[420px] bg-[#FFE1A6] opacity-70" aria-hidden="true" />
      <div className="blob top-80 -right-32 size-[420px] bg-[#CDBEFF] opacity-80" aria-hidden="true" />
      <div className="blob top-[520px] -left-32 size-[420px] bg-[#C9E8FF] opacity-80" aria-hidden="true" />

      <section className="relative mx-auto grid max-w-[1240px] items-center gap-12 px-6 pt-14 pb-8 sm:px-10 lg:grid-cols-[1.05fr_1fr] lg:pt-20">
        <div>
          <h1 className="font-display text-[56px] leading-[0.93] font-extrabold tracking-[-0.03em] sm:text-[80px] lg:text-[88px]">Checkout, but lucky.</h1>
          <p className="mt-7 max-w-[44ch] text-lg text-ink-soft">
            Gift cards from thousands of brands around the world, paid in USDC. Pay the price, or add a little for a fair chance at
            cashback, sometimes all of it. Either way, the card is yours.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Link href="/shop" className={buttonVariants({ size: "lg" })}>Open the shop</Link>
            <Link href="/welcome" className={buttonVariants({ size: "lg", variant: "light" })}>Create your account</Link>
          </div>
          <p className="mt-6 flex items-center gap-2 text-sm text-muted">
            <span className={`size-2 rounded-full ${network === "testnet" ? "bg-warn" : "bg-good"}`} />
            {network === "testnet" ? "Live on NEAR testnet with free test USDC" : "Live on NEAR"}
          </p>
        </div>
        <HeroArt />
      </section>

      <section id="how" className="relative mx-auto max-w-[1240px] scroll-mt-28 px-6 pt-24 sm:px-10">
        <h2 className="font-display text-5xl font-extrabold tracking-[-0.03em] sm:text-[56px]">How it works</h2>
        <ol className="mt-8 grid gap-4 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="relative flex min-h-[280px] flex-col overflow-hidden rounded-[2.1rem] p-7" style={{ background: s.bg }}>
              <span className="font-display text-[84px] leading-[0.9] font-extrabold text-ink/15" aria-hidden="true">{i + 1}</span>
              <h3 className="font-display mt-2 text-[26px] font-extrabold tracking-tight">{s.title}</h3>
              <p className="mt-1 text-ink-soft">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="modes" className="relative mx-auto max-w-[1240px] scroll-mt-28 px-6 pt-24 sm:px-10">
        <h2 className="font-display text-5xl font-extrabold tracking-[-0.03em] sm:text-[56px]">Four ways to pay</h2>
        <p className="mt-3 max-w-[60ch] text-lg text-ink-soft">
          For a $20 card. Lucky modes cost more up front and pay cashback in fixed slabs. Any cashback leaves you below the price, but the
          most likely result is no cashback.
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {MODES.map((m) => {
            const p = modePalette(m.mode)
            // The model at its best, whatever today's reserve: the whole card in the Draw. The shop prices from the live reserve.
            const q = simpleQuote(m, EXAMPLE, Number.MAX_SAFE_INTEGER)
            const slabs = pricedOutcomes(m, q).filter((o) => o.cashback > 0)
            const freeSlab = slabs.find((o) => o.price === 0)
            return (
              <article key={m.name} className="flex min-h-[300px] flex-col rounded-[2.1rem] p-7" style={{ background: p.tile, color: p.ink }}>
                <div className="flex items-center gap-2">
                  <h3 className="font-display text-[30px] font-extrabold">{m.name}</h3>
                  {m.name === RECOMMENDED && <span className="pill">Recommended</span>}
                </div>
                <p className="font-display mt-4 text-5xl font-extrabold">{usdUp(q.maxPrice)}</p>
                <p className="opacity-75">{m.premiumBps ? `up front, +${m.premiumBps / 100}%` : "exactly the price"}</p>
                <div className="mt-auto pt-6 text-[15px]">
                  {m.premiumBps === 0
                    ? <p className="opacity-80">No Draw, no cashback. The card at its price.</p>
                    : (
                      <>
                        <p><b>{cashbackChanceBps(m) / 100}%</b> get cashback</p>
                        <p className="opacity-80">{slabs.filter((o) => o !== freeSlab).map((o) => `${o.pct}%`).join(", ")} back, or 100% off</p>
                        {freeSlab && <span className="pill mt-3 !bg-white/70">100% off {freeSlab.chanceBps / 100}% of the time</span>}
                      </>
                    )}
                </div>
              </article>
            )
          })}
        </div>
        <div className="mt-4">
          <OddsGrid />
        </div>
      </section>

      <section className="relative mx-auto max-w-[1240px] px-6 pt-24 sm:px-10">
        <div className="relative overflow-hidden rounded-[2.75rem] bg-ink px-8 py-14 text-white sm:px-14">
          <div className="blob -top-20 -right-16 size-80 bg-lilac opacity-50" aria-hidden="true" />
          <div className="blob right-56 -bottom-36 size-72 bg-gold opacity-35" aria-hidden="true" />
          <div className="relative grid gap-12 lg:grid-cols-[1fr_1.2fr]">
            <div>
              <h2 className="font-display text-5xl leading-none font-extrabold tracking-[-0.03em] sm:text-[56px]">Built to be checked, not trusted.</h2>
              <p className="mt-4 max-w-[44ch] text-lg text-white/70">
                Your balance, your limits and every Draw live in a NEAR contract. This is what lucky buyers have actually paid so far.
              </p>
              <p className="font-display mt-8 text-7xl font-extrabold text-gold">{avg === undefined ? "105.6%" : `${avg.toFixed(1)}%`}</p>
              <p className="text-white/70">
                {avg === undefined ? "promised average, for every mode" : `of the price, on average, over ${stats!.lucky_settled} Draws. Promised: 105.6%.`}
              </p>
              <Link href="/fair" className={`${buttonVariants({ variant: "light" })} mt-6`}>See the live numbers</Link>
            </div>
            <ul className="grid gap-4 sm:grid-cols-2">
              <Point icon={ShieldCheck} title="Every Draw is public">
                The contract logs the seed and the roll. Anyone can recompute a Draw in their browser.{" "}
                <Link href={EXAMPLE_DRAW_HREF} className="font-semibold text-gold underline underline-offset-4">See one</Link>
              </Point>
              <Point icon={Repeat2} title="Nobody can retry a Draw">Delivery is confirmed first. The Draw runs a block later, in a step nothing can undo, not even us.</Point>
              <Point icon={Lock} title="Cashback is covered first">Each lucky purchase locks what its biggest possible cashback would cost, so the money is there whatever the result.</Point>
              <Point icon={SlidersHorizontal} title="Limits you set">The contract caps every purchase at your per-purchase and daily limits, including the ones the Telegram bot makes.</Point>
            </ul>
          </div>
        </div>
      </section>

      <section className="relative mx-auto grid max-w-[1240px] items-center gap-12 px-6 pt-24 sm:px-10 lg:grid-cols-2">
        <div>
          <h2 className="font-display text-5xl font-extrabold tracking-[-0.03em] sm:text-[56px]">Or just ask in Telegram.</h2>
          <p className="mt-4 max-w-[46ch] text-lg text-ink-soft">
            Connect Telegram from your wallet page and the Luckout bot can search, quote and prepare purchases for you. Nothing is bought
            until you tap the button, and codes arrive in your private chat.
          </p>
          <Link href="/wallet" className={`${buttonVariants({ variant: "light", size: "lg" })} mt-7`}>Connect Telegram</Link>
        </div>
        <div className="flex flex-col gap-3 rounded-[2.25rem] bg-sky-soft p-6 text-[15px] sm:p-8" aria-label="Example chat with the Luckout bot">
          <p className="self-end rounded-3xl rounded-br-md bg-ink px-4 py-2.5 text-white">A $10 Steam card, Classic</p>
          <div className="flex max-w-[88%] flex-col gap-3 rounded-3xl rounded-bl-md bg-white px-4 py-3 shadow-card">
            <p>Steam $10: price $10.00. On Classic you pay $12.00 now, and 40% of the time you get cashback, from 20% to all of it.</p>
            <div className="grid grid-cols-2 gap-2 text-sm font-semibold">
              <span className="rounded-full bg-soft px-3 py-2 text-center">Buy for $12.00</span>
              <span className="rounded-full bg-soft px-3 py-2 text-center">Cancel</span>
            </div>
          </div>
          <div className="flex max-w-[88%] items-center gap-3 rounded-3xl rounded-bl-md bg-gold px-4 py-3 font-semibold text-gold-ink">
            $2.40 cashback! You paid $9.60, $0.40 less than the price.
          </div>
        </div>
      </section>

      <section className="relative mx-auto w-full max-w-[860px] px-6 pt-24 sm:px-10">
        <h2 className="font-display text-5xl font-extrabold tracking-[-0.03em] sm:text-[56px]">Questions</h2>
        <div className="mt-8 flex flex-col gap-3">
          {FAQ.map((f) => (
            <details key={f.q} className="group card px-6">
              <summary className="flex list-none items-center justify-between gap-4 py-5 text-lg font-semibold">
                {f.q}
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-soft text-xl leading-none transition-transform group-open:rotate-45" aria-hidden="true">+</span>
              </summary>
              <p className="pb-6 text-ink-soft">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="relative mx-auto max-w-[1240px] px-6 pt-24 sm:px-10">
        <div className="relative overflow-hidden rounded-[2.75rem] px-8 py-14 sm:px-14" style={{ background: "linear-gradient(160deg,#FFE7A3,#FFC53D 60%,#FFB21F)" }}>
          <div className="blob -top-24 -right-10 size-80 bg-white opacity-50" aria-hidden="true" />
          <div className="relative text-gold-ink">
            <h2 className="max-w-[14em] font-display text-5xl leading-none font-extrabold tracking-[-0.03em] sm:text-[60px]">Your next card could be 100% off.</h2>
            <p className="mt-4 text-lg opacity-80">Sign in with a NEAR or EVM wallet and choose how you like to pay. It takes a minute.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/welcome" className={buttonVariants({ size: "lg" })}>Create your account</Link>
              <Link href="/shop" className={buttonVariants({ size: "lg", variant: "onColor" })}>Browse cards first</Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}

function Point({ icon: Icon, title, children }: { icon: typeof Lock; title: string; children: React.ReactNode }) {
  return (
    <li className="rounded-[1.75rem] bg-white/8 p-6 ring-1 ring-white/10">
      <span className="mb-4 grid size-11 place-items-center rounded-2xl bg-white/10 text-gold"><Icon size={20} /></span>
      <h3 className="font-display text-xl font-extrabold">{title}</h3>
      <p className="mt-1 text-[15px] text-white/70">{children}</p>
    </li>
  )
}
