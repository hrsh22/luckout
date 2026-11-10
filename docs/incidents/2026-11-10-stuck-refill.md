# Stuck refill, 2026-11-10

**Status: resolved, nothing lost.** 1Click finished the swap 53 minutes late, after NEAR Intents support (ticket 81387) stepped in, and Bitrefill credited the $10. Tracked in GitHub issue #4.

## Summary

The first mainnet Bitrefill refill ($10) paid NEAR Intents 1Click at 14:37 UTC. 1Click took the deposit but didn't fill the swap, and didn't refund it at the 14:53 deadline we asked for. Meanwhile the 10.054603 USDC sat in `intents.near`, under the account 1Click controls for that swap, where only 1Click could move it. No customer money was involved. The server marked the refill `stuck` at 15:23 and paused automatic refills, as designed, so no more money went in. At 15:30:44 1Click completed the swap: Bitrefill received exactly 10.00 USDC on Base and credited it, and the unused 0.051029 USDC came back to the treasury. The $10 of credit cost 10.003574 USDC.

## Identifiers

| What | Value |
|---|---|
| Refill (mainnet DB) | `7d52e4bc-ded0-4ca7-96a5-dc87ba533220`, step `stuck` |
| Swap | 10.054603 USDC on NEAR for exactly 10.00 USDC on Base (`EXACT_OUTPUT`) |
| Refund address | `treasury.luckout.near` |
| Our payment (treasury → deposit address) | `DXdvKYCUjBiE34dJdEYocokf7k6tnpJcjvYFAneZqVC` |
| 1Click's forwarding into `intents.near` | `8rPjDTUFzfYr8TECNrLbNMPNGqwhvdu2VucxMExjZ9cA` (signed by `bridge-mng.near`) |
| Deposit address | `c144151490f8689cbc2bc035f9f22d1e3fb7a5cc06fdb2ef61875f87518c1415` |
| Explorer | https://explorer.near-intents.org/transactions/c144151490f8689cbc2bc035f9f22d1e3fb7a5cc06fdb2ef61875f87518c1415 |
| Quote (correlation) id | `f15881eb-9396-4d37-897d-68425e5f7fda` |
| Where the money waited | `intents.near`, owner `727f7786b2958c65d51715ea7e639a3bbcc9efe128287ff9ce7aff0907ce1449`, 10054603 of `nep141:17208628…a1` (USDC) |
| Delivery to Bitrefill (Base) | `0xd2b5db612f6dee4e532d4209f0fc4c864b8e8ee11b92d31493770f2da5cd1346`; 1Click's NEAR side `FCGsWiCvVpwddEuhLf5NC6nxBXQ6UbzMvXiGGyMRtxi1` |
| Bitrefill deposit invoice | `7bb5b7cc-fd1d-4073-8882-5954b03b460f`, pays `0xC2bcB691B03e836d1Cb79210DCcec30aB720E77b`; made 14:23, `all_delivered` at 15:31:37 (Bitrefill credited it although it came 68 minutes after the invoice was made) |
| Support | Ticket 81387 (near.com chat). We asked for a refund; they completed the swap instead. |

Check it any time: `curl "https://1click.chaindefuser.com/v0/status?depositAddress=c144151490f8689cbc2bc035f9f22d1e3fb7a5cc06fdb2ef61875f87518c1415"`.

## Timeline (UTC)

| Time | What happened |
|---|---|
| 14:21 | Contract and accounts deployed on mainnet. |
| 14:23 | Mainnet server started. Credit was $0, so a $10 refill began: Bitrefill invoice, then a 1Click quote. The contract's treasury wasn't set, so it waited at `fund`. |
| 14:36:19 | Owner set the treasury (`set_treasury`). |
| 14:36:33 | Alert "needs $10.06 more": the treasury was still empty. |
| 14:37:08 | Owner sent $25 USDC to the treasury. |
| 14:37:38 | Treasury paid 10.054603 USDC to the deposit address, using the **14½-minute-old quote**. |
| 14:37:51 | 1Click registered the deposit: `PROCESSING`. It never changed after this. |
| 14:53:16 | Our deadline. 1Click should have started a refund; it didn't. |
| ~15:10 | Re-submitted the deposit through `/v0/deposit/submit`: no change. The explorer showed other swaps, including some from NEAR USDC, finishing in 1–4 minutes. |
| 15:23 | Server marked the refill `stuck`, paused automatic refills, alerted on Telegram. |
| ~15:30 | Ticket 81387 opened; details sent, then a follow-up asking for a refund. |
| 15:30:44 | 1Click completed the swap: 10.00 USDC to Bitrefill on Base, 0.051029 USDC back to the treasury. |
| 15:31:37 | Bitrefill marked the deposit invoice `all_delivered`; the USD credit went from $0 to $10. |

## Why

Ours:

1. **Launch order.** The server was started before the treasury was set and funded, so a refill was certain to start and then wait.
2. **Design.** The pipeline was invoice → quote → fund → send, so any wait for money aged the quote. We paid 14½ minutes after quoting; 1Click quotes are meant to be paid within seconds. This is the most likely reason no solver filled the swap (only 1Click can confirm).
3. **Bug.** The refill stored 1Click's `deadline` from the quote, which is when the deposit address dies (three days out), as our refund deadline. It didn't cause this, but a stuck swap would only have been flagged three days later. Fixed in PR #3 before this incident was understood.

1Click's: the deposit was valid (above `minAmountIn` 10.004329), and the request asked for refunds from 14:53. Neither filling nor refunding it contradicts their API docs.

## What changed (PR #5)

- **Money first.** The pipeline is now fund → invoice → quote → send. The treasury holds the most a refill may cost (amount + 1%) and its gas before any invoice or quote exists. Invoice, quote and payment then run back to back.
- **No stale quotes.** A quote more than two minutes old is thrown away and re-quoted, never paid.
- **Faster refunds and alerts.** Our refund deadline is 15 minutes (was 30), and a swap is called stuck 20 minutes after it (was 30). The alert comes about 35 minutes after the quote, before Bitrefill's 60-minute invoice expires.
- **Stricter quote checks.** 1Click must echo delivery on Base (`recipientType DESTINATION_CHAIN`) and deposit and refund on NEAR (`ORIGIN_CHAIN`), so it can never keep our money inside NEAR Intents.
- **An alert that says what to do.** The stuck alert carries the explorer link, our payment's hash, the quote id, the refund address, the verified support channels, and the advice to ask for a refund rather than completion.
- **Stuck swaps stay watched, and close themselves when the outcome is clean.** They're re-checked every five minutes. A late refund closes the refill as refunded; a late completion closes it as credited once Bitrefill has the credit. Either way you're told and automatic refills resume. Only an unclear outcome still waits for a person.
- **Runbook.** A stuck refill's steps, verified support channels, and the manual fallback of topping up on bitrefill.com.

## Risks that remain

- 1Click can still stall a swap, and while it does the money isn't ours to move. Bound: one refill at a time, at most its amount + 1%, and automatic refills pause.
- A payment signed but not yet broadcast when the server crashes is resumed later with the same bytes, so it is never paid twice. If the server stays down for more than two minutes at that exact moment, that payment goes out on an older quote. 1Click should still refund it from our deadline.
- We call 1Click without an API key: 0.2% extra per swap, and no partner relationship. A key from NEAR Intents' partner portal is worth getting before volume grows.

## How it closed

1Click completed the swap and Bitrefill credited it, so the money is all accounted for. The treasury paid 10.054603 USDC: 10.003574 bought the $10 of credit and 0.051029 came back, leaving the treasury at 14.996426 USDC. The refill itself is closed by the stuck-swap check from PR #5, which finds the swap succeeded and Bitrefill credited, and records it as credited.

Follow-up the same day: refills now land in our own Base wallet first and pay Bitrefill only once the USDC is there (ADR-0009, amended "Base wallet"), so a late completion like this one can't reach an expired invoice at all.

Lessons beyond the code: launch a network with the treasury set and funded before the server starts (the code now makes this order safe either way), and send support our own payment's hash: we first sent 1Click's forwarding hash by mistake.
