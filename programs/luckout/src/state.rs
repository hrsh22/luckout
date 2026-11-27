//! Accounts and the types they hold (ADR-0015, "Accounts"). Every account starts with a layout version
//! byte and keeps spare bytes, so a new field rarely needs a resize, and a build refuses an account whose
//! layout is newer than it knows (`fresh`).

use anchor_lang::prelude::*;

use crate::error::LuckoutError;

/// The account layout this build reads and writes.
pub const LAYOUT: u8 = 1;
/// The most cards one Checkout holds: Bitrefill's own cart size.
pub const MAX_CART: usize = 15;
pub const MAX_NAME: usize = 16;
pub const MAX_OUTCOMES: usize = 8;
pub const MAX_VERSIONS: usize = 32;

pub const CONFIG_SEED: &[u8] = b"config";
/// The Vault's authority. It is also the delegate every Deposit Address approves once.
pub const VAULT_AUTHORITY_SEED: &[u8] = b"vault";
pub const VAULT_SEED: &[u8] = b"vault-usdc";
pub const CUSTOMER_SEED: &[u8] = b"customer";
pub const CHECKOUT_SEED: &[u8] = b"checkout";

/// Refuses an account written by a newer build, so a rolled-back build never misreads one.
pub fn fresh(layout: u8) -> Result<()> {
    require!(layout <= LAYOUT, LuckoutError::NewerLayout);
    Ok(())
}

/// Normal is a Standard Purchase; Lucky(n) plays Game Version n.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum Mode {
    Normal,
    Lucky(u32),
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct Outcome {
    /// Final Price as a share of the Lucky Amount, e.g. 5_000 = pays half.
    pub final_bps: u32,
    pub chance_bps: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq, InitSpace)]
pub struct GameVersion {
    #[max_len(MAX_NAME)]
    pub name: String,
    pub premium_bps: u32,
    #[max_len(MAX_OUTCOMES)]
    pub outcomes: Vec<Outcome>,
}

/// The most Cashback one card can pay: the lower of a fixed amount (`None` is off) and a share of Free Reserve.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct CashbackCap {
    pub fixed: Option<u64>,
    pub reserve_bps: u32,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub layout: u8,
    pub bump: u8,
    pub vault_authority_bump: u8,
    pub owner: Pubkey,
    /// Becomes the owner only when it accepts, so a typo can't hand the program to a key nobody holds.
    pub pending_owner: Option<Pubkey>,
    pub operator: Pubkey,
    pub usdc_mint: Pubkey,
    pub vault: Pubkey,
    /// The Pay Wallet's USDC account, which `settle` repays.
    pub pay_wallet: Pubkey,
    /// Stops only new Checkouts. Settling, Draws, Reclaim, deposits and withdrawals keep working.
    pub paused: bool,
    pub cashback_cap: CashbackCap,
    /// A Checkout with Lucky cards plays at least this much Lucky Amount, so its margin pays for its Draw.
    pub min_lucky_checkout: u64,
    pub free_reserve: u64,
    pub locked_reserve: u64,
    /// Delivered cards' Reference Prices not yet repaid to the Pay Wallet (past the daily cap), held for the owner.
    pub proceeds: u64,
    pub repay_daily_cap: u64,
    pub repay_day: i64,
    pub repaid_today: u64,
    /// Live Average = lucky_paid_total / lucky_amount_total, promised to be about 105.6%.
    pub lucky_settled: u64,
    pub lucky_amount_total: u64,
    pub lucky_paid_total: u64,
    pub spare: [u8; 64],
    /// Append-only. Grows by one entry with each `add_game_version`.
    #[max_len(0)]
    pub versions: Vec<GameVersion>,
}

impl Config {
    pub fn space(versions: usize) -> usize {
        8 + Config::INIT_SPACE + versions * GameVersion::INIT_SPACE
    }
}

#[account]
#[derive(InitSpace)]
pub struct Customer {
    pub layout: u8,
    pub bump: u8,
    /// The customer's Privy wallet: their Deposit Address, and the key that signs for them.
    pub wallet: Pubkey,
    pub balance: u64,
    pub per_purchase_limit: u64,
    pub daily_limit: u64,
    pub default_mode: Mode,
    pub day: i64,
    pub spent_today: u64,
    /// Running Total = cashback_received - premiums_paid.
    pub premiums_paid: u64,
    pub cashback_received: u64,
    /// Checkouts admitted so far: the next one must carry this number.
    pub checkouts: u64,
    pub spare: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum Status {
    Pending,
    /// Delivered and Lucky: waiting for its randomness.
    Drawing,
    Delivered,
    Failed,
    Reclaimed,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct Card {
    pub mode: Mode,
    pub reference_price: u64,
    pub lucky_amount: u64,
    /// Debited at admission: the Maximum Price, or the Reference Price for Normal.
    pub max_price: u64,
    /// Free Reserve locked for this card: its largest Reference Discount.
    pub locked: u64,
    pub status: Status,
    pub cashback: u64,
    /// Which of the Checkout's randomness requests draws this card.
    pub round: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Checkout {
    pub layout: u8,
    pub bump: u8,
    /// The customer's wallet.
    pub customer: Pubkey,
    pub number: u64,
    /// Paid the rent, and gets it back when the Checkout closes.
    pub payer: Pubkey,
    pub created_at: i64,
    /// Randomness requests made so far; the next request's seed uses this number.
    pub rounds: u8,
    pub requested_at: i64,
    pub spare: [u8; 16],
    #[max_len(MAX_CART)]
    pub cards: Vec<Card>,
}

impl Checkout {
    pub fn space(cards: usize) -> usize {
        8 + Checkout::INIT_SPACE - MAX_CART * Card::INIT_SPACE + cards * Card::INIT_SPACE
    }

    /// Every card is delivered (and drawn), failed or reclaimed.
    pub fn done(&self) -> bool {
        self.cards
            .iter()
            .all(|c| !matches!(c.status, Status::Pending | Status::Drawing))
    }
}
