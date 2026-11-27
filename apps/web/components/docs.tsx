import { usd, usdUp } from "@/lib/format"
import { AMPLE_RESERVE, cashbackChanceBps, MODES, pricedOutcomes, simpleQuote } from "@/lib/modes"
import { modePalette } from "@/lib/palette"
import { EXAMPLE_DRAW_HREF } from "@/lib/site"
import { ArrowDown, ArrowRight } from "lucide-react"
import Link from "next/link"

export const docLink = "font-semibold text-ink underline decoration-ink/25 underline-offset-4 hover:decoration-ink"

/** A link to the example Draw Proof, whose address depends on the network (JSX in MDX skips mdx-components). */
export const ExampleDraw = ({ children }: { children: React.ReactNode }) => <Link href={EXAMPLE_DRAW_HREF} className={docLink}>{children}</Link>

/** Docs tables: MDX's GFM tables (mdx-components.tsx) and the ones below share them. */
export const Table = (p: React.ComponentProps<"table">) => (
  <div className="card mt-6 overflow-x-auto">
    {/* Too narrow on a phone, it scrolls sideways inside its card rather than squeezing every column. */}
    <table className="w-full min-w-[34rem] text-left text-[15px]" {...p} />
  </div>
)
export const Th = (p: React.ComponentProps<"th">) => <th className="border-b border-line px-4 py-3 align-bottom font-semibold text-ink" {...p} />
export const Td = (p: React.ComponentProps<"td">) => <td className="border-b border-line px-4 py-3 align-top [tr:last-child_&]:border-0" {...p} />

/** A whole-dollar amount without its cents ("$200"), else to the cent: for limits and minimums in prose. */
export const money = (micro: number) => usd(micro).replace(/\.00$/, "")

/** The site's pale washes, one per step or note, so a page reads like the landing page. */
export const TINT = {
  sky: "#E2F4FF",
  lilac: "#EEE8FF",
  gold: "#FFF3CF",
  lime: "#EEFBD6",
  tang: "#FFF1E8",
  pink: "#FFE3F1",
  good: "#E3F7EA",
  warn: "#FFF3D6"
} as const
export type Tint = keyof typeof TINT
const CYCLE: ReadonlyArray<Tint> = ["sky", "lilac", "gold", "lime"]

/** Choices side by side, each in its own wash; with `href`, a tile is a link to that page or section. */
export const Tiles = ({ children }: { children: React.ReactNode }) => (
  <div className="@container mt-6"><div className="grid gap-3 @lg:grid-cols-3">{children}</div></div>
)
export function Tile({ title, href, tint = "sky", children }: { title: string; href?: string; tint?: Tint; children: React.ReactNode }) {
  const inner = (
    <>
      <span className="flex items-start justify-between gap-2 font-semibold text-ink">
        {title}{href && <ArrowRight size={18} className="mt-0.5 shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />}
      </span>
      <span className="mt-1 block text-[15px] leading-snug text-ink-soft">{children}</span>
    </>
  )
  const className = "group block rounded-[1.5rem] p-5"
  return href
    ? <Link href={href} className={`${className} transition-shadow hover:shadow-float`} style={{ background: TINT[tint] }}>{inner}</Link>
    : <div className={className} style={{ background: TINT[tint] }}>{inner}</div>
}

interface FlowNode {
  title: string
  body?: string
  tint?: Tint
}

/** A process as boxes and arrows: up to three go across a wide column, more always go down, as on a phone. */
export function Flow({ label, nodes }: { label: string; nodes: ReadonlyArray<FlowNode> }) {
  const across = nodes.length <= 3
  return (
    <figure className="@container mt-6">
      <ol aria-label={label} className={`flex flex-col gap-1.5 ${across ? "@xl:flex-row" : ""}`}>
        {nodes.map((n, i) => (
          <li key={n.title} className={`flex flex-1 flex-col items-stretch gap-1.5 ${across ? "@xl:flex-row @xl:items-center" : ""}`}>
            {i > 0 && <ArrowDown size={20} className={`shrink-0 self-center text-muted ${across ? "@xl:-rotate-90" : ""}`} aria-hidden="true" />}
            <span className="block flex-1 self-stretch rounded-[1.5rem] p-4" style={{ background: TINT[n.tint ?? CYCLE[i % CYCLE.length]!] }}>
              <span className="block font-semibold text-ink">{n.title}</span>
              {n.body && <span className="mt-1 block text-[15px] leading-snug text-ink-soft">{n.body}</span>}
            </span>
          </li>
        ))}
      </ol>
    </figure>
  )
}

/** One FAQ entry, folded like the landing page's; its question is an h3 with an id, so a link can open it. */
export const Q = ({ q, children }: { q: string; children: React.ReactNode }) => (
  <details id={q.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")} className="group card mt-3 scroll-mt-28 px-6">
    <summary className="flex list-none items-center justify-between gap-4 py-5 [&::-webkit-details-marker]:hidden">
      <h3 className="text-lg leading-snug font-semibold text-ink">{q}</h3>
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-soft text-xl leading-none text-ink transition-transform group-open:rotate-45" aria-hidden="true">+</span>
    </summary>
    <div className="pb-6 [&>p:first-child]:mt-0 [&>ul:first-child]:mt-0">{children}</div>
  </details>
)

/** Numbered steps on a rail: what to do, in order. Each step's body is MDX, so it can hold links and lists. */
export const Steps = ({ children }: { children: React.ReactNode }) => (
  <ol className="mt-6 flex flex-col [counter-reset:step]">{children}</ol>
)
export const Step = ({ title, children, tint = "lilac" }: { title: string; children?: React.ReactNode; tint?: Tint }) => (
  <li className="group/step relative pb-7 pl-14 [counter-increment:step] last:pb-0">
    <span aria-hidden="true" className="absolute top-11 bottom-1 left-[19px] w-0.5 rounded-full bg-line group-last/step:hidden" />
    <span
      aria-hidden="true"
      className="font-display absolute top-0 left-0 grid size-10 place-items-center rounded-full text-base font-extrabold text-ink before:content-[counter(step)]"
      style={{ background: TINT[tint] }}
    />
    <p className="pt-1.5 font-semibold text-ink">{title}</p>
    <div className="[&>p:first-child]:mt-1 [&>ul:first-child]:mt-2">{children}</div>
  </li>
)

/** A short aside in a pale wash: a tip, or the one thing not to miss. */
export const Note = ({ title, children, tint = "sky" }: { title?: string; children: React.ReactNode; tint?: Tint }) => (
  <aside className="mt-6 rounded-[1.5rem] p-5 text-base text-ink [&>p:first-of-type]:mt-0 [&>p]:mt-2" style={{ background: TINT[tint] }}>
    {title && <p className="font-semibold">{title}</p>}
    {children}
  </aside>
)

interface ChatLine {
  from: "you" | "bot"
  text: string
  /** Buttons under the bot's message; the first is drawn as the one to tap. */
  buttons?: ReadonlyArray<string>
}

/** A Telegram chat with the bot, drawn rather than screenshotted, so it never goes stale. */
export const Chat = ({ label, lines }: { label: string; lines: ReadonlyArray<ChatLine> }) => (
  <figure className="card mt-6 overflow-hidden">
    <figcaption className="flex items-center gap-3 border-b border-line px-5 py-3.5">
      <span className="font-display grid size-9 place-items-center rounded-full bg-lilac text-sm font-extrabold text-white" aria-hidden="true">L</span>
      <span className="leading-tight"><span className="block font-semibold text-ink">Luckout</span><span className="text-sm text-muted">{label}</span></span>
    </figcaption>
    <div className="flex flex-col gap-2.5 bg-soft px-4 py-5 text-[15px] leading-snug sm:px-5">
      {lines.map((l, i) => (
        <div key={i} className={l.from === "you" ? "flex justify-end" : "flex flex-col items-start gap-1.5"}>
          <p className={`max-w-[85%] rounded-[1.25rem] px-4 py-2.5 whitespace-pre-line ${l.from === "you" ? "rounded-br-md bg-ink text-white" : "rounded-bl-md bg-white text-ink shadow-card"}`}>
            <span className="sr-only">{l.from === "you" ? "You: " : "Bot: "}</span>{l.text}
          </p>
          {l.buttons && (
            <span className="flex flex-wrap gap-1.5">
              {l.buttons.map((b, j) => (
                <span key={b} className={`rounded-full px-4 py-1.5 text-sm font-semibold ${j === 0 ? "bg-lilac text-white" : "bg-white text-ink shadow-card"}`}>{b}</span>
              ))}
            </span>
          )}
        </div>
      ))}
    </div>
  </figure>
)

const PRICE = 20_000_000

/** The four modes for a $20 card, from the same tables the shop prices with. */
export function ModeTable() {
  return (
    <Table>
      <caption className="sr-only">The four modes for a $20 card</caption>
      <thead>
        <tr><Th>Mode</Th><Th>You pay up front</Th><Th>Chance of cashback</Th><Th>Cashback, as a share of what you paid</Th></tr>
      </thead>
      <tbody>
        {MODES.map((m) => {
          const q = simpleQuote(m, PRICE, AMPLE_RESERVE)
          const back = pricedOutcomes(m, q).filter((o) => o.cashback > 0).map((o) => `${o.pct}%`)
          return (
            <tr key={m.name}>
              <Td>
                <span className="flex items-center gap-2 font-semibold text-ink">
                  <span className="size-2.5 rounded-full" style={{ background: modePalette(m.mode).solid }} aria-hidden="true" />
                  {m.name}
                </span>
              </Td>
              <Td>{usdUp(q.maxPrice)}{m.premiumBps > 0 && ` (+${m.premiumBps / 100}%)`}</Td>
              <Td>{m.premiumBps > 0 ? `${cashbackChanceBps(m) / 100}%` : "No Draw"}</Td>
              <Td>{back.length > 0 ? `${back.slice(0, -1).join(", ")} or ${back.at(-1)}` : "None: the card at its price"}</Td>
            </tr>
          )
        })}
      </tbody>
    </Table>
  )
}
