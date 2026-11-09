# Luckout

Luckout ("checkout, but lucky") is a voucher shop, run on NEAR with a Web App and a Telegram Agent, where customers buy at the current Bitrefill price or pay a bounded premium for a chance to pay much less. See `docs/adr/`, starting with ADR-0001 and ADR-0002.

## Language

**Voucher**:
A prepaid product with a stated monetary value that the customer selects and is guaranteed to receive after a completed purchase.
_Avoid_: Prize, winnings, item

**Face Value**:
The monetary denomination printed on or redeemable through a Voucher; it is descriptive and is not the basis for Lucky Buy percentages.
_Avoid_: Ticket price, stake

**Reference Price**:
The current Bitrefill price for the selected Voucher, expressed in USDC; Lucky Buy percentages are calculated from this amount rather than Face Value.
_Avoid_: Face value, retail price

**Purchase Quote**:
The terms of one purchase: Voucher, Reference Price, Game Version, and Maximum Price. It uses the customer's Default Mode unless they pick another for that purchase; a Standard Purchase has no Game Version or Maximum Price.
_Avoid_: Estimate, floating price

**Balance**:
The customer's USDC held by the contract on their behalf; purchases debit it, Refunds and failed purchases credit it, and any unlocked amount can be withdrawn at any time.
_Avoid_: Wallet, account credit, house funds

**Top-Up**:
Moving value from any supported chain into a customer's Balance through a NEAR Intents swap followed by a deposit.
_Avoid_: Payment, bridge

**Agent**:
The Telegram chat bot that searches, quotes, and buys on a customer's behalf; like the Web App, it can only buy through the server, whose NEAR key is restricted to the contract's purchase methods.
_Avoid_: Custodian, operator, wallet

**Web App**:
The browser storefront where a customer connects their NEAR wallet, tops up, sets Spending Limits, links Telegram, buys, watches Draws, and reads purchase history and Redemption Data.
_Avoid_: Dashboard, admin console

**Spending Limit**:
A per-purchase or per-day cap the customer sets on their own Balance, enforced by the contract against every Agent action.
_Avoid_: Admission Policy, allowance

**Standard Purchase**:
The Normal mode: the customer buys a Voucher at exactly Reference Price, with no Draw and no fee.
_Avoid_: Safe bet, fee-bearing purchase

**Lucky Buy**:
A purchase in which the customer pays a bounded Maximum Price for a guaranteed Voucher and a Draw determines a Refund, allowing some outcomes below Reference Price.
_Avoid_: Spin, gamble, lottery ticket

**Voucher Guarantee**:
The promise that every successfully completed Lucky Buy delivers the exact Voucher the customer selected, regardless of the Draw outcome.
_Avoid_: Principal protection, no-loss guarantee

**Redemption Data**:
The private code, PIN, link, or instructions needed to use a Voucher, delivered only in the customer's private chat.
_Avoid_: Voucher, public metadata, onchain token

**Game Version**:
An immutable table of Final Price percentages and probabilities that a customer accepts before a Lucky Buy. The live versions are Classic (+10%), Bold (+25%), and Jackpot (+50%); all share the same Target Gross Margin and differ only in how much extra is risked and how big the wins are.
_Avoid_: Live odds, mutable configuration, difficulty

**Default Mode**:
The mode, Normal or one of the Game Versions, that a customer chooses once and every purchase uses unless they pick another for that purchase.
_Avoid_: Recommended mode, auto mode

**Maximum Price**:
The greatest Final Price a customer can pay for a Lucky Buy, equal to Reference Price plus its Game Version's premium (10%, 25%, or 50%) on the Lucky Amount.
_Avoid_: Bet size, maximum loss

**Risk Premium**:
The difference between a Lucky Buy's Maximum Price and its Reference Price; it is charged only on the Lucky Amount.
_Avoid_: Entry fee, wager

**Draw**:
The random event, run by the contract in the receipt right after the one that confirms delivery, that determines a Lucky Buy's Refund; it never changes the selected Voucher or whether the customer receives it, and nothing can undo the confirmation once the Draw is scheduled.
_Avoid_: Bet result, spin result, reveal animation

**Refund**:
Money credited automatically to the customer's Balance from a Lucky Buy's Draw, reducing its Final Price and sometimes bringing it below Reference Price.
_Avoid_: Yield, token reward, cashback

**Final Price**:
The Maximum Price minus the Refund.
_Avoid_: Loss, swap output

**Reference Discount**:
The amount by which a Lucky Buy's Final Price falls below its Reference Price. Getting some Refund while still paying above Reference Price is never called a discount or win.
_Avoid_: Refund, prize, winnings

**Target Gross Margin**:
The long-run expected amount above Reference Price, before operating costs, across many Draws: 6% for every Game Version and purchase size. It is the only revenue.
_Avoid_: House edge, guaranteed profit, per-order fee, top-up fee

**Failed Purchase**:
A purchase the operator marks as undeliverable; the full amount debited returns to the customer's Balance with no Draw.
_Avoid_: Cancellation, Draw loss

**Reclaim**:
The customer's right to recover the full amount debited for a purchase the operator has neither confirmed nor failed within 24 hours.
_Avoid_: Cancellation, chargeback

**Refund Reserve**:
The operator-funded pool in the contract that backs Lucky Buy Refunds; the portion locked for accepted purchases forms Locked Draw Liabilities and the rest is Free Reserve.
_Avoid_: Liquidity pool, treasury

**Locked Draw Liability**:
The Free Reserve held for one accepted Lucky Buy: its largest possible Reference Discount, which is the part of its largest Refund not already covered by its own Risk Premium. It is held until that purchase is confirmed, failed, or reclaimed.
_Avoid_: Free Reserve, operator funds

**Free Reserve**:
Refund Reserve not locked against an accepted Lucky Buy; the operator may withdraw it, which reduces capacity for new Lucky Buys.
_Avoid_: Protocol revenue, customer funds

**Discount Cap**:
The largest Reference Discount one Lucky Buy can produce: 20% of Free Reserve at admission. It never limits purchase size, grows as the reserve grows, and never changes an accepted purchase.
_Avoid_: Purchase cap, mode restriction

**Lucky Amount**:
The part of a Lucky Buy's Reference Price that its Game Version applies to: the whole price, or less when the full price's largest discount would exceed the Discount Cap. The Risk Premium is charged only on this part, and the rest is bought at Reference Price.
_Avoid_: Stake, bet size

**Draw Proof**:
The public record of one Draw: its transaction, random seed, purchase ID, and Game Version, from which anyone can recompute the Refund in their browser.
_Avoid_: Receipt, audit log

**Live Average**:
The public, running average Final Price of all settled Lucky Buys, shown beside the promised 106% of Reference Price.
_Avoid_: House edge, RTP

**Running Total**:
A customer's total Reference Discounts minus their total Risk Premiums paid, shown as how far ahead or behind they are overall.
_Avoid_: Profit, winnings

**Win Card**:
A shareable image of a Lucky Buy that ended below Reference Price, linking to its Draw Proof and never showing Redemption Data.
_Avoid_: Receipt, ticket

**Autopilot**:
A customer-defined recurring purchase, such as a weekday lunch voucher, that the Agent executes without asking each time, always within Spending Limits.
_Avoid_: Subscription, standing order
