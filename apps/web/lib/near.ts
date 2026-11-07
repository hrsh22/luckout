import { NearConnector } from "@hot-labs/near-connect"

let connector: NearConnector | undefined

/** Browser-only NEAR Connect singleton (HOT Wallet works inside Telegram too). */
export const near = () =>
  (connector ??= new NearConnector({
    network: process.env.NEXT_PUBLIC_NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet"
  }))
