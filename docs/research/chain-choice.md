# Which chain Luckout should move to from NEAR

Researched 2026-11-26 against Bitrefill's live MCP server (guest login, read-only `tools/list` and `get-product-details`; no invoice created), docs.bitrefill.com, Circle's docs, the Chainlink, Pyth, ORAO, MagicBlock and Switchboard docs and repos, on-chain reads on Base, Arbitrum, Polygon and Solana mainnet (gas prices, Pyth Entropy `getFeeV2()`, ORAO's config account, Solana rent), the 1Click API (token list and two `dry: true` quotes), the Transak, Binance, Relay, deBridge and Across public APIs, the Privy, Reown, Dynamic, Phantom and Coinbase (CDP) docs, onramp, exchange and grant pages, and Telegram's bot terms. Nothing was signed, paid or created, and no personal data was sent anywhere. Token prices for dollar figures are CoinGecko's at about 12:40 UTC (a secondary source): ETH $1,704, SOL $70.88, POL $0.0765, TON $0.96, NEAR $3.10.

## Answer in one paragraph

Bitrefill takes USDC from Luckout's payer on **Solana, Base, Polygon PoS, Arbitrum**, Ethereum and BSC, and USDT on all of those except Base plus Tron and TON. It takes **nothing on NEAR**. So moving the contract to any of the first four lets it pay Bitrefill on its own chain, and the Refills, Treasury, Base Float, Chain Signatures and Intents Accounts can all go. TON can't do the same job: there is no Circle USDC on TON, Bitrefill takes only USDT there, and TON's docs name no verifiable-randomness provider. Among the four, **I recommend Solana**, with Base, then Polygon, behind it. Four reasons decide it. Indian customers hold USDT, and on Solana both USDC and USDT are payable to Bitrefill and withdrawable from Binance. On Base only USDC is. Solana's fee-payer field makes deposits, withdrawals and settings gas-free with no extra contract code. The contract stays in Rust (Anchor 1.2). And there is an open India-only grant: Solana Foundation × CoinDCX, up to $15k. Solana costs more for the Draw: about 0.0005 SOL (≈$0.035) per randomness request on ORAO or MagicBlock, against well under a cent for Chainlink VRF on Base, and the Solana providers are younger. Solana also charges refundable rent for every account, and a program-owned deposit address trips the default off-curve check in Solana's token library. If Chainlink-grade randomness at under a cent, or permanent per-customer deposit addresses, matter more than USDT and the grant, choose Base. It's the same Solidity whether it ends up on Base or Polygon.

---

## Comparison

Each cell is backed in the section for its criterion below. "≈$" figures use the prices above.

| | NEAR (today) | Solana | Base | Polygon PoS | Arbitrum | TON |
|---|---|---|---|---|---|---|
| **1. Bitrefill guest invoice** | None (USDC/USDT on NEAR refused) | USDC + USDT; x402 documented | USDC only; x402 documented | USDC + USDT; x402 documented | USDC + USDT; x402 documented | USDT (and TON coin) only; no x402 |
| **2. Native USDC / CCTP** | Native / no | Native / yes | Native / yes (fast) | Native / yes | Native / yes (fast) | None / no |
| **3. Randomness for the Draw** | Block seed only (block producer can predict it) | ORAO 0.0005 SOL ≈$0.035; MagicBlock 0.0005–0.0008 SOL; Switchboard (caller reveals) | Chainlink VRF ≈$0.005 + L1 fee (est.); Pyth Entropy ≈$0.026 | Chainlink VRF ≈$0.01 (est.); no Pyth | Chainlink ≈$0.014 (est.); Pyth ≈$0.51 | No provider in docs; built-ins validator-predictable |
| **4. Gas-free customers, server buys within limits** | Done (NEP-366 relayer, function-call key) | Native fee payer; Kora; program vault | Own relayer + EIP-3009/712; CDP Paymaster (+7%); spend permissions not live in Coinbase Wallet | Own relayer + EIP-3009/712; third-party paymasters | Same as Polygon | Relayer + wallets that accept signed internal messages |
| **5. Social login** | Privy tier 2 (sign only) | Privy tier 3, Dynamic (gasless), Reown, Phantom | All of them + Coinbase smart accounts | Privy, Dynamic, Reown, Phantom | Privy, Dynamic, Reown | Privy tier 1 (keys only), Dynamic (no gasless) |
| **6. INR/UPI onramps** | Onramp.money | Onmeta, Onramp.money | Onmeta, Onramp.money | Onmeta, Onramp.money | Onmeta, Onramp.money | Onmeta, Onramp.money |
| **7. Exchange withdrawals (Binance; others unverified)** | USDC + USDT | USDC 0.3 + USDT 0.7 | USDC 0.2 only | USDC 0.12 + USDT 0.03 | USDC 0.5 + USDT 0.3 | USDT 0.3 only |
| **8. Deposits from other chains** | 1Click home chain; no CCTP, Relay, deBridge | 1Click, CCTP, Relay, deBridge; off-curve owner caveat | 1Click, CCTP, Relay, deBridge, Across | Same as Base | Same as Base | 1Click (USDT), Relay |
| **9. Porting the contract** | None | Anchor (Rust); maths and test vectors carry over | Solidity rewrite; most mature tooling | Same Solidity as Base | Same Solidity as Base | Tolk, async messages, jettons: largest rewrite |
| **10. Grants for an India team** | (current home) | SF × CoinDCX India grant open, ≤$15k | Builder Grant ≤$5k (selective); Batches $100k investment | Current round not confirmed | Foundation grants, mostly milestone-based | Foundation grants; only chain allowed in Mini Apps |
| **11. Fees, finality, reliability** | ≈$0.0016 per relay | 5,000 lamports/signature; refundable rent; Alpenglow live | 0.006 gwei; sequencer halts Aug 2025, Jun 2026 | ≈$0.001/tx; 2–5 s finality; Sep 2025 finality bug | 0.02 gwei | ~400 ms blocks, ~1 s finality |

---

## 1. Bitrefill: which chains a guest invoice can be paid on

**Live answer.** Logged in as a guest (our staging OAuth client), `tools/list` gives `buy-products`'s `payment_method` enum, and `get-product-details` gives what each product accepts. For two Indian products (`swiggy-money-india`, `amazon-fresh-india`) the `address_based` list is identical:

```
ethereum, eth_base, usdc_base, usdt_erc20, usdt_trc20, usdc_erc20, usdc_polygon, usdt_polygon,
usdc_arbitrum, usdt_arbitrum, usdc_solana, usdt_solana, solana, eth_arbitrum, usdc_bsc, usdt_bsc,
lightning, ark, bitcoin, dogecoin, dash, litecoin, ton, usdt_ton
```

- **USDC:** Base, Ethereum, Polygon, Arbitrum, Solana, BSC. **USDT:** Ethereum, Tron, Polygon, Arbitrum, Solana, BSC, TON. There is no `usdt_base` anywhere, and nothing on NEAR. The enum has no NEAR method at all; on 2026-11-07, `usdc_near` and `usdt_near` were refused with `unsupported_payment_method` ([bitrefill-funding.md](bitrefill-funding.md)).
- The enum also lists `sui`, `usdc_sui`, `usdt_sui`, `usdc_tempo` and `usdt_tempo`, but neither Indian product accepts them. Sui is therefore not a candidate, despite zkLogin.
- **x402.** The partner guide says `buy-products` returns an `x402_payment_url` for crypto invoices. It works when *"the invoice was created with a USDC method (`usdc_base`, `usdc_arbitrum`, `usdc_polygon` or `usdc_solana`) and is younger than 15 minutes"* ([MCP partner integration guide](https://docs.bitrefill.com/docs/mcp-partner-integration-guide.md), "Paying an MCP invoice with x402"). Our guest invoices came back without that field on 2026-11-15 and again on 2026-11-24. A plain transfer to `payment_info.address` works on every chain above, so x402 isn't needed for any choice.

## 2. USDC: native issuance and CCTP

- Circle lists native USDC on **Arbitrum, Base, NEAR, Polygon PoS and Solana**, among others. **TON is not listed** ([USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)).
- CCTP V2 lists **Arbitrum, Base, Polygon PoS and Solana** as sources and destinations. Fast Transfer is offered from Arbitrum, Base and Solana ("N/A" for Polygon, whose standard attestation is already fast). **NEAR and TON are not CCTP domains** ([CCTP supported blockchains](https://developers.circle.com/cctp/cctp-supported-blockchains)).

## 3. Verifiable randomness for the Draw

The Draw today runs in a callback receipt with NEAR's block seed, scheduled by `confirm_delivery`. The confirmation can't be undone once a result exists (ADR-0001, amended 2026-11-09). On every candidate chain, the same property comes from one rule. **The instruction that confirms delivery also requests the randomness, and the result arrives in a later transaction.** Nobody can then see the result before "delivered" is committed. The provider may compute the result a moment before posting it, but it can't change it.

### Providers

| Chain | Provider | Model | Cost per request today | Notes |
|---|---|---|---|---|
| Base, Arbitrum, Polygon | **Chainlink VRF v2.5** | Request, then callback `fulfillRandomWords` | Formula: gas price × (callback + coordinator overhead) × (1 + premium). With measured gas (Base 0.006 gwei, Arbitrum 0.0201 gwei, Polygon 280 gwei) and an assumed 150k-gas callback: **Base ≈$0.005, Arbitrum ≈$0.014, Polygon ≈$0.01**. Excludes the L1 data fee on Base and Arbitrum. | Premium 60% (ETH) / 50% (LINK) on Base and Arbitrum, 84% / 70% on Polygon. Minimum confirmations 0 on Base, 1 on Arbitrum, 3 on Polygon ([supported networks](https://docs.chain.link/vrf/v2-5/supported-networks), [billing](https://docs.chain.link/vrf/v2-5/billing)). Not on Solana, TON or NEAR. |
| Base, Arbitrum | **Pyth Entropy v2** | Commit-reveal with the provider's hash chain; a keeper calls `entropyCallback` | On-chain `getFeeV2()` today: **Base 1.5e13 wei ≈$0.026; Arbitrum 2.999e14 wei ≈$0.51** | Contracts `0x6E7D…81Bb` (Base) and `0x7698…AdAc` (Arbitrum), from Pyth's [contract registry](https://github.com/pyth-network/pyth-crosschain/blob/main/contract_manager/src/store/contracts/EvmEntropyContracts.json). Polygon PoS is not in the registry. *"neither the user nor the provider can predict or manipulate the random outcome"* ([Entropy docs](https://docs.pyth.network/llms-entropy.txt)). |
| Solana | **ORAO VRF** | Classic: the oracle writes to a PDA derived from your 32-byte seed. Callback: the oracle *"invokes a callback instruction of your program … in the fulfillment transaction itself"* | Config account `5ER1oENn…` holds `request_fee` = **500,000 lamports (0.0005 SOL ≈$0.035)**, plus the randomness account's rent | *"The fulfillment authorities sign the seed with Ed25519, the program verifies the signatures"*. The current SDK targets Anchor 1.2 ([solana-vrf README](https://github.com/orao-network/solana-vrf), [GETTING_STARTED](https://github.com/orao-network/solana-vrf/blob/master/GETTING_STARTED.md)). |
| Solana | **MagicBlock VRF** | CPI request into a queue; the oracle posts result and proof; the VRF program verifies and calls back | **0.0005 SOL (1–2 s tier) or 0.0008 SOL (<500 ms tier)**, ≈$0.035–0.057. Free inside MagicBlock's ephemeral rollup. | RFC 9381 VRF over Ristretto, proof verified on-chain ([pricing](https://docs.magicblock.gg/pages/verifiable-randomness-functions-vrfs/introduction/pricing), [technical details](https://docs.magicblock.gg/pages/verifiable-randomness-functions-vrfs/introduction/technical-details)) |
| Solana (EVM: Monad only in its example) | **Switchboard On-Demand** | Commit, then reveal, then settle. The caller fetches the reveal off-chain and submits it. | Not verified (docs host unreachable) | Switchboard's own example: *"it's the responsibility of the caller to reveal the randomness. Therefore, the game collateral MUST be taken upon randomness request, not on reveal."* ([coin-flip program](https://github.com/switchboard-xyz/sb-on-demand-examples/blob/main/solana/randomness/coin-flip/programs/sb-randomness/src/lib.rs)). Its EVM example targets Monad only ([EVM coin-flip](https://github.com/switchboard-xyz/sb-on-demand-examples/tree/main/evm/randomness/coin-flip)). |
| TON | none found | — | — | TON's docs offer only built-ins and commit-reveal (below) |

**Can the server learn the result before committing to "delivered"?**

- **Chainlink, Pyth, ORAO Callback and MagicBlock:** no, if the request is made in the confirming instruction. Chainlink's guidance matches our rules: *"Do not allow re-requesting or cancellation of randomness"*, *"Don't accept bids/bets/inputs after you have made a randomness request"*, and *"`fulfillRandomWords` must not revert"* ([VRF security](https://docs.chain.link/vrf/v2-5/security)). A chain reorganisation can only *"re-roll the dice, not predetermine"* the result, so we should keep Polygon's 3 confirmations.
- **ORAO Classic and Switchboard:** the result exists before our settle transaction runs, and with Switchboard the server sees it first. That is safe only if the confirming instruction already locked everything, and **anyone (the customer's Web App included) can submit the settle**. Withholding then delays the Cashback but can't change it. This is today's `retry_draw` property.
- **Seeds:** the program should derive the seed inside the confirming instruction (purchase id plus something unknown in advance, such as a recent slot hash). A server-chosen seed is risky because ORAO's programs *"run on devnet and mainnet under the same program IDs"*. If devnet and mainnet signed with the same keys, a server could try a seed on devnet first. I couldn't confirm whether they do.
- **Cost per Checkout, not per card:** one random value can serve a whole Checkout. The contract already derives each card's value as `sha256(seed || purchase_id)` (`draw_random`, `contract/src/lib.rs`). On Solana that divides the ≈$0.035 across the Lucky Buys in a Cart.

**Is built-in randomness safe?**

- **OP-stack (Base):** the L2 block's `random` *"is set to the `prev_randao` L1 block attribute"* of its L1 origin ([OP derivation spec](https://github.com/ethereum-optimism/specs/blob/main/specs/protocol/derivation.md)). That L1 block is public before the L2 block, and several L2 blocks share it. **Not safe.**
- **Arbitrum:** `block.prevrandao` *"Returns the constant 1"*, and `blockhash` is *"cryptographically insecure"* ([Solidity support](https://github.com/OffchainLabs/arbitrum-docs/blob/master/content/docs/arbitrum-essentials/arbitrum-vs-ethereum/solidity-support.mdx)). **Not safe.**
- **TON:** *"Validators can predict single-block randomness. Do not use `random.initialize()` for high-value applications"*. The docs recommend commit-reveal for lotteries ([random number generation](https://docs.ton.org/llms/contracts/techniques/random/content.md)). **Not safe on its own.**
- **NEAR:** *"Only the validator mining the transaction can predict which random number will come out"*. It can also refuse to produce the block ([NEAR docs](https://github.com/near/docs/blob/master/smart-contracts/security/random.mdx)). We accept this today only because the Cashback Cap bounds what one Draw can pay (ADR-0001, amended 2026-11-17).
- **Polygon PoS and Solana:** see Couldn't verify.

## 4. No gas for customers, and server-submitted purchases within contract limits

The model carries over to every chain. The contract holds the Balance, and a server operator key may only call the purchase entry points. The contract enforces Spending Limits and `max_debit` on every purchase. The customer signs nothing per purchase. What changes is how deposits, withdrawals and settings reach the chain without the customer holding gas.

- **Solana.** Any account can pay a transaction's fees. The customer signs the instruction, and our key signs as fee payer. That is NEP-366 without a meta-transaction format. The Solana Foundation's **Kora** is a ready-made signing and fee-paying service (*"Enable gasless transactions where users pay fees in any token … Users never need SOL"*, [Kora](https://github.com/solana-foundation/kora)). The base fee is 5,000 lamports per signature ([constants reference](https://github.com/solana-foundation/solana-com/blob/main/apps/docs/content/docs/en/core/constants-reference.mdx)). Pitfalls:
  - **One delegate per token account.** An SPL token account has a single `delegate: COption<Pubkey>` ([token state](https://github.com/solana-program/token/blob/main/interface/src/state.rs)). A design that left USDC in the customer's wallet with Luckout as delegate would break as soon as another app took the delegate slot. Keep the Balance in a program-owned vault, as on NEAR.
  - **Rent.** Every account we create needs a refundable deposit: 1,666,240 lamports (≈$0.12) for 200 bytes, read today with `getMinimumBalanceForRentExemption`. Close each purchase record after settlement, and keep Draw Proofs in program events (ADR-0005 already reads events), or the deposits pile up.
  - **Paying fees for signed calls.** Our relayer pays for transactions customers sign, so it needs the checks in ADR-0008: exact accounts, no rent refunded to the caller, simulate first.
- **Base, Polygon, Arbitrum.** The operator EOA submits purchases and pays gas. For the customer's own calls there are three routes:
  - **Our own relayer.** It sends a USDC `receiveWithAuthorization` (EIP-3009) deposit and EIP-712-signed withdrawals and settings, checked in the contract (ERC-1271 for smart accounts). ADR-0011 records that USDC supports EIP-3009 on Base, Arbitrum and Polygon. This means writing the signature and nonce code ADR-0011 avoided by using NEAR Intents, though OpenZeppelin ships it.
  - **An ERC-4337 paymaster.** Coinbase's CDP Paymaster supports Base Mainnet only (*"Other EVM networks: Use third-party ERC-7677 paymasters"*) and bills gas *"plus a 7% fee"* ([CDP Paymaster](https://docs.cdp.coinbase.com/paymaster/introduction/welcome)).
  - **EIP-7702.** Base adopted it in Isthmus. Arbitrum (ArbOS 40) and Polygon (Bhilai) adopted it per secondary sources.
- **Base Account spend permissions,** which would let the customer keep USDC and let us pull within a period allowance, are **not usable today**. Coinbase's page says *"Spend Permissions in Coinbase Wallet (formerly known as Base App) are coming soon"* ([spend permissions](https://docs.cdp.coinbase.com/coinbase-wallet/improve-ux/spend-permissions)). Base's docs now mark the Base Account SDK as moved to CDP, Base App as renamed Coinbase Wallet, OnchainKit as retired and MiniKit as sunset ([migrated products](https://docs.base.org/base-account/improve-ux/spend-permissions)).
- **CDP embedded wallets** offer **delegated signing**: *"your backend can sign within that delegation while the user is offline"* ([delegated signing](https://docs.cdp.coinbase.com/wallets/using-wallets/delegated-signing)). That is a custodial-feeling alternative to the contract-enforced limits we have now. Not recommended.
- **TON.** Gasless is a relayer that sends the user-signed request as an internal message carrying Gram for fees. *"The wallet contract must support owner-signed internal messages"*, and the relayer *"must attach enough Gram for compute"* ([gasless transactions](https://docs.ton.org/llms/contracts/standard/wallets/gasless/content.md)). TON's docs now call the native coin Gram, and WazirX announced the Toncoin → Gram rebrand.

## 5. Social login and embedded wallets

| SDK | Chains | Key type |
|---|---|---|
| **Privy** | Tier 3 (send, gas sponsorship, smart wallets on EVM): **EVM, Solana**, Tempo, Tron. Tier 2 (sign transactions): XRPL, Sui, Stellar, Aptos, **NEAR**. Tier 1 (keys and signatures only): Bitcoin, Cosmos, **TON**, Starknet ([chain support](https://docs.privy.io/wallets/overview/chains)) | Plain keypairs (secp256k1, Ed25519) that can be exported; EVM smart wallets optional |
| **Reown AppKit** | Email and social login on *"all EVM-compatible chains listed in Viem"* and **Solana**. Not on TON (TON is supported only for connecting wallets) ([socials](https://docs.reown.com/appkit/authentication/socials)) | Backed by Magic. On EVM, *"New AppKit Universal Wallet Users will be given smart accounts by default"* (ERC-4337 via Pimlico) ([smart accounts](https://docs.reown.com/appkit/features/smart-accounts)) |
| **Dynamic** | Tier 1: **EVM and Solana** (send, gasless, delegated access), **TON** (send and sign, not gasless), Sui, Bitcoin, Stellar, Tron and others ([chain support](https://www.dynamic.xyz/docs/embedded-wallets/chains/overview)) | MPC |
| **Phantom Connect** | Google or Apple login with an embedded wallet, for *"Solana, Ethereum, Bitcoin, Base, and Polygon. Monad and Sui support have been deprecated"* ([Phantom docs index](https://docs.phantom.com/llms.txt)) | Embedded wallet, with a sponsored fee-payer flow |
| **Coinbase** | Coinbase Wallet SDK (`@base-org/account`) for smart-contract accounts on EVM ([overview](https://docs.cdp.coinbase.com/coinbase-wallet/overview)); CDP embedded wallets with email, SMS and social login ([overview](https://docs.cdp.coinbase.com/embedded-wallets/welcome)) | Smart accounts (Coinbase Wallet); user-controlled keys in a TEE (CDP) |

Social login works on Solana and on the EVM chains. On NEAR it is sign-only through Privy, and on TON it is at most keys. On EVM, smart-account wallets need ERC-1271 checks in our contract, which is easy in Solidity. Our NEAR design refuses them, because NEAR Intents recovers keys (ADR-0011).

## 6. Onramps in India (INR via UPI)

Only two providers say on their own pages that they serve India with INR and UPI:

- **Onmeta.** The FAQ lists *"India: NEFT, IMPS, UPI (Google Pay, PhonePe, Paytm and other UPI apps)"*. KYC is PAN, Aadhaar and a selfie, with basic KYC at ₹20,000 a day. Chains: Ethereum, Polygon, Arbitrum, Optimism, **Base, Solana, TON**. NEAR is not listed. The per-chain token list needs a partner key ([docs](https://docs.onmeta.in/docs/intro)).
- **Onramp.money.** The homepage says *"From UPI in India…"* and lists chains *"Ethereum, Polygon, BSC, Solana, NEAR, Optimism, Arbitrum, Tron"*, with Base and TON logos ([onramp.money](https://onramp.money)). Its token list didn't render.

The others don't fill the gap:

- **Transak** no longer covers India. Its [global coverage](https://transak.com/global-coverage) table has no India row, and its public fiat list (`/api/v2/currencies/fiat-currencies`) has 26 currencies, none of them INR.
- **MoonPay** lists India as unsupported (help article dated 2026-10-05).
- **Banxa** lists India with INR by card, Apple Pay or Google Pay, but not UPI.
- **Mercuryo** and **Alchemy Pay** were not confirmable.

## 7. Indian exchanges: withdrawal networks

- **Binance** (public endpoint behind its fee page, [`getNetworkCoinAll`](https://www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll); fee in the coin):
  - **USDC** withdraws on Base 0.2, Solana 0.3, Polygon 0.12, Arbitrum 0.5 and NEAR 0.2 (also ETH, BSC, OP and others).
  - **USDT** withdraws on Solana 0.7, Polygon 0.03, Arbitrum 0.3, TON 0.3, NEAR 0.2, Tron 2 and BSC 0.01. There is **no USDT on Base**.
- **CoinSwitch:** *"We do not support crypto withdrawals at this time"* ([crypto deposit FAQ](https://coinswitch.co/pro/crypto-deposit)). Its users can't send to Luckout at all.
- **WazirX** is operating, with announcements through 26 Nov 2026 ([announcements](https://support.wazirx.com/hc/en-us/sections/360000016573-Announcements)). Its fee table has one USDT row and no network named.
- **Mudrex** charges *"2% (min. $0.5)"* on crypto withdrawals and names no networks ([fees](https://mudrex.com/fee)).
- **CoinDCX** (fee page 403) and **Giottus** (fee page 404): not verified.

## 8. Deposits from any chain

- **NEAR Intents 1Click** ([`/v0/tokens`](https://1click.chaindefuser.com/v0/tokens), 234 tokens on 39 chains) lists USDC on `sol`, `base`, `pol`, `arb` and `near`, USDT on `sol`, `pol`, `near` and `ton`, and USDT0 on `arb`. The list doesn't say which tokens work as a source and which as a destination. We already use Base and Solana USDC in both directions.
- **Program-owned deposit addresses on Solana.** A dry quote, Base USDC → Solana USDC, accepted an **off-curve** recipient (a PDA). It returned `amountOut` 4.811378 for 5 USDC, `withdrawFee` 188,253 (≈$0.19, which likely includes opening the token account), and ~32 s. The same quote to an on-curve key gave the same result. This proves only that the quote is accepted, not that the delivery lands. The catch is Solana's token library: `getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve = false, …)` throws for a PDA owner unless the caller opts in ([source](https://github.com/solana-program/token-2022/blob/main/clients/js-legacy/src/state/mint.ts)). Any wallet, exchange or onramp that derives the token account with the defaults will refuse or fail. Treat a permanent PDA deposit address as unproven until one 1Click delivery and one exchange withdrawal land. On EVM the equivalent is ordinary: a per-customer CREATE2 forwarder address is just an address to the sender.
- **CCTP:** Solana, Base, Polygon and Arbitrum (§2).
- **Relay** ([`/chains`](https://api.relay.link/chains)) lists Solana, Base, Polygon, Arbitrum, TON and Tron, but not NEAR. **deBridge** ([supported chains](https://dln.debridge.finance/v1.0/supported-chains-info)) lists Solana, Base, Polygon, Arbitrum and Tron, not TON or NEAR. **Across** ([available routes](https://app.across.to/api/available-routes)) lists Base, Polygon, Arbitrum and Tron among its chain ids, but not Solana, TON or NEAR.

## 9. Porting effort

The contract is 1,603 lines of near-sdk Rust plus 3,280 lines of tests (`contract/src/lib.rs`, `tests.rs`).

- **What survives anywhere:**
  - the pure logic: Game Version validation, `draw_random`, `roll_from_random`, `final_bps_for_roll`, `final_price`, the quote and Lucky Amount maths, the limit and lock rules;
  - the test vectors;
  - the server's purchase workflow, guest checkout, Checkout Email and Agent.
- **What goes:** `ft_on_transfer`, `on_auth` (NEAR Intents), the promise callbacks (`on_send`, `on_send_to_intents`), function-call access keys, Refills, the Treasury and Chain Signatures. On Solana and EVM a token transfer from the contract is a synchronous call that reverts the whole transaction on failure, so the NEAR refund-on-failed-transfer callbacks disappear.
- **Solana (Anchor).** Anchor's latest release is v1.2.2 (2026-10-28), with 0.30–0.32 patch releases on 2026-11-03 ([releases](https://github.com/solana-foundation/anchor/releases)). ORAO's SDK already targets Anchor 1.2. The pure functions port almost verbatim as Rust. The new work:
  - accounts and PDAs per customer, purchase and Checkout, with rent and closing;
  - the VRF request and callback.

  The limits help a Cart: transactions now go up to 4,096 bytes (*"Solana raised the maximum transaction size from 1232 bytes to 4096 bytes … on September 15, 2026"*, [upgrade note](https://github.com/solana-foundation/solana-com/blob/main/apps/media/content/upgrades/larger-transaction-sizes.mdx)). A 15-card Cart fits the 64-account and 1.4M-compute-unit limits ([constants](https://github.com/solana-foundation/solana-com/blob/main/apps/docs/content/docs/en/core/constants-reference.mdx)), but each card adds a purchase account, so measure it.
- **EVM (Solidity, Foundry v1.10.0 released 2026-11-19).** A full rewrite in another language; only the logic and test cases port. Mappings fit the Balance and purchase model directly, and Chainlink's consumer base contract and OpenZeppelin's EIP-712 and ERC-1271 helpers are standard. One contract deploys unchanged to Base, Polygon or Arbitrum.
- **TON (Tolk, now *"Official TON smart contracts programming language"*, [Tolk](https://docs.ton.org/llms/tolk/overview/content.md)).** Every cross-contract step is an asynchronous message with bounces. USDT is a jetton, with a wallet contract per holder. Admitting a Cart all-or-none across messages is hard. This is the largest rewrite and the least like the current code.
- **ADRs.** Leaving NEAR contradicts ADR-0001 and replaces most of ADR-0008, 0009, 0011 and 0012. It also replaces ADR-0014's 1Click leg on Solana. A new ADR would supersede them. Per AGENTS.md, nothing is built until the user says go, and Rust contract work only with explicit permission.

## 10. Ecosystem and grants for an India-based team

- **Solana.** *"Solana Foundation & CoinDCX India Grants"* is **OPEN**: up to $15,000 in USDC, region India, *"an exclusive focus on builders engaged in the Solana ecosystem"*, paid *"to your Okto wallet"*, with a 30-day average response and 173 applications ([Superteam Earn listing](https://earn.superteam.fun/grants/Solana-fdn-coindcx-instagrant)).
- **Base:**
  - *"The Base team provides grants very selectively. The first step to be eligible for grants is to integrate Builder Codes."* The Grant Program gives *"up to $5,000"* ([builders](https://docs.base.org/get-started/builders)).
  - **Base Batches** gives *"A $100,000 investment"* and 8 weeks, for teams *"committed to Base as their primary network"* ([Base Batches](https://docs.base.org/get-started/base-batches)). The Fall 2026 deadline (9 Sep) has passed, per secondary sources.
- **Polygon:** the grants page describes a Community Grants Program "Season 01" with no year shown. Current round not confirmed.
- **Arbitrum:** Foundation grants exist ([arbitrum.foundation/grants](https://arbitrum.foundation/grants)). Its H1 2026 report says under $200k was granted up front without milestones. There is also a Stablecoin Growth Program for USDG.
- **TON:** Foundation grants and sponsorships are applied for via `@tonfunding_bot`, per a secondary report dated 30 Jul 2026.
- **Telegram's terms, §7:** *"all Mini Apps which implement cryptocurrency functionality, either within the Mini App itself or within its connected bot, are required to be based exclusively on The Open Network (TON) blockchain"* ([bot developer terms](https://telegram.org/tos/bot-developers)). This doesn't change with any non-TON choice. The Agent stays a plain bot with no Mini App, as today.

## 11. Fees, finality and reliability (brief)

- **NEAR:** a relayed call costs about 0.0005 NEAR (≈$0.0016), measured on testnet (ADR-0008).
- **Solana:**
  - The fee is 5,000 lamports per signature (≈$0.00035), plus priority fees and rent.
  - **Alpenglow** consensus is live on mainnet, activated 2026-10-21 at epoch 1064 with a ~150 ms finality target (solana.com's upgrade page, which was behind a bot check, so secondary reports). Our RPC read showed epoch 1097.
- **Base:**
  - Gas measured at 0.006 gwei.
  - Sequencer halts: 33 minutes in Aug 2025, then about 116 and 20 minutes on 25–26 Jun 2026, both from one sequencer bug (secondary reports). Base-paid Bitrefill invoices stall during such halts today too.
- **Polygon PoS:**
  - Gas 280 gwei of POL, about $0.001 for a simple transfer.
  - *"deterministic finality is now achieved in 2 to 5 seconds"* ([finality](https://docs.polygon.technology/pos/concepts/finality/finality)).
  - A Sep 2025 bug delayed finality by 10–15 minutes (secondary).
- **Arbitrum:** gas measured at 0.0201 gwei, plus the L1 data fee.
- **TON:** *"As of April 9th 2026, mainnet runs with a block interval of about 400 ms … Target finalization lag is reduced from ~10 s to about 1 s"* ([sub-second finality](https://docs.ton.org/subsecond)).

---

## Recommendation

**Move to Solana. Base is the fallback, then Polygon.**

What decides it:

1. **It deletes the money shuttle.** This is true of any of the four chains Bitrefill pays out on, so it doesn't pick between them, but it rules out NEAR and TON. The contract (or the server, from its operator account) pays each invoice in `usdc_solana` from the chain the Balances live on. The Refills, Treasury, Base Float, Base Wallet via Chain Signatures and Intents Accounts go.
2. **USDT as well as USDC, for Indian customers.** Bitrefill takes both on Solana, and Binance withdraws both to Solana. On Base it's USDC only on both sides. Polygon matches Solana here (Binance's USDT withdrawal fee to Polygon is the lowest, 0.03).
3. **Gas-free customer calls with no extra contract code.** Solana's fee payer does what our NEP-366 Relayer does. On EVM we'd add EIP-712 and EIP-3009 handling, or pay a paymaster.
4. **What we already have:**
   - the contract logic stays Rust;
   - Solana sign-in, Solana Pay and the Jupiter swap path are built (ADR-0011, ADR-0014);
   - an open India-only Solana grant (up to $15k).

What it costs, and how to contain it:

- **Draw randomness costs about $0.035 per request** (ORAO or MagicBlock), against about half a cent for Chainlink on Base. One request per Checkout, as described in §3, and a later VRF price cut both shrink it. The providers are younger than Chainlink. MagicBlock's proof is verified on-chain; ORAO uses Ed25519 signatures from its own authorities.
- **Rent:** close purchase records after settlement.
- **Program-owned deposit addresses** are unproven with exchanges. Keep 1Click deposit addresses per Top-Up until a test lands.
- **A full contract rewrite and a fresh audit.**

What would change the answer:

- **Chainlink-grade randomness at under a cent becomes a requirement**, or ORAO's devnet and mainnet authorities turn out to share keys → **Base**, with Chainlink VRF v2.5, or Pyth Entropy at ≈$0.026.
- **Permanent per-customer deposit addresses are a must**, and off-curve sends fail → **EVM**, with CREATE2 forwarders.
- **Coinbase Wallet ships spend permissions**, and we'd rather customers keep their USDC in their own wallets → **Base**.
- **Indian USDT volume dominates and Base's halts hurt** → **Polygon**, with the same Solidity as Base.
- **A Telegram Mini App becomes the main channel** → only **TON** is allowed, at the cost of USDT-only Balances, no CCTP and no randomness provider.
- **Bitrefill's KYC/business route turns out to need a specific chain or payer.** (It didn't: on 2026-11-27 Bitrefill accepted one tagged paying address, which can be on Solana.)

## Couldn't verify

- **Indian exchange withdrawal networks** for CoinDCX (403), Giottus (404), Mudrex and WazirX (no networks named). Binance's figures come from its global public endpoint and may differ for Indian accounts.
- **Per-chain token lists (USDC vs USDT)** for Onmeta (needs a partner key) and Onramp.money (didn't render). Also when Transak dropped India, and Mercuryo's and Alchemy Pay's India coverage. Coinbase Onramp in India needs a CDP key to query.
- **Switchboard On-Demand's fee and latency.** docs.switchboard.xyz didn't resolve from here.
- **ORAO:**
  - its latency;
  - whether its randomness accounts can be closed;
  - whether devnet and mainnet share signing keys;
  - the `request_fee` offset in the config account, which comes from the SDK's layout and was not confirmed in its docs.
- **Pyth Entropy's reveal delays.** The chainlist table renders client-side. I also don't know why Arbitrum's fee is about 20× Base's.
- **Chainlink VRF's real per-request cost.** The figures above are estimates from the docs' formula, measured gas prices and an assumed 150k-gas callback, without the L1 data fee.
- **Polygon PoS `PREVRANDAO` behaviour,** and a primary statement that Solana's runtime offers no randomness. I assumed it doesn't and found no first-party page to cite.
- **Status claims from secondary sources:** Alpenglow's activation and current finality (the page sat behind a bot check), Solana's and Base's outage histories, and EIP-7702 on Arbitrum and Polygon.
- **Whether a 1Click delivery to an off-curve owner actually lands,** and whether wallets, exchanges and onramps will send to one (only the dry quote was tried).
- **Whether Bitrefill guest invoices now carry `x402_payment_url`** (absent on 2026-11-24).
- **Current grant rounds** for Polygon, TON and the next Base Batches cohort.
- **NEAR's current finality time.**
