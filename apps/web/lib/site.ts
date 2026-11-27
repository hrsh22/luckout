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

// TODO(phase3-proof): NEAR Draws; link a Solana Draw Proof once the page reads them.
/**
 * A Draw Proof to show, linked from the landing page, Fairness and the footer. Mainnet: a Jackpot Draw on
 * app.luckout.near, $8.28 for an $11.03 card, on www.luckout.wtf (staging's contract doesn't have it).
 * Testnet: a Classic Draw, $7.20 for a $10 card, on app.luckout.testnet.
 */
export const EXAMPLE_DRAW_HREF = testnet
  ? "/draw/9ggLQCJyXjk4ThsDGMNwRmMDuFKvw79Uk6pNbFmedKdU"
  : "https://www.luckout.wtf/draw/CyiYfQGS1HXFZk7CzRDj79picMQckQjPPd71q5B7ww3p"
