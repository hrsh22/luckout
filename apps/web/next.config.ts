import { loadEnvConfig } from "@next/env"
import type { NextConfig } from "next"

// One `.env` at the repo root for every app.
loadEnvConfig(new URL("../..", import.meta.url).pathname)

// A production build must point at the real API, not fall back to localhost.
if (process.env.VERCEL_ENV === "production" && !process.env.NEXT_PUBLIC_API_URL) {
  throw new Error("NEXT_PUBLIC_API_URL must be set for production builds")
}

// A build for one network must never point at the other's accounts or API (testnet and mainnet
// are separate deployments: docs in deploy/README.md).
const network = process.env.NEXT_PUBLIC_NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet"
// Mainnet USDC is the 64-hex bridged token, and the mainnet API lives at luckout-api.gamified.trade.
const mixed = ["NEXT_PUBLIC_LUCKOUT_CONTRACT_ID", "NEXT_PUBLIC_USDC_CONTRACT_ID"].filter((k) => {
  const v = process.env[k] ?? ""
  return network === "mainnet" ? v.endsWith(".testnet") || v === "" : v.endsWith(".near") || /^[0-9a-f]{64}$/.test(v)
})
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? ""
if (network === "mainnet" ? apiUrl.includes("testnet") : URL.parse(apiUrl)?.hostname === "luckout-api.gamified.trade") mixed.push("NEXT_PUBLIC_API_URL")
if (mixed.length > 0) throw new Error(`NEXT_PUBLIC_NEAR_NETWORK=${network}, but these point elsewhere: ${mixed.join(", ")}`)

// ponytail: no script-src. NEAR Connect runs each wallet's code, fetched from that wallet's own
// origin, in iframes that inherit this policy; lock scripts down once wallets can live with it.
const csp = ["frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'", "form-action 'self'"].join("; ")

export default {
  transpilePackages: ["@luckout/api"],
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: csp },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" }
      ]
    }]
  }
} satisfies NextConfig
