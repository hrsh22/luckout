import type { Mode } from "@luckout/api"

// Per-account browser notes: whether welcome was finished or skipped, and a mode chosen before
// the first deposit (the contract can only save it once the account exists).

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
