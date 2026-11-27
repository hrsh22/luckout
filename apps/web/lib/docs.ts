/**
 * Every docs page, in sidebar order. The route, its metadata, the sidebar and the sitemap all read this list, so a
 * page is one MDX file in content/docs plus one line here. No `@/` imports: lib/docs.test.ts loads it in plain Node.
 */
export interface Doc {
  /**
   * "" is /docs itself; "add-funds/ore" is a subpage of "add-funds", listed right after it. Never a chain's name,
   * so a URL outlives a chain move (ADR-0015).
   */
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
    slug: "sign-in",
    title: "Create your account",
    description: "Sign in with a NEAR, EVM or Solana wallet, pick your default mode, and give the email your cards are sent to. It takes a minute.",
    section: "Start"
  },
  {
    slug: "add-funds",
    title: "Add funds",
    description: "Add USDC to your Luckout balance from the wallet you signed in with, from another chain or an exchange, or with ORE.",
    section: "Start"
  },
  {
    slug: "add-funds/other-chains",
    title: "From another chain",
    description: "Send USDC, USDT, ETH, BTC, SOL or wNEAR from eight chains or an exchange, and it lands in your Luckout balance as USDC.",
    section: "Start"
  },
  {
    slug: "add-funds/ore",
    title: "Pay with ORE",
    description: "Pay for a Top-Up in ORE from a Solana wallet: one swap you approve turns it into the USDC your Luckout balance needs.",
    section: "Start"
  },
  {
    slug: "buy",
    title: "Buy a card",
    description: "Find a card for your country, choose an amount and a mode, and buy it from your balance. The code usually arrives within a minute.",
    section: "Buying"
  },
  {
    slug: "buy/cart",
    title: "The Cart",
    description: "Put up to 15 cards in one Cart and pay once. Each card stays its own purchase, with its own Draw and its own refund.",
    section: "Buying"
  },
  {
    slug: "buy/your-cards",
    title: "Your cards and codes",
    description: "Where your codes show, what each purchase status means, the date to use a card by, and marking a card as used.",
    section: "Buying"
  },
  {
    slug: "modes",
    title: "The four modes",
    description: "Normal, Lite, Classic and Jackpot: what each costs up front, how often it pays cashback and how much, with the exact odds.",
    section: "Modes and cashback"
  },
  {
    slug: "draw",
    title: "The Draw",
    description: "When the Draw runs, where its randomness comes from, why nobody can retry it, and how to read, check and share a Draw Proof.",
    section: "Modes and cashback"
  },
  {
    slug: "fairness",
    title: "How Luckout stays fair",
    description: "How Luckout earns, why a Draw can't be retried, how every cashback is covered, and how to check any Draw yourself.",
    section: "Modes and cashback"
  },
  {
    slug: "balance",
    title: "Your balance",
    description: "Where your USDC is held, how to withdraw it to your wallet or another chain, and the network fees Luckout pays for you.",
    section: "Your money"
  },
  {
    slug: "limits",
    title: "Limits",
    description: "The spending limits you set for your own balance, the daily and monthly limits on each email your cards go to, and how to raise them.",
    section: "Your money"
  },
  {
    slug: "refunds",
    title: "Refunds and Reclaim",
    description: "What happens to your money when a card can't be delivered, how to reclaim a stuck purchase, and where Top-Up refunds go.",
    section: "Your money"
  },
  {
    slug: "telegram",
    title: "The Telegram bot",
    description: "Link Telegram and ask the Luckout bot for a card, even from a photo of a checkout. Nothing is bought until you tap.",
    section: "Telegram"
  },
  {
    slug: "telegram/safety",
    title: "How the bot keeps you safe",
    description: "Why the bot can't spend without your tap or past your limits, how its AI runs in a verified enclave, and what it keeps of your chats.",
    section: "Telegram"
  },
  {
    slug: "faq",
    title: "Questions and answers",
    description: "Short answers on cards and countries, modes and cashback, your money, the Draw, Telegram, and how Luckout earns.",
    section: "Help"
  },
  {
    slug: "support",
    title: "Get help",
    description: "What to do when a code doesn't work, a purchase is slow or a Top-Up hasn't landed, and how to reach us on Telegram.",
    section: "Help"
  }
]

export const docHref = (d: Doc) => (d.slug ? `/docs/${d.slug}` : "/docs")
export const docFile = (d: Doc) => d.slug || "index"
/** The page a subpage sits under, or undefined for a top-level page. */
export const parentOf = (d: Doc) => DOCS.find((p) => p.slug !== "" && d.slug.startsWith(`${p.slug}/`))
export const childrenOf = (d: Doc) => DOCS.filter((c) => parentOf(c) === d)

/** Said word for word on every page that names Bitrefill: Bitrefill's condition (2026-11-27). */
export const BITREFILL_NOTE = "Luckout sources its gift cards from Bitrefill, which isn't affiliated with Luckout."
