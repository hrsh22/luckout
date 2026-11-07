# The Agent prepares purchases and the customer confirms them

The Agent is a language model reading untrusted text: customer messages, voucher names and descriptions from Bitrefill, and anything a customer pastes. Any of it can carry instructions. So the Agent's safety comes from what it cannot do, not from its prompt.

The model's tools can search the catalog, read prices, balances and quotes, list past purchases, and prepare a purchase. Preparing a purchase only puts a Confirm button under the reply, showing the voucher, the price and the most the customer could pay. Nothing is bought until the customer taps it. The server checks that the tap comes from the same Telegram user the purchase was prepared for, accepts each confirmation once, and drops it after 10 minutes. The confirmation's id becomes the purchase's idempotency key, so a double tap can't buy twice. Behind that, the contract enforces the customer's Spending Limits on every purchase whoever submits it, so even a fully compromised server or Agent can spend at most those limits (`apps/server/scripts/attack.ts` demonstrates this with the operator's key).

Redemption Data never enters the model's context: the purchase tools return names, prices and statuses, and the bot sends codes to the customer itself, in a private chat. The bot ignores group chats. Telegram is linked to a NEAR account only through the Web App, whose session comes from a NEP-413 signature by a full-access key, so whoever controls the Telegram account can't link it to someone else's balance.

Rejected: letting the model buy directly under a per-purchase cap (a prompt injection could still spend up to the cap without the customer's knowledge), and confirming by typing "yes" (the model, or text it was shown, could produce the same words).
