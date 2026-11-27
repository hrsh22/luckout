//! The game maths, ported from the NEAR contract (`contract/src/lib.rs`) with its test vectors. The Web App's
//! Draw Proof mirrors `card_random`, `roll_from_random`, `final_bps_for_roll` and `final_price`.
//! All amounts are USDC base units (6 decimals); all rates are basis points.

use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

use crate::error::LuckoutError;
use crate::state::{CashbackCap, GameVersion, Mode, Outcome, MAX_NAME, MAX_OUTCOMES};

pub const BPS: u64 = 10_000;
/// Every Game Version averages 105.6% of the Lucky Amount (ADR-0002).
pub const TARGET_FINAL_BPS: u64 = 10_560;
/// Every card stores a record; a floor keeps a stolen operator key from cheaply filling accounts.
pub const MIN_REFERENCE_PRICE: u64 = 500_000;
pub const MAX_CAP_RESERVE_BPS: u32 = 5_000;

impl GameVersion {
    pub fn min_final_bps(&self) -> u32 {
        self.outcomes.iter().map(|o| o.final_bps).min().unwrap_or(BPS as u32)
    }
    /// Largest Reference Discount as a share of the Lucky Amount.
    pub fn max_discount_bps(&self) -> u64 {
        BPS - self.min_final_bps() as u64
    }
    /// Largest Cashback as a share of the Lucky Amount.
    pub fn max_cashback_bps(&self) -> u64 {
        BPS + self.premium_bps as u64 - self.min_final_bps() as u64
    }
}

/// Each table lists (Cashback as a % of what the customer paid, chance in bps); the rest of the chance gets
/// no Cashback. Stored as Final Price shares of the Lucky Amount.
pub fn default_game_versions() -> Vec<GameVersion> {
    let v = |name: &str, premium_bps: u32, cashback: &[(u32, u32)]| {
        let paid = BPS as u32 + premium_bps;
        let none = BPS as u32 - cashback.iter().map(|&(_, chance)| chance).sum::<u32>();
        let mut outcomes: Vec<Outcome> = cashback
            .iter()
            .map(|&(pct, chance_bps)| Outcome { final_bps: paid * (100 - pct) / 100, chance_bps })
            .collect();
        outcomes.push(Outcome { final_bps: paid, chance_bps: none });
        GameVersion { name: name.into(), premium_bps, outcomes }
    };
    vec![
        v("Lite", 1_000, &[(100, 100), (50, 100), (30, 100), (20, 200), (10, 1_800)]),
        v("Classic", 2_000, &[(100, 200), (50, 300), (40, 400), (30, 700), (20, 2_400)]),
        v("Jackpot", 5_000, &[(100, 1_000), (50, 1_200), (40, 3_400)]),
    ]
}

/// Chances sum to 100%, no outcome exceeds the Maximum Price, any Cashback leaves the customer below the
/// Reference Price, at least one outcome is a discount, and the average is exactly 105.6%.
pub fn validate_game_version(v: &GameVersion) -> Result<()> {
    require!(
        !v.name.is_empty()
            && v.name.len() <= MAX_NAME
            && !v.outcomes.is_empty()
            && v.outcomes.len() <= MAX_OUTCOMES
            && v.premium_bps > 0,
        LuckoutError::BadGameVersion
    );
    let max = BPS as u32 + v.premium_bps;
    let (mut chance, mut weighted) = (0u128, 0u128);
    for o in &v.outcomes {
        require!(
            o.chance_bps > 0 && o.final_bps <= max && (o.final_bps == max || o.final_bps < BPS as u32),
            LuckoutError::BadGameVersion
        );
        chance += o.chance_bps as u128;
        weighted += o.chance_bps as u128 * o.final_bps as u128;
    }
    require!(
        chance == BPS as u128
            && weighted == TARGET_FINAL_BPS as u128 * BPS as u128
            && (v.min_final_bps() as u64) < BPS,
        LuckoutError::BadGameVersion
    );
    Ok(())
}

/// The seed of a Checkout's `round`th randomness request. Neither we nor the customer choose it, and no two
/// requests share one, so a request can never be made again for the same Draw.
pub fn draw_seed(checkout: &Pubkey, round: u8) -> [u8; 32] {
    hashv(&[b"luckout-draw", checkout.as_ref(), &[round]]).to_bytes()
}

/// A card's random value: sha256(ORAO's value ‖ card index), so cards drawn from one value stay independent.
pub fn card_random(value: &[u8; 64], card: u8) -> [u8; 32] {
    hashv(&[value, &[card]]).to_bytes()
}

/// 0..10_000; modulo bias is below 1e-15.
pub fn roll_from_random(random: &[u8; 32]) -> u32 {
    (u64::from_le_bytes(random[..8].try_into().unwrap()) % BPS) as u32
}

pub fn final_bps_for_roll(outcomes: &[Outcome], roll: u32) -> u32 {
    let mut cumulative = 0;
    for o in outcomes {
        cumulative += o.chance_bps;
        if roll < cumulative {
            return o.final_bps;
        }
    }
    unreachable!("validated tables cover every roll")
}

/// Unlucky part at Reference Price plus the drawn share of the Lucky Amount, rounded up to the house by under
/// one base unit and never above the Maximum Price.
pub fn final_price(reference: u64, lucky: u64, max_price: u64, final_bps: u32) -> u64 {
    let lucky_paid = (lucky as u128 * final_bps as u128).div_ceil(BPS as u128) as u64;
    (reference - lucky + lucky_paid).min(max_price)
}

/// The most Cashback one card can pay with `free` Free Reserve.
pub fn max_cashback_at(cap: &CashbackCap, free: u64) -> u64 {
    let share = (free as u128 * cap.reserve_bps as u128 / BPS as u128) as u64;
    cap.fixed.unwrap_or(u64::MAX).min(share)
}

/// The most of `r` a card on `v` can play: its best result pays at most the Cashback Cap, and its lock fits.
pub fn lucky_allowed(cap: &CashbackCap, v: &GameVersion, free: u64, r: u64) -> u64 {
    let by_cap = max_cashback_at(cap, free) as u128 * BPS as u128 / v.max_cashback_bps() as u128;
    let by_lock = free as u128 * BPS as u128 / v.max_discount_bps() as u128;
    (r as u128).min(by_cap).min(by_lock) as u64
}

pub fn version(versions: &[GameVersion], v: u32) -> Result<&GameVersion> {
    versions.get(v as usize).ok_or_else(|| error!(LuckoutError::UnknownGameVersion))
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Quote {
    pub mode: Mode,
    pub reference_price: u64,
    pub lucky_amount: u64,
    pub max_price: u64,
}

/// One card's terms with `free` Free Reserve. `confirmed` is the Lucky Amount the customer saw: it is played
/// as is, or refused if the reserve no longer covers it. Without it, the most the reserve allows now.
pub fn quote_at(
    cap: &CashbackCap,
    versions: &[GameVersion],
    free: u64,
    r: u64,
    mode: Mode,
    confirmed: Option<u64>,
) -> Result<Quote> {
    require!(r >= MIN_REFERENCE_PRICE, LuckoutError::BelowMinimumPrice);
    let (lucky, premium) = match mode {
        Mode::Normal => {
            require!(confirmed.unwrap_or(0) == 0, LuckoutError::NormalHasLuckyAmount);
            (0, 0)
        }
        Mode::Lucky(v) => {
            let version = version(versions, v)?;
            let allowed = lucky_allowed(cap, version, free, r);
            let lucky = match confirmed {
                None => allowed,
                Some(x) => {
                    require!(x > 0 && x <= r, LuckoutError::InvalidLuckyAmount);
                    require!(x <= allowed, LuckoutError::ReserveMoved);
                    x
                }
            };
            require!(lucky > 0, LuckoutError::ReserveTooSmall);
            // Rounded up, so even tiny Lucky Amounts average at least 105.6% (ADR-0004).
            (lucky, (lucky as u128 * version.premium_bps as u128).div_ceil(BPS as u128) as u64)
        }
    };
    Ok(Quote { mode, reference_price: r, lucky_amount: lucky, max_price: r + premium })
}

/// The reserve a card locks: its largest Reference Discount.
pub fn lock_for(versions: &[GameVersion], q: &Quote) -> Result<u64> {
    Ok(match q.mode {
        Mode::Normal => 0,
        Mode::Lucky(v) => {
            (q.lucky_amount as u128 * version(versions, v)?.max_discount_bps() as u128 / BPS as u128) as u64
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const USDC: u64 = 1_000_000;
    const CAP: CashbackCap = CashbackCap { fixed: Some(50 * USDC), reserve_bps: 2_000 };

    fn q(free: u64, r: u64, v: u32) -> Quote {
        quote_at(&CAP, &default_game_versions(), free, r, Mode::Lucky(v), None).unwrap()
    }

    #[test]
    fn default_tables_sum_to_100_and_average_exactly_105_6() {
        for v in default_game_versions() {
            validate_game_version(&v).unwrap();
            let total: u64 = (0..10_000).map(|r| final_bps_for_roll(&v.outcomes, r) as u64).sum();
            assert_eq!(total, TARGET_FINAL_BPS * BPS, "{}", v.name);
        }
    }

    #[test]
    fn default_tables_match_adr_0002() {
        let vs = default_game_versions();
        let classic: Vec<(u32, u32)> = vs[1].outcomes.iter().map(|o| (o.final_bps, o.chance_bps)).collect();
        assert_eq!(classic, [(0, 200), (6_000, 300), (7_200, 400), (8_400, 700), (9_600, 2_400), (12_000, 6_000)]);
        let cashback: Vec<u32> = vs
            .iter()
            .map(|v| v.outcomes.iter().filter(|o| o.final_bps < 10_000).map(|o| o.chance_bps).sum())
            .collect();
        assert_eq!(cashback, [2_300, 4_000, 5_600]);
    }

    #[test]
    fn rejects_bad_tables() {
        let t = |premium_bps, outcomes: &[(u32, u32)]| GameVersion {
            name: "Bad".into(),
            premium_bps,
            outcomes: outcomes.iter().map(|&(final_bps, chance_bps)| Outcome { final_bps, chance_bps }).collect(),
        };
        // Cashback that still costs more than normal, a bigger edge, and an outcome above the Maximum Price.
        assert!(validate_game_version(&t(2_000, &[(10_800, 5_000), (12_000, 5_000)])).is_err());
        assert!(validate_game_version(&t(1_000, &[(5_000, 100), (11_000, 9_900)])).is_err());
        assert!(validate_game_version(&t(1_000, &[(12_000, 10_000)])).is_err());
    }

    #[test]
    fn small_purchases_get_the_full_game_version() {
        // 20% of 45 USDC is 9 USDC of Cashback: Jackpot's free result on 6 USDC pays back exactly 9.
        let quotes: Vec<_> = (0..3).map(|v| q(45 * USDC, 6 * USDC, v)).map(|q| (q.lucky_amount, q.max_price)).collect();
        assert_eq!(quotes, [(6 * USDC, 6_600_000), (6 * USDC, 7_200_000), (6 * USDC, 9 * USDC)]);
    }

    #[test]
    fn big_purchases_only_play_the_lucky_amount() {
        let lite = q(165 * USDC, 1_000 * USDC, 0);
        assert_eq!((lite.lucky_amount, lite.max_price), (30 * USDC, 1_003 * USDC));
    }

    #[test]
    fn no_card_pays_back_more_than_50_usdc() {
        let r = 1_000 * USDC;
        let free = |v| {
            let q = q(1_000 * USDC, r, v);
            (q.lucky_amount, q.max_price - final_price(r, q.lucky_amount, q.max_price, 0))
        };
        assert_eq!(free(0), (45_454_545, 50 * USDC));
        assert_eq!(free(1), (41_666_666, 50 * USDC));
        assert_eq!(free(2), (33_333_333, 50 * USDC));
    }

    #[test]
    fn a_lucky_card_needs_a_reserve_and_a_normal_one_has_no_lucky_amount() {
        let vs = default_game_versions();
        assert!(quote_at(&CAP, &vs, 0, 6 * USDC, Mode::Lucky(0), None).is_err());
        assert!(quote_at(&CAP, &vs, 0, 6 * USDC, Mode::Normal, Some(1)).is_err());
        assert!(quote_at(&CAP, &vs, 0, 499_999, Mode::Normal, None).is_err());
        assert_eq!(quote_at(&CAP, &vs, 0, 6 * USDC, Mode::Normal, Some(0)).unwrap().max_price, 6 * USDC);
    }

    #[test]
    fn the_premium_rounds_up() {
        assert_eq!(q(500 * USDC, 1_000_001, 0).max_price, 1_100_002);
    }

    #[test]
    fn a_confirmed_lucky_amount_is_kept_or_refused() {
        let vs = default_game_versions();
        let at = |free, l| quote_at(&CAP, &vs, free, 6 * USDC, Mode::Lucky(1), Some(l));
        assert_eq!(at(1_000 * USDC, 3 * USDC).unwrap().lucky_amount, 3 * USDC);
        assert!(at(USDC, 3 * USDC).is_err());
        assert!(at(1_000 * USDC, 7 * USDC).is_err());
    }

    #[test]
    fn cards_drawn_together_get_independent_rolls_and_seeds_never_repeat() {
        let value = [7u8; 64];
        let rolls: Vec<u32> = (0..15).map(|c| roll_from_random(&card_random(&value, c))).collect();
        let mut unique = rolls.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), 15);
        let k = Pubkey::new_unique();
        assert_ne!(draw_seed(&k, 0), draw_seed(&k, 1));
        assert_ne!(draw_seed(&k, 0), draw_seed(&Pubkey::new_unique(), 0));
    }

    #[test]
    fn final_price_never_exceeds_the_maximum_and_rounds_to_the_house() {
        // Classic on 6 USDC: a free result pays 0, 20% back pays 5.76.
        assert_eq!(final_price(6 * USDC, 6 * USDC, 7_200_000, 0), 0);
        assert_eq!(final_price(6 * USDC, 6 * USDC, 7_200_000, 9_600), 5_760_000);
        assert_eq!(final_price(6 * USDC, 6 * USDC, 7_200_000, 12_000), 7_200_000);
        assert_eq!(final_price(1_000_001, 1, 1_000_002, 5_000), 1_000_001);
    }
}
