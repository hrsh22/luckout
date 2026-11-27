# Runbook

What to do when something goes wrong on Luckout on Solana (ADR-0015). Keys, settings and deploys are in [README.md](README.md).

Start at the Admin panel (`/admin`, for the Privy wallets in `ADMIN_ACCOUNTS`). Its control room reads the program live: the pause, the reserve and Proceeds, the daily repay cap, the fee payer's SOL, the Pay Wallet's float, and our paying address against Bitrefill's limits. Under Purchases it lists those that need attention, oldest first, each with **Retry now** where going again is safe, or **Manual check**, which links here. **Stop sales** and **Retry now** need no wallet. Owner actions (pause, reserve, Proceeds, caps, operator, Pay Wallet, ownership) build a transaction for the owner's wallet to sign.

Alerts reach the admin chat as `⚠️ Luckout [mainnet FM2m]: …`, naming the cluster and the start of the program's address: `FM2m` is staging, `GCeZ` production. The same alert is sent at most once an hour.

Logs, as the site user: `pm2 logs luckout-api --lines 200`. A checkout that stopped for now logs `checkout <id> paused: <why>`. A Monitor check that couldn't run logs `monitor: the <name> check failed`; the other checks still alert.

## Which checkout runs where

- **Mainnet (staging and production): guest checkout** (ADR-0012). Each Checkout is one Bitrefill invoice, placed with the customer's Checkout Email, or on their own Bitrefill account once they've connected it. The Pay Wallet pays it in USDC on Solana (`usdc_solana`) at the step `pay`. `settle` repays the Pay Wallet from the Vault, up to the owner's daily repay cap. A mainnet server doesn't start without a guest client.
- **Devnet (and a local validator):** only Bitrefill's test cards (ids starting `test-`), bought with our own Bitrefill account's key. They're free: there's no `pay` step, and the Pay Wallet pays nothing for them.

A checkout's steps (`checkouts.step`): `waiting` (only while the float is short) → `admit` → `ordering` → `pay` → `delivery` → `settle` → `draw` → `done`. It ends `rejected`, uncharged, if the program refuses the admission or it's cancelled while waiting. `restock` is a charged checkout waiting for the float. Its cards (`purchases.step`) share its step until `delivery`, then go on alone: `confirm` or `fail`, then `drawing` (Lucky cards waiting for ORAO), then `settled` or `failed`.

Every step is saved before its side effect, and every transaction is saved signed before it's sent, so a restart resumes it rather than signing twice. The reconciler resumes open checkouts every 30 seconds, each with its own backoff. After 12 tries (about six hours) it gives up:
- a guest checkout still at `ordering`, with nothing paid, is refunded in full;
- a Draw keeps waiting;
- anything else goes `stuck`, with an alert.

## A purchase is stuck

The Monitor checks every 10 minutes and alerts `N purchase(s) stuck; see deploy/RUNBOOK.md` and `N purchase(s) still unfinished after 15 minutes`. The customer is told their card needs a manual check, and that they can Reclaim it 24 hours after buying.

**Find it** as the site user: `ssh luckout-staging-api-milesvm` (staging) or `ssh luckout-milesvm` (production). The role and database are the ones in the site's `DATABASE_URL`; staging's are `luckout_staging` and `luckout_staging_solana`.

```sh
psql -h 127.0.0.1 -U <role> <db> -c "SELECT p.id, p.checkout_id, p.position, p.step, c.step AS checkout_step, p.error, p.account_id, c.address, c.invoice_id, c.admit_tx->>'signature' AS admit, c.pay_tx->>'signature' AS payment, c.settle_tx->>'signature' AS settle, c.attempts, p.created_at FROM purchases p JOIN checkouts c ON c.id = p.checkout_id WHERE p.step NOT IN ('settled', 'failed', 'rejected') ORDER BY p.created_at"
```

- `address` is the Checkout account.
- `position` is the card's place in it.
- `account_id` is the customer's Privy wallet, which is also their Deposit Address.
- Admin → Purchases shows each purchase's invoice, payment and transactions, with Solana Explorer links.

**Check the chain and Bitrefill before changing anything.**

- **A transaction** (`admit`, `payment`, `settle`): look it up on `https://explorer.solana.com/tx/<signature>`, or with `solana confirm -v <signature> --url "$RPC"` where the Solana CLI is installed.
  - Success: it landed.
  - Failed: it ran, was refused, and moved nothing.
  - Not found: it hasn't landed. Once its blockhash has expired (a minute or two after signing), it never will.
- **The cards**, read from the Checkout account, as the site user:
  ```sh
  cd ~/htdocs/<site>/apps/server && node --env-file=../../.env --input-type=module -e '
  import { Connection, PublicKey } from "@solana/web3.js"
  import { decodeAccount } from "./src/Program.ts"
  const a = await new Connection(process.env.SOLANA_RPC_URL).getAccountInfo(new PublicKey(process.argv[1]))
  console.log(a ? JSON.stringify(decodeAccount("Checkout", a.data), (_, v) => (typeof v === "bigint" ? String(v) : v), 1) : "closed")' <address>
  ```
  Each card's `status.kind` is one of:
  - `Pending`: open. The customer can Reclaim it 24 hours after the account's `created_at`.
  - `Drawing`: delivered, with its Draw waiting for ORAO.
  - `Delivered`, `Failed` or `Reclaimed`.

  `closed` means every card ended and the account closed. Its transactions (`https://explorer.solana.com/address/<address>`) show how.
- **Bitrefill:** guest orders aren't in our Bitrefill account. Bitrefill support can look one up from the invoice id and the payment's signature. Bitrefill also emails each guest card's code to its Checkout Email.

A `Gave up after 12 attempts at <step>: …` error carries only what the checkout last saved. The cause of each failed try is in the logs, as `checkout <id> paused: …`.

| Error or step | Means | Do |
|---|---|---|
| `Gave up after 12 attempts at delivery: …` | We paid the invoice, and Bitrefill hasn't delivered in about six hours. | **Retry now**. It asks Bitrefill only about that invoice, and refunds the customer itself if Bitrefill says a card failed. Still nothing: ask Bitrefill support, with the invoice id and the payment's signature. Never set `fail`: the invoice is paid. |
| `Gave up … at confirm: …` or `at fail: …` | `settle` kept failing: the RPC, or the fee payer out of SOL. | Fix the cause, then **Retry now**. The program closes a card only once. |
| `Gave up … at admit: …` | The admission kept failing: the RPC, or the fee payer. | Look up its `admit` transaction, then restart at `admit` (below). The server resends that same transaction, and signs a new one only after the old one's blockhash has expired, so it can't charge twice. |
| `Gave up … at pay: …` | Paying the invoice kept failing. | Look up its `payment`, then restart at `pay`. The server checks the saved payment first: if it landed, the checkout goes on to `delivery`. If it never landed, the server pays again only within 50 minutes of the invoice, and otherwise asks Bitrefill for a fresh one. |
| `failing it was refused, delivered onchain: …`, with the alert `purchase … is delivered onchain but we tried to fail it` | Bitrefill said the card failed, but the program has it Delivered: the customer paid and has no code. | Ask Bitrefill support about the card. Delivered after all: get the code to the customer, and set the card `settled`. Not delivered: send its price in USDC to the customer's Deposit Address (`account_id`), which the sweep moves into their Balance, and set the card `failed`. |
| Card `drawing`, checkout `draw`, with the alert `… have a Draw still unfinished after 10 minutes` or `… a Draw is still unfinished after 12 tries` | ORAO hasn't filled the request (it takes 4 to 20 s), or finishing it keeps failing (the RPC, the fee payer). The card is delivered and its code shown; only its Cashback waits. | Check the fee payer and the RPC. The server keeps finishing it and never gives up. An hour after the request it asks ORAO again (`ORAO hadn't filled round N after an hour; asked again`). Anyone may finish a Draw. |
| `waiting`; or `restock`, `The payment failed, so nothing was paid: …` | The float can't cover the checkout yet (uncharged), or its payment was refused, usually because the float ran short (charged). | See [A short Pay Wallet float](#a-short-pay-wallet-float). |
| Alert `Bitrefill didn't deliver … on paid invoice …; payment …. Claim the refund to the Pay Wallet.` | We paid, and Bitrefill ended the order without a card. The customer was refunded in full. | Ask Bitrefill support to refund the invoice to the Pay Wallet's address, with the invoice id and the payment's signature. |
| Alert `Bitrefill matched … to an order another card of it already has …` | Bitrefill listed one order for two cards of a checkout. The second waits at `delivery`, so no code goes to two cards. | If it lasts, compare the invoice's orders with Bitrefill support. |
| Alert `Bitrefill delivered … with no code or link we recognise …` | The card was delivered, but nothing in what Bitrefill sent looks like a code. | Check the card with Bitrefill support before the customer has to ask. |
| `Bitrefill refused: …` (card `failed`) | Bitrefill wouldn't take the order. Nothing was paid, and the customer was refunded in full. A guest gets 15 cards a day, $500 a day and $1,000 a month per Checkout Email; the shop and the bot check these first. | Read the reason. A customer at the guest limits can connect their own Bitrefill account. |
| `Bitrefill's invoice … costs $X, more than the admitted $Y` | Bitrefill priced the invoice above what the customer was charged, so we didn't pay it. Refunded in full. | Nothing. If it repeats for one card, its price is moving: check the card in the shop. |
| `We couldn't order this card from Bitrefill`, with the alert `… couldn't be ordered from Bitrefill in 12 attempts (nothing was paid); refunding it in full` | Placing the order failed for about six hours: Bitrefill down or rate limiting us, or our guest login refused. Refunded in full. | Find the cause in the logs before more checkouts hit it. |
| `We couldn't order and pay for this card in time`, with the alert `… couldn't be ordered and paid for in time; refunding it in full` | Charged over an hour ago and still unpaid. Refunded in full, well before the customer could Reclaim. | Same. |
| `Bitrefill order outcome unknown; check the Bitrefill account` (devnet only) | The server restarted while ordering a test card on our account. | Find the order in our Bitrefill account. Delivered: set `invoice_id` on the checkout and its cards, then restart at `delivery`. No order: set the cards to `fail` and the checkout to `settle`. |

**Restart a purchase** only at the step it gave up at (its error says which). Move its checkout and cards together, with the backoff cleared, in one transaction. **Retry now** does this for `delivery`, `confirm` and `fail`. By hand, for `delivery`:

```sql
-- The server runs checkouts, not cards: move the checkout and its cards together, in one transaction, or nothing resumes.
-- For admit or pay, put that step in both statements instead of 'delivery'. For confirm or fail, use Retry now.
BEGIN;
UPDATE purchases SET step = 'delivery', error = NULL, updated_at = now()
  WHERE checkout_id = '<checkout_id>' AND step = 'stuck';
UPDATE checkouts SET step = 'delivery', error = NULL, attempts = 0, next_attempt_at = now(), updated_at = now() - interval '1 minute'
  WHERE id = '<checkout_id>' AND step = 'stuck';
COMMIT;
```

The rules for setting a step by hand:
- Never set `waiting`, `ordering` or `restock`: those can charge, order or pay again.
- Never move a checkout back to a step it has already passed.
- Never set `fail` while the checkout has a payment that landed or could still land. The customer would be refunded for a card that still arrives.

A stuck card that the customer reclaims, or that is failed onchain, is closed by the server within 5 minutes.

## The customer reclaimed after we delivered

The alert `purchase <id> was delivered but closed onchain as Reclaimed; its voucher cost is ours` means `settle` found the card already reclaimed. The customer has both the code and their money back, and the card's price is our loss. Nothing to fix in the database. It can only happen to a card left unconfirmed for 24 hours.

A stuck card the customer reclaims is closed as `failed` with the error `Reclaimed`, without this alert. To find any that had a code:

```sh
psql -h 127.0.0.1 -U <role> <db> -c "SELECT id, account_id, voucher_name, package_value, reference_price FROM purchases WHERE step = 'failed' AND error = 'Reclaimed' AND redemption IS NOT NULL"
```

## Low SOL, or a short Pay Wallet float

Each alert below comes when a balance drops under its line, then once a day while it stays there. A restart doesn't repeat it. Staging's lines are a fraction of production's (`GAS_ALERT_PERCENT`).

- **`the fee payer <address> has under 1 SOL left; every purchase, deposit and Draw stops when it runs out`.**
  - The fee payer pays every transaction's fee, the rent of customers' and Checkout accounts, and ORAO's request for each Draw. A Checkout account's rent comes back when it closes.
  - **Do:** send SOL to its address from any wallet (Admin → Paying Bitrefill → Fee payer).
  - Until then, admissions, payments, settlements, Draws and deposits all fail, and so do customers' withdrawals, settings and Reclaims.
  - Checkouts that gave up meanwhile are `stuck`: **Retry now**, or restart them as above.
  - The operator and the Pay Wallet need no SOL of their own: the fee payer pays their fees too.
- **`the Pay Wallet's float is down to X USDC; checkouts wait for it once it can't pay Bitrefill`** (under 100 USDC on production). Top it up as below.
- **`today's repayments to the Pay Wallet reached X of the Y USDC daily cap; raise it in the admin panel`** (at 80% of the cap). Past the cap, `settle` puts delivered cards' prices into Proceeds instead of the float, so the float runs down. **Do:** the owner raises it (Admin → Repaid today → Change the cap). Keep it at about twice the busiest day.

### A short Pay Wallet float

The Pay Wallet pays each checkout's invoice, and `settle` repays it. A new checkout that costs more than the float can cover goes to `waiting`. The float it can use is the Pay Wallet's USDC, less what checkouts at `admit`, `ordering` or `pay` are yet to pay.

- **`checkout <id> waits for the Pay Wallet: its float can't cover $X yet. Top it up, or it's cancelled after 60 minutes.`** Nothing is charged.
  - The checkout goes ahead by itself within 10 seconds of the float covering it.
  - The customer can cancel it meanwhile.
  - After 60 minutes it's cancelled, uncharged.
  - Each customer can have one waiting checkout at a time.
- **`checkout <id>: its payment to Bitrefill failed (…); it waits for the Pay Wallet's float`.** The checkout is at `restock`: charged, but nothing was paid.
  - Once the float covers it, it is ordered again with a fresh invoice.
  - If that doesn't happen within 60 minutes of placing it, it's refunded in full.

**Top it up**, in any of these ways. Waiting checkouts then go ahead on their own.
- **From Proceeds (owner):** Admin → Proceeds → Withdraw, to "the Pay Wallet, as float".
- **Raise the daily repay cap (owner),** if the repay alert fired.
- **Send USDC on Solana** to the Pay Wallet's own address, from any wallet or exchange: Admin → Paying Bitrefill → Pay Wallet float shows it under "Send USDC on Solana to" (and `deploy/README.md`, Environments, lists it). Never to its USDC account, which the panel shows below it only as a detail.

While sales are stopped or the program is paused, waiting checkouts keep their place, but their 60 minutes keep running.

## A deposit didn't reach the Balance

The server moves USDC from each Deposit Address into its customer's Balance (`deposit_for`):
- in a sweep every two minutes;
- at once on Alchemy's webhook, if `ALCHEMY_WEBHOOK_SIGNING_KEY` is set.

Less than 1 USDC waits until more arrives. Only customers in `known_accounts` (everyone who has signed in) are swept.

- **No approval yet:** the customer hasn't made the one-time approval. The Wallet page asks for it.
- **Another app's approval replaced ours** (alert `another app's approval replaced ours at <wallet>'s Deposit Address: …`): what arrives stays at the address. The customer is told once in Telegram, if linked, to approve again in Wallet. To find them: `SELECT account_id, approval_lost_at FROM known_accounts WHERE approval_lost_at IS NOT NULL`.
- **The sweep fails:** the log says `deposit for <wallet> failed: …` or `deposit sweep failed`. Usually the fee payer or the RPC. After three failures in a row for one wallet, the alert `deposits for <wallet> keep failing, …` comes, then hourly while it lasts.
- **USDT** isn't swept. The customer taps to swap it in, in Wallet.

## Stopping purchases

- **Something looks wrong: Admin → Stop sales.**
  - Any admin can, with no wallet.
  - No new purchase starts, from the web or the bot. The web shows a "paused for a few minutes" banner.
  - Checkouts already on their way finish. Waiting ones keep their place.
  - Deposits, withdrawals and Reclaims keep working.
  - **Restart sales** undoes it.
- **The hard stop: Admin → Pause the program**, signed in the owner's wallet.
  - The program refuses every new Checkout, whoever sends it. One the server hadn't admitted yet ends `rejected` (`New purchases are paused`), uncharged.
  - Checkouts already admitted still settle and draw, and deposits, withdrawals and Reclaims keep working.
  - The server sees the pause within 15 seconds and closes the shop too.
  - **Resume the program** undoes it.
- **The Vault holds less than the program owes.** The Monitor alerts `the Vault holds X USDC, less than the program owes: …`. Pause the program now, then investigate.
- **The server's keys may be stolen.** The operator and the Pay Wallet are both on the VM. Together they can admit Checkouts against customers' Balances and settle them as delivered, and `settle` repays the Pay Wallet up to the daily cap.
  1. Pause the program.
  2. Set the daily repay cap to 0. `settle` then sends everything to Proceeds, which only the owner can withdraw.
  3. Make fresh keys on the VM, once it's clean.
  4. **Change the operator** and **Change the Pay Wallet** in the Admin panel. Bitrefill must tag a new Pay Wallet before it pays anything.
  5. Put the new keys in `.env` and run `pm2 restart luckout-api`.

  A stolen fee payer only loses its SOL: replace its key in `.env`.

## Bitrefill's limits and client secret

- **`Luckout's paying address reached Bitrefill's limit ($10000.00 a day, $50000.00 a month); new checkouts are refused until it frees up`.**
  - Bitrefill tagged our paying address with these limits. Every card the Pay Wallet pays counts against them: a guest's, whatever its Checkout Email, and one on a customer's own Bitrefill account.
  - New checkouts are refused until the 24-hour and 30-day windows move on. Admin → Our paying address shows where it stands.
  - Only Bitrefill can raise the limits.
- **`the Bitrefill client secret expires on <date>, in N day(s): …`**, said daily from two weeks before.
  - Register a new client and replace the `BITREFILL_CLIENT_*` values (`deploy/README.md`, "A Bitrefill client for guest checkout"), then `pm2 restart luckout-api`.
  - Customers' Bitrefill Connections belong to the old client, so they connect again.
  - Once it has expired, the alert says so: no card can be bought, and nobody can connect Bitrefill, until it's replaced.
- **`BITREFILL_CLIENT_SECRET_EXPIRES_AT isn't set, …`:** put in the seconds-since-1970 value Bitrefill returned at registration. Without it, nothing warns before the secret expires. A value in milliseconds stops the server at start.

## The server won't start

`pm2 logs luckout-api --lines 200`. The key check comes before the database, so a server refused there has run no migration.

- **`SOLANA_CLUSTER=mainnet also needs …`:** fill in the listed values in `.env` (`MAINNET_REQUIRES` in `apps/server/src/main.ts`). It also names a `REDEMPTION_KEY` that isn't 64 hex characters, or a `SESSION_SECRET` under 32.
- **`couldn't read the program's Config (…)`:**
  - The RPC didn't answer: pm2 keeps restarting the server, and it starts once the RPC answers.
  - `the program at … isn't initialized`: `SOLANA_PROGRAM_ID` is wrong, or the program was never set up (`deploy/README.md`, A new program, step 5).
- **`SOLANA_… is the program's owner` or `proposed owner`:** the owner's key never goes on the server. Take it out of `.env`.
- **`SOLANA_OPERATOR_SECRET_KEY is …, but the program's operator is …`:** put the operator's key in `.env`. If the owner changed the operator, put the new key in.
- **`SOLANA_PAY_WALLET_SECRET_KEY doesn't own the program's Pay Wallet account …`:** the same, for the Pay Wallet.
- **`Another Luckout server is already running against this database`:** `pm2 list`, and stop the extra process. Exactly one may run.
- **`This database belongs to …, but SOLANA_PROGRAM_ID is …`** (or `SOLANA_CLUSTER`), or **`This database belongs to the NEAR deployment …`:** `DATABASE_URL` points at another deployment's database (`DeploymentLock`), which was left as it was: the check comes before any migration. Point it at this site's own.
- `SOLANA_CLUSTER` must be `localnet`, `devnet` or `mainnet`. Anything else stops the start.

## Rolling back a release

A release goes in this order: the program (upgraded by hand, staging's first), then the server (CI deploys it on the merge), then the web. How to go back depends on how far it got.

- **The program upgrade went wrong:**
  - Stop sales, and redeploy the build dumped before the upgrade (`deploy/README.md`, Upgrading a program, steps 1 and 6).
  - This only works if the release didn't change an account layout. An older build refuses any account a newer one wrote (`This account was written by a newer build`), so after a layout change, fix forward.
  - Put back the server that goes with that program too.
- **The server:**
  - A failed deploy prints the command to go back: `bash deploy/remote-deploy.sh <branch> <earlier commit>`.
  - If the server was refused at its key check or its database check (`This database belongs to …`), nothing was migrated, and going back is safe.
  - Otherwise its migrations stay. Check `git diff <earlier> <failed> -- apps/server/src/Db.ts` first. A new table, or a new nullable or defaulted column, doesn't bother the old code. Anything else means fixing forward: revert or fix on `staging` by PR, then release.
- **The web:**
  - Vercel's Instant Rollback brings back the previous production deployment. On the Hobby plan it only goes back one.
  - Fixing forward is safer when the server changed too.
  - If a release's web never deployed, call the branch's Deploy Hook without echoing its URL: `read -rs HOOK && curl -fsS -X POST "$HOOK"; unset HOOK`.
- **The last resort: a dump.** Restore it as in [Restoring from a dump](#restoring-from-a-dump). Everything recorded after it is lost from the database and has to be read back from the chain. Before a release, take one by hand: `(umask 077; pg_dump -h 127.0.0.1 -U <role> <db> | gzip > ~/backups/prerelease-$(date +%F).sql.gz)`.

## Restoring from a dump

Every night at 03:00, each site dumps its database to `~/backups/luckout-<date>.sql.gz` (`deploy/backup.sh`, from the site user's crontab). It keeps the last 15 days and writes one line per night to `~/backups/backup.log`.

A dump that failed, came out incomplete, or isn't this site's database is thrown away, the older dumps are kept, and the admin chat gets "the nightly database dump failed (…)". To see why, run the crontab's command by hand as the site user (`crontab -l` shows it).

The dumps live on the VM itself, so they don't survive losing the VM. Copy a recent one to your own machine now and then, e.g. `scp luckout-staging-api-milesvm:backups/luckout-<date>.sql.gz .`.

To restore a broken or lost database (`<db>` and `<role>` are the site's, as in its `DATABASE_URL`):

1. **Stop the server**, so nothing writes while you restore: `pm2 stop luckout-api`. Customers' Balances are in the program and stay safe. Checkouts wait.
2. **An empty database.** A dump only loads into an empty one: into one that still has its tables, it stops at the first `CREATE TABLE` and changes nothing. As the Postgres admin (`ssh postgres-milesvm`), keep the broken one aside instead of dropping it (close any open `psql` sessions on it first):
   ```sql
   ALTER DATABASE <db> RENAME TO <db>_broken;
   CREATE DATABASE <db> OWNER <role>;
   ```
3. **Load the dump** as the site user, all or nothing:
   ```sh
   gunzip -c ~/backups/luckout-<date>.sql.gz | psql -h 127.0.0.1 -U <role> -d <db> -v ON_ERROR_STOP=1 --single-transaction
   ```
   Use the VM's own `psql`: recent `pg_dump` versions write `\restrict` lines that an older `psql` refuses.
4. **Keep the site's `.env` as it is.** Redemption Data, Checkout Emails and Bitrefill logins are sealed with its `REDEMPTION_KEY`. A dump restored under another key can't be read, so the key's backup matters as much as the dump. The database also records its cluster and program, so only this site's server starts on it.
5. **Park what could buy again.** On start the server resumes every open checkout. One restored at `waiting`, `admit`, `ordering`, `restock` or `pay` may have been admitted, ordered or paid after the dump. Resumed, it would take the customer's next Checkout number and charge again, or pay a new invoice. Park those first, as the site user:
   ```sh
   # Both are parked in one transaction, so a parked checkout is never admitted, ordered or paid again (and Retry now refuses it).
   psql -h 127.0.0.1 -U <role> -d <db> -v ON_ERROR_STOP=1 -c "UPDATE purchases SET step = 'stuck', error = 'Restored from a dump at ' || step || ': check by hand' WHERE step IN ('waiting', 'admit', 'ordering', 'restock', 'pay'); UPDATE checkouts SET step = 'stuck', error = 'Restored from a dump at ' || step || ': check by hand' WHERE step IN ('waiting', 'admit', 'ordering', 'restock', 'pay')"
   ```
   Those at `delivery`, `settle` or `draw` are safe to resume:
   - `delivery` only asks Bitrefill about its own invoice;
   - the program closes a card only once;
   - finishing a Draw only reads ORAO's value.

   Check the parked ones as in [A purchase is stuck](#a-purchase-is-stuck).
6. **Start it:** `pm2 start luckout-api`. It runs any migration newer than the dump; `/health` should answer 204.
7. **What happened after the dump** is missing from the database, and so from Admin, which reads it. Read it back from the chain:
   - **Checkouts.** The operator signs every `admit` and `settle`. Its transactions after the dump's time (on the explorer, or `solana transaction-history <operator>`) list every Checkout admitted or settled since, and each `admit` names its Checkout account.
   - **Cards paid for.** The Pay Wallet's outgoing USDC transfers after the dump's time each paid one checkout's invoice. Bitrefill support can tell from a payment's signature which invoice it paid, and whether the cards were delivered.
   - **Closing them.** The server won't finish checkouts it has no rows for, and the app can Reclaim only purchases in the database. A card Bitrefill delivered: get its code to the customer (Bitrefill also emailed it to their Checkout Email). Settling or reclaiming the rest needs a one-off script: `settle` signed by the operator, or `reclaim` signed by the customer's wallet after 24 hours. Anyone can send `finish_draw` for a filled request.
   - **Customers.** Anyone who first signed in after the dump isn't in `known_accounts`, so their deposits aren't swept until they sign in again. Anyone who set a Checkout Email or connected Bitrefill since the dump does it again.
