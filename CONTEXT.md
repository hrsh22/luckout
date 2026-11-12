# Luckout

Luckout ("checkout, but lucky") is a voucher shop, run on NEAR with a Web App and a Telegram Agent, where customers buy at the current Bitrefill price or pay a little extra up front for Cashback, sometimes all of it. See `docs/adr/`, starting with ADR-0001 and ADR-0002.

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
The customer's USDC held by the contract on their behalf; purchases debit it, Cashback and failed purchases credit it, and any unlocked amount can be withdrawn at any time.
_Avoid_: Wallet, account credit, house funds

**Top-Up**:
Moving value from any supported chain into a customer's Balance through a NEAR Intents swap followed by a deposit.
_Avoid_: Payment, bridge

**Intents Account**:
A customer's own account in NEAR Intents, named after their EVM address and controlled only by their EVM key; an EVM wallet's Top-Ups pass through it and its withdrawals return to it, and Luckout moves money out of it only with the customer's signature.
_Avoid_: Deposit address, wallet, sub-account

**Agent**:
The Telegram chat bot that searches, quotes, and buys on a customer's behalf; like the Web App, it can only buy through the server, whose NEAR key is restricted to the contract's purchase methods.
_Avoid_: Custodian, operator, wallet

**Web App**:
The browser storefront where a customer connects their NEAR wallet, tops up, sets Spending Limits, links Telegram, buys, watches Draws, and reads purchase history and Redemption Data.
_Avoid_: Dashboard, admin console

**Bitrefill Credit**:
Our USD store credit at Bitrefill, which pays for every real card and can't be refunded; kept between a floor and a ceiling at about a day of sales with a Base Float (two without).
_Avoid_: Float, balance (that's the customer's), wallet

**Refill**:
Topping up the Bitrefill Credit: a NEAR Intents swap from the Treasury into the Base Wallet, then an exact USD deposit paid from the Base Wallet to Bitrefill.
_Avoid_: Top-Up (that's the customer's), recharge

**Treasury**:
The server-held account that pays Refills. The contract lets it pull Proceeds only to itself, within a daily cap the owner sets, or not at all in manual mode.
_Avoid_: Hot wallet, float account

**Base Wallet**:
Our address on Base, derived from the Treasury through NEAR Chain Signatures, with no key of its own. Refills land here and pay Bitrefill from here, so a late swap can never pay an expired invoice.
_Avoid_: EVM wallet, hot wallet

**Base Float**:
USDC kept ready in the Base Wallet, so a Refill pays Bitrefill in about a minute instead of waiting on a swap; topped back up from the Treasury once it's under half. Unlike Bitrefill Credit, it's still ours.
_Avoid_: Buffer, reserve (that's the Cashback Reserve)

**Relayer**:
The server's NEAR account that sends a customer's own wallet-signed calls (deposits, withdrawals, settings) and pays their network fee, so customers need no NEAR; it can only send what the customer signed.
_Avoid_: Paymaster, gas station, sponsor

**Spending Limit**:
A per-purchase or per-day cap the customer sets on their own Balance, enforced by the contract against every Agent action.
_Avoid_: Admission Policy, allowance

**Standard Purchase**:
The Normal mode: the customer buys a Voucher at exactly Reference Price, with no Draw and no fee.
_Avoid_: Safe bet, fee-bearing purchase

**Lucky Buy**:
A purchase in which the customer pays a bounded Maximum Price for a guaranteed Voucher and a Draw determines the Cashback, which always leaves the price below Reference Price when there is any.
_Avoid_: Spin, gamble, lottery ticket

**Voucher Guarantee**:
The promise that every successfully completed Lucky Buy delivers the exact Voucher the customer selected, regardless of the Draw outcome.
_Avoid_: Principal protection, no-loss guarantee

**Redemption Data**:
The private code, PIN, link, or instructions needed to use a Voucher, delivered only in the customer's private chat.
_Avoid_: Voucher, public metadata, onchain token

**Game Version**:
An immutable table of Cashback slabs and probabilities that a customer accepts before a Lucky Buy, stored onchain as Final Price percentages. The live versions are Lite (+10%), Classic (+20%), and Jackpot (+50%); all share the same Target Gross Margin and differ only in how much extra is paid up front and how often and how big the Cashback is.
_Avoid_: Live odds, mutable configuration, difficulty

**Default Mode**:
The mode, Normal or one of the Game Versions, that a customer chooses once and every purchase uses unless they pick another for that purchase.
_Avoid_: Recommended mode, auto mode

**Maximum Price**:
The greatest Final Price a customer can pay for a Lucky Buy, equal to Reference Price plus its Game Version's premium (10%, 20%, or 50%) on the Lucky Amount.
_Avoid_: Bet size, maximum loss

**Risk Premium**:
The difference between a Lucky Buy's Maximum Price and its Reference Price; it is charged only on the Lucky Amount.
_Avoid_: Entry fee, wager

**Draw**:
The random event, run by the contract in the receipt right after the one that confirms delivery, that determines a Lucky Buy's Cashback; it never changes the selected Voucher or whether the customer receives it, and nothing can undo the confirmation once the Draw is scheduled.
_Avoid_: Bet result, spin result, reveal animation

**Cashback**:
Money credited automatically to the customer's Balance from a Lucky Buy's Draw, as a share of what they paid in 10% slabs (100% is free). Any Cashback leaves the Final Price below Reference Price.
_Avoid_: Refund (in anything customers read), yield, token reward, partial cashback

**Final Price**:
The Maximum Price minus the Cashback.
_Avoid_: Loss, swap output

**Reference Discount**:
The amount by which a Lucky Buy's Final Price falls below its Reference Price. No Game Version may pay Cashback that still leaves the price above Reference Price.
_Avoid_: Refund, prize, winnings

**Target Gross Margin**:
The long-run expected amount above Reference Price, before operating costs, across many Draws: exactly 5.6% for every Game Version and purchase size. It is the only revenue.
_Avoid_: House edge, guaranteed profit, per-order fee, top-up fee

**Failed Purchase**:
A purchase the operator marks as undeliverable; the full amount debited returns to the customer's Balance with no Draw.
_Avoid_: Cancellation, Draw loss

**Reclaim**:
The customer's right to recover the full amount debited for a purchase the operator has neither confirmed nor failed within 24 hours.
_Avoid_: Cancellation, chargeback

**Cashback Reserve**:
The operator-funded pool in the contract that backs Lucky Buy Cashback; the portion locked for accepted purchases forms Locked Draw Liabilities and the rest is Free Reserve.
_Avoid_: Refund Reserve, liquidity pool, treasury

**Locked Draw Liability**:
The Free Reserve held for one accepted Lucky Buy: its largest possible Reference Discount, which is the part of its largest Cashback not already covered by its own Risk Premium. It is held until that purchase is confirmed, failed, or reclaimed.
_Avoid_: Free Reserve, operator funds

**Free Reserve**:
Cashback Reserve not locked against an accepted Lucky Buy; the operator may withdraw it, which reduces capacity for new Lucky Buys.
_Avoid_: Protocol revenue, customer funds

**Cashback Cap**:
The most Cashback one Lucky Buy can pay: the lower of a fixed amount and a share of Free Reserve at admission, both set by the owner. Either limit may be off, but not both. It never limits purchase size, only the Lucky Amount, and never changes an accepted purchase.
_Avoid_: Discount Cap (its share once limited the Reference Discount instead), prize limit, purchase cap

**Lucky Amount**:
The part of a Lucky Buy's Reference Price that its Game Version applies to: the whole price, or less when the full price's largest Cashback would exceed the Cashback Cap or its Reserve Lock would exceed Free Reserve. The Risk Premium is charged only on this part, and the rest is bought at Reference Price.
_Avoid_: Stake, bet size

**Draw Proof**:
The public record of one Draw: its transaction, random seed, purchase ID, and Game Version, from which anyone can recompute the Cashback in their browser.
_Avoid_: Receipt, audit log

**Live Average**:
The public, running average Final Price of all settled Lucky Buys, shown beside the promised 105.6% of Reference Price.
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
