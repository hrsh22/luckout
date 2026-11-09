import { loadEnvConfig } from "@next/env"
import type { NextConfig } from "next"

// One `.env` at the repo root for every app.
loadEnvConfig(new URL("../..", import.meta.url).pathname)

// A production build must point at the real API, not fall back to localhost.
if (process.env.VERCEL_ENV === "production" && !process.env.NEXT_PUBLIC_API_URL) {
  throw new Error("NEXT_PUBLIC_API_URL must be set for production builds")
}

// ponytail: no script-src. NEAR Connect runs each wallet's code, fetched from that wallet's own
// origin, in iframes that inherit this policy; lock scripts down once wallets can live with it.
const csp = ["frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'", "form-action 'self'"].join("; ")

export default {
  transpilePackages: ["@luckout/api"],
  images: { remotePatterns: [{ protocol: "https", hostname: "www.bitrefill.com" }] },
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
