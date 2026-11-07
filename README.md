# Luckout

**Checkout, but lucky.** Buy the gift cards you already buy, pay a little extra for a fair chance to pay much less, and always get your voucher.

Luckout is a voucher shop on NEAR. It has a web app and a Telegram agent, and its vouchers come from Bitrefill. Built for the NEAR Hackathon 2026.

> **Status:** the workspace runs: the web app, the server with PGlite, and the Bitrefill catalog. The contract is drafted in `contract/` but not compiled yet.

## Quickstart

Needs Node 24+ and pnpm (`corepack enable`).

```sh
pnpm install
cp .env.example .env   # optional: add BITREFILL_API_KEY to search the catalog
pnpm dev               # web on :3000, server on :8787
pnpm test              # server tests; the Bitrefill ones are skipped without a key
```

**Testnet deployment:** contract [`app.luckout.testnet`](https://testnet.nearblocks.io/address/app.luckout.testnet), test-USDC token with a public `faucet` method (100 tUSDC per call) [`usdc.luckout.testnet`](https://testnet.nearblocks.io/address/usdc.luckout.testnet), and operator `server.luckout.testnet`. To deploy your own, run `contract/deploy-testnet.sh` (needs `cargo-near` and `near-cli-rs`); `cd contract && cargo test` runs the contract tests.

No database is needed: without `DATABASE_URL`, the server stores data in PGlite under `apps/server/.data/`. All environment variables are listed in [`.env.example`](.env.example).

## How it works

1. **Top up** from any chain. NEAR Intents turns the funds into one USDC balance held by the Luckout contract.
2. **Buy** in the web app or ask the Telegram agent. Our server submits the purchase, so you pay no gas and sign nothing each time, and the contract enforces your own spending limits.
3. **Draw.** When the voucher is delivered, the same onchain call draws your price and credits any refund.
4. **Check it.** Every draw links to its transaction and can be recomputed in your browser.

| Mode | Most you pay (₹500 voucher) | Chance to pay less | Best case | Average |
|---|---:|---:|---:|---:|
| Normal | ₹500 | No draw | ₹500 | ₹500 |
| Classic | ₹550 | 4% | ₹250 | ₹530 |
| Bold | ₹625 | 18% | Free | ₹530 |
| Jackpot | ₹750 | 25% | Free | ₹530 |

Every lucky mode averages 6% over the normal price, and that's our only revenue: no top-up fees, no service fees.

## Repository

```text
apps/web        Next.js web app (Vercel)
apps/server     Effect server: API, Telegram agent, purchase workflow (our VM)
packages/api    shared API definition and schemas
contract/       Rust NEAR contract
docs/           plan, decisions (ADRs), agent docs
CONTEXT.md      domain glossary — use these terms
```

## Docs

- [Build plan](docs/plan.md): scope, schedule, what's needed, risks.
- [Decisions](docs/adr/): why it works the way it does.
- [Glossary](CONTEXT.md): Balance, Lucky Buy, Game Version, Draw, Refund Reserve, and so on.
