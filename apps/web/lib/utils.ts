import { toast } from "sonner"

export { cn } from "cn"

// ponytail: one flag for the whole tab, in memory. A wallet shows one request at a time anyway; make it
// per-wallet if the app ever drives two wallets at once.
let walletBusy = false

/**
 * Runs one wallet request at a time. While one is open, another tap answers false at once and asks the wallet
 * nothing: a double click on Deposit, Withdraw or an owner action would otherwise open two requests, and
 * approving both moves the money twice. A `tapped` request says why, since a request left open in a wallet (a phone
 * wallet never answering) would otherwise make every button seem dead; one the app starts by itself stays quiet.
 */
export const oneAtATime = async (f: () => Promise<boolean>, tapped = true): Promise<boolean> => {
  if (walletBusy) {
    // One toast however often they tap.
    if (tapped) toast("You have a request open in your wallet", { id: "wallet-busy", description: "Approve or close it there first, then try again." })
    return false
  }
  walletBusy = true
  try {
    return await f()
  } finally {
    walletBusy = false
  }
}
