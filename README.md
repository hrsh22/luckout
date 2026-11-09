# Luckout

**Checkout, but lucky.** Buy the gift cards you already buy, pay a little extra up front for a fair chance at cashback, sometimes all of it, and always get your voucher.

Luckout is a voucher shop on NEAR. It has a web app and a Telegram agent, and its vouchers come from Bitrefill. Built for the NEAR Hackathon 2026.

[![CI](https://github.com/hrsh22/luckout/actions/workflows/ci.yml/badge.svg)](https://github.com/hrsh22/luckout/actions/workflows/ci.yml)

## How it works

1. **Top up** from any chain. NEAR Intents 1Click swaps it into native USDC in your NEAR account, and one deposit moves it into your Luckout balance, held by the contract.
2. **Buy** in the web app or ask the Telegram agent. Our server submits the purchase, so you pay no gas and sign nothing each time, and the contract enforces the Spending Limits you set.
3. **Draw.** When the voucher is delivered, the contract draws your cashback and credits it to your balance. The code and the result arrive together, seconds after you buy.
4. **Check it.** Every draw has a Draw Proof page that recomputes it in your browser from the chain, and a public page shows the live average against the promised 105.6%.

Exact odds on a ₹500 voucher (chance → what you end up paying):

| Cashback | Normal · ₹500 | Lite · ₹550 | Classic · ₹600 | Jackpot · ₹750 |
|---|---:|---:|---:|---:|
| 100% back | — | 1% → ₹0 | 2% → ₹0 | 10% → ₹0 |
| 50% back | — | 1% → ₹275 | 3% → ₹300 | 12% → ₹375 |
| 40% back | — | — | 4% → ₹360 | 34% → ₹450 |
| 30% back | — | 1% → ₹385 | 7% → ₹420 | — |
| 20% back | — | 2% → ₹440 | 24% → ₹480 | — |
| 10% back | — | 18% → ₹495 | — | — |
| No cashback | 100% → ₹500 | 77% → ₹550 | 60% → ₹600 | 44% → ₹750 |
| **Average** | ₹500 | ₹528 | ₹528 | ₹528 |

Any cashback leaves you below the normal price, one purchase gets at most $50 back, and every lucky mode averages exactly 5.6% over the normal price. That's our only revenue: no top-up fees, no service fees.

## Try it on testnet

**Live: [luckout.gamified.trade](https://luckout.gamified.trade)** (API at `luckout-api.gamified.trade`). Open the shop at [`/shop`](https://luckout.gamified.trade/shop), sign in with a testnet wallet, tap "Get 100 test USDC and deposit it" on the Balance page, and buy a Bitrefill test voucher.

Contract [`app.luckout.testnet`](https://testnet.nearblocks.io/address/app.luckout.testnet), test USDC [`usdc.luckout.testnet`](https://testnet.nearblocks.io/address/usdc.luckout.testnet) (anyone can call `faucet` for 100 tUSDC), operator `server.luckout.testnet`.

- **Draw Proof** of the first testnet draw, recomputed in your browser: [luckout.gamified.trade/draw/77EAmNVp…](https://luckout.gamified.trade/draw/77EAmNVpwoqL62byNaPmES54vJmRMChfzL5LrMb8NxFQ).
- **Is it fair?** at [`/fair`](https://luckout.gamified.trade/fair) shows the Live Average from `get_stats`.
- **Buying** needs the server's operator key and a Bitrefill key. On testnet only Bitrefill's free test vouchers can be bought, with test USDC.

## Quickstart

Needs Node 24+ and pnpm (`corepack enable`).

```sh
pnpm install
cp .env.example .env   # optional; everything below runs without it
pnpm dev               # web on :3000, server on :8787
pnpm test              # unit tests; tests that call Bitrefill or 1Click skip without keys
```

Without any keys, the server starts on PGlite (no database to install), the Draw Proof and Live Average pages read testnet directly, and the shop says which key is missing. With `BITREFILL_API_KEY` the catalog and prices work; with the operator key and `REDEMPTION_KEY` purchases work. All variables are in [`.env.example`](.env.example).

- **Contract:** `cd contract && cargo test` (Rust 1.95, pinned). `contract/deploy-testnet.sh` deploys your own copy with a faucet account.
- **End to end against testnet:** with the server running, `node apps/server/scripts/e2e.ts` signs in with keys from `~/.near-credentials` and checks sign-in, sessions, idempotency, a Jackpot Draw, Spending Limits and isolation. Set `API_URL=https://luckout-api.gamified.trade` to run it against production.
- **Deploying:** [`deploy/README.md`](deploy/README.md) (server on a CloudPanel VM with pm2; web on Vercel).

## Security model

- **Customers sign once, not per purchase.** The server's NEAR key is a function-call key that can only call `purchase`, `confirm_delivery` and `fail_purchase`. Raising limits, changing settings and withdrawing need the customer's own full-access signature.
- **A compromised server or agent can spend at most your limits.** The contract checks the per-purchase and daily Spending Limits on every purchase, whoever submits it. `apps/server/scripts/attack.ts` demonstrates it on testnet: holding the operator's key, it tries to overspend, bundle a confirmation with a call that reverts unlucky Draws, run a Draw directly, withdraw a customer's balance, raise their limits, drain the reserve, pause the shop and move tokens, and every attempt is refused by NEAR or the contract.
- **The agent can't buy on its own.** The model can only prepare a purchase; you tap Confirm, and the contract refuses to debit more than the maximum on the button. Voucher codes never enter the model's context, and the bot only talks in private chats. Telegram is linked from your signed-in wallet session, never the other way round.
- **Admission is idempotent onchain.** Each purchase carries the server's order id, and the contract admits an order once, so no retry or resend can debit twice.
- **No result shopping.** Confirming delivery closes the purchase for good, and the Draw then runs in a separate receipt a block later, with gas the contract sets and randomness that didn't exist when the confirmation was signed. Nobody, not even a full-access key, can bundle the confirmation with a call that reverts unlucky outcomes, fail the purchase after seeing the result, or call the Draw directly. A purchase the operator neither confirms nor fails can be reclaimed in full after 24 hours.
- **Every cashback is covered before the purchase starts.** Each Lucky Buy locks its largest possible discount from the Cashback Reserve; one purchase can get at most $50 back and never cost more than 20% of the free reserve.
- **Sign-in** uses NEP-413 signed messages with single-use nonces, accepted only from a full-access key of the account. Voucher codes are encrypted at rest (AES-256-GCM).
- **Crash-safe purchases.** Every step is saved before its side effect, and each transaction is saved before it is sent; a reconciler finishes anything left part-way without buying or charging twice, backing off and flagging for a human anything that keeps failing.

What the contract does **not** prove, and you trust us for:

- **Delivery.** The operator confirms delivery; the chain can't see a Bitrefill code. A purchase we never confirm or fail can be reclaimed after 24 hours.
- **The mode and amount within your limits.** The operator submits each purchase. The contract caps the debit at what you confirmed and at your Spending Limits, but a compromised server could buy for you, in any mode, up to those limits.
- **The daily limit is per UTC day.** It resets at 00:00 UTC, so up to twice the daily limit can be spent across midnight.
- **Upgrades.** On testnet, the contract account keeps a full-access key, so its owner can deploy new code. Before mainnet, that key is deleted or moved behind a multisig with a timelock, and this section will say which.

## Repository

```text
apps/web        Next.js web app: landing page, shop, balance, purchases, Draw Proof, Live Average, Win Cards
apps/server     Effect server: HTTP API, purchase workflow and reconciler, Telegram agent, top-ups
packages/api    shared HttpApi definition and schemas (typed client for the web app)
contract/       Rust NEAR contract, plus a testnet-only test-USDC token with a faucet
deploy/         pm2 config, VM setup and the runbook for the server
docs/           plan, decisions (ADRs), research
CONTEXT.md      domain glossary
```

## Docs

- [Build plan](docs/plan.md): scope, schedule, what's needed, risks.
- [Decisions](docs/adr/): why it works the way it does.
- [Glossary](CONTEXT.md): Balance, Lucky Buy, Game Version, Draw, Cashback, and so on.
- [Bitrefill funding research](docs/research/bitrefill-funding.md): why the float is USD store credit.
