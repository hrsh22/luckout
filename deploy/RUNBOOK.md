# Runbook

Most of this is also on the admin panel (`/admin`, for accounts in `ADMIN_ACCOUNTS`): gas for each account with a Send NEAR button, the reserve and proceeds, the shop switch, the relayer's switch and caps, Bitrefill's USD credit and daily orders, and stuck purchases with **Retry now** where that's safe (open purchases, and ones that gave up at `confirm` or `fail`). Anything it marks **Manual check** needs the steps below.

## A purchase is stuck

The Monitor alerts when a purchase reaches `stuck`, or is still unfinished after 15 minutes. Find it:

```sh
ssh luckout-milesvm
psql -h 127.0.0.1 -U luckout luckout -c "SELECT id, account_id, step, error, invoice_id, contract_purchase_id, attempts, created_at FROM purchases WHERE step NOT IN ('settled', 'failed', 'rejected') ORDER BY created_at"
```

Then check both sides before changing anything:

- **Onchain:** `near contract call-function as-read-only <contract> get_purchase json-args '{"purchase_id":<contract_purchase_id>}' network-config <network> now`. Status `Pending` (still open), `Drawing` (delivered, Draw not run yet), `Delivered`, `Failed` or `Reclaimed`.
- **Bitrefill:** the order history in the Bitrefill account, matched by `invoice_id`, or by time and product when `invoice_id` is empty.

| Error or step | Means | Do |
|---|---|---|
| `Bitrefill order outcome unknown` (step was `ordering`) | We may have paid Bitrefill without saving the invoice. | If Bitrefill shows the order delivered: set `invoice_id` and `step = 'delivery'`; the reconciler confirms it within a minute. If there's no order: `step = 'fail'`, and the customer is refunded. |
| `Gave up after 12 attempts at delivery` | Bitrefill never finished delivering. | Same as above, using `invoice_id`. |
| `Gave up … at confirm` / `at fail` | NEAR kept refusing or timing out. | Read the error. If the operator is out of gas, top it up, then set `step` back to `confirm`/`fail`, `attempts = 0`, `next_attempt_at = now()`. |
| Onchain `Drawing` for long | The Draw callback failed. | Setting `step = 'confirm'` reschedules it; the customer can also call `retry_draw`. |
| `Bitrefill refused: HTTP 400` on every purchase | Usually the account's daily purchase limit (`purchase_limit_reached`, 15 per day across all products on our account as of 2026-11-09). The customer was refunded in full. | Nothing to fix in code. It resets daily; ask Bitrefill to raise it before launch. |
| `fail_purchase refused, delivered onchain` | We confirmed a delivery we later tried to fail. | Check Bitrefill: if the voucher was delivered, set `step = 'settled'`. |

Restart a purchase by setting its step and clearing the backoff, for example:

```sql
UPDATE purchases SET step = 'delivery', invoice_id = '<id>', attempts = 0, next_attempt_at = now(), updated_at = now() - interval '1 minute' WHERE id = '<uuid>';
```

Never set `admit` or `ordering` by hand: those can debit or buy again.

## The customer reclaimed after we delivered

The alert says "was delivered but closed onchain as Reclaimed". The customer has both the voucher and their money; the voucher cost is ours. Nothing to fix in the database.

## Low operator gas or contract storage

- Operator under 0.5 NEAR: send NEAR to the operator account. Purchases stop when it runs out.
- Contract under 1 NEAR free: send NEAR to the contract account. New purchases fail when storage can't be paid.
- Relayer under 0.5 NEAR: send NEAR to the relayer account. Until then customers' wallets pay their own fees (the web app falls back by itself), and customers with no NEAR can't deposit or withdraw.

## Stopping purchases

- **Something looks wrong, stop new purchases now:** Admin → **Stop sales**. Any admin can, no wallet needed. The web shows a "paused for a few minutes" banner, the Buy button explains, and the Telegram bot stops offering Buy buttons. Purchases already in progress finish; waiting ones keep their place; withdrawals and reclaims keep working. **Restart sales** undoes it.
- **The hard stop:** Admin → **Pause the contract**, signed by the owner's wallet. The contract itself then refuses every new purchase, whoever sends it.

## Bitrefill credit and refills (ADR-0009)

The admin panel's Bitrefill credit section shows the credit against its target, the treasury, and every refill step by step.

- **A refill says "Needs a look" (stuck), and automatic refills are paused.** No more money goes in while it's stuck. The Telegram alert has what you need: the swap's explorer page, our payment's transaction hash, the quote id, and the refund address. Check both sides before resolving it:
  - 1Click: the explorer page in the alert, or `curl "https://1click.chaindefuser.com/v0/status?depositAddress=<the swap's deposit address>"` (in the `refills.swap` column). `SUCCESS` means Bitrefill's address was paid; `REFUNDED` means the USDC went back to the treasury. The server keeps checking every five minutes, and closes the refill by itself when 1Click refunds it, or finishes it and Bitrefill credits it; it tells you either way.
  - Bitrefill: the deposit invoice (`refills.invoice_id`) in the Bitrefill account, and the USD credit.
  If the credit arrived, or the money is back in the treasury, resolve the refill in the panel with a note; automatic refills start again. If 1Click paid Bitrefill but the credit never arrived, contact Bitrefill support with the invoice id before resolving.
- **1Click hasn't finished or refunded a swap past its deadline.** Contact NEAR Intents support through a channel their own sites link: the "Support" Telegram group linked from docs.near-intents.org (https://t.me/near_intents), or the chat on near-intents.org (desktop only). Send the deposit address, our payment's transaction hash (the treasury's, not 1Click's forwarding one), the quote id, the amounts, and the refund address. Ask for a **refund** to the treasury, not completion: Bitrefill's deposit invoice expires 60 minutes after the refill quoted, and a late payment to it may not be credited. Support never needs a seed phrase, a private key or a wallet connection. Record it like `docs/incidents/2026-11-10-stuck-refill.md`.
- **Sales need credit while refills are stuck.** Top up the USD credit by hand on bitrefill.com with any coin they accept. The server reads the balance from Bitrefill, so waiting purchases go ahead on their own.
- **"Waiting for $X in the treasury (manual mode)."** Move proceeds in from the panel (Treasury → Move proceeds here), or switch the treasury to automatic.
- **"The contract's treasury is …, not …".** The owner points the contract at the server's treasury in the panel (Treasury → Fix it).
- **Credit shows "No answer".** Bitrefill's balance API is down (it happens). Purchases still go ahead, and an order Bitrefill refuses for credit waits safely; refills won't start until the balance can be read.
- **Setting up a treasury (once per network).** Create the account with a full-access key, put it in `TREASURY_ACCOUNT_ID` / `TREASURY_PRIVATE_KEY`, give it about 0.5 NEAR for gas, register it on USDC (`storage_deposit` for itself; `scripts/treasury.ts` does this on testnet), then have the owner call `set_treasury` from the panel.

## The server won't start

- `NEAR_NETWORK=mainnet also needs …`: fill in the listed values in `.env`.
- `Another Luckout server is already running`: `pm2 list`; stop the extra process. Exactly one may run.
- Logs: `pm2 logs luckout-api --lines 200`.
