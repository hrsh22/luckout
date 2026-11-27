# Move to Solana, with Privy as the only login

Bitrefill takes nothing on NEAR, so every card is paid through a shuttle. The Treasury pulls Proceeds, Refills swap them through NEAR Intents into the Base Wallet that Chain Signatures controls, and the Base Wallet pays Bitrefill (ADR-0009, ADR-0012). On top of that, the Relayer pays customers' NEAR gas (ADR-0008), and EVM and Solana wallets reach the contract through Intents Accounts (ADR-0011). Most of the server is this plumbing. Login is wallets only: Reown's email and social logins are switched off because those accounts can't pass Intents key recovery. Our customers are mostly in India and hold USDT. We compared NEAR, Solana, Base, Polygon, Arbitrum and TON (`docs/research/chain-choice.md`).

So Luckout moves to **Solana**, and **Privy** becomes the only login:

- **The shuttle goes.** Bitrefill takes USDC and USDT on Solana, so the program's money pays invoices on its own chain.
- **No Relayer.** Solana lets us pay any transaction's fee, so customers need no SOL.
- **The contract stays in Rust**, rewritten with Anchor.
- **The cost:** a randomness provider for the Draw (about $0.13 a Checkout) and rent for every account, most of it refundable.

## The program keeps today's rules

Balance, Spending Limits, Default Mode, Game Versions, Lucky Amount, Cashback Cap, Cashback Reserve, the 24-hour Reclaim, Failed Purchases, a pause that stops only new purchases, and exact integer USDC (ADR-0002, ADR-0004) all work as they do now. The game maths and its test vectors carry over from `contract/src`. What changes is how state is laid out and where the Draw's randomness comes from.

**Accounts**

- **Config:** the owner, operator and Pay Wallet; the Game Versions and Cashback Cap; the reserve totals, Proceeds and the daily repay cap; the smallest Lucky Checkout; and the Live Average counters.
- **Vault:** one USDC account the program owns. Every Balance, the Cashback Reserve and Proceeds sit in it.
- **Customer account:** one per customer, belonging to their Privy wallet. The one-time approval opens it, with the Default Mode chosen in Welcome, for about $0.12 of rent. It holds their Balance, Spending Limits, Default Mode, Running Total and a count of their Checkouts.
- **Checkout account:** one per Checkout, holding up to 15 cards. Each card has its own status, Lucky Amount, lock and Cashback, so each keeps its own refund and Reclaim (ADR-0013).
  - **Duplicates fail, even after closing.** The account's address comes from the customer and the Checkout's number. Admission names the number it expects, and only the customer's next number is accepted. So a retry of an admitted Checkout fails, even after its account has closed and the address is free again. This replaces the contract's `orders` map.
  - **It closes when done.** It closes when its last card is done, and its rent comes back.
- **Room to grow.** Every account starts with a version byte and spare bytes, so a new field rarely needs a resize.

**Who calls what**

- **The customer signs, and we pay the fee:** the one-time deposit approval, a USDT deposit, withdraw, set Spending Limits, set the Default Mode, Reclaim.
- **The operator:** admits a Checkout, and settles it by confirming the delivered cards and failing the rest. A Buy is a Checkout of one card, so the single-card methods ADR-0013 kept for older servers go.
- **Anyone:** finishes a Draw whose randomness has arrived, and requests it again if it never arrives (below). Anyone can also move USDC a customer has approved into that customer's own Balance (`deposit_for`, below).
- **The owner:** Game Versions, the Cashback Cap, the smallest Lucky Checkout, the operator, the Pay Wallet, the repay cap, pause, reserve and Proceeds withdrawals, and upgrades. For now it is one key in our own wallet, never on the VM, with no time lock, so it can pause at once. The Admin panel builds these transactions for that wallet to sign, as it does today.
- **Ready for a multisig later.** The owner changes by propose and accept, as in today's contract, and the upgrade authority moves with one command. So both can move to a Squads multisig with a time lock without changing the program. At that point a small upgrade adds a pause-only guardian key, using the spare bytes, so the time lock never delays a pause.

## The Draw can't be re-rolled

- **Delivery is confirmed first.** As today, nothing that sees an outcome can undo a confirmation (ADR-0001, amended).
- **`settle` asks for randomness once.** In the same instruction, it requests one value from ORAO's VRF for the cards it confirmed. The seed comes from the Checkout's address and how many times it has been settled. Neither we nor the customer choose it.
- **Anyone can finish the Draw.** Once ORAO's oracles have filled in the request, the program reads the stored value. Each card's random value is `sha256(value ‖ card)`, so cards drawn together stay independent (ADR-0013).
- **Finishing again only re-reads.** It reads the same value again. No retry asks for a new value, and there is no callback that can go missing.
- **ORAO over MagicBlock.** ORAO stores the result for the program to read. MagicBlock calls the program back, and a failed callback would need a retry path.
- **The program checks the randomness account.** It must belong to ORAO's program, sit at the address our seed gives, and be filled. Otherwise anyone finishing a Draw could hand it a forged value.
- **A request that's never filled can be replaced.** If ORAO hasn't filled it after an hour, anyone may request again under the next seed, and the card uses its latest request. So a card's lock is never held forever. Only ORAO could re-roll a Draw by withholding a value, and it is trusted already. The Cashback Cap's fixed amount stays on to limit that.
- **The Draw Proof is checkable.** It is the request, ORAO's filled-in value and its signatures, the card and its Game Version. It is recorded with Anchor's `emit_cpi!`, so long transaction logs can't cut it off. Anyone can check the value against ORAO's oracle keys and recompute the Cashback (ADR-0005). The server also keeps each proof in Postgres, with ORAO's filling transaction and its oracle keys at the time, so a proof never depends on an archival RPC. This replaces NEAR's block seed, which the block producer could predict.
- **One request per settle, not per card.** A request costs about 0.0019 SOL (about $0.13): ORAO's 0.0005 SOL fee, plus 0.0013 SOL of rent that its request account keeps for good (read from mainnet on 2026-11-27). The 5.6% margin covers that from about $2.40 of Lucky Amount. So a Checkout's Lucky Amounts must add up to the smallest Lucky Checkout, an owner setting that starts at 2.5 USDC and moves with SOL's price. A slow card settled later costs a second request, which a small Checkout's margin doesn't cover. That's accepted.

## Paying Bitrefill

- **The Pay Wallet pays invoices.** It is a key on our VM holding a small USDC float, and it pays each Checkout's invoice in USDC on Solana (`usdc_solana`). Cards are bought as a guest or on the customer's Bitrefill Connection, as ADR-0012 says.
- **Bitrefill agreed to one paying address** (2026-11-27). They screen and tag the address that pays all our invoices, with limits of $10k a day and $50k a month. So each Solana Pay Wallet's address goes to Bitrefill for tagging before it pays anything.
- **`settle` repays it at once.** In the same instruction, it sends the delivered cards' Reference Prices from the Vault to the Pay Wallet, up to a daily cap the owner sets. Past the cap, they wait as Proceeds for the owner. Reaching the cap fails nothing, but the float runs down, so the monitor warns at 80% and the owner raises the cap as sales grow.
- **The float stays small.** It only covers Checkouts in flight for a few minutes: about $300–500, not a day of sales.
- **A failed card's refund is claimed, as today.** The Pay Wallet paid for the card, and the program refunds the customer from the Vault. Bitrefill doesn't send a guest invoice's refund back by itself, so an alert names the invoice, and we claim the refund to the Pay Wallet.
- **The shuttle's parts go.** The Treasury, Refills, the Base Wallet, the Base Float and Chain Signatures are no longer needed.
- **A stolen operator key gets no more than today.** It can confirm cards that were never delivered, and the daily cap bounds what leaves.
- **Rejected: the program paying invoices straight from the Vault.** The money would leave before delivery, and a failed card would be refunded from the Vault before Bitrefill refunds us. That is the parked advance-against-collateral design.

## Privy is the only login

- **One sign-in window.** Customers sign in with email, Google, Telegram or an external Solana wallet (Phantom, Solflare, Backpack), all in Privy's own window. Only that window makes a wallet for someone who signs in with Phantom, so there's no login screen of our own.
- **Everyone has a Privy Solana wallet.** Every customer gets one, even one who signs in with Phantom, and their Customer account belongs to it. An external wallet only pays in. One rule covers everyone, and the same address takes deposits from the app or the bot.
- **NEAR and EVM sign-in go.** EVM chains and NEAR stay Top-Up sources through 1Click.
- **Linking Telegram happens in Privy.** The server reads the link from Privy.
- **The login email fills in the Checkout Email.** The customer can change it.
- **Customers can export their key.** The Privy wallet is theirs, so they can always leave without us or Privy.
- **Privy isn't used for onramps or gas.** It has no Indian onramp coverage, and we pay the fees.

## Deposits arrive by themselves

- **Each customer has a Deposit Address.** It is their Privy wallet's address: permanent, any amount, from any exchange or wallet.
- **The customer approves once.** The first time they ask for their Deposit Address, their Privy wallet signs one transaction, with no prompt, and our fee payer pays for it. It opens the wallet's USDC account and their Customer account, and makes the Vault's authority that USDC account's delegate. In the bot, it's a link that opens the app.
- **The program decides where the money goes.** `deposit_for(customer)`, which anyone may call, moves USDC from that account into that customer's own Balance and nowhere else. No key of ours can send it anywhere else, whoever holds it.
- **The server calls it.** Our RPC provider's webhook reports each transfer, and a sweep every few minutes catches any the webhook missed. Less than 1 USDC waits until more arrives.
- **An account has one delegate.** If another app's approval replaces ours, the server notices and asks for the approval again at the next visit.
- **USDT takes one tap for now.** The customer's wallet signs Jupiter's swap and the deposit in one transaction, checked the way ADR-0014 checks swaps. In the bot, the Agent sends a link that opens it in the app. Later, the program may swap USDT itself, with its own minimum out.
- **Other chains go through 1Click.** A quote delivers USDC on Solana to the Deposit Address, and the rest is as above. With Intents Accounts gone, 1Click's refunds need an address on the source chain. The app knows it when the customer pays from a connected wallet; otherwise the customer gives one first.
- **ORE becomes one transaction** (ADR-0014): the Jupiter swap and the deposit, with no 1Click.
- **Rejected: a Privy session signer on our server.** Its limits are only as strong as whoever can change its policy, and a break-in on the VM might be able to. The delegate puts the limit in the program instead.

## The Agent takes deposits

- **It asks how the customer will pay.** When a customer is short, the Agent asks which token and chain they'll use, and how much: at least what's missing, and at least 1 USDC.
- **It gives them where to send it.**
  - **USDC or USDT on Solana:** their Deposit Address.
  - **Anything else 1Click takes:** a 1Click deposit address for that token, with the amount, the deadline, and a memo where the chain needs one.
    - It asks for a refund address on that chain first. 1Click refunds to the address we give it, not to the sender, who may be an exchange.
    - The quote swaps whatever arrives above its minimum (`FLEX_INPUT`), so the extra sent for fees lands in the Balance too.
- **One tap confirms both, until the quote expires.** When the money reaches the Balance, the Agent buys the Checkout if its price still fits what the customer confirmed; the program checks `max_debit`. Otherwise it asks again.
  - **The confirmation lapses with the quote,** after 30 minutes. Money that lands later just stays in the Balance.
  - **It suggests a little extra** for exchange fees. If less arrives, it says how much is missing and doesn't buy.
  - **This amends ADR-0007.** A confirmation can wait for money to arrive, but only until its quote expires.
- **A new customer signs in once.** The bot sends them to the app to sign in with Telegram, and the same visit signs the approval. Privy could make a user from a Telegram account without that visit, but the approval would still need it.
- **Telegram's terms allow it while there's no Mini App.** Bot developer terms §7 limit crypto to TON in a Mini App and the bot connected to it. A bot with no Mini App is outside that rule, which is why the Agent can hand out addresses. So Luckout still has no Mini App. This corrects ADR-0014's closing line, which read the rule as covering every bot.

## Keys

- **Operator:** on the VM. It may admit and settle Checkouts, and pays for nothing.
- **Fee payer:** on the VM. It holds only SOL and has no rights in the program. It pays the fees of transactions the server built itself and never signs one a client built, so a crafted transaction can't borrow anyone's authority or drain its SOL.
- **Pay Wallet:** on the VM, holding the USDC float.
- **Owner and upgrade authority:** one key in our own wallet, kept off the VM. A Squads multisig with a time lock, and a guardian key, can take over later (above).

## Upgrades in place

- **Nothing moves.** The program upgrades without moving the Vault or any account, as on NEAR.
- **Every build is kept.** Every release build is kept and published as a verified build. Rolling back means redeploying the previous one.
- **Before an upgrade:** pause, let pending Draws finish, and keep the accounts that finishing a Draw takes unchanged.
- **New fields** go into spare bytes. Migration code gets written only when a field first outgrows them.
- **Rollback is either safe or refused.** A build refuses any account whose version byte is newer than it knows, so a rolled-back build can't misread one. Each release says whether it changes a layout, and so whether it can be rolled back.
- **The upgrade authority stays** until the program is stable.
- **A new program address** means taking the money out through the old program first.

## Environments

This replaces ADR-0010's testnet.

- **Tests and development:** a local validator, with ORAO's program and a filled randomness account loaded into it. The program has no test-only path.
- **Devnet:** only for trying the program against ORAO's devnet. Nothing runs there long-term, and it has no 1Click, Jupiter or Bitrefill.
- **Staging and production:** mainnet, each with its own program and its own Privy app.
- **Rent:** a program locks 5.08 SOL per MB (read from mainnet on 2026-11-26), and an upgrade borrows the same again until it finishes. The build CI makes for deploys is 477 KB, about 2.43 SOL, so both programs and an upgrade's buffer need about 7.5 SOL.

## Running it

- **RPC:** a paid RPC with webhooks (Helius or similar).
- **Privy's price:**
  - free up to 499 monthly users and 50,000 customer signatures a month
  - then $299 a month up to 2,499 users, and $499 up to 9,999
  - our own keys' signatures don't count
- **Quotes:** they come from simulating the program's quote instruction, so pricing lives only in the program.
- **New alerts:**
  - the Pay Wallet's float is low
  - the fee payer's SOL is low
  - a Draw is still unfinished minutes after its request
  - a deposit failed, or a Deposit Address lost its approval
- **Review:** no outside security review for now. It gets decided again before real customer volume.

## What this replaces

- **Superseded:**
  - ADR-0001's choice of NEAR and its block seed
  - ADR-0008
  - ADR-0009
  - ADR-0010's testnet
  - ADR-0011
  - ADR-0012's Base payment
  - ADR-0013's single-card methods and `on_draw_many`
  - what ADR-0005's recompute takes as input
  - ADR-0014's 1Click step
- **Still in force:** ADR-0002, ADR-0003, ADR-0004, ADR-0006, and ADR-0007 as amended above.

## Rejected

- **Base:** Chainlink randomness costs under a cent, and the Solidity would run on any EVM chain. But Bitrefill takes only USDC there, which our USDT holders can't pay with directly, and Coinbase's spend permissions aren't live.
- **Staying on NEAR and adding Privy:** login gets easier, but paying Bitrefill still needs the shuttle.
- **A program-owned Deposit Address per customer:** such an address is off the curve, and exchanges often refuse to send to one.
- **One account per card:** fifteen rent deposits per Checkout, and a hand-made duplicate check.

Accepted 2026-11-27. The same day, an independent review's fixes were folded in, along with the pre-build checks answered from primary docs and mainnet reads. Nothing is built yet. `docs/solana-migration.md` sets the order, and each phase starts on an explicit go.
