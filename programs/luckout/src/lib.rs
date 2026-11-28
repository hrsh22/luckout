//! Luckout on Solana (ADR-0015): customer Balances in USDC, Spending Limits and Default Mode, Game Versions,
//! the Cashback Reserve, Checkouts of up to 15 cards, and Draws from ORAO's VRF that can't be re-rolled.
//! See CONTEXT.md for the domain language. All amounts are USDC base units; all rates are basis points.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use orao_solana_vrf::state::RandomnessAccountData;

pub mod error;
pub mod game;
pub mod state;

use error::LuckoutError;
use game::*;
use state::*;

// One build per environment, each with its own program id: `--features staging` or `--features production`
// for mainnet, none for devnet and tests.
#[cfg(all(feature = "staging", feature = "production"))]
compile_error!("build for staging or production, not both");
#[cfg(not(any(feature = "staging", feature = "production")))]
declare_id!("4Tziwbh1vEDremxPViXgEa91FP3Nv4hUyNmLXMzRK2Z3");
#[cfg(feature = "staging")]
declare_id!("FM2mRU3R8jtCArHTK4fYiSseDmR9vjhJfPa9D5A2sv3F");
#[cfg(feature = "production")]
declare_id!("GCeZ67ann5G1hzNijYtqFiHyAJ4dJy2mwFA6g2eQfssr");

/// Circle's USDC on mainnet: the only token a mainnet build can be set up with.
#[cfg(any(feature = "staging", feature = "production"))]
pub const MAINNET_USDC: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

pub const DAY: i64 = 86_400;
pub const RECLAIM_AFTER: i64 = DAY;
/// An unfilled randomness request can be replaced after this long, so a card's lock is never held forever.
pub const REQUEST_AGAIN_AFTER: i64 = 3_600;
/// 1 USDC: what a deposit's fee is worth moving for.
pub const MIN_DEPOSIT: u64 = 1_000_000;
pub const DEFAULT_PER_PURCHASE_LIMIT: u64 = 200_000_000;
pub const DEFAULT_DAILY_LIMIT: u64 = 1_000_000_000;
pub const DEFAULT_CASHBACK_CAP: CashbackCap = CashbackCap { fixed: Some(50_000_000), reserve_bps: 2_000 };
/// 2.5 USDC: about where the 5.6% margin pays for one ORAO request (ADR-0015).
pub const DEFAULT_MIN_LUCKY_CHECKOUT: u64 = 2_500_000;
pub const DEFAULT_REPAY_DAILY_CAP: u64 = 500_000_000;

/// One card to admit, as the customer confirmed it. `mode: None` plays their Default Mode.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CardOrder {
    pub reference_price: u64,
    pub mode: Option<Mode>,
    /// The most the customer confirmed for this card; a higher Maximum Price is refused.
    pub max_debit: u64,
    /// The Lucky Amount the customer confirmed; without it, the most the reserve allows now.
    pub lucky_amount: Option<u64>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct QuoteItem {
    pub reference_price: u64,
    pub mode: Mode,
    pub lucky_amount: Option<u64>,
}

#[event]
pub struct Deposited {
    pub customer: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Withdrawn {
    pub customer: Pubkey,
    pub amount: u64,
    pub to: Pubkey,
}

#[event]
pub struct Admitted {
    pub customer: Pubkey,
    pub checkout: Pubkey,
    pub number: u64,
    pub cards: Vec<Card>,
}

#[event]
pub struct Settled {
    pub checkout: Pubkey,
    pub delivered: Vec<u8>,
    pub failed: Vec<u8>,
    pub repaid: u64,
    pub to_proceeds: u64,
}

#[event]
pub struct Reclaimed {
    pub checkout: Pubkey,
    pub card: u8,
    pub amount: u64,
}

#[event]
pub struct DrawRequested {
    pub checkout: Pubkey,
    pub round: u8,
    pub seed: [u8; 32],
}

/// A Draw Proof: anyone can check `randomness` against ORAO's oracle keys and recompute the rest (ADR-0005).
#[event]
pub struct Draw {
    pub checkout: Pubkey,
    pub customer: Pubkey,
    pub card: u8,
    pub round: u8,
    pub seed: [u8; 32],
    pub request: Pubkey,
    pub randomness: [u8; 64],
    pub random: [u8; 32],
    pub roll: u32,
    pub game_version: u32,
    pub reference_price: u64,
    pub lucky_amount: u64,
    pub max_price: u64,
    pub final_bps: u32,
    pub final_price: u64,
    pub cashback: u64,
}

#[event]
pub struct OwnerMoved {
    pub what: String,
    pub amount: u64,
    pub to: Pubkey,
}

#[program]
pub mod luckout {
    use super::*;

    // ---------- setup ----------

    /// Only the program's upgrade authority can initialize it, and becomes the owner.
    pub fn initialize(ctx: Context<Initialize>, operator: Pubkey) -> Result<()> {
        let owner = ctx.accounts.owner.key();
        require!(operator != owner && operator != crate::ID, LuckoutError::BadRole);
        #[cfg(any(feature = "staging", feature = "production"))]
        require_keys_eq!(ctx.accounts.usdc_mint.key(), MAINNET_USDC, LuckoutError::NotUsdc);
        ctx.accounts.config.set_inner(Config {
            layout: LAYOUT,
            bump: ctx.bumps.config,
            vault_authority_bump: ctx.bumps.vault_authority,
            owner,
            pending_owner: None,
            operator,
            usdc_mint: ctx.accounts.usdc_mint.key(),
            vault: ctx.accounts.vault.key(),
            pay_wallet: ctx.accounts.pay_wallet.key(),
            paused: false,
            cashback_cap: DEFAULT_CASHBACK_CAP,
            min_lucky_checkout: DEFAULT_MIN_LUCKY_CHECKOUT,
            free_reserve: 0,
            locked_reserve: 0,
            proceeds: 0,
            repay_daily_cap: DEFAULT_REPAY_DAILY_CAP,
            repay_day: 0,
            repaid_today: 0,
            lucky_settled: 0,
            lucky_amount_total: 0,
            lucky_paid_total: 0,
            guardian: Pubkey::default(),
            spare: [0; 32],
            versions: default_game_versions(),
        });
        Ok(())
    }

    // ---------- customer (their wallet signs; our fee payer pays) ----------

    /// Opens the customer's account with the Default Mode they chose. Sent with the one-time approval that
    /// makes the Vault's authority the delegate of their USDC account.
    pub fn open(ctx: Context<Open>, default_mode: Mode) -> Result<()> {
        fresh(ctx.accounts.config.layout)?;
        known_mode(&ctx.accounts.config, default_mode)?;
        ctx.accounts.customer.set_inner(Customer {
            layout: LAYOUT,
            bump: ctx.bumps.customer,
            wallet: ctx.accounts.wallet.key(),
            balance: 0,
            per_purchase_limit: DEFAULT_PER_PURCHASE_LIMIT,
            daily_limit: DEFAULT_DAILY_LIMIT,
            default_mode,
            day: 0,
            spent_today: 0,
            premiums_paid: 0,
            cashback_received: 0,
            checkouts: 0,
            spare: [0; 32],
        });
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let a = ctx.accounts;
        fresh(a.config.layout)?;
        fresh(a.customer.layout)?;
        require!(amount > 0, LuckoutError::NothingToWithdraw);
        require!(a.customer.balance >= amount, LuckoutError::InsufficientBalance);
        a.customer.balance -= amount;
        pay_out(&a.config, &a.vault, &a.vault_authority, a.to.to_account_info(), amount)?;
        emit!(Withdrawn { customer: a.customer.wallet, amount, to: a.to.key() });
        Ok(())
    }

    /// `u64::MAX` is "No limit".
    pub fn set_limits(ctx: Context<CustomerSetting>, per_purchase: u64, daily: u64) -> Result<()> {
        let c = &mut ctx.accounts.customer;
        fresh(c.layout)?;
        c.per_purchase_limit = per_purchase;
        c.daily_limit = daily;
        Ok(())
    }

    pub fn set_default_mode(ctx: Context<CustomerSetting>, mode: Mode) -> Result<()> {
        fresh(ctx.accounts.customer.layout)?;
        known_mode(&ctx.accounts.config, mode)?;
        ctx.accounts.customer.default_mode = mode;
        Ok(())
    }

    /// The customer takes back the full amount of a card nobody confirmed or failed within 24 hours.
    pub fn reclaim(ctx: Context<Reclaim>, card: u8) -> Result<()> {
        let a = ctx.accounts;
        fresh(a.config.layout)?;
        fresh(a.customer.layout)?;
        fresh(a.checkout.layout)?;
        let now = Clock::get()?.unix_timestamp;
        require!(now >= a.checkout.created_at + RECLAIM_AFTER, LuckoutError::TooEarlyToReclaim);
        let c = a.checkout.cards.get_mut(card as usize).ok_or(LuckoutError::UnknownCard)?;
        require!(c.status == Status::Pending, LuckoutError::NotPending);
        let amount = unwind(&mut a.config, &mut a.customer, c, Status::Reclaimed);
        emit!(Reclaimed { checkout: a.checkout.key(), card, amount });
        close_if_done(&a.checkout, &a.checkout_payer)
    }

    // ---------- anyone ----------

    /// Moves the USDC in a customer's approved account into their own Balance, and nowhere else.
    pub fn deposit_for(ctx: Context<DepositFor>) -> Result<()> {
        let a = ctx.accounts;
        fresh(a.config.layout)?;
        fresh(a.customer.layout)?;
        let amount = a.source.amount.min(a.source.delegated_amount);
        require!(amount >= MIN_DEPOSIT, LuckoutError::DepositTooSmall);
        token::transfer(
            CpiContext::new_with_signer(
                token::ID,
                Transfer {
                    from: a.source.to_account_info(),
                    to: a.vault.to_account_info(),
                    authority: a.vault_authority.to_account_info(),
                },
                &[&[VAULT_AUTHORITY_SEED, &[a.config.vault_authority_bump]]],
            ),
            amount,
        )?;
        a.customer.balance += amount;
        emit!(Deposited { customer: a.customer.wallet, amount });
        Ok(())
    }

    /// Finishes the Draws of the cards waiting on `round`'s randomness, once ORAO has filled it in. Anyone may
    /// call it; it only reads the stored value, so calling again can't change a result.
    pub fn finish_draw(ctx: Context<FinishDraw>, round: u8) -> Result<()> {
        let checkout_key = ctx.accounts.checkout.key();
        let seed = draw_seed(&checkout_key, round);
        let request = ctx.accounts.randomness.key();
        let value = read_randomness(&ctx.accounts.randomness, &seed)?.ok_or(LuckoutError::RandomnessNotFilled)?;
        let a = &mut *ctx.accounts;
        fresh(a.config.layout)?;
        fresh(a.customer.layout)?;
        fresh(a.checkout.layout)?;
        let mut proofs = vec![];
        let customer_wallet = a.checkout.customer;
        for (i, card) in a.checkout.cards.iter_mut().enumerate() {
            let Mode::Lucky(v) = card.mode else { continue };
            if card.status != Status::Drawing || card.round != round {
                continue;
            }
            let outcomes = version(&a.config.versions, v)?.outcomes.clone();
            let random = card_random(&value, i as u8);
            let roll = roll_from_random(&random);
            let final_bps = final_bps_for_roll(&outcomes, roll);
            let price = final_price(card.reference_price, card.lucky_amount, card.max_price, final_bps);
            let cashback = card.max_price - price;
            let premium = card.max_price - card.reference_price;

            a.customer.balance += cashback;
            a.customer.premiums_paid += premium;
            a.customer.cashback_received += cashback;
            // Free Reserve changes by Risk Premium - Cashback once the lock is released.
            a.config.locked_reserve -= card.locked;
            a.config.free_reserve = a.config.free_reserve + card.locked + premium - cashback;
            a.config.lucky_settled += 1;
            a.config.lucky_amount_total += card.lucky_amount;
            a.config.lucky_paid_total += card.lucky_amount + premium - cashback;
            card.cashback = cashback;
            card.status = Status::Delivered;
            proofs.push(Draw {
                checkout: checkout_key,
                customer: customer_wallet,
                card: i as u8,
                round,
                seed,
                request,
                randomness: value,
                random,
                roll,
                game_version: v,
                reference_price: card.reference_price,
                lucky_amount: card.lucky_amount,
                max_price: card.max_price,
                final_bps,
                final_price: price,
                cashback,
            });
        }
        require!(!proofs.is_empty(), LuckoutError::NothingToDraw);
        close_if_done(&a.checkout, &a.checkout_payer)?;
        for proof in proofs {
            emit_cpi!(proof);
        }
        Ok(())
    }

    /// Replaces a request ORAO hasn't filled an hour after it was made: its cards move to a new request under
    /// the next seed. A filled request can't be replaced, so this never re-rolls a Draw.
    pub fn request_again(ctx: Context<RequestAgain>, round: u8) -> Result<()> {
        let checkout_key = ctx.accounts.checkout.key();
        let old = read_randomness(&ctx.accounts.old_request, &draw_seed(&checkout_key, round))?;
        require!(old.is_none(), LuckoutError::RandomnessFilled);
        let a = &mut *ctx.accounts;
        fresh(a.checkout.layout)?;
        let now = Clock::get()?.unix_timestamp;
        require!(now >= a.checkout.requested_at + REQUEST_AGAIN_AFTER, LuckoutError::TooEarlyToRequestAgain);
        let next = a.checkout.rounds;
        let mut moved = 0;
        for card in a.checkout.cards.iter_mut().filter(|c| c.status == Status::Drawing && c.round == round) {
            card.round = next;
            moved += 1;
        }
        require!(moved > 0, LuckoutError::NothingToDraw);
        request_randomness(
            &a.payer,
            &a.network_state,
            &a.treasury,
            &a.request,
            &a.system_program,
            &mut a.checkout,
            checkout_key,
            now,
        )
    }

    // ---------- operator ----------

    /// Admits a Checkout: every card or none, in order, each debiting its Maximum Price and locking the reserve
    /// as the cards before it left it. `number` must be the customer's next, so a retry of an admitted
    /// Checkout fails even after its account has closed.
    pub fn admit(ctx: Context<Admit>, number: u64, cards: Vec<CardOrder>) -> Result<()> {
        let a = ctx.accounts;
        fresh(a.config.layout)?;
        fresh(a.customer.layout)?;
        require!(!a.config.paused, LuckoutError::Paused);
        require!(!cards.is_empty() && cards.len() <= MAX_CART, LuckoutError::BadCart);
        require!(number == a.customer.checkouts, LuckoutError::WrongCheckoutNumber);
        let now = Clock::get()?.unix_timestamp;
        let (config, customer) = (&mut a.config, &mut a.customer);
        if customer.day != now / DAY {
            customer.day = now / DAY;
            customer.spent_today = 0;
        }
        let (mut admitted, mut lucky_total, mut any_lucky) = (vec![], 0u64, false);
        for o in cards {
            let mode = o.mode.unwrap_or(customer.default_mode);
            let q = quote_at(&config.cashback_cap, &config.versions, config.free_reserve, o.reference_price, mode, o.lucky_amount)?;
            let debit = q.max_price;
            require!(debit <= o.max_debit, LuckoutError::PriceChanged);
            require!(debit <= customer.per_purchase_limit, LuckoutError::OverPerPurchaseLimit);
            require!(
                customer.spent_today.saturating_add(debit) <= customer.daily_limit,
                LuckoutError::OverDailyLimit
            );
            require!(customer.balance >= debit, LuckoutError::InsufficientBalance);
            customer.balance -= debit;
            customer.spent_today += debit;
            let lock = lock_for(&config.versions, &q)?;
            config.free_reserve -= lock;
            config.locked_reserve += lock;
            if matches!(mode, Mode::Lucky(_)) {
                any_lucky = true;
                lucky_total += q.lucky_amount;
            }
            admitted.push(Card {
                mode,
                reference_price: q.reference_price,
                lucky_amount: q.lucky_amount,
                max_price: q.max_price,
                locked: lock,
                status: Status::Pending,
                cashback: 0,
                round: 0,
            });
        }
        require!(!any_lucky || lucky_total >= config.min_lucky_checkout, LuckoutError::LuckyCheckoutTooSmall);
        customer.checkouts += 1;
        emit!(Admitted { customer: customer.wallet, checkout: a.checkout.key(), number, cards: admitted.clone() });
        a.checkout.set_inner(Checkout {
            layout: LAYOUT,
            bump: ctx.bumps.checkout,
            customer: customer.wallet,
            number,
            payer: a.payer.key(),
            created_at: now,
            rounds: 0,
            requested_at: 0,
            spare: [0; 16],
            cards: admitted,
        });
        Ok(())
    }

    /// Confirms delivery of `delivered` and fails `failed`. Delivered cards' Reference Prices repay the Pay
    /// Wallet up to the daily cap; past it they wait as Proceeds. Delivered Lucky cards share one randomness
    /// request, made in this same instruction, after delivery is confirmed (ADR-0001, amended).
    pub fn settle(ctx: Context<Settle>, delivered: Vec<u8>, failed: Vec<u8>) -> Result<()> {
        let checkout_key = ctx.accounts.checkout.key();
        let a = &mut *ctx.accounts;
        fresh(a.config.layout)?;
        fresh(a.customer.layout)?;
        fresh(a.checkout.layout)?;
        let n = a.checkout.cards.len();
        require!(
            !(delivered.is_empty() && failed.is_empty()) && delivered.len() + failed.len() <= n,
            LuckoutError::BadCart
        );
        let mut seen = 0u16;
        let mut check = |i: u8| -> Result<usize> {
            require!((i as usize) < n, LuckoutError::UnknownCard);
            require!(seen & (1 << i) == 0, LuckoutError::DuplicateCard);
            seen |= 1 << i;
            Ok(i as usize)
        };
        let (mut owed, mut lucky) = (0u64, false);
        let round = a.checkout.rounds;
        for &i in &delivered {
            let c = &mut a.checkout.cards[check(i)?];
            require!(c.status == Status::Pending, LuckoutError::NotPending);
            owed += c.reference_price;
            if matches!(c.mode, Mode::Lucky(_)) {
                c.status = Status::Drawing;
                c.round = round;
                lucky = true;
            } else {
                c.status = Status::Delivered;
            }
        }
        for &i in &failed {
            let c = &mut a.checkout.cards[check(i)?];
            require!(c.status == Status::Pending, LuckoutError::NotPending);
            unwind(&mut a.config, &mut a.customer, c, Status::Failed);
        }

        let now = Clock::get()?.unix_timestamp;
        if a.config.repay_day != now / DAY {
            a.config.repay_day = now / DAY;
            a.config.repaid_today = 0;
        }
        let repaid = owed.min(a.config.repay_daily_cap.saturating_sub(a.config.repaid_today));
        a.config.repaid_today += repaid;
        a.config.proceeds += owed - repaid;
        if repaid > 0 {
            pay_out(&a.config, &a.vault, &a.vault_authority, a.pay_wallet.to_account_info(), repaid)?;
        }
        emit!(Settled { checkout: checkout_key, delivered, failed, repaid, to_proceeds: owed - repaid });

        if lucky {
            let missing = || error!(LuckoutError::MissingRandomnessAccounts);
            let (Some(ns), Some(tr), Some(req)) = (&a.network_state, &a.treasury, &a.request) else {
                return Err(missing());
            };
            require!(a.vrf.is_some(), LuckoutError::MissingRandomnessAccounts);
            request_randomness(&a.payer, ns, tr, req, &a.system_program, &mut a.checkout, checkout_key, now)?;
        }
        close_if_done(&a.checkout, &a.checkout_payer)
    }

    // ---------- owner ----------

    pub fn set_operator(ctx: Context<OwnerOnly>, operator: Pubkey) -> Result<()> {
        let c = &mut ctx.accounts.config;
        require!(
            operator != c.owner && Some(operator) != c.pending_owner && operator != crate::ID,
            LuckoutError::BadRole
        );
        c.operator = operator;
        Ok(())
    }

    pub fn set_pay_wallet(ctx: Context<SetPayWallet>) -> Result<()> {
        ctx.accounts.config.pay_wallet = ctx.accounts.pay_wallet.key();
        Ok(())
    }

    /// Stops only new Checkouts.
    pub fn set_paused(ctx: Context<OwnerOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    /// `None` removes the guardian.
    pub fn set_guardian(ctx: Context<OwnerOnly>, guardian: Option<Pubkey>) -> Result<()> {
        ctx.accounts.config.guardian = guardian.unwrap_or_default();
        Ok(())
    }

    /// The guardian's only power, which the owner has too: stop new Checkouts at once. Only the owner restarts them.
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        ctx.accounts.config.paused = true;
        Ok(())
    }

    /// One card pays at most the lower of `fixed` (`None` is off) and `reserve_bps` of Free Reserve.
    pub fn set_cashback_cap(ctx: Context<OwnerOnly>, fixed: Option<u64>, reserve_bps: u32) -> Result<()> {
        require!(
            fixed != Some(0) && reserve_bps > 0 && reserve_bps <= MAX_CAP_RESERVE_BPS,
            LuckoutError::BadCashbackCap
        );
        ctx.accounts.config.cashback_cap = CashbackCap { fixed, reserve_bps };
        Ok(())
    }

    pub fn set_repay_cap(ctx: Context<OwnerOnly>, daily: u64) -> Result<()> {
        ctx.accounts.config.repay_daily_cap = daily;
        Ok(())
    }

    pub fn set_min_lucky_checkout(ctx: Context<OwnerOnly>, amount: u64) -> Result<()> {
        ctx.accounts.config.min_lucky_checkout = amount;
        Ok(())
    }

    pub fn add_game_version(ctx: Context<AddGameVersion>, version: GameVersion) -> Result<()> {
        validate_game_version(&version)?;
        let c = &mut ctx.accounts.config;
        require!(c.versions.len() < MAX_VERSIONS, LuckoutError::TooManyVersions);
        c.versions.push(version);
        Ok(())
    }

    pub fn fund_reserve(ctx: Context<FundReserve>, amount: u64) -> Result<()> {
        let a = ctx.accounts;
        require!(amount > 0, LuckoutError::NothingToWithdraw);
        token::transfer(
            CpiContext::new(
                token::ID,
                Transfer {
                    from: a.from.to_account_info(),
                    to: a.vault.to_account_info(),
                    authority: a.owner.to_account_info(),
                },
            ),
            amount,
        )?;
        a.config.free_reserve += amount;
        emit!(OwnerMoved { what: "reserve_funded".into(), amount, to: a.vault.key() });
        Ok(())
    }

    pub fn withdraw_reserve(ctx: Context<OwnerPayout>, amount: u64) -> Result<()> {
        let a = ctx.accounts;
        require!(amount > 0, LuckoutError::NothingToWithdraw);
        require!(a.config.free_reserve >= amount, LuckoutError::ExceedsFreeReserve);
        require_keys_eq!(a.to.owner, a.config.owner, LuckoutError::WrongTokenAccount);
        a.config.free_reserve -= amount;
        pay_out(&a.config, &a.vault, &a.vault_authority, a.to.to_account_info(), amount)?;
        emit!(OwnerMoved { what: "reserve_withdrawn".into(), amount, to: a.to.key() });
        Ok(())
    }

    /// Proceeds go to the owner, or to the Pay Wallet.
    pub fn withdraw_proceeds(ctx: Context<OwnerPayout>, amount: u64) -> Result<()> {
        let a = ctx.accounts;
        require!(amount > 0, LuckoutError::NothingToWithdraw);
        require!(a.config.proceeds >= amount, LuckoutError::ExceedsProceeds);
        require!(
            a.to.owner == a.config.owner || a.to.key() == a.config.pay_wallet,
            LuckoutError::WrongTokenAccount
        );
        a.config.proceeds -= amount;
        pay_out(&a.config, &a.vault, &a.vault_authority, a.to.to_account_info(), amount)?;
        emit!(OwnerMoved { what: "proceeds_withdrawn".into(), amount, to: a.to.key() });
        Ok(())
    }

    /// Proposes a new owner, or withdraws the proposal with `None`. Nothing changes until it accepts, so the
    /// owner and the upgrade authority can move to a multisig later without changing the program.
    pub fn propose_owner(ctx: Context<OwnerOnly>, new_owner: Option<Pubkey>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        if let Some(o) = new_owner {
            require!(o != c.owner && o != c.operator && o != crate::ID, LuckoutError::BadRole);
        }
        c.pending_owner = new_owner;
        Ok(())
    }

    pub fn accept_owner(ctx: Context<AcceptOwner>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        let caller = ctx.accounts.new_owner.key();
        require!(c.pending_owner == Some(caller), LuckoutError::NotProposedOwner);
        require!(caller != c.operator, LuckoutError::BadRole);
        c.owner = caller;
        c.pending_owner = None;
        Ok(())
    }

    // ---------- views (simulated) ----------

    /// A cart's terms, card by card, as `admit` would take them now: each Lucky card's cap and lock come from
    /// the Free Reserve the cards before it left. A Lucky card the reserve can't cover comes back Normal; a
    /// confirmed Lucky Amount it no longer covers is quoted as without one, so the caller sees it moved.
    pub fn quote_many(ctx: Context<ReadConfig>, items: Vec<QuoteItem>) -> Result<Vec<Quote>> {
        let c = &ctx.accounts.config;
        require!(!items.is_empty() && items.len() <= MAX_CART, LuckoutError::BadCart);
        let mut free = c.free_reserve;
        let mut quotes = Vec::with_capacity(items.len());
        for i in items {
            let r = i.reference_price;
            let (mode, confirmed) = match i.mode {
                Mode::Lucky(v) => match lucky_allowed(&c.cashback_cap, version(&c.versions, v)?, free, r) {
                    0 => (Mode::Normal, None),
                    allowed => (i.mode, i.lucky_amount.filter(|&x| x > 0 && x <= allowed)),
                },
                m => (m, None),
            };
            let q = quote_at(&c.cashback_cap, &c.versions, free, r, mode, confirmed)?;
            free -= lock_for(&c.versions, &q)?;
            quotes.push(q);
        }
        Ok(quotes)
    }
}

// ---------- helpers ----------

fn known_mode(config: &Config, mode: Mode) -> Result<()> {
    if let Mode::Lucky(v) = mode {
        version(&config.versions, v)?;
    }
    Ok(())
}

/// Everything debited for the card returns to the customer, and its lock to Free Reserve. No Draw.
fn unwind(config: &mut Config, customer: &mut Customer, card: &mut Card, status: Status) -> u64 {
    customer.balance += card.max_price;
    config.locked_reserve -= card.locked;
    config.free_reserve += card.locked;
    card.status = status;
    card.max_price
}

fn pay_out<'info>(
    config: &Config,
    vault: &Account<'info, TokenAccount>,
    vault_authority: &UncheckedAccount<'info>,
    to: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    token::transfer(
        CpiContext::new_with_signer(
            token::ID,
            Transfer { from: vault.to_account_info(), to, authority: vault_authority.to_account_info() },
            &[&[VAULT_AUTHORITY_SEED, &[config.vault_authority_bump]]],
        ),
        amount,
    )
}

fn close_if_done<'info>(checkout: &Account<'info, Checkout>, payer: &UncheckedAccount<'info>) -> Result<()> {
    if checkout.done() {
        checkout.close(payer.to_account_info())?;
    }
    Ok(())
}

/// Reads a randomness account that must be ORAO's request for `seed`: `Some` once filled. Anything else
/// (another owner, another address) is refused, so nobody can hand a Draw a value of their own.
fn read_randomness(account: &UncheckedAccount, seed: &[u8; 32]) -> Result<Option<[u8; 64]>> {
    require_keys_eq!(*account.owner, orao_solana_vrf::ID, LuckoutError::WrongRandomnessAccount);
    require_keys_eq!(
        account.key(),
        orao_solana_vrf::randomness_account_address(&orao_solana_vrf::ID, seed),
        LuckoutError::WrongRandomnessAccount
    );
    let data = RandomnessAccountData::try_deserialize(&mut &account.data.borrow()[..])?;
    Ok(data.fulfilled_randomness().copied())
}

/// Asks ORAO for one value under the Checkout's next seed, paid by our fee payer.
#[allow(clippy::too_many_arguments)]
fn request_randomness<'info>(
    payer: &Signer<'info>,
    network_state: &UncheckedAccount<'info>,
    treasury: &UncheckedAccount<'info>,
    request: &UncheckedAccount<'info>,
    system_program: &Program<'info, System>,
    checkout: &mut Account<'info, Checkout>,
    checkout_key: Pubkey,
    now: i64,
) -> Result<()> {
    let round = checkout.rounds;
    require!(round < u8::MAX, LuckoutError::TooManyRounds);
    let seed = draw_seed(&checkout_key, round);
    orao_solana_vrf::cpi::request_v2(
        CpiContext::new(
            orao_solana_vrf::ID,
            orao_solana_vrf::cpi::accounts::RequestV2 {
                payer: payer.to_account_info(),
                network_state: network_state.to_account_info(),
                treasury: treasury.to_account_info(),
                request: request.to_account_info(),
                system_program: system_program.to_account_info(),
            },
        ),
        seed,
    )?;
    checkout.rounds += 1;
    checkout.requested_at = now;
    emit!(DrawRequested { checkout: checkout_key, round, seed });
    Ok(())
}

// ---------- accounts ----------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = Config::space(3), seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: a data-less PDA that owns the Vault and is each Deposit Address's delegate.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = owner,
        seeds = [VAULT_SEED],
        bump,
        token::mint = usdc_mint,
        token::authority = vault_authority,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(token::mint = usdc_mint)]
    pub pay_wallet: Account<'info, TokenAccount>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ LuckoutError::NotOwner)]
    pub program: Program<'info, crate::program::Luckout>,
    #[account(constraint = program_data.upgrade_authority_address == Some(owner.key()) @ LuckoutError::NotOwner)]
    pub program_data: Account<'info, ProgramData>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Open<'info> {
    pub wallet: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = payer,
        space = 8 + Customer::INIT_SPACE,
        seeds = [CUSTOMER_SEED, wallet.key().as_ref()],
        bump,
    )]
    pub customer: Account<'info, Customer>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub wallet: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [CUSTOMER_SEED, wallet.key().as_ref()], bump = customer.bump)]
    pub customer: Account<'info, Customer>,
    #[account(mut, address = config.vault)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: the Vault's authority PDA.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, token::mint = config.usdc_mint)]
    pub to: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CustomerSetting<'info> {
    pub wallet: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [CUSTOMER_SEED, wallet.key().as_ref()], bump = customer.bump)]
    pub customer: Account<'info, Customer>,
}

#[derive(Accounts)]
pub struct Reclaim<'info> {
    pub wallet: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [CUSTOMER_SEED, wallet.key().as_ref()], bump = customer.bump)]
    pub customer: Account<'info, Customer>,
    #[account(
        mut,
        seeds = [CHECKOUT_SEED, wallet.key().as_ref(), &checkout.number.to_le_bytes()],
        bump = checkout.bump,
    )]
    pub checkout: Account<'info, Checkout>,
    /// CHECK: gets the Checkout's rent back when it closes.
    #[account(mut, address = checkout.payer)]
    pub checkout_payer: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct DepositFor<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [CUSTOMER_SEED, customer.wallet.as_ref()], bump = customer.bump)]
    pub customer: Account<'info, Customer>,
    #[account(
        mut,
        token::mint = config.usdc_mint,
        constraint = source.owner == customer.wallet @ LuckoutError::WrongTokenAccount,
        constraint = source.delegate.contains(&vault_authority.key()) @ LuckoutError::WrongTokenAccount,
    )]
    pub source: Account<'info, TokenAccount>,
    #[account(mut, address = config.vault)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: the Vault's authority PDA, the delegate the customer approved.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct FinishDraw<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [CUSTOMER_SEED, checkout.customer.as_ref()], bump = customer.bump)]
    pub customer: Account<'info, Customer>,
    #[account(
        mut,
        seeds = [CHECKOUT_SEED, checkout.customer.as_ref(), &checkout.number.to_le_bytes()],
        bump = checkout.bump,
    )]
    pub checkout: Account<'info, Checkout>,
    /// CHECK: ORAO's request for this Checkout and round, checked in `read_randomness`.
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: gets the Checkout's rent back when it closes.
    #[account(mut, address = checkout.payer)]
    pub checkout_payer: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RequestAgain<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [CHECKOUT_SEED, checkout.customer.as_ref(), &checkout.number.to_le_bytes()],
        bump = checkout.bump,
    )]
    pub checkout: Account<'info, Checkout>,
    /// CHECK: the unfilled request being replaced, checked in `read_randomness`.
    pub old_request: UncheckedAccount<'info>,
    /// CHECK: ORAO's program.
    #[account(address = orao_solana_vrf::ID)]
    pub vrf: UncheckedAccount<'info>,
    /// CHECK: checked by ORAO.
    #[account(mut)]
    pub network_state: UncheckedAccount<'info>,
    /// CHECK: checked by ORAO.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: created by ORAO at our seed's address.
    #[account(mut)]
    pub request: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(number: u64, cards: Vec<CardOrder>)]
pub struct Admit<'info> {
    #[account(address = config.operator @ LuckoutError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [CUSTOMER_SEED, customer.wallet.as_ref()], bump = customer.bump)]
    pub customer: Account<'info, Customer>,
    #[account(
        init,
        payer = payer,
        space = Checkout::space(cards.len().clamp(1, MAX_CART)),
        seeds = [CHECKOUT_SEED, customer.wallet.as_ref(), &number.to_le_bytes()],
        bump,
    )]
    pub checkout: Account<'info, Checkout>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(address = config.operator @ LuckoutError::NotOperator)]
    pub operator: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [CUSTOMER_SEED, checkout.customer.as_ref()], bump = customer.bump)]
    pub customer: Account<'info, Customer>,
    #[account(
        mut,
        seeds = [CHECKOUT_SEED, checkout.customer.as_ref(), &checkout.number.to_le_bytes()],
        bump = checkout.bump,
    )]
    pub checkout: Account<'info, Checkout>,
    #[account(mut, address = config.vault)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: the Vault's authority PDA.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, address = config.pay_wallet)]
    pub pay_wallet: Account<'info, TokenAccount>,
    /// CHECK: gets the Checkout's rent back when it closes.
    #[account(mut, address = checkout.payer)]
    pub checkout_payer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// CHECK: ORAO's program; needed only when a Lucky card is delivered.
    #[account(address = orao_solana_vrf::ID)]
    pub vrf: Option<UncheckedAccount<'info>>,
    /// CHECK: checked by ORAO.
    #[account(mut)]
    pub network_state: Option<UncheckedAccount<'info>>,
    /// CHECK: checked by ORAO.
    #[account(mut)]
    pub treasury: Option<UncheckedAccount<'info>>,
    /// CHECK: created by ORAO at our seed's address.
    #[account(mut)]
    pub request: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = owner @ LuckoutError::NotOwner)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct Pause<'info> {
    pub guardian: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = guardian.key() == config.guardian || guardian.key() == config.owner @ LuckoutError::NotGuardian
    )]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct SetPayWallet<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = owner @ LuckoutError::NotOwner)]
    pub config: Account<'info, Config>,
    #[account(token::mint = config.usdc_mint)]
    pub pay_wallet: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct AddGameVersion<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = owner @ LuckoutError::NotOwner,
        realloc = Config::space(config.versions.len() + 1),
        realloc::payer = owner,
        realloc::zero = false,
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundReserve<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = owner @ LuckoutError::NotOwner)]
    pub config: Account<'info, Config>,
    #[account(mut, token::mint = config.usdc_mint)]
    pub from: Account<'info, TokenAccount>,
    #[account(mut, address = config.vault)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct OwnerPayout<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = owner @ LuckoutError::NotOwner)]
    pub config: Account<'info, Config>,
    #[account(mut, address = config.vault)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: the Vault's authority PDA.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, token::mint = config.usdc_mint)]
    pub to: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AcceptOwner<'info> {
    pub new_owner: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct ReadConfig<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}
