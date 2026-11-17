export { cn } from "cn"

// ponytail: one flag for the whole tab, in memory. A wallet shows one request at a time anyway; make it
// per-wallet if the app ever drives two wallets at once.
let walletBusy = false

/**
 * Runs one wallet request at a time. While one is open, another tap answers false at once and asks the wallet
 * nothing: a double click on Deposit, Withdraw or an owner action would otherwise open two requests, and
 * approving both moves the money twice.
 */
export const oneAtATime = async (f: () => Promise<boolean>): Promise<boolean> => {
  if (walletBusy) return false
  walletBusy = true
  try {
    return await f()
  } finally {
    walletBusy = false
  }
}
