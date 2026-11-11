---
status: accepted
---

# Let EVM wallets use their NEAR Intents account

A customer who has only an EVM wallet (MetaMask, Rabby and the like) can't use Luckout today. Sign-in is a NEP-413 message from a full-access NEAR key, and NEAR Connect's Ethereum-wallets option can sign neither messages nor delegate actions (its manifest lists `signMessage` and `signDelegateActions` as false), so it fails at sign-in. ADR-0008's note that these customers "still pay their own fees" is wrong: they can't get in at all. NEAR's own Ethereum-wallet accounts (NEP-518) wouldn't help either, since their owners pay gas in NEAR.

We follow near.com, which signs in EVM wallets and keeps everything after the deposit gas-free. We checked its live code and the open-source near-intents.org frontend it shares. There, the customer's account is their account on `intents.near`, named after their EVM address. They deposit by sending tokens to a bridge address from their own wallet, paying that chain's gas. Everything after that is an intent they sign as a plain message (ERC-191), which a relay sends and pays for.

**Identity.** An EVM customer is their address in lowercase, `0x…`. That is also the name of their Intents Account and a valid NEAR account id, so purchases, Draws, Draw Proofs, Spending Limits, the Agent and Telegram linking treat them like any other customer. Sign-in is a plain `personal_sign` of the server's one-time challenge, which the server checks by key recovery.

**Top-Up.** 1Click swaps into an exact amount of USDC delivered to the customer's Intents Account. The customer sends from their wallet and pays the origin chain's gas. That is the only fee they ever pay, as on near.com. In the same step they sign an intent that moves exactly that USDC into Luckout: an `FtWithdraw` to our contract with the message `{"for":"0x…"}`. The server sends it when 1Click reports the swap done. If anything stalls, the USDC waits in the customer's own Intents Account, where near.com or any NEAR Intents app can use it without us.

**Settings, withdrawals, Reclaims and Draw reruns.** NEAR Intents' `AuthCall` intent makes `intents.near` check the customer's signature itself and then call our contract's `on_auth(signer_id, msg)`. The contract accepts that call only from `intents.near` and only for `0x…` customers, so customers who sign in with a NEAR wallet keep their own-key path and depend on NEAR Intents for nothing new. Our relayer sends these intents and pays the NEAR gas, within the same daily caps as other relays (ADR-0008).

**Withdrawals.** The contract sends a withdrawal only to the signer's own Intents Account, as an `ft_transfer_call` to `intents.near` with the account as its message, and never to an address the server picks. Getting the money to an EVM chain is a second intent the customer signs, moving it to a 1Click deposit address; 1Click pays the gas on the destination chain. They can also leave it in their Intents Account and use it on near.com.

**Buying** doesn't change: the server submits purchases (ADR-0001).

**What it costs in trust.** EVM customers trust NEAR Intents to say who signed. `intents.near` can be upgraded by its operators, but every Top-Up and withdrawal already passes through it, so this adds little. A compromised server gains nothing new. It can't sign intents and can't redirect a withdrawal. As today, it could show a fake 1Click deposit address for a Top-Up, and now also for an exit. The relayer pays only for a short list of exact intents, each with no attached deposit and signed by the signed-in account. Before paying, it checks the signature, the deadline and that the nonce is unused. The contract's Intents account id is fixed in the code for each network (`intents.near`, or `intents.luckout.testnet`), with no setter, so nothing short of a contract upgrade can block EVM customers' withdrawals, and the owner can already upgrade (README, Upgrades). Only regular EVM accounts can sign in, including ones upgraded with EIP-7702. NEAR Intents checks these signatures by key recovery, so smart-contract wallets such as Safe or Coinbase Smart Wallet can't sign.

**Testnet.** NEAR Intents and 1Click run only on mainnet (ADR-0009, ADR-0010). Testnet gets our own copy of the intents contract at `intents.luckout.testnet`: the exact wasm mainnet runs (code hash `BtA1BEFN…`, version 0.4.5), with no fee. On testnet the relayer gets test USDC from the faucet and deposits it into the customer's testnet Intents Account, as 1Click would on mainnet. The 1Click legs are tested on mainnet with small amounts.

**Checked before building (2026-11-11).** On mainnet, with a test EVM wallet: 1Click delivered exactly $2.00 USDC from Base into its Intents Account about 20 seconds after the Base transfer, and $1.00 from that account back to Base in about 45 seconds, with no gas paid by the wallet. A move-in our then-current contract refused ("Unknown deposit message") came back to the signer's Intents Account. On testnet, `AuthCall` set the Default Mode and limits and withdrew to the Intents Account, burning about 17 Tgas.

## Considered options

- **Our own relayer on every EVM chain, so deposits cost no gas either.** It would pay origin gas through EIP-3009's signed transfers, which USDC supports on Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, Gnosis, Monad and X Layer, and USDT0 on six chains. Rejected: it needs a gas wallet on every chain to watch and refill, we'd absorb Ethereum mainnet gas, and other tokens would still cost gas. near.com doesn't do it either. Revisit for Base alone if customers get stuck without gas. Until then, someone holding funds on an exchange can withdraw straight to the deposit address and let the exchange pay.
- **A NEAR account per customer whose key the server holds.** Rejected: custodial, and it breaks the promise that a compromised server can spend at most a customer's Spending Limits.
- **Checking EIP-712 signatures in our contract.** Rejected: we'd write and audit signature and nonce code ourselves, and the money passes through NEAR Intents anyway.
- **NEP-518 Ethereum-wallet accounts.** Rejected: customers pay gas in NEAR and switch MetaMask to a NEAR network, and NEAR Connect's option for them can't sign in.
- **1Click's `customRecipientMsg`, to deposit straight into the contract with one signature.** Rejected for now: 1Click marks it highly experimental, funds are lost if the call fails, and the server would choose the message.

## Consequences

- The contract gains `on_auth`, the `{"for":"0x…"}` deposit message, and withdrawals to an Intents Account that put back any amount the transfer returns. Its stored state doesn't change, so it upgrades in place with no migration, and every balance stays where it is.
- It amends ADR-0001 (for EVM customers, a Top-Up lands in the Intents Account, and their EVM key, through NEAR Intents, signs withdrawals and settings) and ADR-0008 (the relayer also sends `execute_intents`, and its Ethereum-wallet note is replaced).
- The relayer's daily caps cover EVM customers' intents too, except a Top-Up's own move-in. An EVM customer has no wallet to fall back on when the cap is reached, so the caps must stay well above what one customer needs in a day.
- ADR-0003 is untouched: we pay no EVM gas, and NEAR gas stays the relayer's, as today.
