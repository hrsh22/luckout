import { network } from "./chain"

/** Our public URL: shared Draw Proof links and Win Cards point here, not at *.vercel.app. */
export const siteUrl = process.env.VERCEL_ENV === "production"
  ? "https://luckout.gamified.trade"
  : process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "http://localhost:3000"

export const testnet = network === "testnet"

/** A Classic Draw from testnet: 40% back, so $7.20 for a $10 card ($4.80 of $12 back), linked from the landing page. */
export const EXAMPLE_DRAW = "9ggLQCJyXjk4ThsDGMNwRmMDuFKvw79Uk6pNbFmedKdU"
