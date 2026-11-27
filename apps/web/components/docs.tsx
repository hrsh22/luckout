import { usdUp } from "@/lib/format"
import { AMPLE_RESERVE, cashbackChanceBps, MODES, pricedOutcomes, simpleQuote } from "@/lib/modes"
import { modePalette } from "@/lib/palette"
import { EXAMPLE_DRAW_HREF } from "@/lib/site"
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
