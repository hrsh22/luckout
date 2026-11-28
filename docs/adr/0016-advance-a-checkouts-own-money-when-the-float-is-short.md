# Advance a Checkout's own money when the float is short

The Pay Wallet's float pays each Checkout's Bitrefill invoice, and `settle` repays it from the Vault once the cards are delivered (ADR-0015). A Checkout bigger than the free float waited uncharged for up to an hour, and was then cancelled. The float was meant to make purchases instant, but it was capping their size. Keeping a float as big as the biggest Cart would leave hundreds of dollars on a hot key for nothing.

ADR-0015 rejected "the program paying invoices straight from the Vault", because the money would leave before delivery, and a failed card would then be refunded from the Vault before Bitrefill refunds us. This reverses that for the **shortfall only**. The float still pays what it can, and nothing but the shortfall leaves early.

## What the program does

- **`advance`, signed by the operator,** sends part of one Checkout's own money from the Vault to the Pay Wallet, and records it on that Checkout and as a total on Config.
  - It is only ever that Checkout's money. A Checkout's advance never exceeds its Pending cards' Reference Prices.
  - It counts against the daily repay cap, as `settle`'s repayments do, and it fails when the cap has no room: unlike a repayment, nothing can wait as Proceeds instead. What stolen operator and Pay Wallet keys can move in a day stays what it was.
  - It is refused while the program is paused.
- **`settle` takes delivered cards from the advance first.** What a delivered card owes the Pay Wallet is covered by the Checkout's advance before anything is repaid, and only the rest counts against the cap.
- **A failed or reclaimed card is still due its full Maximum Price.** What the Vault still holds for it goes to the Balance at once. The part of the advance the Checkout's remaining Pending cards no longer back has already paid Bitrefill, so it becomes a **pending refund**: an exact amount on that Checkout, totalled on Config.
  - The Vault never pays it with money it doesn't hold for that customer. Other customers' Balances, the Cashback Reserve and Proceeds are never touched.
  - Delivered cards take the advance before failed ones, so the customer is owed as little as possible.
  - The Checkout stays open, and keeps its rent, until nothing is owed.
  - Lucky cards' reserve locks and Draws are as before.
- **`pay_refund`, signed by whoever brings the USDC,** moves it from their account into the Vault and credits the customer's Balance. In practice the Pay Wallet signs; the owner can too. It never credits more than is pending.
- **The Vault's equation** becomes: Balances + open cards' money − outstanding advances + the reserve + Proceeds. The Monitor's solvency check follows it.

## What the server does

- **A Checkout is admitted when the float and the cap's room together cover it.** The free float is the Pay Wallet's USDC, less the pending refunds it owes and what Checkouts on their way are yet to pay. The cap's room is the daily repay cap, less what was repaid and advanced today. Past both, the Checkout waits uncharged as before, and the alert says the cap is why.
- **The advance and the payment are one transaction.** At the `pay` step, the server works out what the float can't pay of this invoice and sends `advance` for exactly that, with the transfer to Bitrefill, signed by the operator and the Pay Wallet.
  - An order Bitrefill refuses is never paid, so it needs no advance.
  - No crash can leave a Checkout advanced and unpaid.
  - A payment the program or the token program refuses moves nothing, the advance included. The Checkout waits as `restock`, as before.
  - It is saved signed before it's sent and resumed after a crash, like every payment, so nothing is ever advanced or paid twice.
- **One lock for every spend from the Pay Wallet.** Placing a Checkout, a payment with its advance, and paying a pending refund all run under the float's lock, from deciding until the transaction lands or fails. So two of them never count on the same USDC.
  - A payment uses the float first and advances the rest. The total advanced across Checkouts on their way is what they need beyond the float, and it fits in the cap's room their admission checked.
  - The lock is held across a send: seconds, or a minute if the chain stalls. Placements wait behind it.
- **Pending refunds come first.** A failed card's settlement pays its pending refund in the same transaction when the Pay Wallet holds the money beyond the refunds it already owes. Otherwise it waits on the chain, and the server pays pending refunds oldest first, every 10 seconds, as soon as the Pay Wallet's USDC covers one. That money can come from other settlements, an owner's top-up, or Bitrefill's refund. The admins hear when a refund becomes pending and when it is paid, and the Monitor alerts on one still owed after an hour.
- **Undelivered invoices are kept for follow-up.** For each paid invoice Bitrefill didn't deliver, the Admin panel lists the checkout, the customer, the invoice id, our payment's signature, when it landed, what it advanced, each card's price, and the customer's refund: paid at once, pending, or paid later, each with its transaction. An admin marks Bitrefill's refund received, with its transaction. Bitrefill's guest invoice lookup reports only an invoice's status and its orders, not a refund, so nothing is read from it.

## Accounts

- **Layout 2** puts the Checkout's `advanced` and `refund_pending`, and Config's `advanced` and `refunds_pending`, in what were spare bytes.
  - An account layout 1 wrote reads them as 0, so live accounts need no migration and no resize. The Checkout's spare bytes are now used up, so its next field needs a bigger account. Checkouts live a day at most, so new ones can simply be made bigger.
  - Every account this build creates, and a Checkout it advances, is written as layout 2, so a rolled-back build refuses it rather than misread it. Config keeps its layout byte: an older build never acts on the totals and carries them through untouched.

## Rejected

- **Advancing before the order.** The advance would leave the Vault for orders Bitrefill then refuses, and the customer would be owed a refund for nothing.
- **Advancing as its own transaction before the payment.** A crash between the two would leave money advanced and unpaid, needing its own recovery.
- **Recording pending refunds on the Customer account.** One total per customer can't say which purchase it is for, and the Checkout already holds that purchase's money and cards.
- **A refund from the Vault, repaid by the Pay Wallet later.** It would pay one customer with others' money until then.

**Supersedes** ADR-0015's rejection of the program paying invoices from the Vault, for the shortfall only. The rest of ADR-0015's "Paying Bitrefill" stands. Accepted 2026-11-28. The program's change needs an in-place upgrade of each environment's program, extended first, before the server that uses it is deployed.
