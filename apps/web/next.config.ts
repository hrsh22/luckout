import { loadEnvConfig } from "@next/env"
import type { NextConfig } from "next"

// One `.env` at the repo root for every app.
loadEnvConfig(new URL("../..", import.meta.url).pathname)

export default {
  transpilePackages: ["@luckout/api"]
} satisfies NextConfig
