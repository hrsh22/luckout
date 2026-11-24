# Take ORE through a Jupiter swap the customer signs

Customers asked to pay with ORE, a Solana token. NEAR Intents 1Click doesn't list it (none of its 233 tokens, checked 2026-11-24), and Bitrefill doesn't take it, so a Top-Up (ADR-0001) can't start from ORE as it is. Jupiter, Solana's swap aggregator, routes ORE to USDC with about $870k of liquidity. ORE also moves fast: it went from $77.41 to $70.84 within an hour that day. So whatever turns ORE into USDC must not let time pass between the price the customer sees and the swap.

So a token 1Click doesn't take is paid through **one Solana transaction that Luckout builds and the customer's own wallet signs**. Everything after it is an ordinary Solana USDC Top-Up:

- **1Click is quoted from USDC on Solana**, as for any Solana USDC Top-Up (EXACT_OUTPUT, the same recipient and refund rules). Its deposit address takes only USDC, so the app never shows it as somewhere to send ORE.
- **The transaction swaps an exact amount of ORE with a minimum out.** Jupiter's ExactIn swap turns exactly the ORE the customer was shown into USDC in their own wallet. Its minimum out, which Jupiter's program enforces, covers what 1Click needs, with 0.5% of room for the price to move while it lands. The same transaction then sends exactly 1Click's amount to the deposit address. If the price moves past that room, the whole transaction fails and only Solana's network fee is spent. Whatever the swap beats its minimum by stays in the customer's wallet as USDC.
- **Rejected: Jupiter's ExactOut,** which would deliver USDC straight to the deposit address. It routes through fewer pools: that day it cost 0.97–1.18% below ORE's market price, against 0.31% for ExactIn.
- **The server checks the transaction before handing it out.**
  - **The route:** price impact at most 1%, no more than 1.5% under Jupiter's market price, only liquid intermediate tokens.
  - **Jupiter's instructions:** only a compute budget, opening the wallet's own token accounts and the swap itself. Anything else, such as a token `Approve`, is refused, because a delegate would leave today's balances unchanged and empty the account later.
  - **The order of checks:** the chain is read before Jupiter is called, so a wallet without the ORE, or a Top-Up already being paid, costs no Jupiter calls.
  - **The outcome:** it simulates the transaction against the chain and checks what it does. The deposit address gets exactly 1Click's USDC. The wallet spends exactly the ORE shown, none of its own USDC, and at most 0.005 SOL.

  A route whose simulation fails on slippage, a market with a stale quote, is rebuilt once without that route's markets.
- **It can't pay twice.**
  - **On chain:** the deposit address's USDC account is opened in the transaction, and not idempotently. Once one payment has landed, any other transaction built for the same quote fails, whether it came from a second tap or from the code scanned as well as the wallet.
  - **On the server:** while one wallet's transaction may still land (90 seconds), no other wallet gets one for that quote.
  - **Near the deadline:** none is built within 2 minutes of the quote's deadline.
- **Only a payment found on chain counts.** A transaction the app says it sent may still fail or never land, and the customer must be able to send another. The tracking pass records a payment once it finds a transaction that put the needed USDC into the deposit address's account.
- **Two ways to sign.** A customer signed in with a Solana wallet signs it in the app. Anyone else pays by scanning the Top-Up's Solana Pay code with Phantom, Solflare or Backpack. Their wallet asks `/solana-pay/<deposit address>` for the same transaction, built for that wallet. The server finds that payment on chain (the deposit address's USDC account), so a paid Top-Up stays in sight even if the app never hears of it.
- **Luckout never holds the ORE.** It moves from the customer's wallet to Jupiter's pools in the customer's own transaction. 1Click's change and refunds go where a Solana USDC Top-Up's go. An EVM wallet has no Solana address, so its change, USDC on Solana in its Intents Account, is sent back to it as USDC on Base.
- **No fee of ours.** No Jupiter platform fee is added: Luckout earns only from the Lucky Buy margin (ADR-0003).

Adding another Solana token is one line in `SWAP_TOKENS` (`apps/server/src/Swap.ts`), after its liquidity has been checked. Without a Jupiter API key (`JUPITER_API_KEY`), no swap-paid token is offered. The Telegram bot doesn't offer ORE: its Mini App and bot may only take TON.

Rejected for now:

- **A deposit address for ORE sent from an exchange.** Luckout would hold the customer's ORE until it swaps it, and refund it when the price moves. That needs its own decision.
- **Letting the swap deliver to 1Click without a minimum out.** The customer couldn't know the most it costs.
