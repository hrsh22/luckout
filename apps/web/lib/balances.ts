"use client"

import { projectId } from "@/lib/evm"
import { matchHoldings, type ReownBalance } from "@/lib/holdings"
import { solanaBalances } from "@/lib/solana"
import { solanaAddress, type TopUpAsset } from "@luckout/api"
import { useQuery } from "@tanstack/react-query"

export { GAS_COIN, type Holding, maxTopUp } from "@/lib/holdings"

/**
 * Reown's balance lookup (the one AppKit's account view uses): every chain in one call, read-only. It answers an
 * empty list unless the request says which SDK asks, as AppKit's own does (its CORS allows these headers).
 */
const fetchBalances = async (address: string): Promise<ReadonlyArray<ReownBalance>> => {
  const r = await fetch(`https://rpc.walletconnect.org/v1/account/${address}/balance?projectId=${projectId}&currency=usd`, {
    headers: { "x-sdk-type": "appkit", "x-sdk-version": "html-wagmi-1.8.24" }
  })
  if (!r.ok) throw new Error(`balances: HTTP ${r.status}`)
  return ((await r.json()) as { balances?: ReadonlyArray<ReownBalance> }).balances ?? []
}

/**
 * The connected EVM or Solana wallet's holdings of the tokens we take (see matchHoldings); nothing until (or unless)
 * read. Reown's lookup has nothing for Solana, so a Solana wallet's are read from Solana itself.
 */
export const useWalletHoldings = (accountId: string | undefined, wallet: "evm" | "solana", assets: ReadonlyArray<TopUpAsset> | undefined) => {
  // Solana is asked about each token we take by its mint, so it needs the tokens first.
  const mints = assets?.flatMap((a) => (a.chain === "sol" && a.contract ? [a.contract] : [])) ?? []
  const q = useQuery({
    queryKey: ["wallet-balances", accountId, wallet, mints],
    queryFn: () => (wallet === "solana" ? solanaBalances(solanaAddress(accountId!), mints) : fetchBalances(accountId!)),
    enabled: !!accountId && (wallet !== "solana" || !!assets),
    staleTime: 30_000,
    retry: 1
  })
  return assets && q.data ? matchHoldings(assets, q.data) : { holdings: undefined, gas: undefined }
}
