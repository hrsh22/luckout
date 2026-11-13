import { network } from "./chain"

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

export const testnet = network === "testnet"

/** The free testnet demo, linked from the mainnet site. */
export const TESTNET_SITE = "https://testnet.luckout.wtf"

/** A Classic Draw from testnet: 40% back, so $7.20 for a $10 card ($4.80 of $12 back), linked from the landing page. */
export const EXAMPLE_DRAW = "9ggLQCJyXjk4ThsDGMNwRmMDuFKvw79Uk6pNbFmedKdU"
/** Its Draw Proof page. The transaction is on testnet, so the mainnet site links to the testnet site's page. */
export const EXAMPLE_DRAW_HREF = testnet ? `/draw/${EXAMPLE_DRAW}` : `${TESTNET_SITE}/draw/${EXAMPLE_DRAW}`
