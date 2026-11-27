import type { ProgramInfo } from "@luckout/api"
import { api } from "./api.ts"

// The program's public state comes from our server (GET /program), which reads it from Solana and keeps it about 30
// seconds, so every visitor shares one read and no RPC key reaches the browser (ADR-0015).

/** The Solana cluster this build talks to: the server's SOLANA_CLUSTER. Only mainnet sells real cards. */
export const cluster: ProgramInfo["cluster"] = process.env.NEXT_PUBLIC_SOLANA_CLUSTER === "mainnet"
  ? "mainnet"
  : process.env.NEXT_PUBLIC_SOLANA_CLUSTER === "localnet"
  ? "localnet"
  : "devnet"

/** Solana Explorer takes every cluster, a local validator too (Solscan doesn't). */
const explorerCluster = cluster === "mainnet"
  ? ""
  : cluster === "devnet"
  ? "?cluster=devnet"
  : `?cluster=custom&customUrl=${encodeURIComponent("http://localhost:8899")}`
export const explorer = (signature: string) => `https://explorer.solana.com/tx/${signature}${explorerCluster}`
export const explorerAccount = (address: string) => `https://explorer.solana.com/address/${address}${explorerCluster}`

/** The program's Game Versions, reserve, Cashback Cap, smallest Lucky Checkout and Live Average figures. Needs no sign-in. */
export const programInfo = (timeout: "10 seconds" | "30 seconds" = "30 seconds") => api((c) => c.program(), undefined, timeout)

export type Stats = ProgramInfo["stats"]

/** Live Average: what lucky buyers paid per 100 of price, across every settled Lucky Buy. */
export const liveAverage = (s: Stats) => (s.luckyAmountTotal > 0 ? (s.luckyPaidTotal / s.luckyAmountTotal) * 100 : undefined)
