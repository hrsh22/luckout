"use client"

import { Select } from "@base-ui/react/select"
import type { TopUpAsset } from "@luckout/api"
import { Check, ChevronDown } from "lucide-react"

// Icons are self-hosted SVGs in /public/crypto, from @web3icons/core (MIT): one per token, and a small
// badge per chain. wNEAR shares NEAR's.
const TOKENS = new Set(["usdc", "usdt", "eth", "btc", "sol", "near"])
const CHAINS = new Set(["base", "eth", "arb", "pol", "bsc", "sol", "btc", "near"])
/** The chains Top-Ups come from, as the page names them. */
const CHAIN_NAMES: Record<string, string> = {
  eth: "Ethereum", arb: "Arbitrum", base: "Base", pol: "Polygon", bsc: "BNB Chain", sol: "Solana", btc: "Bitcoin", near: "NEAR", tron: "Tron"
}

export const chainLabel = (chain: string) => CHAIN_NAMES[chain] ?? chain
const tokenIcon = (symbol: string) => {
  const k = symbol.toLowerCase().replace(/^wnear$/, "near")
  return TOKENS.has(k) ? `/crypto/${k}.svg` : undefined
}

/** Stablecoins first; then each token from the chains cheapest to send from. */
const SYMBOLS = ["USDC", "USDT", "ETH", "BTC", "SOL", "wNEAR"]
const CHAIN_ORDER = ["base", "arb", "pol", "bsc", "tron", "sol", "eth", "btc", "near"]
const rank = (order: ReadonlyArray<string>, v: string) => (order.includes(v) ? order.indexOf(v) : order.length)
export const sortAssets = (assets: ReadonlyArray<TopUpAsset>) =>
  [...assets].sort((a, b) => rank(SYMBOLS, a.symbol) - rank(SYMBOLS, b.symbol) || rank(CHAIN_ORDER, a.chain) - rank(CHAIN_ORDER, b.chain))

/** The token's logo with its chain as a small badge, so "USDC on Base" reads at a glance. */
export function TokenMark({ symbol, chain, size = 32 }: { symbol: string; chain: string; size?: number }) {
  const icon = tokenIcon(symbol)
  const badge = CHAINS.has(chain) ? `/crypto/chain-${chain}.svg` : undefined
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }} aria-hidden="true">
      {icon
        ? <img src={icon} alt="" width={size} height={size} className="rounded-full" />
        : <span className="grid size-full place-items-center rounded-full bg-soft text-xs font-bold">{symbol.slice(0, 3)}</span>}
      {badge && icon !== `/crypto/${chain}.svg` && (
        <img src={badge} alt="" width={size / 2} height={size / 2} className="absolute -right-1 -bottom-1 rounded-full bg-white ring-2 ring-white" />
      )}
    </span>
  )
}

function Option({ a }: { a: TopUpAsset }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3">
      <TokenMark symbol={a.symbol} chain={a.chain} />
      <span className="flex min-w-0 flex-col text-left leading-tight">
        <span className="font-semibold">{a.symbol}</span>
        <span className="text-sm text-muted">{chainLabel(a.chain)}</span>
      </span>
    </span>
  )
}

/** Choose a token to pay with: logos and chain badges instead of a long text list. */
export function TokenPicker({ assets, value, onChange, label = "Pay with" }: {
  assets: ReadonlyArray<TopUpAsset>
  value: string
  onChange: (assetId: string) => void
  label?: string
}) {
  const selected = assets.find((a) => a.assetId === value)
  return (
    <Select.Root value={value} onValueChange={(v) => typeof v === "string" && onChange(v)}>
      <Select.Trigger className="field flex !h-14 items-center gap-3 !rounded-[1.25rem]" aria-label={label}>
        <Select.Value className="flex min-w-0 flex-1">
          {() => (selected ? <Option a={selected} /> : <span className="text-muted">Choose a token</span>)}
        </Select.Value>
        <Select.Icon className="ml-auto text-muted"><ChevronDown size={18} /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={6} alignItemWithTrigger={false} className="z-[60]">
          <Select.Popup className="max-h-[min(22rem,var(--available-height))] w-[var(--anchor-width)] overflow-y-auto rounded-2xl bg-white p-1.5 shadow-pop outline-none">
            {assets.map((a) => (
              <Select.Item
                key={a.assetId}
                value={a.assetId}
                label={`${a.symbol} ${chainLabel(a.chain)}`}
                className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 outline-none select-none data-[highlighted]:bg-soft"
              >
                <Option a={a} />
                <Select.ItemIndicator className="text-ink"><Check size={16} strokeWidth={3} /></Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}
