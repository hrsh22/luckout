# Solana migration plan

This plan carries out ADR-0015. Each phase starts on an explicit go (`AGENTS.md`). Phase 1 is Rust contract work, so it needs that go most of all. Every phase ends with a check, and its result is noted here.

## Phase 0: alongside, no code

**Yours:**

- **Lawyer:** the 2025 online gaming law, FIU-IND registration, and custody (the customers' Privy wallets and the one-time deposit approval).
- **Bitrefill** (go-ahead received 2026-11-27):
  - the KYC and questionnaire they asked for
  - tell them the payer moves to USDC on Solana
  - ask whether a failed card's refund can go back to the paying address by itself
- **UPI onramps:** apply to Onmeta and Onramp.money, the two that take INR by UPI.
- **Grants:** apply for the Solana Foundation × CoinDCX India grant (up to $15k), and join Superteam India.
- **Privacy policy:** cover Privy and India's DPDP Act.
- **NEAR:** freeze releases and mainnet upgrades, except security fixes.
- **Accounts and keys:**
  - Privy, with a development app and a production app
  - an RPC provider with webhooks (Helius or similar)
  - Telegram login for Privy: in BotFather's Login Widget, allow `https://auth.privy.io/api/v1/oauth/callback`, and give Privy the client ID and secret shown there
  - the owner key: a wallet you control (a hardware wallet if possible), never on the VM

**Mine, each on your go:**

- **Pay Wallets:** a key made on each VM, staging and production. Only the addresses leave the VM. They go to Bitrefill for tagging before either pays anything.
- **Wording fixes** on the site, docs and bot: Bitrefill is only where the cards come from, and isn't affiliated with Luckout. Then the summary Bitrefill asked for.

## Checked before building (2026-11-27)

The pre-build checks were answered from primary docs and mainnet reads. What's left needs a build or real money, so it moves into Phases 1 and 4.

| Question | Answer | Left to prove |
|---|---|---|
| Does a Privy wallet sign the approval with no prompt, with our fee payer paying? | Yes. `signTransaction` takes `showWalletUIs: false`, and Privy documents the fee-payer flow. | In the web app (Phase 3) |
| Does a Phantom sign-in get a Privy wallet, and can customers export their key? | Yes, with `createOnLogin: 'all-users'`, in Privy's own window only. Export is on by default. | — |
| What does Privy cost? | Free up to 499 monthly users and 50,000 signatures a month. Then $299 a month up to 2,499 users, and $499 up to 9,999. | — |
| Can the server make a Privy user from a Telegram account? | Yes, but we won't. The approval still needs the customer's wallet to sign in the app, so the bot sends new customers there to sign in once. | — |
| What does ORAO cost, and is it on devnet? | It's the same program on devnet and mainnet. The fee is 0.0005 SOL, and each request account keeps 0.0013 SOL of rent for good (read from mainnet). About $0.13 a Draw, filled in 4–20 s. | A Draw on devnet (Phase 1) |
| Where does 1Click refund when the sender is an exchange? | To the `refundTo` address we give it, not the sender. `FLEX_INPUT` swaps whatever arrives above the quote's minimum. | Tron and Base Top-Ups (Phase 4) |
| Does a 15-card Checkout fit one transaction? | Yes, measured at the first build: admit is 731 bytes and settle with ORAO's request 735, of 1,232. Finishing 13 Draws takes about 150k compute units of 1.4M. `quote_many`'s answer is 439 of 1,024 bytes. | — |
| Can a fresh wallet pay Bitrefill, and where do failed cards' refunds go? | Guest invoices take `usdc_solana`. A failed card's refund isn't sent back by itself; we claim it, as today. | The first small card from each Pay Wallet (Phase 4) |
| Do exchanges open a fresh address's token account? | Solana's exchange guide says they should. Binance and CoinDCX don't say. | Real withdrawals (Phase 4) |
| How big is the program? | 477 KB as CI builds it for deploys, about 2.43 SOL of rent. | — |

## Phase 1: the program (needs your go for Rust)

- **Build it** in `programs/luckout` with Anchor 1.x and `orao-solana-vrf` 0.8, using the accounts and instructions in ADR-0015.
- **Port the game maths and test vectors** from `contract/src`: `draw_random`, `roll_from_random`, `final_bps_for_roll`, `final_price`, `quote_at`, `lucky_allowed` and `max_cashback_at`.
- **Measure the first build:**
  - its size, which sets the SOL budget
  - whether a 15-card admit and a 15-card settle with ORAO's request each fit one transaction: 1,232 bytes, or a v1 transaction's 4,096
  - whether `quote_many`'s answer fits 1,024 bytes; if not, quotes come in pages
- **Test on a local validator,** with ORAO's program and a filled randomness account loaded in (no test-only path in the program):
  - every refusal, including a wrong Vault, Customer account or token account
  - a randomness account that isn't ORAO's, isn't at our seed's address, or isn't filled
  - a cart admitted card by card, in order
  - a Checkout number reused, before and after its account closed
  - Lucky Amount, the smallest Lucky Checkout, and the Cashback Cap
  - a settle with both delivered and failed cards
  - a Draw finished twice, and a request replaced after an hour unfilled
  - `deposit_for` moving money only into the approving customer's Balance
  - Reclaim at 24 hours
  - the repay cap, pause and unpause by the owner only, and an owner change by propose and accept
  - Checkout accounts closing
  - an account with a newer version byte refused
  - an upgrade that adds a field into the spare bytes
- **Deploy to devnet,** with a verified build made in CI.

**Done when** every test passes and a 15-card Lucky Checkout on devnet settles and draws from ORAO's devnet.

**Done 2026-11-27.**
- **Built** in `programs/luckout`, with 28 tests passing (PR #214). CI runs them and builds the program reproducibly with `solana-verify`. Deploys use that build: 477 KB, with `opt-level = "z"` to save rent at the cost of more compute.
- **Live on devnet** at `4Tziwbh1vEDremxPViXgEa91FP3Nv4hUyNmLXMzRK2Z3`, deployed from CI's build. `apps/server/scripts/solana-devnet.ts` ran a 15-card Lucky Checkout:
  - admit: 84k compute units
  - settle with ORAO's request: 79k; the Pay Wallet was repaid 90 USDC
  - ORAO's devnet oracles filled the request in 4.2 s
  - finishing 15 Draws: 165k compute units; 13.68 USDC of Cashback, and the Checkout closed
- **Moved to Phase 4:** the test of an upgrade adding a field into the spare bytes. It needs two builds.

## Phase 2: the server

| Today | Becomes |
|---|---|
| `Near.ts` | A Solana client that sends, simulates (for quotes) and reads accounts |
| `Relay.ts`, `Intents.ts` | A fee payer that only pays for transactions the server built. `Intents.ts` goes. |
| `Base.ts`, `Refill.ts`, `Credit.ts` | Pay Wallet payments in `Bitrefill.ts`. Repaying happens in `settle`. These files go. |
| `Purchases.ts` | The same workflow, admitting and settling one numbered Checkout account. It stores each Draw Proof with ORAO's filling transaction. |
| `TopUp.ts`, `OneClick.ts` | 1Click `FLEX_INPUT` quotes to the Deposit Address, refunding to an address on the source chain. Intents Accounts and Send-Backs go. |
| `Swap.ts` | The Jupiter swap and the deposit in one transaction, for ORE and USDT |
| new `Deposits.ts` | `deposit_for` on each webhook, plus a sweep every few minutes. It watches for a lost approval. |
| `Agent.ts`, `Telegram.ts` | A deposit tool (the Deposit Address, or a 1Click address); buying once the money lands, until the quote expires; new customers sent to sign in once with Telegram |
| `Auth.ts` | Privy's tokens instead of wallet signatures |
| `Bitrefill.ts` | Also counts all orders against our paying address's cap ($10k a day, $50k a month) and pauses sales when it's reached, as it does at the daily order limit today. Per-email guest limits stay. A failed card's refund is claimed to the Pay Wallet, with an alert as today. |
| `Admin.ts` | Owner actions as Solana transactions the owner's wallet signs, as today |
| `Monitor.ts`, `Alerts.ts`, `Mcp.ts` | The new alerts, and reads from Solana |

- **Kept as they are:** `Connect.ts` (Bitrefill confirmed on 2026-11-27 that per-email guest limits still apply, so Connect Bitrefill stays as the way past them), `Attestation.ts`, `Seal.ts`, `Sales.ts`, `Settings.ts`, `RateLimit.ts`, `Edge.ts` and `Db.ts`.
- **A fresh database** for the Solana deployment. NEAR's history stays in the old one.

**Done when** the server's tests pass against a local validator with Bitrefill faked.

**Done 2026-11-28, on branch `solana-server`.** The server's 250 tests pass on LiteSVM, running the real program and ORAO's, with Bitrefill faked.
- **Built:**
  - `Program.ts`, which codes the program's instructions, accounts, events and errors from its IDL, committed in `programs/idl`
  - `Solana.ts`, which separates the transport (RPC, or LiteSVM in tests) from our keys. It saves every transaction before sending it and resumes it after a crash.
  - Purchases on the program, with the Draw step
  - Privy sign-in
  - Bitrefill in `usdc_solana`, with our paying address's limits
  - `Deposits.ts` and the transactions a customer signs
  - 1Click Top-Ups to the Deposit Address (`FLEX_INPUT`, with a refund address on the source chain)
  - USDT and ORE as one swap-and-deposit transaction
  - the Agent's deposit tool, and buying once the money lands
  - Admin, Monitor and MCP on the program
- **Removed:** `Near`, `Relay`, `Intents`, `Base`, `Credit` and `Refill`, their scripts, and `near-api-js`.
- **Carried into Phase 3:**
  - the web app still calls the old endpoints and fails its type check
  - in the bot, 1Click addresses for other chains wait for a refund-address question; until then it gives the Deposit Address
  - `deploy/README.md` still describes NEAR
- **Carried into Phase 4:** Jupiter's `payer` (the fee payer funding the customer's token accounts) must be proved with real money.
- **Decisions made while building:**
  - **Accounts and sessions:** a customer's account id is their Privy wallet's address. Privy's tokens are checked once, at sign-in. After that our own session cookie carries it, bound to the cluster and the program.
  - **Transactions a customer signs:** we build each one with our fee payer and hand it out unsigned with a token that binds its bytes (`/transactions/*`). The fee payer signs only those bytes, and only once the customer has signed them.
  - **A short float:** a checkout the Pay Wallet's float can't cover waits uncharged, and the owner is told. It goes ahead once the float covers it, or is cancelled after 60 minutes. A charged one is refunded in full.
  - **Our paying address's limits:** checked when a checkout is placed, against every card the Pay Wallet pays, guest or Connect ($10k a day, $50k a month).
  - **Deposits:** a sweep every two minutes, plus Alchemy's signed webhook (`ALCHEMY_WEBHOOK_SIGNING_KEY`).
  - **Gone:** withdrawals to other chains through 1Click. Withdrawals go to any Solana address.
  - **Test cards:** off mainnet, only Bitrefill's test cards are sold.
  - **One program per environment:** staging and production each need a build with their own program id. That's set up in Phase 4.

## Phase 3: the web app

- **Privy login,** in Privy's own window, replaces NEAR Connect, Reown and the Solana wallet adapter. `lib/near.ts` and `lib/evm.ts` go, and `lib/solana.ts` shrinks.
- **Wallet page:**
  - the Deposit Address with its QR code, after the one-time approval (signed with no prompt)
  - a tap for USDT that has arrived
  - 1Click Top-Ups from other chains
  - withdrawal to any Solana address
- **Draw Proof page:** checks ORAO's value and recomputes the Cashback (`lib/draw.ts`, `lib/proof.ts`).
- **Admin panel:** owner actions signed in the owner's wallet, as today.
- **Docs** (`docs/docs-site-plan.md`): rewrite the pages it marks as changing with Solana: sign-in, add-funds and add-funds/other-chains, draw, balance, refunds and telegram, and touch up the ones marked "Lightly". Their URLs stay.

**Done when** a customer on a local validator signs in with email, deposits, buys a Lucky Cart, sees its Draw Proofs and withdraws.

**Done 2026-11-28, on branch `solana-server`,** on devnet rather than a local validator: the devnet program, a test USDC mint, ORAO's devnet oracles and Bitrefill's test cards. The server's 258 tests and the web app's 65 pass, and the web app builds. In a browser:
- **Signed in** with a Privy test account (email). The one-time approval was signed with no prompt, our fee payer paying.
- **Deposited:** USDC sent to the Deposit Address was swept into the Balance in 36 s.
- **Bought** a $20 card on Classic, then a two-card Lucky Cart ($10 + $10 on Classic, $24 in one payment). Each card was delivered with its code, and each Draw finished from ORAO.
- **Draw Proofs:** the pages for card 1 and card 2 of the Cart recomputed everything in the browser and matched.
- **Withdrew** $5 to a fresh Solana address, its USDC account opened for it.
- **Admin panel:** the control room reads the program live. Every owner action was signed from it and landed, in a Wallet Standard wallet holding the devnet owner key (as Phantom would) and in a Privy wallet: pause and resume, the repay cap, the smallest Lucky Checkout, the Cashback Cap, funding and withdrawing the reserve, withdrawing Proceeds, changing the operator and the Pay Wallet, and handing ownership over and back. The server now refuses to start if any of its keys is the owner's.
- **Carried into Phase 4:**
  - Google, Telegram and Phantom sign-in need a person to click through them
- **Since, on the same branch:**
  - the server's quotes and purchases put a checkout's Lucky cards under the smallest Lucky Checkout at Normal (`belowMin` on the quote), as the web does, and the Agent and its Buy line say Lucky plays from that much a checkout
  - the bot gives a 1Click address for another chain's token once the customer has typed their refund address there; USDC and USDT on Solana still go to the Deposit Address
  - `deploy/README.md` describes Solana

## Phase 4: staging on mainnet

- **Deploy** the staging program, with a small Cashback Reserve and float. The staging Pay Wallet's first card is a small one.
- **Prove each deposit route with real money:**
  - USDC and USDT on Solana, withdrawn from Binance and from an Indian exchange to a fresh Deposit Address. If USDT can't arrive, the approval also opens the USDT account.
  - 1Click from Tron and from Base
  - the bot's Deposit Address, and a 1Click address from the bot
- **Prove the rest with real money:**
  - a 15-card Lucky Checkout
  - a failed card, with its refund claimed back to the Pay Wallet
  - a Reclaim
  - a withdrawal
  - a pause
  - an upgrade, and a rollback
  - an upgrade that changes a layout, with the older build refusing the new accounts

## Phase 5: cutover

1. **Production program:** deploy it with the owner key, then fund the Cashback Reserve and the float. The production Pay Wallet's first card is a small one.
2. **Switch the site:** point luckout.wtf at the Solana build, and pause new purchases on NEAR.
3. **Move the team's money over.** Only our team has bought on NEAR.
   - A one-off script withdraws each NEAR Balance whose key we hold and sends it to that person's Deposit Address, where it lands in their new Balance.
   - Anyone whose key we don't hold withdraws for themselves.
   - Old purchases stay in the old database, and every card's code is also in its Checkout Email.
4. **Wind down NEAR:**
   - let pending purchases finish
   - withdraw the reserve and Proceeds to `luckout.near`
   - empty the Base Float, Treasury and Relayer
   - move everything to Solana
5. **Update the docs:**
   - mark the superseded ADRs
   - update `CONTEXT.md` as below
   - update `README.md` and `deploy/README.md`

### `CONTEXT.md` at cutover

- **Terms that go:** Intents Account, Send-Back, Relayer, Refill, Treasury, Base Wallet, Base Float, Bitrefill Credit.
- **New terms:** Pay Wallet, Deposit Address.
- **Terms that change:** Top-Up, Balance (held by the program), Draw (randomness from a provider), Checkout (one numbered account), Web App (Privy login), Agent (takes deposits), Swap Token.

## After cutover

- USDT swapped by the program itself, with no tap
- Moving the owner and upgrade authority to a Squads multisig with a time lock, plus a small upgrade adding a pause-only guardian key
- An outside security review, before real customer volume

## Decisions (2026-11-27)

1. **Owner:** one key in our own wallet, with no multisig and no time lock for now. The program is ready to move to a multisig later.
2. **Daily repay cap:** starts at $500. The monitor warns at 80%, and the owner raises it as sales grow, keeping it at about twice the busiest day.
3. **Key export:** customers can always export their Privy key.
4. **Outside review:** not now.
5. **NEAR funds:** moved by script at cutover, since only our team used it.
6. **Smallest Lucky Checkout:** 2.5 USDC to start, the point where the margin covers one Draw. It's an owner setting, moved as SOL's price moves.

## What only you can provide

| Item | Needed by |
|---|---|
| Privy development and production app IDs | Phase 2 |
| RPC provider key, with webhooks | Phase 2 |
| Telegram login for Privy, set up in BotFather | Phase 3 |
| Bitrefill's tagging of the Pay Wallet addresses | Phase 4 |
| The owner key, in a wallet you control | Phase 4 |
| About 7.5 SOL: two programs at 2.43 SOL each, an upgrade buffer of the same size, fees, Draws (about 0.002 SOL each) and customer accounts (about $0.12 each) | Phase 4 |
| USDC for the staging reserve and float, then for production | Phases 4 and 5 |
