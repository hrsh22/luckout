# Runbook

Most of this is also on the admin panel (`/admin`, for accounts in `ADMIN_ACCOUNTS`): gas for each account with a Send NEAR button, the reserve and proceeds, the shop switch, the relayer's switch and caps, the Base Float and how near the busiest Checkout Email is to Bitrefill's limits (where the credit model runs: Bitrefill's USD credit and daily orders), and stuck purchases with **Retry now** where that's safe (open purchases, and ones that gave up at `confirm` or `fail`). Anything it marks **Manual check** needs the steps below.

## Which checkout runs where

- **Guest checkout (ADR-0012)** on mainnet, staging and production alike. Each card is a Bitrefill invoice placed with the customer's Checkout Email (or on their own Bitrefill account, once they've connected it) and paid in USDC on Base from the Base Wallet. The USDC there is the Base Float. A purchase passes through the step `pay`, and the admin panel has a **Base Float** section.
- **The credit model (ADR-0009)** on testnet. Cards are Bitrefill's free test cards, bought with our own account's key. There is no `pay` step and no refill, and the admin panel has a **Bitrefill credit** section. Production ran this model, with refills of the credit, until the release that switched it (`deploy/README.md`, "Releasing staging to production").

## A purchase is stuck

The Monitor alerts when a purchase reaches `stuck`, or is still unfinished after 15 minutes. Find it:

```sh
ssh luckout-milesvm
psql -h 127.0.0.1 -U luckout luckout -c "SELECT p.id, p.checkout_id, p.step, c.step AS checkout_step, p.error, p.account_id, c.invoice_id, c.pay_tx->>'hash' AS base_payment, c.pay_tx->>'nonce' AS base_nonce, p.contract_purchase_id, c.attempts, p.created_at FROM purchases p JOIN checkouts c ON c.id = p.checkout_id WHERE p.step NOT IN ('settled', 'failed', 'rejected') ORDER BY p.created_at"
```

Then check both sides before changing anything:

- **Onchain:** `near contract call-function as-read-only <contract> get_purchase json-args '{"purchase_id":<contract_purchase_id>}' network-config <network> now`. Status `Pending` (still open), `Drawing` (delivered, Draw not run yet), `Delivered`, `Failed` or `Reclaimed`.
- **Bitrefill:** with guest checkout there is no order history on our account. Admin → Purchases shows the purchase's Bitrefill invoice, what was paid from the Base Float and its Base payment; the invoice itself can only be asked about at Bitrefill support, with the invoice id and the payment's hash. In the credit model: the order history in the Bitrefill account, matched by `invoice_id`, or by time and product when `invoice_id` is empty.
- **Base (guest checkout):** the purchase's Base payment on basescan.org (`base_payment` above, or the link in Admin → Purchases). "Success" means Bitrefill was paid; "Fail" means it reverted and nothing moved; not found means it hasn't been mined.

| Error or step | Means | Do |
|---|---|---|
| `Bitrefill order outcome unknown` (step was `ordering`; credit model) | We may have paid Bitrefill without saving the invoice. | If Bitrefill shows the order delivered: set `invoice_id` and `step = 'delivery'`; the reconciler confirms it within a minute. If there's no order: `step = 'fail'`, and the customer is refunded. |
| `Gave up after 12 attempts at delivery` | Bitrefill never finished delivering. | Credit model: same as above, using `invoice_id`. Guest checkout: the invoice was paid (`base_payment`), so never set `fail`. Set `step = 'delivery'` again with the backoff cleared: it only asks Bitrefill about that invoice, and refunds the customer itself if Bitrefill says it failed. If it still isn't delivered, ask Bitrefill support, with the invoice id and the Base payment's hash. |
| `Gave up … at confirm` / `at fail` | NEAR kept refusing or timing out. | Read the error. If the operator is out of gas, top it up, then set `step` back to `confirm`/`fail`, `attempts = 0`, `next_attempt_at = now()`. |
| Onchain `Drawing` for long | The Draw callback failed. | Setting `step = 'confirm'` reschedules it; the customer can also call `retry_draw`. |
| `Bitrefill refused: …` | Bitrefill wouldn't take the order; the customer was refunded in full. With guest checkout its limits count per Checkout Email (15 cards a day, $500 a day, $1,000 a month), or per the customer's own account once they've connected Bitrefill, and the shop and the bot say so before Bitrefill refuses: read the reason. In the credit model it is usually our account's daily purchase limit (`purchase_limit_reached`, 15 a day across all products). | Nothing to fix in code. A customer at the guest limits can connect their own Bitrefill account from Wallet. |
| `fail_purchase refused, delivered onchain` | We confirmed a delivery we later tried to fail. | Check Bitrefill: if the voucher was delivered, set `step = 'settled'`. |
| `Gave up … at pay` | Guest checkout: the Base payment for the card's invoice couldn't be signed, sent or seen mined (Base's RPC, Chain Signatures, the treasury out of NEAR, or the Base Wallet out of ETH). | Read the error and fix its cause first, then look at the Base payment. Whatever you set, clear the backoff as in the example below. **None** (`base_payment` is empty): nothing was signed or paid; set `step = 'pay'` (it asks Bitrefill for a fresh invoice if this one is over 40 minutes old), or `step = 'fail'` to refund the customer now. **Success** on basescan: Bitrefill was paid; set `step = 'delivery'` and `ordered_at = now()` (the server sets it when it sees the payment mined, and the float's sales figures count the card from then). **Fail** on basescan: nothing moved; set `step = 'pay'`, and the server sees the revert itself, waits for the float and orders afresh. **Not found**: its outcome is unknown. If the Base Wallet has a mined transaction with this payment's nonce (`pay_tx->>'nonce'`) or a higher one, this one can never be mined: set `step = 'fail'`, and the customer is refunded. Otherwise leave the row alone: the customer can Reclaim 24 hours after buying, and the server then closes the purchase by itself. |
| `purchase <id>: its Base payment to Bitrefill reverted (nothing moved); it waits for the float` | Guest checkout: the payment was mined and failed, usually because the Base Float ran short. The purchase is charged and waits for the float (step `restock`). | Nothing by hand. A refill is started for it: check in Admin → Base Float that one is running and the treasury can fund it. If the float doesn't come in time, the customer is refunded in full before they could Reclaim. |
| `purchase <id>: Bitrefill didn't deliver paid invoice <invoice> (<reason>); Base payment <hash>` | Guest checkout: we paid the invoice from the Base Float and Bitrefill ended it without a card. The customer was refunded in full; the payment is ours to recover. | Ask Bitrefill support for a refund, with the invoice id and the Base payment's hash. |
| `Bitrefill's invoice <invoice> costs $X, more than the admitted $Y` | Guest checkout: Bitrefill priced the invoice above what the contract charged the customer, so it wasn't paid. The customer was refunded in full. | Nothing by hand. If it repeats for one card, its price moved between the quote and the order: check the card in the shop. |
| `purchase <id> couldn't be ordered and paid for in time; refunding it in full` | Guest checkout: Base or Bitrefill kept failing until the purchase had waited as long as the float settings allow, or the customer could soon Reclaim it. Nothing was paid, and the customer is refunded. | Nothing by hand. Find what kept failing (the purchase's earlier errors in the log: Base's RPC, Chain Signatures, gas) before more purchases meet it. |
| A purchase at `pay` whose error says its Base payment `wasn't mined before invoice … neared expiry, so it isn't sent again` | Guest checkout: the payment was signed and sent, but not mined 50 minutes after the invoice was made. From then on the server only asks Base where it is, and gives up (`stuck`) after 12 tries. | Look the payment up on basescan and follow `Gave up … at pay`. Change nothing while it isn't found. |
| `purchase <id> couldn't be ordered from Bitrefill in 12 attempts (nothing was paid); refunding it in full` | Guest checkout: placing the order kept failing for about six hours of retries (Bitrefill unreachable or rate limiting us, or our guest login refused). No invoice was paid, and the customer is refunded in full. | Nothing by hand. Find what kept failing (the purchase's earlier errors in the log) before more purchases meet it. |

Restart a purchase by setting its step and clearing the backoff, for example:

```sql
-- The server runs checkouts, not cards: move the checkout and its cards together, in one transaction, or nothing resumes.
-- Each card goes to its own step; the checkout to 'settle' if any card is at 'confirm' or 'fail', else to the cards' step.
-- Credit model, with an invoice found by hand: also SET invoice_id = '<invoice>' in both statements (delivery asks
-- Bitrefill only about the cards that carry the checkout's invoice).
BEGIN;
UPDATE purchases SET step = 'delivery', error = NULL, updated_at = now()
  WHERE checkout_id = '<checkout_id>' AND step = 'stuck';
UPDATE checkouts SET step = 'delivery', error = NULL, attempts = 0, next_attempt_at = now(), updated_at = now() - interval '1 minute'
  WHERE id = '<checkout_id>' AND step = 'stuck';
COMMIT;
```

Never set `admit` or `ordering` by hand: those can debit or buy again. With guest checkout, never set `ordering` or `fail` while the purchase has a Base payment that hasn't failed (reverted, or lost its nonce to a mined transaction): a new invoice would be paid on top of it, or the customer refunded for a card that still arrives.

## The customer reclaimed after we delivered

The alert says "was delivered but closed onchain as Reclaimed". The customer has both the voucher and their money; the voucher cost is ours. Nothing to fix in the database.

## Low operator gas or contract storage

- Operator under 0.5 NEAR: send NEAR to the operator account. Purchases stop when it runs out.
- Contract under 1 NEAR free: send NEAR to the contract account. New purchases fail when storage can't be paid.
- Relayer under 0.5 NEAR: send NEAR to the relayer account. Until then customers' wallets pay their own fees (the web app falls back by itself), and customers with no NEAR can't deposit or withdraw.
- Treasury under 0.1 NEAR: send NEAR to the treasury account (Admin → Gas). It signs every refill and, with guest checkout, every card's Base payment, about 0.01 NEAR each through Chain Signatures; both stop when it runs out.
- Base Wallet under 0.0001 ETH: send about $1 of ETH on Base to its address (Admin → Gas → Base wallet → Copy address). With guest checkout no card can be paid without it, and refills wait at `fund`.

## Stopping purchases

- **Something looks wrong, stop new purchases now:** Admin → **Stop sales**. Any admin can, no wallet needed. The web shows a "paused for a few minutes" banner, the Buy button explains, and the Telegram bot stops offering Buy buttons. Purchases already in progress finish; waiting ones keep their place; withdrawals and reclaims keep working. **Restart sales** undoes it.
- **The hard stop:** Admin → **Pause the contract**, signed by the owner's wallet. The contract itself then refuses every new purchase, whoever sends it.
- **The server's keys may be stolen:** pause the contract and set the treasury to manual (Admin → Treasury → Change mode, a cap of 0), both owner-signed. Pausing alone doesn't stop the treasury pulling proceeds (ADR-0009).

## The Base Float and refills (ADR-0012)

With guest checkout, every card's Bitrefill invoice is paid in USDC on Base from the Base Wallet. The USDC there is the Base Float. A refill tops it up: the treasury's USDC goes through a 1Click swap into the Base Wallet, and the refill is done when it lands ("Base Float refilled"). The admin panel's Base Float section shows the float against its target, the Checkout card (how near the busiest Checkout Email is to Bitrefill's limits), the treasury, and every refill step by step.

- **A refill says "Needs a look" (stuck), and automatic refills are paused.** No more money goes in while it's stuck. The Telegram alert has what you need: the swap's explorer page, our payment's transaction hash, the quote id, and the refund address. Check before resolving it:
  - 1Click: the explorer page in the alert, or `curl "https://1click.chaindefuser.com/v0/status?depositAddress=<the swap's deposit address>"` (in the `refills.swap` column). `SUCCESS` means our Base Wallet was paid; `REFUNDED` means the USDC went back to the treasury. The server keeps checking every five minutes, and closes the refill by itself when 1Click refunds it or finishes it; it tells you either way.
  - Base: the Base Wallet's USDC, in Admin → Base Float or on basescan.org.

  If the USDC is in the Base Wallet, or back in the treasury, resolve the refill in the panel with a note; automatic refills start again. The reason "1Click isn't answering and the swap is long past its deadline" is handled the same way.
- **"Refill … keeps failing at <step>: <error>. It retries by itself, and no other refill starts meanwhile."** Sent after five failed tries in a row, then at most once an hour. Nothing is lost and nothing needs resolving: read the error (NEAR's RPC, 1Click refusing or down, Base's RPC) and fix its cause. Only one refill is open at a time, so the float isn't topped up until this one gets through.
- **1Click hasn't finished or refunded a swap past its deadline.** Contact NEAR Intents support through a channel their own sites link: the "Support" Telegram group linked from docs.near-intents.org (https://t.me/near_intents), or the chat on near-intents.org (desktop only). Send the deposit address, our payment's transaction hash (the treasury's, not 1Click's forwarding one), the quote id, the amounts, and the refund address. Ask them to finish it or refund it to the treasury: either is safe, because the swap pays our own Base Wallet. Support never needs a seed phrase, a private key or a wallet connection. Record it like `docs/incidents/2026-11-10-stuck-refill.md`.
- **Cards must keep selling while refills are stuck or failing.** Send USDC on Base straight to the Base Wallet from any wallet or exchange (Admin → Gas → Base wallet → Copy address). The server reads the float from Base, so waiting purchases go ahead on their own.
- **"Waiting for $X in the treasury (manual mode)."** Move proceeds in from the panel (Treasury → Move proceeds here), or switch the treasury to automatic.
- **"The contract's treasury is …, not …".** The owner points the contract at the server's treasury in the panel (Treasury → Fix it).
- **The float shows "No answer yet".** Base's RPC isn't answering (`BASE_RPC_URL`): check the provider. Until it does, cards can't be paid (purchases retry by themselves at `pay`) and refills won't start.
- **"N purchase(s) … are waiting for the Base Float, uncharged."** No order is refused for its size; a big one waits for a refill sized for it. The alert says what holds it, usually today's refill limit: raise it in Admin → Base Float → Settings, or it carries on as the 24-hour window frees up. Customers can cancel while they wait, and are never charged before the card can be bought; after a day it's cancelled for them.
- **"N purchase(s) worth $X are waiting for the Base Float, and no refill can start: <why>."** The reason names what only an admin can clear: a stuck refill to resolve, two failed refills in six hours, a missing treasury key.
- **"The Base Float is low and automatic refills are off: a $X refill is due."** Switch Auto back on in Admin → Base Float, or start one with Refill now.
- **"The Base Float dropped $X more than our payments explain."** USDC left the Base Wallet that no purchase accounts for. First look for a stuck purchase whose Base payment of that amount was mined after it gave up: a stuck one isn't counted as on its way, and is handled as `Gave up … at pay`. Otherwise look at the wallet on basescan.org. A transfer we didn't make means the treasury's key is in other hands: follow "The server's keys may be stolen" under Stopping purchases.
- **"A $X refill needs $Y more in the treasury."** Either today's treasury cap binds (raise it in Admin → Treasury → Change mode, to the cap the alert suggests, or wait for the cap to reset), or the proceeds are short (it carries on as sales come in, or send USDC to the treasury to cover it now). A standing buffer of USDC in the treasury makes big orders instant.
- **"Today's treasury pulls reached $X of the $Y daily cap."** Real demand: raise the cap as suggested. Not expected: switch the treasury to manual at once. The same goes for **"Refills in the last 24 hours are far above the usual."**
- **The Base Wallet.** Refills swap into our own address on Base and stop there; each card's invoice is paid from it by one exact transfer, saved before it's sent, so a retry resends the same transaction and never pays twice. It has no private key: the address is derived from the treasury account through NEAR Chain Signatures (`v1.signer`, path `evm`), and each payment is signed by NEAR's MPC network at the treasury's request, for about 0.01 NEAR. Whoever controls the treasury account controls the wallet, including your own wallet key on it. It needs a little ETH on Base for gas (about $1 lasts hundreds of payments); the Monitor alerts under 0.0001 ETH.
- **Float settings.** Admin → Base Float → Settings: what refills top up to at least, the most the float holds, the line below which a refill starts, the most refilled in a day, and how long a purchase may wait for the float. The target is about a day of recent sales, between the first two.
- **Setting up a treasury (once per network).** Create the account with a full-access key, put it in `TREASURY_ACCOUNT_ID` / `TREASURY_PRIVATE_KEY`, give it about 0.5 NEAR for gas, register it on USDC (`storage_deposit` for itself; `scripts/treasury.ts` does this on testnet), then have the owner call `set_treasury` from the panel.

### Where the credit model still runs (ADR-0009)

No deployment refills Bitrefill credit once production has switched: testnet's test cards are free, and refills don't run there. These entries describe that path while its code exists, and applied to production before its switch.

- **A stuck refill.** Besides 1Click, check the deposit invoice (`refills.invoice_id`) in the Bitrefill account, and the USD credit. If the credit arrived, or the money is back in the treasury, resolve the refill. If our Base Wallet paid Bitrefill but the credit never arrived, contact Bitrefill support with the invoice id before resolving.
- **Sales need credit while refills are stuck.** Top up the USD credit by hand on bitrefill.com with any coin they accept. The server reads the balance from Bitrefill, so waiting purchases go ahead on their own.
- **Credit shows "No answer".** Bitrefill's balance API is down (it happens). Purchases still go ahead, and an order Bitrefill refuses for credit waits safely; refills won't start until the balance can be read.
- **"N purchase(s) … are waiting for credit, uncharged."** As for the float above; what holds it can also be Bitrefill's account limit (ask Bitrefill).
- **The Base float.** Admin → Bitrefill credit → Settings → "Keep ready on Base" ($50 by default on mainnet; 0 turns it off). Refills pay Bitrefill from it in about a minute; once it's under half, a "float" refill swaps the rest back in from the treasury (it shows in the refills list as "to top up the Base float" and ends "In our Base wallet"). It counts against the treasury's daily cap like any pull, but not against the daily refill limit, since it isn't Bitrefill credit. If the float stays empty, check the refills list: a top-up waits behind a running refill, and like any refill it needs the treasury funded and ETH for gas.
- **A Base payment needs a look.** Each payment is fixed (nonce and fees) before it's signed and saved signed before it's sent, so a retry never pays twice. If it was signed but couldn't be sent before Bitrefill's invoice was 50 minutes old, it's never sent and the refill stops: resolve it, and the next refill pays a fresh invoice. If it was sent but not mined in 10 minutes, look it up on basescan.org; the server keeps checking and closes the refill when it's mined and credited.

## Bitrefill's client secret

- **"the Bitrefill client secret expires on <date>, in N day(s)"**, daily from two weeks before. Register a new client and replace the `BITREFILL_CLIENT_*` values as `deploy/README.md` says under "When the client secret is about to expire". Once it has expired the alert says so, and until that is done no card can be bought and nobody can connect Bitrefill.
- **"BITREFILL_CLIENT_SECRET_EXPIRES_AT isn't set"**: put the date Bitrefill returned at registration in the server's `.env`, or nothing warns before the secret expires.

## The server won't start

- `NEAR_NETWORK=mainnet also needs …`: fill in the listed values in `.env`.
- `Another Luckout server is already running`: `pm2 list`; stop the extra process. Exactly one may run.
- `OPERATOR_PRIVATE_KEY: …`: the operator key can't call what purchases send (`purchase_many`, `settle`), isn't on chain, or NEAR's RPC didn't answer. For the key, add one that can (`deploy/README.md`, "Releasing staging to production", step 9), put it in `.env` and `pm2 restart luckout-api`. For the RPC, pm2 keeps starting the server again, and it starts once the RPC answers.
- Logs: `pm2 logs luckout-api --lines 200`. A Monitor check that couldn't run is logged as `monitor: the <name> check failed`; its other checks still alert.

## Rolling back a release

A release from `staging` to `main` changes the contract (before the merge), then the server and its database, then the web (`deploy/README.md`, "Releasing staging to production"). The way back depends on how far it got.

- **The contract upgrade failed, or the records read differently after it** (before the merge): `contract/upgrade.sh` printed the command that deploys the saved code and the dry run that checks it ("Already deployed."). Restart sales and stop the release there. Once the new server runs, never put the earlier contract code back under it: every Checkout's admission and settlement uses methods only the new code has.
- **The new server refused to start at its key check** (`OPERATOR_PRIVATE_KEY: …` in `pm2 logs luckout-api`): it stopped before the database, so nothing was migrated (`SELECT max(migration_id) FROM effect_sql_migrations` reads as before the merge). Add a key that can call `purchase_many` and `settle`, put it in `.env`, then `pm2 restart luckout-api`. Going back with `bash deploy/remote-deploy.sh main <commit before the merge>` is also still safe here.
- **Anything else once the migrations ran: fix forward.** Revert or fix the change on `staging` by PR, then release it to `main`; CI deploys each. Never run `remote-deploy.sh main <earlier commit>` across migration 0025: the earlier code can't record a purchase on the migrated tables, so sales stop for everyone.
- **The last resort, only if fixing forward can't work: the pre-release dump** (step 15 of the release). Everything recorded after it is lost from the database and has to be read back from the chains.
  1. Admin → Stop sales, then `pm2 stop luckout-api`.
  2. Restore the dump (`~/backups/prerelease-<date>.sql.gz`, or the copy taken off the VM) as in [Restoring from a dump](#restoring-from-a-dump), steps 2 to 4.
  3. Park what could buy again. That dump predates Checkouts, so it is the purchases alone (the first `UPDATE` of [Restoring from a dump](#restoring-from-a-dump), step 5):
     ```sh
     psql -h 127.0.0.1 -U <role> -d <db> -c "UPDATE purchases SET step = 'stuck', error = 'Restored from the pre-release dump at ' || step || ': check by hand' WHERE step IN ('waiting', 'admit', 'ordering', 'restock')"
     ```
  4. As the site user: `bash deploy/remote-deploy.sh main <commit before the merge>`, which starts the earlier code. Don't start the server before this (Restoring's step 6): the release's code would migrate the dump again. Put the web back with it: the release's web can't sign in to the earlier server. Vercel's Instant Rollback (Deployments → Instant Rollback) restores the production deployment before the current one, and on the Hobby plan only that one, so it fits only while the release's deployment is the latest; otherwise open production's deployment from before the merge and Redeploy it. Then revert the merge on `main` by PR, or CI deploys the release again on its next push.
  5. Purchases made since the merge are on chain but not in the database: find and close them as in [Restoring from a dump](#restoring-from-a-dump), step 7. Their cards were paid from the Base Float, so match them to the Base Wallet's payments.
  6. The earlier code buys with Bitrefill Credit again: check Admin's **Bitrefill credit** section, and switch **Auto** on (top right of the "USD credit at Bitrefill" card) if it was spent down. Keep the new server key and the new `.env` lines (the earlier code ignores the lines, and the key allows its methods too), and keep the upgraded contract: the earlier server and web work with it.
- **The web alone:** Vercel's Instant Rollback brings back the earlier web (only the one production deployment before, on the Hobby plan), which can't sign in to the new server. Fix forward instead. If the release's web never deployed, call `main`'s Deploy Hook (Vercel → Project → Settings → Git → Deploy Hooks) without echoing its URL: `read -rs HOOK && curl -fsS -X POST "$HOOK"; unset HOOK`.

## Restoring from a dump

Every night at 03:00 each site dumps its database to `~/backups/luckout-<date>.sql.gz` (`deploy/backup.sh`, from the site user's crontab), keeps the last 15 days, and writes one line per night to `~/backups/backup.log`. A dump that failed, came out incomplete, or isn't of this site's database is thrown away, older dumps are kept, and the admin chat gets "the nightly database dump failed (…)". To see why, run the crontab's command by hand as the site user (`crontab -l` shows it). The dumps are on the VM itself: they don't survive losing the VM, so copy a recent one to your own machine now and then (`scp luckout-milesvm:backups/luckout-<date>.sql.gz .`).

To restore a broken or lost database (`<db>` and `<role>` are the site's, as in its `DATABASE_URL`: `luckout_mainnet`, `luckout_staging` or `luckout_testnet`):

1. **Stop the server**, so nothing writes while you restore: `pm2 stop luckout-api`. Customers' Balances are in the contract and stay safe; purchases wait.
2. **An empty database.** A dump only loads into an empty one: into a database that still has the tables it stops at the first `CREATE TABLE` and changes nothing. As the Postgres admin, keep the broken one aside instead of dropping it (close any open `psql` sessions on it first):
   ```sql
   ALTER DATABASE <db> RENAME TO <db>_broken;
   CREATE DATABASE <db> OWNER <role>;
   ```
3. **Load the dump**, as the site user, all or nothing:
   ```sh
   gunzip -c ~/backups/luckout-<date>.sql.gz | psql -h 127.0.0.1 -U <role> -d <db> -v ON_ERROR_STOP=1 --single-transaction
   ```
   Use the VM's own `psql`: recent `pg_dump` versions write `\restrict` lines that an older `psql` refuses.
4. **Keep the site's `.env` as it is.** Redemption Data, Checkout Emails and Bitrefill logins are sealed with its `REDEMPTION_KEY`: a dump restored under another key can't be read, so the key's backup matters as much as the dump. The database also records its network and contract, so only this site's server starts on it.
5. **Park what could buy again.** Once the server starts it resumes every open purchase, and one restored at `waiting`, `admit`, `ordering`, `restock` or `pay` may have been bought and paid for after the dump: the contract hands back the existing purchase for an order id it has seen, and the server then orders and pays a new invoice. Park those first, as the site user:
   ```sh
   # The server resumes checkouts, not cards: both are parked, in one transaction, so a parked checkout is never
   # admitted, ordered or paid again (and Retry now refuses it). A dump from before migration 0025 has no checkouts
   # table, so this errors and parks nothing: run only its first UPDATE (purchases), and 0025 carries `stuck` over
   # to the checkouts it makes when the server starts.
   psql -h 127.0.0.1 -U <role> -d <db> -v ON_ERROR_STOP=1 -c "UPDATE purchases SET step = 'stuck', error = 'Restored from a dump at ' || step || ': check by hand' WHERE step IN ('waiting', 'admit', 'ordering', 'restock', 'pay'); UPDATE checkouts SET step = 'stuck', error = 'Restored from a dump at ' || step || ': check by hand' WHERE step IN ('waiting', 'admit', 'ordering', 'restock', 'pay')"
   ```
   Those at `delivery`, `confirm` or `fail` are safe to resume: they only ask Bitrefill about their own invoice, or settle on chain, where the contract closes a purchase only once. Check the parked ones like the purchases in the last step.
6. **Start it:** `pm2 start luckout-api`. It runs any migration newer than the dump; `/health` should answer 204.
7. **What happened after the dump is missing** from the database, and so from Admin, which reads it. Guest orders aren't in our Bitrefill account either, so the money side is read from the chains:
   - **Purchases.** The dump's newest is `SELECT max(contract_purchase_id) FROM purchases`. The contract numbers purchases in order, so `get_purchase` (as in "A purchase is stuck") with the next ids, one by one until it returns `null`, lists the purchases made since, each with its customer, price and status.
   - **Cards paid for.** The Base Wallet's outgoing USDC transfers on basescan.org after the dump's time (Admin → Gas → Base wallet → Copy address): each paid one card's invoice. Match them to the purchases by time and amount; Bitrefill support can tell from a payment's hash which invoice it paid and whether the card was delivered. In the credit model, the order history in our Bitrefill account lists them instead.
   - **Closing them.** The server won't finish these. For one still `Pending` on chain whose card was delivered, get the code from Bitrefill to the customer, then call `confirm_delivery` with `{"purchase_id":<id>}` as the operator (`OPERATOR_ACCOUNT_ID`, whose key is `OPERATOR_PRIVATE_KEY` in the site's `.env`; the server sends it with 100 Tgas), so it isn't also Reclaimed. One that was never paid for: the customer gets the full amount back by Reclaim 24 hours after buying.
   - **Refills.** The treasury's transactions on nearblocks.io after the dump's time: its pulls of proceeds and its transfers to 1Click. Their money is on chain (the treasury, 1Click, the Base Wallet), not in the database; a swap still open is handled as in "1Click hasn't finished or refunded a swap past its deadline".
   - Customers who signed in, linked Telegram or set a Checkout Email since the dump do it again.
