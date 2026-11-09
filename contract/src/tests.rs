use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

const USDC: u128 = 1_000_000;
const DAY: u64 = DAY_NS;

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn owner() -> AccountId {
    id("owner.near")
}
fn operator() -> AccountId {
    id("server.near")
}
fn usdc() -> AccountId {
    id("usdc.near")
}
fn alice() -> AccountId {
    id("alice.near")
}

fn call(who: AccountId, ts: u64, seed: [u8; 32], yocto: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(id("luckout.near"))
        .predecessor_account_id(who)
        .block_timestamp(ts)
        .random_seed(seed)
        .attached_deposit(NearToken::from_yoctonear(yocto))
        .build());
}
fn as_(who: AccountId) {
    call(who, DAY, [0; 32], 0);
}

/// Fresh contract with `reserve` USDC of Free Reserve and Alice holding `deposit`.
fn setup(reserve: u128, deposit: u128) -> Contract {
    as_(owner());
    let mut c = Contract::new(owner(), operator(), usdc());
    as_(usdc());
    if reserve > 0 {
        let _ = c.ft_on_transfer(owner(), U128(reserve), "reserve".into());
    }
    let _ = c.ft_on_transfer(alice(), U128(deposit), "".into());
    c
}

fn raise_limits(c: &mut Contract) {
    call(alice(), DAY, [0; 32], 1);
    c.set_limits(U128(u128::MAX / 4), U128(u128::MAX / 4));
}

fn balance(c: &Contract) -> u128 {
    c.get_account(alice()).unwrap().balance.0
}

fn contract() -> AccountId {
    id("luckout.near")
}

/// Confirms delivery, then runs the Draw callback the way NEAR would, in a later receipt.
fn deliver(c: &mut Contract, pid: u64, seed: [u8; 32]) -> Purchase {
    call(operator(), DAY, [0; 32], 0);
    let _ = c.confirm_delivery(pid);
    if c.get_purchase(pid).unwrap().status == Status::Drawing {
        call(contract(), DAY, seed, 0);
        c.on_draw(pid);
    }
    c.get_purchase(pid).unwrap()
}

#[test]
fn default_tables_sum_to_100_and_average_exactly_105_6() {
    for v in default_game_versions() {
        validate_game_version(&v);
        let total: u128 = (0..10_000).map(|r| final_bps_for_roll(&v.outcomes, r) as u128).sum();
        assert_eq!(total, TARGET_FINAL_BPS * BPS, "{}", v.name);
    }
}

#[test]
fn default_tables_match_adr_0002() {
    let vs = default_game_versions();
    let names: Vec<&str> = vs.iter().map(|v| v.name.as_str()).collect();
    assert_eq!(names, ["Lite", "Classic", "Jackpot"]);
    // Classic on 100: pays 120, then 20% back is 96, 30% is 84, and so on.
    let classic: Vec<(u32, u32)> = vs[1].outcomes.iter().map(|o| (o.final_bps, o.chance_bps)).collect();
    assert_eq!(classic, [(0, 200), (6_000, 300), (7_200, 400), (8_400, 700), (9_600, 2_400), (12_000, 6_000)]);
    // Chance of any Cashback; every Cashback leaves the price below normal.
    let cashback: Vec<u32> = vs
        .iter()
        .map(|v| v.outcomes.iter().filter(|o| o.final_bps < 10_000).map(|o| o.chance_bps).sum())
        .collect();
    assert_eq!(cashback, [2_300, 4_000, 5_600]);
}

#[test]
#[should_panic(expected = "Any cashback must leave the price below normal")]
fn rejects_cashback_that_still_costs_more_than_normal() {
    validate_game_version(&GameVersion {
        name: "Teaser".into(),
        premium_bps: 2_000,
        outcomes: vec![
            Outcome { final_bps: 10_800, chance_bps: 5_000 },
            Outcome { final_bps: 12_000, chance_bps: 5_000 },
        ],
    });
}

#[test]
#[should_panic(expected = "Average must be exactly 105.6%")]
fn rejects_a_table_with_a_bigger_edge() {
    validate_game_version(&GameVersion {
        name: "Greedy".into(),
        premium_bps: 1_000,
        outcomes: vec![
            Outcome { final_bps: 5_000, chance_bps: 100 },
            Outcome { final_bps: 11_000, chance_bps: 9_900 },
        ],
    });
}

#[test]
#[should_panic(expected = "Outcome above maximum price")]
fn rejects_an_outcome_above_maximum_price() {
    validate_game_version(&GameVersion {
        name: "Bad".into(),
        premium_bps: 1_000,
        outcomes: vec![Outcome { final_bps: 12_000, chance_bps: 10_000 }],
    });
}

#[test]
fn small_purchases_get_the_full_game_version() {
    let c = setup(30 * USDC, 100 * USDC);
    let q = |v| c.quote(U128(6 * USDC), Mode::Lucky(v));
    assert_eq!((q(0).lucky_amount.0, q(0).max_price.0), (6 * USDC, 6_600_000));
    assert_eq!((q(1).lucky_amount.0, q(1).max_price.0), (6 * USDC, 7_200_000));
    assert_eq!((q(2).lucky_amount.0, q(2).max_price.0), (6 * USDC, 9 * USDC));
    let n = c.quote(U128(6 * USDC), Mode::Normal);
    assert_eq!((n.lucky_amount.0, n.max_price.0), (0, 6 * USDC));
}

#[test]
fn big_purchases_only_play_the_lucky_amount() {
    let c = setup(150 * USDC, 100 * USDC);
    // Discount Cap = 30 USDC, below the 50 USDC Cashback cap for Lite.
    let lite = c.quote(U128(1_000 * USDC), Mode::Lucky(0));
    assert_eq!((lite.lucky_amount.0, lite.max_price.0), (30 * USDC, 1_003 * USDC));
}

#[test]
fn no_lucky_buy_pays_back_more_than_50_usdc() {
    // 1,000 USDC of reserve: the Discount Cap (200) is looser than the Cashback cap.
    let c = setup(1_000 * USDC, 100 * USDC);
    let r = 1_000 * USDC;
    let free = |v: u32| {
        let q = c.quote(U128(r), Mode::Lucky(v));
        (q.lucky_amount.0, q.max_price.0 - final_price(r, q.lucky_amount.0, q.max_price.0, 0))
    };
    // Lite 45.45 + 10%, Classic 41.67 + 20%, Jackpot 33.33 + 50%: each free result pays back 50.
    assert_eq!(free(0), (45_454_545, 50 * USDC));
    assert_eq!(free(1), (41_666_666, 50 * USDC));
    assert_eq!(free(2), (33_333_333, 50 * USDC));
}

#[test]
#[should_panic(expected = "Reserve too small")]
fn lucky_buy_needs_a_reserve() {
    let c = setup(0, 100 * USDC);
    c.quote(U128(6 * USDC), Mode::Lucky(0));
}

#[test]
fn money_is_conserved_and_the_reserve_always_covers_every_payout() {
    let reserve = 500 * USDC;
    // 400 purchases of up to 100 USDC, mostly paid to proceeds.
    let deposit = 100_000 * USDC;
    let mut c = setup(reserve, deposit);
    raise_limits(&mut c);

    for i in 0..400u64 {
        let seed = env::sha256_array(&i.to_le_bytes());
        let mode = match i % 4 {
            0 => Mode::Normal,
            n => Mode::Lucky(n as u32 - 1),
        };
        let r = (2 + (seed[0] as u128 % 199)) * USDC / 2;
        call(operator(), DAY, seed, 0);
        let pid = c.purchase(alice(), U128(r), Some(mode), format!("loop{}", i), U128(u128::MAX));
        let p = c.get_purchase(pid).unwrap();
        // The lock covers the largest possible discount and never exceeds the cap it was admitted under.
        assert!(c.locked_reserve >= p.locked.0);

        if i % 9 == 0 {
            call(operator(), DAY, seed, 0);
            c.fail_purchase(pid);
            assert_eq!(c.get_purchase(pid).unwrap().refund.0, 0);
        } else {
            let p = deliver(&mut c, pid, seed);
            assert_eq!(p.status, Status::Delivered);
            assert!(p.refund.0 <= p.max_price.0 - p.reference_price.0 + p.locked.0);
        }
        assert_eq!(c.locked_reserve, 0);
        assert_eq!(balance(&c) + c.free_reserve + c.locked_reserve + c.proceeds, reserve + deposit);
    }
    assert!(c.lucky_settled > 250);
}

#[test]
fn draw_is_recomputable_from_the_event() {
    let mut c = setup(500 * USDC, 100 * USDC);
    let seed = [7u8; 32];
    call(operator(), DAY, seed, 0);
    let pid = c.purchase(alice(), U128(6 * USDC), Some(Mode::Lucky(2)), format!("o{}", 2), U128(u128::MAX));
    let p = deliver(&mut c, pid, seed);

    let log = get_logs().into_iter().find(|l| l.contains("\"draw\"")).unwrap();
    let random = draw_random(&seed, pid);
    assert!(log.contains(&hex(&random)));
    let f = final_bps_for_roll(&default_game_versions()[2].outcomes, roll_from_random(&random));
    assert_eq!(p.refund.0, 9 * USDC - final_price(6 * USDC, 6 * USDC, 9 * USDC, f));
}

#[test]
fn default_mode_is_used_when_no_mode_is_given() {
    let mut c = setup(500 * USDC, 100 * USDC);
    call(alice(), DAY, [0; 32], 1);
    c.set_default_mode(Mode::Lucky(1));
    as_(operator());
    let pid = c.purchase(alice(), U128(4 * USDC), None, format!("o{}", 3), U128(u128::MAX));
    assert_eq!(c.get_purchase(pid).unwrap().mode, Mode::Lucky(1));
    assert_eq!(balance(&c), 95_200_000);
}

#[test]
fn failed_purchase_returns_everything() {
    let mut c = setup(500 * USDC, 100 * USDC);
    as_(operator());
    let pid = c.purchase(alice(), U128(10 * USDC), Some(Mode::Lucky(2)), format!("o{}", 4), U128(u128::MAX));
    assert_eq!(balance(&c), 85 * USDC);
    c.fail_purchase(pid);
    assert_eq!(balance(&c), 100 * USDC);
    assert_eq!(c.free_reserve, 500 * USDC);
}

#[test]
fn reclaim_opens_after_24_hours() {
    let mut c = setup(500 * USDC, 100 * USDC);
    as_(operator());
    let pid = c.purchase(alice(), U128(10 * USDC), Some(Mode::Lucky(0)), format!("o{}", 5), U128(u128::MAX));
    call(alice(), DAY + RECLAIM_AFTER_NS, [0; 32], 0);
    c.reclaim(pid);
    assert_eq!(balance(&c), 100 * USDC);
    assert_eq!(c.get_purchase(pid).unwrap().status, Status::Reclaimed);
}

#[test]
#[should_panic(expected = "Reclaim opens 24 hours after purchase")]
fn reclaim_too_early_fails() {
    let mut c = setup(500 * USDC, 100 * USDC);
    as_(operator());
    let pid = c.purchase(alice(), U128(10 * USDC), Some(Mode::Lucky(0)), format!("o{}", 6), U128(u128::MAX));
    as_(alice());
    c.reclaim(pid);
}

#[test]
#[should_panic(expected = "Purchase is already closed")]
fn cannot_fail_after_the_draw() {
    let mut c = setup(500 * USDC, 100 * USDC);
    as_(operator());
    let pid = c.purchase(alice(), U128(10 * USDC), Some(Mode::Lucky(2)), format!("o{}", 7), U128(u128::MAX));
    let _ = c.confirm_delivery(pid);
    c.fail_purchase(pid);
}

#[test]
#[should_panic(expected = "Over the per-purchase spending limit")]
fn per_purchase_limit_counts_the_maximum_price() {
    let mut c = setup(500 * USDC, 200 * USDC);
    as_(operator());
    // 40 USDC on Jackpot can cost 56.67 (only 33.33 of it plays), above the default 50 USDC limit.
    c.purchase(alice(), U128(40 * USDC), Some(Mode::Lucky(2)), format!("o{}", 8), U128(u128::MAX));
}

#[test]
#[should_panic(expected = "Over the daily spending limit")]
fn daily_limit_is_enforced() {
    let mut c = setup(0, 200 * USDC);
    as_(operator());
    c.purchase(alice(), U128(40 * USDC), Some(Mode::Normal), format!("o{}", 9), U128(u128::MAX));
    c.purchase(alice(), U128(40 * USDC), Some(Mode::Normal), format!("o{}", 10), U128(u128::MAX));
    c.purchase(alice(), U128(40 * USDC), Some(Mode::Normal), format!("o{}", 11), U128(u128::MAX));
}

#[test]
fn daily_limit_resets_the_next_day() {
    let mut c = setup(0, 200 * USDC);
    as_(operator());
    c.purchase(alice(), U128(50 * USDC), Some(Mode::Normal), format!("o{}", 12), U128(u128::MAX));
    c.purchase(alice(), U128(50 * USDC), Some(Mode::Normal), format!("o{}", 13), U128(u128::MAX));
    call(operator(), 2 * DAY, [0; 32], 0);
    c.purchase(alice(), U128(50 * USDC), Some(Mode::Normal), format!("o{}", 14), U128(u128::MAX));
}

#[test]
#[should_panic(expected = "Only the operator")]
fn only_the_operator_can_buy() {
    let mut c = setup(0, 100 * USDC);
    as_(alice());
    c.purchase(alice(), U128(USDC), Some(Mode::Normal), format!("o{}", 15), U128(u128::MAX));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn raising_limits_needs_a_full_access_signature() {
    let mut c = setup(0, 100 * USDC);
    as_(alice());
    c.set_limits(U128(u128::MAX), U128(u128::MAX));
}

#[test]
#[should_panic(expected = "New purchases are paused")]
fn pause_stops_new_purchases() {
    let mut c = setup(0, 100 * USDC);
    call(owner(), DAY, [0; 32], 1);
    c.set_paused(true);
    as_(operator());
    c.purchase(alice(), U128(USDC), Some(Mode::Normal), format!("o{}", 16), U128(u128::MAX));
}

#[test]
#[should_panic(expected = "Only USDC is accepted")]
fn rejects_other_tokens() {
    let mut c = setup(0, 100 * USDC);
    as_(id("fake.near"));
    let _ = c.ft_on_transfer(alice(), U128(100 * USDC), "".into());
}

#[test]
fn the_same_order_is_admitted_once() {
    let mut c = setup(500 * USDC, 100 * USDC);
    as_(operator());
    let a = c.purchase(alice(), U128(10 * USDC), Some(Mode::Lucky(2)), "order-1".into(), U128(15 * USDC));
    let b = c.purchase(alice(), U128(10 * USDC), Some(Mode::Lucky(2)), "order-1".into(), U128(15 * USDC));
    assert_eq!(a, b);
    assert_eq!(balance(&c), 85 * USDC, "debited once");
}

#[test]
#[should_panic(expected = "Price changed since you confirmed")]
fn never_debits_more_than_the_customer_confirmed() {
    let mut c = setup(500 * USDC, 100 * USDC);
    as_(operator());
    // Confirmed a Normal-looking $10, but the Default Mode would make it Jackpot ($15).
    as_(alice());
    call(alice(), DAY, [0; 32], 1);
    c.set_default_mode(Mode::Lucky(2));
    as_(operator());
    c.purchase(alice(), U128(10 * USDC), None, "order-2".into(), U128(10 * USDC));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn default_mode_needs_a_full_access_signature() {
    let mut c = setup(0, 100 * USDC);
    as_(alice());
    c.set_default_mode(Mode::Lucky(2));
}

#[test]
fn the_draw_runs_in_a_later_receipt_the_confirmation_cant_revert() {
    let mut c = setup(500 * USDC, 100 * USDC);
    as_(operator());
    let pid = c.purchase(alice(), U128(10 * USDC), Some(Mode::Lucky(2)), "o-later".into(), U128(u128::MAX));
    let _ = c.confirm_delivery(pid);
    // Nothing about the outcome exists yet in the confirming receipt.
    assert!(get_logs().iter().all(|l| !l.contains("\"draw\"")));
    assert_eq!(c.get_purchase(pid).unwrap().status, Status::Drawing);
    assert_eq!(balance(&c), 85 * USDC);
    call(contract(), DAY, [9; 32], 0);
    let p = c.on_draw(pid);
    assert_eq!(p.status, Status::Delivered);
    assert_eq!(balance(&c), 85 * USDC + p.refund.0);
    assert!(get_logs().iter().any(|l| l.contains("\"draw\"")));
}

#[test]
#[should_panic(expected = "Draw already done")]
fn a_draw_runs_once() {
    let mut c = setup(500 * USDC, 100 * USDC);
    as_(operator());
    let pid = c.purchase(alice(), U128(10 * USDC), Some(Mode::Lucky(2)), "o-once".into(), U128(u128::MAX));
    deliver(&mut c, pid, [1; 32]);
    call(contract(), DAY, [2; 32], 0);
    c.on_draw(pid);
}

#[test]
fn a_failed_draw_callback_can_be_retried_by_the_customer() {
    let mut c = setup(500 * USDC, 100 * USDC);
    as_(operator());
    let pid = c.purchase(alice(), U128(10 * USDC), Some(Mode::Lucky(0)), "o-retry".into(), U128(u128::MAX));
    let _ = c.confirm_delivery(pid);
    as_(alice());
    let _ = c.retry_draw(pid);
    call(contract(), DAY, [3; 32], 0);
    assert_eq!(c.on_draw(pid).status, Status::Delivered);
}

#[test]
#[should_panic(expected = "Not your purchase")]
fn strangers_cant_retry_a_draw() {
    let mut c = setup(500 * USDC, 100 * USDC);
    as_(operator());
    let pid = c.purchase(alice(), U128(10 * USDC), Some(Mode::Lucky(0)), "o-stranger".into(), U128(u128::MAX));
    let _ = c.confirm_delivery(pid);
    as_(id("mallory.near"));
    let _ = c.retry_draw(pid);
}

#[test]
fn normal_purchases_settle_in_the_confirming_call() {
    let mut c = setup(0, 100 * USDC);
    as_(operator());
    let pid = c.purchase(alice(), U128(10 * USDC), Some(Mode::Normal), "o-normal".into(), U128(u128::MAX));
    let _ = c.confirm_delivery(pid);
    assert_eq!(c.get_purchase(pid).unwrap().status, Status::Delivered);
    assert_eq!(c.get_reserve().proceeds.0, 10 * USDC);
}

#[test]
#[should_panic(expected = "Order id belongs to another purchase")]
fn an_order_id_is_bound_to_its_customer_and_price() {
    let mut c = setup(500 * USDC, 100 * USDC);
    as_(usdc());
    let _ = c.ft_on_transfer(id("bob.near"), U128(100 * USDC), "".into());
    as_(operator());
    c.purchase(alice(), U128(10 * USDC), Some(Mode::Normal), "order-x".into(), U128(u128::MAX));
    c.purchase(id("bob.near"), U128(10 * USDC), Some(Mode::Normal), "order-x".into(), U128(u128::MAX));
}

#[test]
#[should_panic(expected = "Purchases start at 1 USDC")]
fn purchases_start_at_one_usdc() {
    let mut c = setup(0, 100 * USDC);
    as_(operator());
    c.purchase(alice(), U128(999_999), Some(Mode::Normal), "o-tiny".into(), U128(u128::MAX));
}

#[test]
fn the_premium_rounds_up() {
    let c = setup(500 * USDC, 100 * USDC);
    // 10% of 1.000001 USDC is 0.1000001: rounded up to 0.100001.
    let q = c.quote(U128(1_000_001), Mode::Lucky(0));
    assert_eq!(q.max_price.0, 1_100_002);
}
