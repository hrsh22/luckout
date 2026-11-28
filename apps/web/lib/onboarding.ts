import type { Mode } from "@luckout/api"

// Per-account browser notes: whether welcome was finished or skipped, a mode chosen before the one-time approval
// (the program can only save it once the account exists), and the refund address last given for each chain.

const key = (kind: string, accountId: string) => `luckout.${kind}.${accountId}`

const read = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const write = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k)
    else localStorage.setItem(k, v)
  } catch {}
}

export const welcomed = (accountId: string) => read(key("welcomed", accountId)) === "1"
export const markWelcomed = (accountId: string) => write(key("welcomed", accountId), "1")

export const pendingMode = (accountId: string): Mode | undefined => {
  try {
    return JSON.parse(read(key("mode", accountId)) ?? "null") ?? undefined
  } catch {
    return undefined
  }
}
export const setPendingMode = (accountId: string, mode: Mode | undefined) =>
  write(key("mode", accountId), mode === undefined ? null : JSON.stringify(mode))

/** The refund address this customer last gave for 1Click Top-Ups from `chain`, so they needn't type it again. */
export const refundAddress = (accountId: string, chain: string) => read(key(`refund.${chain}`, accountId)) ?? ""
export const setRefundAddress = (accountId: string, chain: string, address: string) => write(key(`refund.${chain}`, accountId), address)
