import { loadEnvConfig } from "@next/env"
import type { NextConfig } from "next"

// One `.env` at the repo root for every app.
loadEnvConfig(new URL("../..", import.meta.url).pathname)

// A production build must point at the real API, not fall back to localhost.
if (process.env.VERCEL_ENV === "production" && !process.env.NEXT_PUBLIC_API_URL) {
  throw new Error("NEXT_PUBLIC_API_URL must be set for production builds")
}

// A build for one cluster must never point at another's API: off mainnet, never production's (api.luckout.wtf).
// Staging and production are both on mainnet, each with its own program, API and Privy app (ADR-0015).
const cluster = process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "devnet"
if (!["localnet", "devnet", "mainnet"].includes(cluster)) throw new Error(`NEXT_PUBLIC_SOLANA_CLUSTER=${cluster} is none of localnet, devnet, mainnet`)
if (cluster !== "mainnet" && URL.parse(process.env.NEXT_PUBLIC_API_URL ?? "")?.hostname === "api.luckout.wtf") {
  throw new Error(`NEXT_PUBLIC_SOLANA_CLUSTER=${cluster}, but NEXT_PUBLIC_API_URL is production's`)
}
// Sign-in falls back to the staging Privy app locally; production must name its own.
if (process.env.VERCEL_ENV === "production" && !process.env.NEXT_PUBLIC_PRIVY_APP_ID) {
  throw new Error("NEXT_PUBLIC_PRIVY_APP_ID must be set for production builds")
}

// ponytail: no script-src. Privy's window loads its own scripts and iframes (auth.privy.io) and wallets' connectors;
// lock scripts down once those can live with it.
const csp = ["frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'", "form-action 'self'"].join("; ")

export default {
  transpilePackages: ["@luckout/api"],
  // No "X-Powered-By: Next.js": it tells a stranger which framework advisories to try.
  poweredByHeader: false,
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
