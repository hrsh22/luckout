# Luckout

**Checkout, but lucky.** Buy the gift cards you already buy, pay a little extra for a fair chance to pay much less, and always get your voucher.

Luckout is a voucher shop on NEAR. It has a web app and a Telegram agent, and its vouchers come from Bitrefill. Built for the NEAR Hackathon 2026.

[![CI](https://github.com/hrsh22/luckout/actions/workflows/ci.yml/badge.svg)](https://github.com/hrsh22/luckout/actions/workflows/ci.yml)

## How it works

1. **Top up** from any chain. NEAR Intents 1Click swaps it into native USDC in your NEAR account, and one deposit moves it into your Luckout balance, held by the contract.
2. **Buy** in the web app or ask the Telegram agent. Our server submits the purchase, so you pay no gas and sign nothing each time, and the contract enforces the Spending Limits you set.
3. **Draw.** When the voucher is delivered, the same onchain call draws your price and credits any refund. The code and the result arrive together, seconds after you buy.
4. **Check it.** Every draw has a Draw Proof page that recomputes it in your browser from the chain, and a public page shows the live average against the promised 106%.

| Mode | Most you pay (₹500 voucher) | Chance to pay less | Best case | Average |
|---|---:|---:|---:|---:|
| Normal | ₹500 | No draw | ₹500 | ₹500 |
| Classic | ₹550 | 4% | ₹250 | ₹530 |
| Bold | ₹625 | 18% | Free | ₹530 |
| Jackpot | ₹750 | 25% | Free | ₹530 |

Every lucky mode averages 6% over the normal price, and that's our only revenue: no top-up fees, no service fees.

## Try it on testnet

Contract [`app.luckout.testnet`](https://testnet.nearblocks.io/address/app.luckout.testnet), test USDC [`usdc.luckout.testnet`](https://testnet.nearblocks.io/address/usdc.luckout.testnet) (anyone can call `faucet` for 100 tUSDC), operator `server.luckout.testnet`.

- **Draw Proof** of the first testnet draw, recomputed in your browser: run the web app and open `/draw/77EAmNVpwoqL62byNaPmES54vJmRMChfzL5LrMb8NxFQ`.
- **Is it fair?** at `/fair` shows the Live Average from `get_stats`.
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
- **End to end against testnet:** with the server running, `node apps/server/scripts/e2e.ts` signs in with keys from `~/.near-credentials` and checks sign-in, sessions, idempotency, Spending Limits and isolation.
- **Deploying:** [`deploy/README.md`](deploy/README.md) (server on a CloudPanel VM with pm2; web on Vercel).

## Security model

- **Customers sign once, not per purchase.** The server's NEAR key is a function-call key that can only call `purchase`, `confirm_delivery` and `fail_purchase`. Raising limits, changing settings and withdrawing need the customer's own full-access signature.
- **A compromised server or agent can spend at most your limits.** The contract checks the per-purchase and daily Spending Limits on every purchase, whoever submits it. `apps/server/scripts/attack.ts` demonstrates it on testnet: holding the operator's key, it tries to overspend, withdraw a customer's balance, raise their limits, drain the reserve, pause the shop and move tokens, and every attempt is refused by NEAR or the contract.
- **The agent can't buy on its own.** The model can only prepare a purchase; you tap Confirm, and the contract refuses to debit more than the maximum on the button. Voucher codes never enter the model's context, and the bot only talks in private chats. Telegram is linked from your signed-in wallet session, never the other way round.
- **Admission is idempotent onchain.** Each purchase carries the server's order id, and the contract admits an order once, so no retry or resend can debit twice.
- **No result shopping.** The draw runs inside the confirmation call, using the randomness of a block that didn't exist when the call was signed, so the operator can't see an outcome and then fail the purchase instead. A purchase the operator neither confirms nor fails can be reclaimed in full after 24 hours.
- **Every refund is covered before the purchase starts.** Each Lucky Buy locks its largest possible discount from the Refund Reserve, and one purchase can never win more than 20% of the free reserve.
- **Sign-in** uses NEP-413 signed messages with single-use nonces, accepted only from a full-access key of the account. Voucher codes are encrypted at rest (AES-256-GCM).
- **Crash-safe purchases.** Every step is saved before its side effect, and each transaction is saved before it is sent; a reconciler finishes anything left part-way without buying or charging twice.

## Repository

```text
apps/web        Next.js web app: shop, wallet, purchases, Draw Proof, Live Average, Win Cards
apps/server     Effect server: HTTP API, purchase workflow and reconciler, Telegram agent, top-ups
packages/api    shared HttpApi definition and schemas (typed client for the web app)
contract/       Rust NEAR contract, plus a testnet-only test-USDC token with a faucet
deploy/         pm2 config and VM setup for the server
docs/           plan, decisions (ADRs), research
CONTEXT.md      domain glossary
```

## Docs

- [Build plan](docs/plan.md): scope, schedule, what's needed, risks.
- [Decisions](docs/adr/): why it works the way it does.
- [Glossary](CONTEXT.md): Balance, Lucky Buy, Game Version, Draw, Refund Reserve, and so on.
- [Bitrefill funding research](docs/research/bitrefill-funding.md): why the float is USD store credit.
