"use client"

import { projectId } from "@/lib/evm"
import { matchHoldings, type ReownBalance } from "@/lib/holdings"
import type { TopUpAsset } from "@luckout/api"
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

/** The connected EVM wallet's holdings of the tokens we take (see matchHoldings); nothing until (or unless) read. */
export const useWalletHoldings = (address: string | undefined, assets: ReadonlyArray<TopUpAsset> | undefined) => {
  const q = useQuery({
    queryKey: ["wallet-balances", address],
    queryFn: () => fetchBalances(address!),
    enabled: !!address,
    staleTime: 30_000,
    retry: 1
  })
  return assets && q.data ? matchHoldings(assets, q.data) : { holdings: undefined, gas: undefined }
}
