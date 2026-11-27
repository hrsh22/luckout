/**
 * Every docs page, in sidebar order. The route, its metadata, the sidebar and the sitemap all read this list, so a
 * page is one MDX file in content/docs plus one line here. No `@/` imports: lib/docs.test.ts loads it in plain Node.
 */
export interface Doc {
  /** "" is /docs itself. Flat, and never a chain's name, so a URL outlives a chain move (ADR-0015). */
  slug: string
  /** The page's h1, its sidebar entry and its <title>. */
  title: string
  /** The search result snippet: unique per page, at most 160 characters. */
  description: string
  section: string
}

export const DOCS: ReadonlyArray<Doc> = [
  {
    slug: "",
    title: "How Luckout works",
    description: "Buy gift cards with USDC at their price, or pay a little more for a fair chance at cashback. You always get the card. Start here.",
    section: "Start"
  },
  {
    slug: "modes",
    title: "The four modes",
    description: "Normal, Lite, Classic and Jackpot: what each costs up front, how often it pays cashback and how much, with the exact odds.",
    section: "Modes and cashback"
  },
  {
    slug: "fairness",
    title: "How Luckout stays fair",
    description: "How Luckout earns, why a Draw can't be retried, how every cashback is covered, and how to check any Draw yourself.",
    section: "Modes and cashback"
  }
]

export const docHref = (d: Doc) => (d.slug ? `/docs/${d.slug}` : "/docs")
export const docFile = (d: Doc) => d.slug || "index"

/** Said word for word on every page that names Bitrefill: Bitrefill's condition (2026-11-27). */
export const BITREFILL_NOTE = "Luckout sources its gift cards from Bitrefill, which isn't affiliated with Luckout."
