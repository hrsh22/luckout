"use client"

// EVM wallets (ADR-0011) through Reown AppKit and wagmi. Loaded only when someone picks an EVM
// wallet, so NEAR wallets never download it. The wallet signs messages (sign-in and NEAR Intents)
// and, for a Top-Up, sends its own tokens on its own chain: the only gas an EVM customer pays.

import type { AppKitNetwork } from "@reown/appkit/networks"
import type { Config } from "@wagmi/core"

const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID || "bafd317da3819c2689b05a75752fe55f"

/** 1Click's chain names → EVM chain ids, for the chains a Top-Up or withdrawal can use. */
export const EVM_CHAIN_IDS: Record<string, number> = { eth: 1, arb: 42161, base: 8453, pol: 137, bsc: 56 }

type Kit = Awaited<ReturnType<typeof setUp>>
let kit: Promise<Kit> | undefined

async function setUp() {
  const [{ createAppKit }, { WagmiAdapter }, n, core] = await Promise.all([
    import("@reown/appkit"),
    import("@reown/appkit-adapter-wagmi"),
    import("@reown/appkit/networks"),
    import("@wagmi/core")
  ])
  const networks: [AppKitNetwork, ...Array<AppKitNetwork>] = [n.base, n.mainnet, n.arbitrum, n.polygon, n.bsc]
  const adapter = new WagmiAdapter({ projectId, networks })
  const modal = createAppKit({
    // AppKit's own types disagree under exactOptionalPropertyTypes (`namespace?:` vs required); the adapter is the documented one.
    adapters: [adapter as never],
    networks,
    projectId,
    metadata: { name: "Luckout", description: "Checkout, but lucky", url: window.location.origin, icons: [`${window.location.origin}/icon.svg`] },
    // Regular accounts only: NEAR Intents checks signatures by key recovery, which smart accounts and
    // email or social logins can't pass.
    defaultAccountTypes: { eip155: "eoa" },
    features: { email: false, socials: false, analytics: false, swaps: false, onramp: false, send: false, history: false, receive: false },
    themeMode: "light"
  })
  return { modal, config: adapter.wagmiConfig as Config, core }
}

const load = () => (kit ??= setUp())

/** The connected address, lowercase, after reconnecting a wallet from an earlier visit. */
export async function evmAddress() {
  const { config, core } = await load()
  await core.reconnect(config).catch(() => {})
  return core.getAccount(config).address?.toLowerCase()
}

/** Opens the wallet picker; resolves with the address once connected, or throws if it was closed first. */
export async function connectEvm(): Promise<string> {
  const { modal, config, core } = await load()
  const now = core.getAccount(config).address
  if (now) return now.toLowerCase()
  return new Promise((resolve, reject) => {
    let opened = false
    const stop = [
      core.watchAccount(config, {
        onChange: (a) => {
          if (!a.address) return
          stop.forEach((s) => s())
          void modal.close()
          resolve(a.address.toLowerCase())
        }
      }),
      modal.subscribeState((s) => {
        if (s.open) opened = true
        else if (opened && !core.getAccount(config).address) {
          stop.forEach((f) => f())
          reject(new Error("User closed the wallet picker"))
        }
      })
    ]
    void modal.open()
  })
}

/** Calls `onChange` when the wallet switches to another address (lowercase) or disconnects (undefined); not while it reconnects. */
export async function watchEvm(onChange: (address: string | undefined) => void) {
  const { config, core } = await load()
  return core.watchAccount(config, {
    onChange: (a) => {
      if (a.status === "connected") onChange(a.address.toLowerCase())
      else if (a.status === "disconnected") onChange(undefined)
    }
  })
}

/** The wallet's account, refusing if it has switched to another address than the one signed in. */
async function walletOn(expected: string) {
  const { config, core } = await load()
  const a = core.getAccount(config)
  if (a.address?.toLowerCase() !== expected) {
    throw new Error(`Your wallet is now on ${a.address ?? "no account"}, not ${expected}. Sign in again with the account you want to use.`)
  }
  return { config, core, account: a.address }
}

/** personal_sign of `message` by the signed-in address. */
export async function signText(expected: string, message: string) {
  const { config, core, account } = await walletOn(expected)
  return core.signMessage(config, { account, message })
}

/** Sends `amount` (base units) of a token, or the chain's own coin without `contract`, from the wallet; gas on the wallet. */
export async function sendFromWallet(expected: string, o: { chain: string; contract?: string | undefined; to: string; amount: string }) {
  const { config, core, account } = await walletOn(expected)
  const chainId = EVM_CHAIN_IDS[o.chain]
  if (!chainId) throw new Error(`Luckout can't send from ${o.chain} with this wallet.`)
  if (core.getAccount(config).chainId !== chainId) await core.switchChain(config, { chainId })
  const hash = o.contract
    ? await core.writeContract(config, {
      account,
      chainId,
      address: o.contract as `0x${string}`,
      abi: [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }],
      functionName: "transfer",
      args: [o.to as `0x${string}`, BigInt(o.amount)]
    })
    : await core.sendTransaction(config, { account, chainId, to: o.to as `0x${string}`, value: BigInt(o.amount) })
  const receipt = await core.waitForTransactionReceipt(config, { hash, chainId })
  if (receipt.status !== "success") throw new Error("Your wallet's transfer failed on its chain. Nothing reached Luckout.")
  return hash
}

export async function disconnectEvm() {
  if (!kit) return
  const { config, core } = await kit
  await core.disconnect(config).catch(() => {})
}
