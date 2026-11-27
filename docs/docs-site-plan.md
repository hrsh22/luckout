# Docs at luckout.wtf/docs

The help docs live inside the Web App at `www.luckout.wtf/docs`, not on a subdomain. Links that point at the docs then count toward the whole site, docs pages can rank for what people search before they buy ("buy gift cards with USDC", "is Luckout fair"), and the site keeps one sitemap, one Search Console property and one deploy. This needs no ADR: it is another route group in the Next.js app on Vercel (ADR-0006).

Each phase starts on an explicit go (`AGENTS.md`). Branch `docs`, cut from `origin/staging` at 8004c1b.

## Who it's for

Customers, not developers: how to sign in, add funds, buy, pick a mode, read a Draw, get money back, and use the Telegram bot. The README stays the developer and judge document.

## Pages

URLs under `/docs`, with no chain names in the slugs, so the URLs survive the move to Solana (ADR-0015). A topic with distinct parts gets subpages one level down (`/docs/add-funds/ore`); its page lists them under "In this part", and the sidebar opens them while you're in that part. Section headings show only in the sidebar.

| Section | URL | What it covers | Changes with Solana |
|---|---|---|---|
| Start | `/docs` | What Luckout is, the three steps, where to go next | |
| | `/docs/sign-in` | Wallets that work, the Welcome steps, Default Mode, Checkout Email, signing out | Yes: Privy login |
| | `/docs/add-funds` | The three ways in, the tabs per wallet, depositing from your own wallet | Yes: Deposit Address |
| | `/docs/add-funds/other-chains` | 1Click Top-Ups: tokens and chains, amounts, fees, each wallet's steps, Money on its way, refunds | Yes: Deposit Address |
| | `/docs/add-funds/ore` | ORE through one Jupiter swap, the Solana Pay code, costs | Lightly |
| Buying | `/docs/buy` | The shop, countries, a card's page, the price, what stops a purchase | |
| | `/docs/buy/cart` | Up to 15 cards, one payment, each card its own purchase and Draw | |
| | `/docs/buy/your-cards` | Where codes show, purchase statuses, Purchases, Used, expiry dates | |
| Modes and cashback | `/docs/modes` | Normal, Lite, Classic, Jackpot: up-front price, odds, slabs, Lucky Amount and Cashback Cap in plain words | |
| | `/docs/draw` | When the Draw runs, where its randomness comes from (with a mode's roll table), why nobody can retry it, Draw Proofs, sharing | Yes: ORAO randomness |
| | `/docs/fairness` | The 105.6% promise, our only revenue, Live Average, Cashback Reserve, what the contract guarantees and what you trust us for. Links to `/fair` for live figures | Lightly |
| Your money | `/docs/balance` | The Balance, Running Total, withdrawing per wallet, free actions (we pay the network fee) | Yes: no Relayer |
| | `/docs/limits` | Spending Limits, Bitrefill's per-email limits, Connect Bitrefill | |
| | `/docs/refunds` | Failed Purchases, Getting it ready, the 24-hour Reclaim, 1Click refunds and Send-Back | Yes: no Intents Account |
| Telegram | `/docs/telegram` | Linking, what the bot can do, photos of a checkout, the Buy tap, codes in your private chat | Yes: linking moves to Privy |
| | `/docs/telegram/safety` | The tap, the contract's limits, the enclave check, what the bot keeps | Lightly |
| Help | `/docs/faq` | The longer FAQ. The landing page keeps its short one, and each answer links to its page | |
| | `/docs/support` | A code that doesn't work, slow purchases and Top-Ups, the bot, Bitrefill's role, and how to reach us | |

**Wording rules for every page:**
- Use `CONTEXT.md`'s terms in plain customer language, as the landing page does ("cashback", "your balance").
- Never use the glossary's avoided words: bet, wager, gamble, lottery, winnings, prize, spin, house edge, RTP.
- **Bitrefill:** every mention says Bitrefill is only where we source the cards and isn't affiliated with Luckout (Bitrefill's condition, 2026-11-27). Use one fixed sentence, set once Dovah sends their wording summary.
- State what Luckout does. Don't add lists of what it doesn't do.
- **Numbers come from code, not typed text:**
  - modes and odds: `MODES`, `OddsGrid`
  - default Spending Limits: `DEFAULT_LIMITS`
  - Bitrefill's limits: `GUEST_LIMITS`, `BITREFILL_ACCOUNT_LIMITS`

  These live in `apps/web/lib/modes.ts`, `apps/web/components/odds-grid.tsx` and `packages/api/src/limits.ts`. MDX can import them, so a change to the code changes the docs.

## How it's built

**Content in MDX with the official `@next/mdx`**, following `node_modules/next/dist/docs/01-app/02-guides/mdx.md` for Next 16:
- New dependencies: `@next/mdx`, `@mdx-js/loader`, `@mdx-js/react`, `@types/mdx`, plus `remark-gfm` for tables and `rehype-slug` for heading anchors.
- The plugins are passed by name as strings, as Turbopack requires.
- Nothing else: no docs framework, and no typography plugin.

**Files** (all under `apps/web`):
- `content/docs/<slug>.mdx`: one file per page, prose only.
- `lib/docs.ts`: one list of `{ slug, title, description, section }`. It drives the sidebar, previous and next links, `generateStaticParams`, page metadata, the sitemap and `llms.txt`, so adding a page is one MDX file and one line here.
- `app/(marketing)/docs/[[...slug]]/page.tsx`: one route for every page.
  - It imports the MDX file by slug.
  - `dynamicParams = false` makes an unknown slug a 404.
  - It lives in `(marketing)`, so the site header and footer come for free.
- `app/(marketing)/docs/layout.tsx`: the sidebar on wide screens and a native `<details>` page menu on phones, with no client JavaScript.
- `mdx-components.tsx`: required by `@next/mdx`. It maps `h2`, `p`, `ul`, `table`, `a`, `code` and the rest to the site's existing styles (`font-display`, `text-ink-soft`, `card`). Each `h2` gets a `#` link from its `rehype-slug` id, so the app and the bot can link to a section.

**For search engines:**
- **Per page:** a unique title (the root template adds "| Luckout"), a unique description of about 150 characters, `alternates.canonical`, and `openGraph.url`. The live site sets no canonical today.
- **Sitemap:** `app/sitemap.ts` adds every page from `lib/docs.ts`.
- **Robots:** `app/robots.ts` already allows `/docs` on production and blocks staging, testnet and previews, so it needs no change.
- **Rendering:** every page is static, built at deploy, with no client JavaScript beyond what the site already loads.
- **Links in:** the site header, the footer and the landing FAQ link to the docs, and Fairness links to `/docs/fairness`, so the pages are found and crawled.
- **`app/llms.txt/route.ts`:** lists the pages with their descriptions for AI search and outside agents.

**One check:** a `node --test` file scans `content/docs/` for the avoided words, and for a Bitrefill mention without the fixed sentence. It runs with `pnpm test`, as the web app's other tests do. A missing MDX file already fails the build through `generateStaticParams`.

## Phases

**Phase 1: the frame (one PR).**
- Dependencies, `next.config.ts`, `mdx-components.tsx`, `lib/docs.ts`, the route and layout.
- The sitemap, header and footer links.
- The check.
- Three real pages: `/docs`, `/docs/modes` and `/docs/fairness`. They don't change with Solana and are worth the most for search.
- **Check:** `next build` succeeds, each page renders at 375 and 1280 px wide, `/sitemap.xml` lists them, and each page's `<head>` has its own title, description and canonical.

**Phase 2: the other ten pages (one PR, or two).**
- Write the chain-neutral pages first: `/docs/buy`, `/docs/limits`, `/docs/faq` and `/docs/support`.
- Then the ones Solana changes, kept short so the rewrite is small.
- The landing FAQ answers end in a "More" link to the matching page.

**Phase 3: links from where questions come up.**
- **In the app:**
  - the mode picker links to `/docs/modes`
  - the Checkout Email step to `/docs/limits#checkout-email`
  - Add funds to `/docs/add-funds`
  - a purchase's Reclaim line to `/docs/refunds#reclaim`
  - Connect Bitrefill to `/docs/limits#connect-bitrefill`
- **In the bot:** the Agent's prompt gets the page URLs, so it answers "how does this work" with a link instead of a long reply. This is a server change.
- **`llms.txt`.**
- **Your step:** add `https://www.luckout.wtf/sitemap.xml` in Google Search Console, and verify the domain there first if it isn't verified yet.

**At the Solana cutover:** rewrite the pages marked "Yes" above, as listed in `docs/solana-migration.md` Phase 3 (the web app). The URLs stay the same.

## Left out until needed

- **Search box:** 13 pages fit in a sidebar. Add Pagefind past about 30 pages.
- **"On this page" contents:** the pages are short. Add it when one passes about four screens.
- **Developer docs** (program methods, the Draw Proof maths, MCP for outside agents): add them after the Solana program settles, so they're written once.
- **Structured data:**
  - FAQ rich results now show only for government and health sites.
  - Breadcrumbs barely show in results.
  - Add Article data if docs pages start showing in results.
- **A docs image per page:** pages share the site's default preview for now. The Draw page's `opengraph-image.tsx` is the pattern if shared links need their own.
- **Translations (for example Hindi, for India):** add them with `hreflang` once the English pages are settled.

## Not docs, but the bigger search win

The voucher pages (`/shop/[id]`, such as "Swiggy gift card with USDC") are what buyers search for. They're allowed by robots but missing from the sitemap. That deserves its own issue.

## Decisions (2026-11-27)

1. **Build now,** not after Solana. The six chain-specific pages get a short rewrite at cutover.
2. **The Bitrefill sentence** is "Luckout sources its gift cards from Bitrefill, which isn't affiliated with Luckout." (`BITREFILL_NOTE` in `lib/docs.ts`), until Dovah's wording summary says otherwise.
3. **The nav label is "Docs",** matching the URL.

## Progress

**Phase 1 done** (2026-11-27, branch `docs`):
- **Pages:** `/docs`, `/docs/modes` and `/docs/fairness`.
- **Dependencies:** `@next/mdx`, `@mdx-js/loader`, `remark-gfm` and `rehype-slug`, plus `@types/mdx` as a dev dependency. `@mdx-js/react` isn't needed: it is only `@next/mdx`'s fallback when `mdx-components.tsx` is missing.
- **The route:** it is two files, `docs/page.tsx` and `docs/[slug]/page.tsx`, sharing `docs/doc-view.tsx`, not one optional catch-all.
- **The sidebar:** it is drawn by the page, which knows the current slug, so it needs no layout file and no client JavaScript.
- **`OddsGrid`:** it now goes side by side by its own width (a container query), not the screen's. The landing page looks as before, and in the docs' narrower column it stacks.
- **Checked:**
  - `next build` succeeds, the 75 web tests pass, and `tsc` is clean.
  - The wording test fails on a planted "bet" and on a bare Bitrefill mention.
  - Each page has its own title, description, canonical and `og:url`.
  - `/sitemap.xml` lists the pages, and `/docs/nope` and `/docs/index` are 404s.
  - Screenshots at 375 and 1280 px show no sideways page scroll. The modes table scrolls inside its card on a phone.

**Phase 2 done** (2026-11-27, branch `docs-pages`, on staging after #215):
- **Pages:** all 18 in the table above. Facts come from the code (file-by-file reads of the web app, server and contract), not from memory.
- **Subpages:** the route is now `docs/[...slug]`. A subpage's eyebrow links to its parent, the parent lists its subpages, and the sidebar opens a part while you're in it.
- **Drawn, not screenshotted** (`components/docs.tsx`, `components/docs-art.tsx`), so nothing goes stale:
  - a card's page, a Cart split into its purchases, where money moves, and a delivered code, all priced by `MODES`;
  - Classic's roll table, in the contract's row order;
  - a Telegram chat in the bot's real message formats;
  - plus steps, flows, tiles, notes and folded FAQ entries for the prose.
- **Numbers from code:** the limits page reads `DEFAULT_LIMITS`, `GUEST_LIMITS` and `BITREFILL_ACCOUNT_LIMITS`.
- **The landing FAQ:** each answer ends in a "More" link to its page. "Tap Confirm" is now "tap its Buy button", the bot's real label.
- **`/llms.txt`:** done early (from Phase 3), from the same list as the sitemap.
- **The test:** it also keeps Bitrefill out of every title and description, since a search result or `llms.txt` shows them alone, with no room for the note.
- **Checked:**
  - `next build` succeeds, the 75 web tests pass, and `tsc` is clean.
  - Every `/docs` link and `#section` anchor on the docs and landing pages resolves (`~/.luckout/test-tools/browser-staging/docs-links.mjs`).
  - No page scrolls sideways at 375 or 1280 px.

**Phase 3 done** (2026-11-28, branch `docs-links`):
- **In the app,** `components/help-link.tsx` opens the docs in a new tab, so a half-finished purchase, a Welcome step or an open sheet stays where it was:
  - the mode picker on a card's page, in Welcome and on the wallet page → `/docs/modes`
  - the Checkout Email form → `/docs/sign-in#your-email-for-cards` (the email lives on that page, not on Limits)
  - Bitrefill's limits → `/docs/limits#bitrefills-limits`; Connect Bitrefill → `/docs/limits#connect-bitrefill`
  - Spending limits on the wallet page → `/docs/limits#your-spending-limits`
  - Add funds (the sheet and Welcome) → `/docs/add-funds`
  - a late purchase's Reclaim line → `/docs/refunds#reclaim`
  - the Draw Proof page → `/docs/draw`, in the same tab, as `/fair` links `/docs/fairness`
- **In the bot:** the Agent's prompt lists eight pages and `@hrsh22`. On the real model, "how does the draw work", "how do you make money", "my code isn't working" and "lite vs jackpot" each got a short answer and the one right page; plain buy requests got none.
- **The test:** every `/docs` link in the web app, the Agent's prompt and the MDX pages must reach a listed page and an existing `#section` (a heading or a folded question). It fails on a planted `/docs/modes#nope`.

**Still open:**
- **A support email.** `/docs/support`, the FAQ and the bot give Telegram `@hrsh22` for now (2026-11-28); a support email comes later.
- **Your step:** add `https://www.luckout.wtf/sitemap.xml` in Google Search Console once the docs are on production.
