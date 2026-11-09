# Luckout build plan

**Goal:** win the NEAR Hackathon. Development ends **14 Nov 2026, 23:59 UTC**; results by 18 Nov.
**Team:** Rishikesh and Claude.
**Pitch deck:** https://claude.ai/artifact/2kQWqUsQnR9KLU2h44qvG8 (private until shared).

## How we're judged

- **First pass:** Claude Code and Codex check that the repo runs and does what the README says. A README that works from a fresh clone is the first gate.
- **Human judges:** technical implementation, design, impact, originality, sustainability.
- **Games track:** judged on the game loop, not the token, with a bonus if players never notice the chain.

**Tracks we enter:** Games With Real Economies, AI Security & Defense, Real-World Money.

**Submission needs:**
- A public GitHub repo with code written since the announcement.
- A public X post with a demo video or screenshots, tagging @NEARProtocol and #NEARHackathon.
- The form: tracks, a NEAR wallet for prizes, the repo and post links, and a 20–2,000 character description.

## Scope

### Ships by 14 November

| Area | What |
|---|---|
| Buy | Top-ups from any chain (1Click, mainnet), four modes (Normal, Lite, Classic, Jackpot) with a saved Default Mode, instant onchain Draw, no gas for customers |
| Agent | Telegram agent on NEAR AI Cloud; Telegram linked by wallet signature; codes sent only by direct message; Spending Limits enforced onchain |
| Proof | Draw Proof page with in-browser recompute, public Live Average, personal Running Total, Win Cards with `next/og` previews |
| Access | Web App with NEAR Connect (HOT Wallet included); testnet demo with a test-USDC faucet; README that runs from a fresh clone |
| Safety | Failed purchases refund in full; 24-hour Reclaim; pause stops only new purchases; reconciliation loop finishes stuck purchases |

### If time allows

The jailbreak demo (the Agent is told to overspend and the contract refuses), Telegram Mini App sign-up, group lunch pots, Autopilot.

### Out of scope

A token or NFTs; streaks, loyalty odds or near-miss effects; an indexer; subscriptions.

## Architecture

See ADR-0006 for the full reasoning.

```text
            Vercel                          Our VM (CloudPanel, pm2)
┌──────────────────────────┐      ┌──────────────────────────────────────┐
│ apps/web  (Next.js)      │ HTTPS│ nginx ──► apps/server (Effect, Node) │
│  shop, settings, proof,  ├─────►│   HttpApi · grammY bot · Agent       │
│  live average, win cards │      │   PurchaseWorkflow · reconciler      │
│  NEAR Connect wallet     │      │            │                         │
└───────────┬──────────────┘      │        Postgres (effect/sql)         │
            │ reads contract      └───────┬──────────┬──────────┬────────┘
            ▼                             ▼          ▼          ▼
     contract/ (Rust, NEAR)  ◄──── function-call key  Bitrefill  NEAR AI Cloud
                                                       1Click     Telegram
```

The repo is a pnpm workspace:

- `apps/web`
- `apps/server`
- `packages/api` (shared HttpApi and schemas)
- `contract/`

### Purchase workflow (server)

1. The quote comes from the contract's `quote` view.
2. `purchase` debits the Maximum Price and locks the reserve onchain. Admission is idempotent through a unique key in Postgres.
3. The server buys on Bitrefill from the prepaid USD store credit, through Bitrefill's MCP `buy-products` with `balance_currency: "USD"`. On testnet the free test products are bought through REST instead (see `docs/research/bitrefill-funding.md`).
4. If delivered, the server calls `confirm_delivery`, which schedules the Draw; it credits the Cashback a block later. It then stores the code and the Draw and sends both to the customer.
5. If Bitrefill fails, the server calls `fail_purchase`, which refunds everything with no Draw.
6. Every minute, the reconciler finishes or fails any purchase that stopped part-way.

## Schedule

Rust work waits for an explicit go-ahead. The contract is designed and drafted in `contract/` (with unit tests), but it hasn't been compiled yet.

| Day | Date | Milestone |
|---|---|---|
| 1 | Sat 8 Nov | Scaffold the workspace. Shared API schemas. Server skeleton with effect/sql and PGlite. Bitrefill service (catalog, invoice, pay, test products). Web skeleton with NEAR Connect and a shadcn theme matching the deck. |
| 2 | Sun 9 Nov | **Contract (on your go):** finish and test it, deploy to testnet with a test-USDC token and faucet. NEAR service in the server. |
| 3 | Mon 10 Nov | Purchase workflow end to end on testnet (admit, Bitrefill, confirm or fail), reconciler. Web: shop, buy, result, history, settings. |
| 4 | Tue 11 Nov | Telegram Agent: wallet-signed linking, NEAR AI Cloud tool loop (search, balance, quote, buy, history), codes by direct message. |
| 5 | Wed 12 Nov | Proof page, Live Average, Running Total, Win Cards. 1Click Top-Ups on mainnet. |
| 6 | Thu 13 Nov | Deploy: VM (CloudPanel, pm2, Postgres), Vercel, mainnet contract. Fresh-clone README check with Claude Code and Codex. Polish. |
| 7 | Fri 14 Nov | Demo video, X post, submission form. Buffer, then stretch items. |

## What only you can provide

| Item | Needed by |
|---|---|
| ~~NEAR testnet accounts~~: done 7 Nov via the faucet: `luckout.testnet` (owner), `app.` (contract), `usdc.` (test token), `server.` (operator, function-call key in `.env`) | — |
| Telegram bot token (from BotFather) | Day 4 |
| NEAR AI Cloud API key | Day 4 |
| Bitrefill API key: done, it's already in `.env` | — |
| About $50 of float: a USD store-credit deposit paid in USDC on Base (the server can create the deposit invoice) | Day 5 |
| 1Click API key | Day 5 |
| NEAR mainnet accounts (owner and operator), a few NEAR for storage and gas, and about $1,000 USDC for the Cashback Reserve | Day 6 |
| ~~VM, API subdomain and SSH~~: done 9 Nov, `luckout-api.gamified.trade` on CloudPanel | — |
| ~~Vercel project~~: done 9 Nov, `luckout.gamified.trade`. The GitHub repo must be public before submission | Day 7 |
| Demo video, X post, submission form, and the NEAR wallet for prizes | Day 7 |

## Open checks

Each of these is a quick check against an API or the docs while building.

- ~~**NEAR AI Cloud:** which models, and tool calling.~~ Checked 7 Nov: `GET https://cloud-api.near.ai/v1/models` is public and lists `supported_features`. Tool-capable and ready, among others: `deepseek-ai/DeepSeek-V4.1-Flash-1017` ($0.30/$1.20 per M tokens), `Qwen/Qwen3.6-35B-A3B-FP8` ($0.17/$1.10), `z-ai/glm-5.3-flash` ($0.08/$0.50), `anthropic/claude-haiku-5-5` ($0.10/$0.50). Pick one when the key arrives; prefer an open-weight model if it runs in NEAR AI's private (TEE) inference.
- **NEAR Connect:** whether HOT Wallet sign-in works inside Telegram.
- ~~**Bitrefill:** whether test products exist.~~ Checked 7 Nov: they do. `test-gift-card-code` and `test-gift-card-link` deliver in under a second for free, even with a zero balance, so the testnet demo uses real Bitrefill fulfillment. The `-fail` products become `not_available` after one use, so the failure path is tested with a stub. REST prices come in satoshis, so the Reference Price instead comes from MCP `get-product-details` in USD, and test products are priced at face value.
- **Bitrefill test-card quota:** after about 15 free test deliveries on 7 Nov, `test-gift-card-code` and `test-gift-card-link` began returning `permanent_failure`. Checked 9 Nov: it resets daily; Normal and Jackpot test purchases delivered again, in production. Keep demo rehearsals under about 15 test deliveries a day.
- **Bitrefill USD charge:** whether the USD balance pays MCP's quoted price or the about 1% lower balance price. Settle it with the first funded purchase.
- ~~**1Click:** whether it can deliver USDC into the customer's account.~~ Checked 7 Nov: yes. An `EXACT_OUTPUT` quote to `nep141:<native USDC>` with `recipient` = the customer's NEAR account (it must exist) delivers exactly the amount asked; refunds go to the same account on Intents (`refundType: INTENTS`), since we don't know their origin-chain address. 10 USDC from Base cost 10.10 with no key and took about 35 s. The API key is optional (without it 1Click adds 0.25%). `customRecipientMsg` could deposit straight into Luckout but is marked experimental with fund-loss warnings, so we keep the two-step flow. The customer must be registered on USDC first; the Wallet page offers that.
- **Testnet USDC:** use our own test token with a faucet instead of hunting for a testnet USDC.

## Risks

| Risk | Mitigation |
|---|---|
| The README doesn't run for the first-pass agents | PGlite fallback with no Docker; a fresh-clone check on Day 6 |
| USD store credit can't be refunded, and is capped at $2,000 across all balances | Keep the float small and refill often |
| Early variance drains the reserve | Jackpot can lose money over about 100 Draws (about 12% chance); fund the reserve before launch and don't sweep profit early (ADR-0003) |
| Block producers can bias `random_seed` | Bounded by the Discount Cap and Spending Limits; disclosed |
| India's Online Gaming Act (2025) | Pitch globally, use Swiggy as one example, geo-restrict where required. This is not legal advice. |
| Running out of time | Stretch items are cut first; the core loop is done by Day 3 |
