import { network } from "./chain"

/** Our public URL: shared Draw Proof links and Win Cards point here, not at *.vercel.app. */
export const siteUrl = process.env.VERCEL_ENV === "production"
  ? "https://luckout.gamified.trade"
  : process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "http://localhost:3000"

export const testnet = network === "testnet"

/** A Draw from testnet that paid $0 for a $10 card, linked from the landing page. */
export const EXAMPLE_DRAW = "D4UXKYAtVx9E4TeFptBNdYtJipu4VhD6UJKf7AMPJwS3"
