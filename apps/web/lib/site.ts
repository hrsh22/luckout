import { cluster } from "./chain.ts"

/**
 * Our public URL: shared Draw Proof links and Win Cards point here, not at *.vercel.app. Each Vercel
 * environment sets it (www.luckout.wtf for mainnet, testnet.luckout.wtf for testnet).
 */
export const siteUrl = process.env.NEXT_PUBLIC_SITE_URL
  ? process.env.NEXT_PUBLIC_SITE_URL
  : process.env.VERCEL_ENV === "production"
  ? "https://www.luckout.wtf"
  : process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "http://localhost:3000"

/** Off mainnet only Bitrefill's test cards are sold. */
export const testnet = cluster !== "mainnet"

/**
 * A Draw Proof to show, linked from the landing page, Fairness and the footer, where this build's program has one.
 * Devnet: card 10 of the 15-card Classic Checkout finished on 2026-11-27, 30% back on a $6 card, on the program the
 * IDL names (4Tziwbh1…). Mainnet has no Draw yet, so the links stay hidden until its first; then put it here.
 */
export const EXAMPLE_DRAW_HREF: string | undefined = cluster === "devnet"
  ? "/draw/2dgQpYiNzc8m7fVacnDacQuJa3SbKD8pzd4QthkuRxCmWzajgxNKrHn1coK1jkhSmpj77YT3mZqSvjgBfWPr4jaW?card=9"
  : undefined
