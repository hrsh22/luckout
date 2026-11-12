use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
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
        let total: u128 = (0..10_000)
            .map(|r| final_bps_for_roll(&v.outcomes, r) as u128)
            .sum();
        assert_eq!(total, TARGET_FINAL_BPS * BPS, "{}", v.name);
    }
}

#[test]
fn default_tables_match_adr_0002() {
    let vs = default_game_versions();
    let names: Vec<&str> = vs.iter().map(|v| v.name.as_str()).collect();
    assert_eq!(names, ["Lite", "Classic", "Jackpot"]);
    // Classic on 100: pays 120, then 20% back is 96, 30% is 84, and so on.
    let classic: Vec<(u32, u32)> = vs[1]
        .outcomes
        .iter()
        .map(|o| (o.final_bps, o.chance_bps))
        .collect();
    assert_eq!(
        classic,
        [
            (0, 200),
            (6_000, 300),
            (7_200, 400),
            (8_400, 700),
            (9_600, 2_400),
            (12_000, 6_000)
        ]
    );
    // Chance of any Cashback; every Cashback leaves the price below normal.
    let cashback: Vec<u32> = vs
        .iter()
        .map(|v| {
            v.outcomes
                .iter()
                .filter(|o| o.final_bps < 10_000)
                .map(|o| o.chance_bps)
                .sum()
        })
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
            Outcome {
                final_bps: 10_800,
                chance_bps: 5_000,
            },
            Outcome {
                final_bps: 12_000,
                chance_bps: 5_000,
            },
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
            Outcome {
                final_bps: 5_000,
                chance_bps: 100,
            },
            Outcome {
                final_bps: 11_000,
                chance_bps: 9_900,
            },
        ],
    });
}

#[test]
#[should_panic(expected = "Outcome above maximum price")]
fn rejects_an_outcome_above_maximum_price() {
    validate_game_version(&GameVersion {
        name: "Bad".into(),
        premium_bps: 1_000,
        outcomes: vec![Outcome {
            final_bps: 12_000,
            chance_bps: 10_000,
        }],
    });
}

#[test]
fn small_purchases_get_the_full_game_version() {
    // 20% of 45 USDC is 9 USDC of Cashback: Jackpot's free result on 6 USDC pays back exactly 9.
    let c = setup(45 * USDC, 100 * USDC);
    let q = |v| c.quote(U128(6 * USDC), Mode::Lucky(v));
    assert_eq!(
        (q(0).lucky_amount.0, q(0).max_price.0),
        (6 * USDC, 6_600_000)
    );
    assert_eq!(
        (q(1).lucky_amount.0, q(1).max_price.0),
        (6 * USDC, 7_200_000)
    );
    assert_eq!(
        (q(2).lucky_amount.0, q(2).max_price.0),
        (6 * USDC, 9 * USDC)
    );
    let n = c.quote(U128(6 * USDC), Mode::Normal);
    assert_eq!((n.lucky_amount.0, n.max_price.0), (0, 6 * USDC));
}

#[test]
fn big_purchases_only_play_the_lucky_amount() {
    let c = setup(165 * USDC, 100 * USDC);
    // 20% of 165 USDC is 33 USDC of Cashback, below the fixed 50: Lite plays 30 (30 + 10% = 33).
    let lite = c.quote(U128(1_000 * USDC), Mode::Lucky(0));
    assert_eq!(
        (lite.lucky_amount.0, lite.max_price.0),
        (30 * USDC, 1_003 * USDC)
    );
}

#[test]
fn no_lucky_buy_pays_back_more_than_50_usdc() {
    // 1,000 USDC of reserve: the 20% share (200) is looser than the fixed 50.
    let c = setup(1_000 * USDC, 100 * USDC);
    let r = 1_000 * USDC;
    let free = |v: u32| {
        let q = c.quote(U128(r), Mode::Lucky(v));
        (
            q.lucky_amount.0,
            q.max_price.0 - final_price(r, q.lucky_amount.0, q.max_price.0, 0),
        )
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

/// Runs a scheduled Draw the way NEAR would, and checks the Cashback stays within its lock.
fn draw(c: &mut Contract, pid: u64, seed: [u8; 32]) {
    call(contract(), DAY, seed, 0);
    let p = c.on_draw(pid);
    assert!(p.cashback.0 <= p.max_price.0 - p.reference_price.0 + p.locked.0);
}

#[test]
fn money_is_conserved_and_the_reserve_always_covers_every_payout() {
    let reserve = 500 * USDC;
    // 400 purchases of up to 100 USDC, mostly paid to proceeds.
    let deposit = 100_000 * USDC;
    let mut c = setup(reserve, deposit);
    raise_limits(&mut c);
    set_treasury(&mut c, u128::MAX / 4);
    // The USDC the contract holds: what came in, less every transfer out that went through.
    let mut held = reserve + deposit;
    // A Lucky Buy whose Draw is scheduled but hasn't run yet.
    let mut drawing: Option<(u64, [u8; 32])> = None;

    for i in 0..400u64 {
        let seed = env::sha256_array(&i.to_le_bytes());
        let mode = match i % 4 {
            0 => Mode::Normal,
            n => Mode::Lucky(n as u32 - 1),
        };
        let r = (2 + (seed[0] as u128 % 199)) * USDC / 2;
        call(operator(), DAY, seed, 0);
        let pid = c.purchase(
            alice(),
            U128(r),
            Some(mode),
            format!("loop{}", i),
            U128(u128::MAX),
            None,
        );
        let p = c.get_purchase(pid).unwrap();
        // The lock covers the largest possible discount and never exceeds the cap it was admitted under.
        assert!(c.locked_reserve >= p.locked.0);
        // Last round's Draw runs only now, so this purchase was admitted while its lock was held.
        if let Some((d, s)) = drawing.take() {
            draw(&mut c, d, s);
        }

        match i % 9 {
            0 => {
                call(operator(), DAY, seed, 0);
                c.fail_purchase(pid);
            }
            1 => {
                call(alice(), DAY + RECLAIM_AFTER_NS, seed, 0);
                c.reclaim(pid);
            }
            _ => {
                call(operator(), DAY, seed, 0);
                let _ = c.confirm_delivery(pid);
                if c.get_purchase(pid).unwrap().status == Status::Drawing {
                    if i % 5 == 2 {
                        drawing = Some((pid, seed));
                    } else {
                        draw(&mut c, pid, seed);
                    }
                }
            }
        }
        if i % 9 < 2 {
            assert_eq!(c.get_purchase(pid).unwrap().cashback.0, 0);
        }

        // Every kind of transfer out; in alternate stretches of 24 rounds they fail and are put back.
        if i % 6 == 3 {
            let (amount, payout) = match (i / 6) % 4 {
                0 => {
                    let amount = balance(&c) / 100;
                    call(alice(), DAY, seed, 1);
                    let _ = c.withdraw(U128(amount));
                    (amount, Payout::Customer(alice()))
                }
                1 => {
                    let amount = c.free_reserve / 20;
                    call(owner(), DAY, seed, 1);
                    let _ = c.withdraw_reserve(U128(amount));
                    (amount, Payout::Reserve)
                }
                2 => {
                    let amount = c.proceeds / 2;
                    call(owner(), DAY, seed, 1);
                    let _ = c.withdraw_proceeds(U128(amount), None);
                    (amount, Payout::Proceeds)
                }
                _ => {
                    let amount = c.proceeds / 2;
                    call(treasury(), DAY, seed, 1);
                    let _ = c.sweep_proceeds(U128(amount));
                    (amount, Payout::Sweep { day: 1 })
                }
            };
            held -= amount;
            let failed = (i / 24) % 2 == 1;
            call(contract(), DAY, seed, 0);
            c.on_send(
                payout,
                U128(amount),
                if failed {
                    Err(PromiseError::Failed)
                } else {
                    Ok(())
                },
            );
            if failed {
                held += amount;
            }
        }

        // A scheduled Draw still holds its lock, and its Risk Premium until it runs.
        let (premium, lock) = drawing.map_or((0, 0), |(d, _)| {
            let p = c.get_purchase(d).unwrap();
            (p.max_price.0 - p.reference_price.0, p.locked.0)
        });
        assert_eq!(c.locked_reserve, lock);
        assert_eq!(
            balance(&c) + c.free_reserve + c.locked_reserve + c.proceeds + premium,
            held
        );
    }
    if let Some((d, s)) = drawing {
        draw(&mut c, d, s);
    }
    assert_eq!(c.locked_reserve, 0);
    assert_eq!(balance(&c) + c.free_reserve + c.proceeds, held);
    assert_eq!(c.lucky_settled, 233);
}

#[test]
fn draw_is_recomputable_from_the_event() {
    let mut c = setup(500 * USDC, 100 * USDC);
    let seed = [7u8; 32];
    call(operator(), DAY, seed, 0);
    let pid = c.purchase(
        alice(),
        U128(6 * USDC),
        Some(Mode::Lucky(2)),
        format!("o{}", 2),
        U128(u128::MAX),
        None,
    );
    let p = deliver(&mut c, pid, seed);

    let log = get_logs()
        .into_iter()
        .find(|l| l.contains("\"draw\""))
        .unwrap();
    let random = draw_random(&seed, pid);
    assert!(log.contains(&hex(&random)));
    let f = final_bps_for_roll(
        &default_game_versions()[2].outcomes,
        roll_from_random(&random),
    );
    assert_eq!(
        p.cashback.0,
        9 * USDC - final_price(6 * USDC, 6 * USDC, 9 * USDC, f)
    );
}

#[test]
fn default_mode_is_used_when_no_mode_is_given() {
    let mut c = setup(500 * USDC, 100 * USDC);
    call(alice(), DAY, [0; 32], 1);
    c.set_default_mode(Mode::Lucky(1));
    as_(operator());
    let pid = c.purchase(
        alice(),
        U128(4 * USDC),
        None,
        format!("o{}", 3),
        U128(u128::MAX),
        None,
    );
    assert_eq!(c.get_purchase(pid).unwrap().mode, Mode::Lucky(1));
    assert_eq!(balance(&c), 95_200_000);
}

#[test]
fn failed_purchase_returns_everything() {
    let mut c = setup(500 * USDC, 100 * USDC);
    as_(operator());
    let pid = c.purchase(
        alice(),
        U128(10 * USDC),
        Some(Mode::Lucky(2)),
        format!("o{}", 4),
        U128(u128::MAX),
        None,
    );
    assert_eq!(balance(&c), 85 * USDC);
    c.fail_purchase(pid);
    assert_eq!(balance(&c), 100 * USDC);
    assert_eq!(c.free_reserve, 500 * USDC);
}

#[test]
fn reclaim_opens_after_24_hours() {
    let mut c = setup(500 * USDC, 100 * USDC);
    as_(operator());
    let pid = c.purchase(
        alice(),
        U128(10 * USDC),
        Some(Mode::Lucky(0)),
        format!("o{}", 5),
        U128(u128::MAX),
        None,
    );
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
    let pid = c.purchase(
        alice(),
        U128(10 * USDC),
        Some(Mode::Lucky(0)),
        format!("o{}", 6),
        U128(u128::MAX),
        None,
    );
    as_(alice());
    c.reclaim(pid);
}

#[test]
#[should_panic(expected = "Purchase is already closed")]
fn cannot_fail_after_the_draw() {
    let mut c = setup(500 * USDC, 100 * USDC);
    as_(operator());
    let pid = c.purchase(
        alice(),
        U128(10 * USDC),
        Some(Mode::Lucky(2)),
        format!("o{}", 7),
        U128(u128::MAX),
        None,
    );
    let _ = c.confirm_delivery(pid);
    c.fail_purchase(pid);
}

#[test]
#[should_panic(expected = "Over the per-purchase spending limit")]
fn per_purchase_limit_counts_the_maximum_price() {
    let mut c = setup(500 * USDC, 200 * USDC);
    as_(operator());
    // 40 USDC on Jackpot can cost 56.67 (only 33.33 of it plays), above the default 50 USDC limit.
    c.purchase(
        alice(),
        U128(40 * USDC),
        Some(Mode::Lucky(2)),
        format!("o{}", 8),
        U128(u128::MAX),
        None,
    );
}

#[test]
#[should_panic(expected = "Over the daily spending limit")]
fn daily_limit_is_enforced() {
    let mut c = setup(0, 200 * USDC);
    as_(operator());
    c.purchase(
        alice(),
        U128(40 * USDC),
        Some(Mode::Normal),
        format!("o{}", 9),
        U128(u128::MAX),
        None,
    );
    c.purchase(
        alice(),
        U128(40 * USDC),
        Some(Mode::Normal),
        format!("o{}", 10),
        U128(u128::MAX),
        None,
    );
    c.purchase(
        alice(),
        U128(40 * USDC),
        Some(Mode::Normal),
        format!("o{}", 11),
        U128(u128::MAX),
        None,
    );
}

#[test]
fn daily_limit_resets_the_next_day() {
    let mut c = setup(0, 200 * USDC);
    as_(operator());
    c.purchase(
        alice(),
        U128(50 * USDC),
        Some(Mode::Normal),
        format!("o{}", 12),
        U128(u128::MAX),
        None,
    );
    c.purchase(
        alice(),
        U128(50 * USDC),
        Some(Mode::Normal),
        format!("o{}", 13),
        U128(u128::MAX),
        None,
    );
    call(operator(), 2 * DAY, [0; 32], 0);
    c.purchase(
        alice(),
        U128(50 * USDC),
        Some(Mode::Normal),
        format!("o{}", 14),
        U128(u128::MAX),
        None,
    );
}

#[test]
#[should_panic(expected = "Only the operator")]
fn only_the_operator_can_buy() {
    let mut c = setup(0, 100 * USDC);
    as_(alice());
    c.purchase(
        alice(),
        U128(USDC),
        Some(Mode::Normal),
        format!("o{}", 15),
        U128(u128::MAX),
        None,
    );
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
    c.purchase(
        alice(),
        U128(USDC),
        Some(Mode::Normal),
        format!("o{}", 16),
        U128(u128::MAX),
        None,
    );
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
    let a = c.purchase(
        alice(),
        U128(10 * USDC),
        Some(Mode::Lucky(2)),
        "order-1".into(),
        U128(15 * USDC),
        None,
    );
    let b = c.purchase(
        alice(),
        U128(10 * USDC),
        Some(Mode::Lucky(2)),
        "order-1".into(),
        U128(15 * USDC),
        None,
    );
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
    c.purchase(
        alice(),
        U128(10 * USDC),
        None,
        "order-2".into(),
        U128(10 * USDC),
        None,
    );
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
    let pid = c.purchase(
        alice(),
        U128(10 * USDC),
        Some(Mode::Lucky(2)),
        "o-later".into(),
        U128(u128::MAX),
        None,
    );
    let _ = c.confirm_delivery(pid);
    // Nothing about the outcome exists yet in the confirming receipt.
    assert!(get_logs().iter().all(|l| !l.contains("\"draw\"")));
    assert_eq!(c.get_purchase(pid).unwrap().status, Status::Drawing);
    assert_eq!(balance(&c), 85 * USDC);
    call(contract(), DAY, [9; 32], 0);
    let p = c.on_draw(pid);
    assert_eq!(p.status, Status::Delivered);
    assert_eq!(balance(&c), 85 * USDC + p.cashback.0);
    assert!(get_logs().iter().any(|l| l.contains("\"draw\"")));
}

#[test]
#[should_panic(expected = "Draw already done")]
fn a_draw_runs_once() {
    let mut c = setup(500 * USDC, 100 * USDC);
    as_(operator());
    let pid = c.purchase(
        alice(),
        U128(10 * USDC),
        Some(Mode::Lucky(2)),
        "o-once".into(),
        U128(u128::MAX),
        None,
    );
    deliver(&mut c, pid, [1; 32]);
    call(contract(), DAY, [2; 32], 0);
    c.on_draw(pid);
}

#[test]
fn a_failed_draw_callback_can_be_retried_by_the_customer() {
    let mut c = setup(500 * USDC, 100 * USDC);
    as_(operator());
    let pid = c.purchase(
        alice(),
        U128(10 * USDC),
        Some(Mode::Lucky(0)),
        "o-retry".into(),
        U128(u128::MAX),
        None,
    );
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
    let pid = c.purchase(
        alice(),
        U128(10 * USDC),
        Some(Mode::Lucky(0)),
        "o-stranger".into(),
        U128(u128::MAX),
        None,
    );
    let _ = c.confirm_delivery(pid);
    as_(id("mallory.near"));
    let _ = c.retry_draw(pid);
}

#[test]
fn normal_purchases_settle_in_the_confirming_call() {
    let mut c = setup(0, 100 * USDC);
    as_(operator());
    let pid = c.purchase(
        alice(),
        U128(10 * USDC),
        Some(Mode::Normal),
        "o-normal".into(),
        U128(u128::MAX),
        None,
    );
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
    c.purchase(
        alice(),
        U128(10 * USDC),
        Some(Mode::Normal),
        "order-x".into(),
        U128(u128::MAX),
        None,
    );
    c.purchase(
        id("bob.near"),
        U128(10 * USDC),
        Some(Mode::Normal),
        "order-x".into(),
        U128(u128::MAX),
        None,
    );
}

#[test]
#[should_panic(expected = "Purchases start at 0.5 USDC")]
fn purchases_start_at_half_a_usdc() {
    let mut c = setup(0, 100 * USDC);
    as_(operator());
    c.purchase(
        alice(),
        U128(499_999),
        Some(Mode::Normal),
        "o-tiny".into(),
        U128(u128::MAX),
        None,
    );
}

#[test]
fn the_premium_rounds_up() {
    let c = setup(500 * USDC, 100 * USDC);
    // 10% of 1.000001 USDC is 0.1000001: rounded up to 0.100001.
    let q = c.quote(U128(1_000_001), Mode::Lucky(0));
    assert_eq!(q.max_price.0, 1_100_002);
}

// ---------- treasury (ADR-0009) ----------

fn treasury() -> AccountId {
    id("treasury.near")
}

/// Alice buys and receives `n` Normal cards of 10 USDC, so the proceeds hold 10·n USDC.
fn with_proceeds(n: u64) -> Contract {
    let mut c = setup(0, 100 * USDC);
    for i in 0..n {
        as_(operator());
        let p = c.purchase(
            alice(),
            U128(10 * USDC),
            Some(Mode::Normal),
            format!("p{i}"),
            U128(u128::MAX),
            None,
        );
        deliver(&mut c, p, [0; 32]);
    }
    assert_eq!(c.get_reserve().proceeds.0, 10 * USDC * n as u128);
    c
}

fn set_treasury(c: &mut Contract, cap: u128) {
    call(owner(), DAY, [0; 32], 1);
    c.set_treasury(Some(treasury()), U128(cap));
}

#[test]
fn the_treasury_pulls_proceeds_up_to_its_daily_cap() {
    let mut c = with_proceeds(5);
    set_treasury(&mut c, 30 * USDC);
    call(treasury(), DAY, [0; 32], 1);
    let _ = c.sweep_proceeds(U128(20 * USDC));
    let _ = c.sweep_proceeds(U128(10 * USDC));
    assert_eq!(c.get_reserve().proceeds.0, 20 * USDC);
    assert_eq!(c.get_config()["swept_today"], "30000000");
    assert!(get_logs().iter().any(|l| l.contains("proceeds_swept")));
}

#[test]
#[should_panic(expected = "Over the treasury's daily cap")]
fn the_treasury_cannot_pull_past_its_cap() {
    let mut c = with_proceeds(5);
    set_treasury(&mut c, 30 * USDC);
    call(treasury(), DAY, [0; 32], 1);
    let _ = c.sweep_proceeds(U128(20 * USDC));
    let _ = c.sweep_proceeds(U128(10 * USDC + 1));
}

#[test]
fn the_cap_starts_over_the_next_day() {
    let mut c = with_proceeds(5);
    set_treasury(&mut c, 30 * USDC);
    call(treasury(), DAY, [0; 32], 1);
    let _ = c.sweep_proceeds(U128(30 * USDC));
    call(treasury(), 2 * DAY, [0; 32], 1);
    let _ = c.sweep_proceeds(U128(20 * USDC));
    assert_eq!(c.get_reserve().proceeds.0, 0);
}

#[test]
#[should_panic(expected = "Only the treasury")]
fn only_the_treasury_can_pull() {
    let mut c = with_proceeds(1);
    set_treasury(&mut c, 30 * USDC);
    call(operator(), DAY, [0; 32], 1);
    let _ = c.sweep_proceeds(U128(USDC));
}

#[test]
#[should_panic(expected = "Over the treasury's daily cap")]
fn a_zero_cap_means_only_the_owner_moves_proceeds() {
    let mut c = with_proceeds(1);
    set_treasury(&mut c, 0);
    call(treasury(), DAY, [0; 32], 1);
    let _ = c.sweep_proceeds(U128(USDC));
}

#[test]
#[should_panic(expected = "Exceeds proceeds")]
fn the_treasury_cannot_pull_more_than_the_proceeds() {
    let mut c = with_proceeds(1);
    set_treasury(&mut c, 100 * USDC);
    call(treasury(), DAY, [0; 32], 1);
    let _ = c.sweep_proceeds(U128(10 * USDC + 1));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn pulling_needs_a_full_access_key() {
    let mut c = with_proceeds(1);
    set_treasury(&mut c, 30 * USDC);
    call(treasury(), DAY, [0; 32], 0);
    let _ = c.sweep_proceeds(U128(USDC));
}

#[test]
#[should_panic(expected = "Only the owner")]
fn only_the_owner_sets_the_treasury() {
    let mut c = with_proceeds(0);
    call(operator(), DAY, [0; 32], 1);
    c.set_treasury(Some(operator()), U128(1_000 * USDC));
}

#[test]
#[should_panic(expected = "The treasury must be its own account")]
fn the_operator_cannot_be_the_treasury() {
    let mut c = with_proceeds(0);
    call(owner(), DAY, [0; 32], 1);
    c.set_treasury(Some(operator()), U128(USDC));
}

#[test]
fn the_owner_sends_proceeds_to_the_treasury_without_a_cap() {
    let mut c = with_proceeds(5);
    set_treasury(&mut c, 0);
    call(owner(), DAY, [0; 32], 1);
    let _ = c.withdraw_proceeds(U128(50 * USDC), Some(true));
    assert_eq!(c.get_reserve().proceeds.0, 0);
    assert!(get_logs().iter().any(|l| l.contains("treasury.near")));
}

#[test]
fn a_failed_pull_puts_back_the_proceeds_and_the_cap() {
    let mut c = with_proceeds(3);
    set_treasury(&mut c, 30 * USDC);
    call(treasury(), DAY, [0; 32], 1);
    let _ = c.sweep_proceeds(U128(30 * USDC));
    call(contract(), DAY, [0; 32], 0);
    c.on_send(
        Payout::Sweep { day: 1 },
        U128(30 * USDC),
        Err(PromiseError::Failed),
    );
    assert_eq!(c.get_reserve().proceeds.0, 30 * USDC);
    assert_eq!(c.get_config()["swept_today"], "0");
}

// ---------- ownership ----------

fn heir() -> AccountId {
    id("heir.near")
}

fn propose(c: &mut Contract, to: Option<AccountId>) {
    call(owner(), DAY, [0; 32], 1);
    c.propose_owner(to);
}

#[test]
fn ownership_moves_only_when_the_new_owner_accepts() {
    let mut c = with_proceeds(0);
    propose(&mut c, Some(heir()));
    assert_eq!(
        c.get_config()["owner"],
        "owner.near",
        "nothing changes on a proposal"
    );
    assert_eq!(c.get_config()["pending_owner"], "heir.near");
    call(heir(), DAY, [0; 32], 1);
    c.accept_owner();
    assert_eq!(c.get_config()["owner"], "heir.near");
    assert!(c.get_config()["pending_owner"].is_null());
    assert!(get_logs().iter().any(|l| l.contains("owner_changed")));
    call(heir(), DAY, [0; 32], 1);
    c.set_paused(true);
}

#[test]
#[should_panic(expected = "Only the owner")]
fn the_old_owner_loses_its_powers() {
    let mut c = with_proceeds(0);
    propose(&mut c, Some(heir()));
    call(heir(), DAY, [0; 32], 1);
    c.accept_owner();
    call(owner(), DAY, [0; 32], 1);
    c.set_paused(true);
}

#[test]
#[should_panic(expected = "Not the proposed owner")]
fn only_the_proposed_account_can_accept() {
    let mut c = with_proceeds(0);
    propose(&mut c, Some(heir()));
    call(alice(), DAY, [0; 32], 1);
    c.accept_owner();
}

#[test]
#[should_panic(expected = "Not the proposed owner")]
fn a_withdrawn_proposal_can_no_longer_be_accepted() {
    let mut c = with_proceeds(0);
    propose(&mut c, Some(heir()));
    propose(&mut c, None);
    call(heir(), DAY, [0; 32], 1);
    c.accept_owner();
}

#[test]
#[should_panic(expected = "Only the owner")]
fn only_the_owner_proposes() {
    let mut c = with_proceeds(0);
    call(operator(), DAY, [0; 32], 1);
    c.propose_owner(Some(operator()));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn accepting_needs_a_full_access_key() {
    let mut c = with_proceeds(0);
    propose(&mut c, Some(heir()));
    call(heir(), DAY, [0; 32], 0);
    c.accept_owner();
}

#[test]
#[should_panic(expected = "That account can't own the contract")]
fn the_operator_can_never_own_the_contract() {
    let mut c = with_proceeds(0);
    propose(&mut c, Some(operator()));
}

#[test]
#[should_panic(expected = "That account can't own the contract")]
fn the_treasury_can_never_own_the_contract() {
    let mut c = with_proceeds(0);
    propose(&mut c, Some(treasury()));
    set_treasury(&mut c, USDC);
    call(treasury(), DAY, [0; 32], 1);
    c.accept_owner();
}

#[test]
#[should_panic(expected = "The treasury must be its own account")]
fn the_owner_can_never_be_the_treasury() {
    let mut c = with_proceeds(0);
    call(owner(), DAY, [0; 32], 1);
    c.set_treasury(Some(owner()), U128(USDC));
}

// ---------- money out ----------

/// The operator admits a purchase for Alice with no confirmed Lucky Amount.
fn buy(c: &mut Contract, r: u128, mode: Mode, order: &str) -> u64 {
    as_(operator());
    c.purchase(
        alice(),
        U128(r),
        Some(mode),
        order.into(),
        U128(u128::MAX),
        None,
    )
}

/// The calls this receipt scheduled, as (receiver, method, JSON args).
fn sent() -> Vec<(AccountId, String, Value)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight {
                    method_name, args, ..
                } => Some((
                    r.receiver_id.clone(),
                    String::from_utf8(method_name).unwrap(),
                    near_sdk::serde_json::from_slice(&args).unwrap(),
                )),
                _ => None,
            })
        })
        .collect()
}

/// An `ft_transfer` of `amount` to `to`, then `on_send` with `payout` to put it back if it fails.
fn transfer(to: &str, amount: u128, payout: Value) -> Vec<(AccountId, String, Value)> {
    vec![
        (
            usdc(),
            "ft_transfer".into(),
            json!({ "receiver_id": to, "amount": amount.to_string(), "memo": null }),
        ),
        (
            contract(),
            "on_send".into(),
            json!({ "payout": payout, "amount": amount.to_string() }),
        ),
    ]
}

#[test]
fn withdrawing_debits_the_balance_and_sends_the_usdc() {
    let mut c = setup(0, 100 * USDC);
    call(alice(), DAY, [0; 32], 1);
    let _ = c.withdraw(U128(40 * USDC));
    assert_eq!(balance(&c), 60 * USDC);
    assert_eq!(
        sent(),
        transfer("alice.near", 40 * USDC, json!({ "Customer": "alice.near" }))
    );
}

#[test]
#[should_panic(expected = "Insufficient balance")]
fn cannot_withdraw_more_than_the_balance() {
    let mut c = setup(0, 100 * USDC);
    call(alice(), DAY, [0; 32], 1);
    let _ = c.withdraw(U128(100 * USDC + 1));
}

#[test]
fn the_owner_withdraws_free_reserve() {
    let mut c = setup(500 * USDC, 100 * USDC);
    // 10 USDC on Jackpot locks 10 USDC of the reserve.
    buy(&mut c, 10 * USDC, Mode::Lucky(2), "o-lock");
    call(owner(), DAY, [0; 32], 1);
    let _ = c.withdraw_reserve(U128(490 * USDC));
    assert_eq!((c.free_reserve, c.locked_reserve), (0, 10 * USDC));
    assert_eq!(sent(), transfer("owner.near", 490 * USDC, json!("Reserve")));
}

#[test]
#[should_panic(expected = "Exceeds free reserve")]
fn locked_reserve_cannot_be_withdrawn() {
    let mut c = setup(500 * USDC, 100 * USDC);
    buy(&mut c, 10 * USDC, Mode::Lucky(2), "o-lock");
    call(owner(), DAY, [0; 32], 1);
    let _ = c.withdraw_reserve(U128(490 * USDC + 1));
}

#[test]
fn a_failed_payout_is_put_back() {
    // Alice holds 80 USDC and the proceeds 20.
    let mut c = with_proceeds(2);
    as_(usdc());
    let _ = c.ft_on_transfer(owner(), U128(100 * USDC), "reserve".into());
    call(alice(), DAY, [0; 32], 1);
    let _ = c.withdraw(U128(30 * USDC));
    call(owner(), DAY, [0; 32], 1);
    let _ = c.withdraw_reserve(U128(40 * USDC));
    let _ = c.withdraw_proceeds(U128(20 * USDC), None);
    assert_eq!(
        (balance(&c), c.free_reserve, c.proceeds),
        (50 * USDC, 60 * USDC, 0)
    );
    call(contract(), DAY, [0; 32], 0);
    // A transfer that went through changes nothing.
    c.on_send(Payout::Customer(alice()), U128(30 * USDC), Ok(()));
    assert_eq!(balance(&c), 50 * USDC);
    for (payout, amount) in [
        (Payout::Customer(alice()), 30),
        (Payout::Reserve, 40),
        (Payout::Proceeds, 20),
    ] {
        c.on_send(payout, U128(amount * USDC), Err(PromiseError::Failed));
    }
    assert_eq!(
        (balance(&c), c.free_reserve, c.proceeds),
        (80 * USDC, 100 * USDC, 20 * USDC)
    );
    assert_eq!(
        get_logs()
            .iter()
            .filter(|l| l.contains("payout_restored"))
            .count(),
        3
    );
}

#[test]
fn a_failed_pull_from_an_earlier_day_leaves_todays_cap_alone() {
    let mut c = with_proceeds(5);
    set_treasury(&mut c, 30 * USDC);
    call(treasury(), DAY, [0; 32], 1);
    let _ = c.sweep_proceeds(U128(30 * USDC));
    call(treasury(), 2 * DAY, [0; 32], 1);
    let _ = c.sweep_proceeds(U128(10 * USDC));
    call(contract(), 2 * DAY, [0; 32], 0);
    c.on_send(
        Payout::Sweep { day: 1 },
        U128(30 * USDC),
        Err(PromiseError::Failed),
    );
    assert_eq!(c.get_reserve().proceeds.0, 40 * USDC);
    assert_eq!(c.get_config()["swept_today"], "10000000");
}

// ---------- purchases ----------

#[test]
fn confirming_a_drawing_purchase_again_only_reschedules_the_draw() {
    let mut c = setup(500 * USDC, 100 * USDC);
    let pid = buy(&mut c, 10 * USDC, Mode::Lucky(1), "o-again");
    let _ = c.confirm_delivery(pid);
    as_(operator());
    let _ = c.confirm_delivery(pid);
    assert_eq!(c.get_reserve().proceeds.0, 10 * USDC, "proceeds added once");
    assert_eq!(c.get_purchase(pid).unwrap().status, Status::Drawing);
    assert_eq!(
        sent(),
        [(contract(), "on_draw".into(), json!({ "purchase_id": pid }))]
    );
    assert!(get_logs().is_empty(), "no second delivery event");
    draw(&mut c, pid, [5; 32]);
    assert_eq!(c.get_purchase(pid).unwrap().status, Status::Delivered);
}

#[test]
#[should_panic(expected = "Deposit at least 1 USDC")]
fn deposits_start_at_1_usdc() {
    let mut c = setup(0, 100 * USDC);
    as_(usdc());
    let _ = c.ft_on_transfer(alice(), U128(USDC - 1), "".into());
}

#[test]
#[should_panic(expected = "Only the owner funds the reserve")]
fn only_the_owner_funds_the_reserve() {
    let mut c = setup(0, 100 * USDC);
    as_(usdc());
    let _ = c.ft_on_transfer(alice(), U128(100 * USDC), "reserve".into());
}

#[test]
#[should_panic(expected = "Unknown deposit message")]
fn unknown_deposit_messages_are_refused() {
    let mut c = setup(0, 100 * USDC);
    as_(usdc());
    let _ = c.ft_on_transfer(alice(), U128(100 * USDC), "gift".into());
}

#[test]
#[should_panic(expected = "Not your purchase")]
fn only_the_customer_can_reclaim() {
    let mut c = setup(500 * USDC, 100 * USDC);
    let pid = buy(&mut c, 10 * USDC, Mode::Lucky(0), "o-mine");
    call(id("mallory.near"), DAY + RECLAIM_AFTER_NS, [0; 32], 0);
    c.reclaim(pid);
}

#[test]
#[should_panic(expected = "Purchase is already closed")]
fn a_confirmed_purchase_cannot_be_reclaimed_even_before_its_draw() {
    let mut c = setup(500 * USDC, 100 * USDC);
    let pid = buy(&mut c, 10 * USDC, Mode::Lucky(0), "o-drawing");
    let _ = c.confirm_delivery(pid);
    call(alice(), DAY + RECLAIM_AFTER_NS, [0; 32], 0);
    c.reclaim(pid);
}

#[test]
#[should_panic(expected = "Purchase is already closed")]
fn a_failed_purchase_cannot_be_confirmed() {
    let mut c = setup(0, 100 * USDC);
    let pid = buy(&mut c, 10 * USDC, Mode::Normal, "o-failed");
    c.fail_purchase(pid);
    let _ = c.confirm_delivery(pid);
}

#[test]
#[should_panic(expected = "Purchase is already closed")]
fn a_reclaimed_purchase_cannot_be_failed() {
    let mut c = setup(0, 100 * USDC);
    let pid = buy(&mut c, 10 * USDC, Mode::Normal, "o-reclaimed");
    call(alice(), DAY + RECLAIM_AFTER_NS, [0; 32], 0);
    c.reclaim(pid);
    as_(operator());
    c.fail_purchase(pid);
}

#[test]
fn pausing_leaves_confirm_fail_reclaim_and_withdraw_working() {
    let mut c = setup(500 * USDC, 100 * USDC);
    let lucky = buy(&mut c, 10 * USDC, Mode::Lucky(1), "p-1");
    let failed = buy(&mut c, 10 * USDC, Mode::Normal, "p-2");
    let reclaimed = buy(&mut c, 10 * USDC, Mode::Normal, "p-3");
    call(owner(), DAY, [0; 32], 1);
    c.set_paused(true);
    let p = deliver(&mut c, lucky, [4; 32]);
    assert_eq!(p.status, Status::Delivered);
    as_(operator());
    c.fail_purchase(failed);
    call(alice(), DAY + RECLAIM_AFTER_NS, [0; 32], 0);
    c.reclaim(reclaimed);
    // 100 - 12 for Classic + 20 back from the failed and reclaimed ones.
    assert_eq!(balance(&c), 88 * USDC + p.cashback.0);
    call(alice(), DAY, [0; 32], 1);
    let all = balance(&c);
    let _ = c.withdraw(U128(all));
    assert_eq!(balance(&c), 0);
}

// ---------- the confirmed Lucky Amount ----------

/// Alice confirms 100 USDC on Lite against a 55 USDC reserve: 20% is 11 USDC of Cashback, so a
/// 10 USDC Lucky Amount for 101.
fn confirmed_quote() -> (Contract, Quote) {
    let mut c = setup(55 * USDC, 200 * USDC);
    raise_limits(&mut c);
    let q = c.quote(U128(100 * USDC), Mode::Lucky(0));
    assert_eq!((q.lucky_amount.0, q.max_price.0), (10 * USDC, 101 * USDC));
    (c, q)
}

/// The operator admits exactly what the customer confirmed in `q`.
fn buy_confirmed(c: &mut Contract, q: &Quote, order: &str) -> u64 {
    as_(operator());
    c.purchase(
        alice(),
        q.reference_price,
        Some(q.mode),
        order.into(),
        q.max_price,
        Some(q.lucky_amount),
    )
}

fn fund_reserve(c: &mut Contract, amount: u128) {
    as_(usdc());
    let _ = c.ft_on_transfer(owner(), U128(amount), "reserve".into());
}

fn shrink_reserve(c: &mut Contract, amount: u128) {
    call(owner(), DAY, [0; 32], 1);
    let _ = c.withdraw_reserve(U128(amount));
}

#[test]
fn a_confirmed_lucky_amount_is_kept_when_the_reserve_grows() {
    let (mut c, q) = confirmed_quote();
    fund_reserve(&mut c, 50 * USDC);
    let pid = buy_confirmed(&mut c, &q, "o-grew");
    let p = c.get_purchase(pid).unwrap();
    assert_eq!(
        (p.lucky_amount.0, p.max_price.0, p.locked.0),
        (10 * USDC, 101 * USDC, 10 * USDC)
    );
    assert_eq!(balance(&c), 99 * USDC);
}

#[test]
#[should_panic(expected = "Price changed since you confirmed")]
fn without_it_a_grown_reserve_refuses_the_confirmed_price() {
    let (mut c, q) = confirmed_quote();
    fund_reserve(&mut c, 50 * USDC);
    as_(operator());
    c.purchase(
        alice(),
        q.reference_price,
        Some(q.mode),
        "o-grew".into(),
        q.max_price,
        None,
    );
}

#[test]
#[should_panic(expected = "The Cashback Reserve moved since you confirmed")]
fn a_confirmed_lucky_amount_is_refused_when_the_reserve_shrinks() {
    let (mut c, q) = confirmed_quote();
    shrink_reserve(&mut c, 25 * USDC);
    buy_confirmed(&mut c, &q, "o-shrank");
}

#[test]
fn without_it_a_shrunk_reserve_admits_a_smaller_game() {
    let (mut c, q) = confirmed_quote();
    // 27.5 USDC left: 5.5 USDC of Cashback, a 5 USDC Lucky Amount.
    shrink_reserve(&mut c, 27_500_000);
    as_(operator());
    let pid = c.purchase(
        alice(),
        q.reference_price,
        Some(q.mode),
        "o-shrank".into(),
        q.max_price,
        None,
    );
    let p = c.get_purchase(pid).unwrap();
    assert_eq!((p.lucky_amount.0, p.max_price.0), (5 * USDC, 100_500_000));
}

#[test]
fn a_replayed_order_returns_its_purchase_before_checking_the_reserve() {
    let (mut c, q) = confirmed_quote();
    let a = buy_confirmed(&mut c, &q, "o-replay");
    shrink_reserve(&mut c, 30 * USDC);
    assert_eq!(buy_confirmed(&mut c, &q, "o-replay"), a);
    assert_eq!(balance(&c), 99 * USDC, "debited once");
}

#[test]
fn a_normal_purchase_may_confirm_a_zero_lucky_amount() {
    let mut c = setup(0, 100 * USDC);
    as_(operator());
    c.purchase(
        alice(),
        U128(10 * USDC),
        Some(Mode::Normal),
        "o-zero".into(),
        U128(10 * USDC),
        Some(U128(0)),
    );
    assert_eq!(balance(&c), 90 * USDC);
}

#[test]
#[should_panic(expected = "A Normal purchase has no Lucky Amount")]
fn a_normal_purchase_has_no_lucky_amount() {
    let mut c = setup(0, 100 * USDC);
    as_(operator());
    c.purchase(
        alice(),
        U128(10 * USDC),
        Some(Mode::Normal),
        "o-one".into(),
        U128(10 * USDC),
        Some(U128(1)),
    );
}

#[test]
#[should_panic(expected = "Invalid Lucky Amount")]
fn the_lucky_amount_cannot_exceed_the_price() {
    let (mut c, mut q) = confirmed_quote();
    fund_reserve(&mut c, 10_000 * USDC);
    q.lucky_amount = U128(q.reference_price.0 + 1);
    buy_confirmed(&mut c, &q, "o-over");
}

/// The wasm entry point parses its JSON arguments into a struct like this one (near-sdk-macros 5,
/// `AttrSigInfo::input_struct_deser`), so callers that leave out `lucky_amount` get `None`.
#[test]
fn callers_may_leave_out_the_lucky_amount() {
    #[derive(near_sdk::serde::Deserialize)]
    #[serde(crate = "near_sdk::serde")]
    #[allow(dead_code)]
    struct Input {
        customer: AccountId,
        reference_price: U128,
        mode: Option<Mode>,
        order_id: String,
        max_debit: U128,
        lucky_amount: Option<U128>,
    }
    let parse = |args: &Value| {
        near_sdk::serde_json::from_slice::<Input>(args.to_string().as_bytes())
            .unwrap()
            .lucky_amount
    };
    let mut args = json!({
        "customer": "alice.near",
        "reference_price": "100000000",
        "mode": { "lucky": 0 },
        "order_id": "o-1",
        "max_debit": "101000000",
    });
    assert_eq!(parse(&args), None);
    args["lucky_amount"] = json!("10000000");
    assert_eq!(parse(&args), Some(U128(10 * USDC)));
}

// ---------- roles ----------

fn set_operator(c: &mut Contract, to: AccountId) {
    call(owner(), DAY, [0; 32], 1);
    c.set_operator(to);
}

#[test]
fn the_owner_can_replace_the_operator() {
    let mut c = setup(0, 100 * USDC);
    set_operator(&mut c, id("server2.near"));
    as_(id("server2.near"));
    c.purchase(
        alice(),
        U128(USDC),
        Some(Mode::Normal),
        "o-new-operator".into(),
        U128(USDC),
        None,
    );
}

#[test]
#[should_panic(expected = "That account can't be the operator")]
fn the_owner_cannot_be_the_operator() {
    let mut c = with_proceeds(0);
    set_operator(&mut c, owner());
}

#[test]
#[should_panic(expected = "That account can't be the operator")]
fn the_proposed_owner_cannot_be_the_operator() {
    let mut c = with_proceeds(0);
    propose(&mut c, Some(heir()));
    set_operator(&mut c, heir());
}

#[test]
#[should_panic(expected = "That account can't be the operator")]
fn the_treasury_cannot_be_the_operator() {
    let mut c = with_proceeds(0);
    set_treasury(&mut c, USDC);
    set_operator(&mut c, treasury());
}

#[test]
#[should_panic(expected = "That account can't be the operator")]
fn the_contract_cannot_be_its_own_operator() {
    let mut c = with_proceeds(0);
    set_operator(&mut c, contract());
}

#[test]
#[should_panic(expected = "That account can't own the contract")]
fn the_operator_can_never_accept_ownership() {
    let mut c = with_proceeds(0);
    propose(&mut c, Some(heir()));
    // What the old `set_operator` could leave on chain: the proposed owner made operator.
    c.operator = heir();
    call(heir(), DAY, [0; 32], 1);
    c.accept_owner();
}

// ---------- the Draw and the contract's own key ----------

/// The Draw callback as NEAR runs it: the contract is the predecessor, `signer` signed the transaction.
fn draw_signed_by(c: &mut Contract, signer: AccountId, pid: u64) -> Purchase {
    testing_env!(VMContextBuilder::new()
        .current_account_id(contract())
        .predecessor_account_id(contract())
        .signer_account_id(signer)
        .build());
    c.on_draw(pid)
}

#[test]
fn a_draw_scheduled_by_the_operator_runs() {
    let mut c = setup(500 * USDC, 100 * USDC);
    let pid = buy(&mut c, 10 * USDC, Mode::Lucky(2), "o-signed");
    let _ = c.confirm_delivery(pid);
    assert_eq!(
        draw_signed_by(&mut c, operator(), pid).status,
        Status::Delivered
    );
}

#[test]
#[should_panic(expected = "The contract's own key can't run a Draw")]
fn the_contract_key_cannot_run_a_draw() {
    let mut c = setup(500 * USDC, 100 * USDC);
    let pid = buy(&mut c, 10 * USDC, Mode::Lucky(2), "o-self");
    let _ = c.confirm_delivery(pid);
    draw_signed_by(&mut c, contract(), pid);
}

#[test]
#[should_panic(expected = "That account can't be the operator")]
fn the_owner_is_never_the_operator_from_the_start() {
    as_(owner());
    Contract::new(owner(), owner(), usdc());
}

#[test]
#[should_panic(expected = "That account can't be the operator")]
fn the_contract_never_operates_itself_from_the_start() {
    as_(owner());
    Contract::new(owner(), contract(), usdc());
}

// ---------- EVM customers through NEAR Intents (ADR-0011) ----------

fn intents() -> AccountId {
    id("intents.near")
}
fn evm() -> AccountId {
    id("0x53a19a03679e8d5e9253a998dcde6c71dbb002a2")
}
fn for_evm() -> String {
    format!(r#"{{"for":"{}"}}"#, evm())
}

/// Fresh contract with a reserve, where the EVM customer moved `deposit` in from NEAR Intents.
fn setup_evm(deposit: u128) -> Contract {
    let mut c = setup(500 * USDC, USDC);
    as_(usdc());
    let _ = c.ft_on_transfer(intents(), U128(deposit), for_evm());
    c
}

fn auth(c: &mut Contract, signer: AccountId, msg: Value) -> PromiseOrValue<()> {
    as_(intents());
    c.on_auth(signer, msg.to_string())
}

fn evm_balance(c: &Contract) -> u128 {
    c.get_account(evm()).unwrap().balance.0
}

#[test]
fn nears_intents_is_fixed_per_network() {
    as_(owner());
    assert_eq!(intents_account(), intents());
    testing_env!(VMContextBuilder::new()
        .current_account_id(id("app.luckout.testnet"))
        .build());
    assert_eq!(intents_account(), id("intents.luckout.testnet"));
}

#[test]
fn only_lowercase_evm_addresses_are_evm_accounts() {
    assert!(is_evm_account(&evm()));
    for s in [
        "alice.near",
        "0x53a19a03679e8d5e9253a998dcde6c71dbb002a",
        "0x53a19a03679e8d5e9253a998dcde6c71dbb002a2a",
        "0x53a19a03679e8d5e9253a998dcde6c71dbb002g2",
        "1x53a19a03679e8d5e9253a998dcde6c71dbb002a2",
    ] {
        if let Ok(a) = s.parse::<AccountId>() {
            assert!(!is_evm_account(&a), "{s}");
        }
    }
}

#[test]
fn a_deposit_from_intents_credits_the_evm_account_it_names() {
    let c = setup_evm(5 * USDC);
    assert_eq!(evm_balance(&c), 5 * USDC);
    assert!(c.get_account(intents()).is_none());
}

#[test]
#[should_panic(expected = "Unknown deposit message")]
fn only_intents_names_the_account_a_deposit_credits() {
    let mut c = setup(0, USDC);
    as_(usdc());
    let _ = c.ft_on_transfer(alice(), U128(5 * USDC), for_evm());
}

#[test]
#[should_panic(expected = "Only EVM accounts are credited this way")]
fn intents_cannot_credit_a_near_account() {
    let mut c = setup(0, USDC);
    as_(usdc());
    let _ = c.ft_on_transfer(intents(), U128(5 * USDC), r#"{"for":"alice.near"}"#.into());
}

#[test]
#[should_panic(expected = "Name the account to credit")]
fn intents_itself_is_never_credited() {
    let mut c = setup(0, USDC);
    as_(usdc());
    let _ = c.ft_on_transfer(intents(), U128(5 * USDC), "".into());
}

#[test]
#[should_panic(expected = "Unknown deposit message")]
fn a_deposit_message_with_extra_fields_is_refused() {
    let mut c = setup(0, USDC);
    as_(usdc());
    let msg = format!(r#"{{"for":"{}","also":"alice.near"}}"#, evm());
    let _ = c.ft_on_transfer(intents(), U128(5 * USDC), msg);
}

#[test]
#[should_panic(expected = "Deposit at least 1 USDC")]
fn deposits_from_intents_have_the_same_minimum() {
    setup_evm(USDC / 2);
}

#[test]
#[should_panic(expected = "Only NEAR Intents vouches for a signer")]
fn the_operator_cannot_act_for_an_evm_customer() {
    let mut c = setup_evm(5 * USDC);
    as_(operator());
    let _ = c.on_auth(
        evm(),
        json!({ "withdraw": { "amount": "1000000" } }).to_string(),
    );
}

#[test]
#[should_panic(expected = "Only NEAR Intents vouches for a signer")]
fn the_evm_customer_cannot_call_on_auth_directly() {
    let mut c = setup_evm(5 * USDC);
    as_(evm());
    let _ = c.on_auth(
        evm(),
        json!({ "withdraw": { "amount": "1000000" } }).to_string(),
    );
}

#[test]
#[should_panic(expected = "Only EVM accounts sign through NEAR Intents")]
fn near_accounts_never_sign_through_intents() {
    let mut c = setup(500 * USDC, 50 * USDC);
    let _ = auth(
        &mut c,
        alice(),
        json!({ "withdraw": { "amount": "1000000" } }),
    );
}

#[test]
#[should_panic(expected = "Unknown action")]
fn unknown_actions_are_refused() {
    let mut c = setup_evm(5 * USDC);
    let _ = auth(
        &mut c,
        evm(),
        json!({ "purchase": { "amount": "1000000" } }),
    );
}

#[test]
fn an_evm_customer_sets_limits_and_default_mode_through_intents() {
    let mut c = setup_evm(5 * USDC);
    let _ = auth(
        &mut c,
        evm(),
        json!({ "set_limits": { "per_purchase": "7000000", "daily": "9000000" } }),
    );
    let _ = auth(
        &mut c,
        evm(),
        json!({ "set_default_mode": { "mode": { "lucky": 1 } } }),
    );
    let a = c.get_account(evm()).unwrap();
    assert_eq!(
        (a.per_purchase_limit.0, a.daily_limit.0, a.default_mode),
        (7 * USDC, 9 * USDC, Mode::Lucky(1))
    );
}

#[test]
fn an_evm_withdrawal_goes_only_to_their_own_intents_account() {
    let mut c = setup_evm(5 * USDC);
    let _ = auth(
        &mut c,
        evm(),
        json!({ "withdraw": { "amount": "2000000" } }),
    );
    assert_eq!(evm_balance(&c), 3 * USDC);
    assert_eq!(
        sent(),
        vec![
            (
                usdc(),
                "ft_transfer_call".into(),
                json!({ "receiver_id": "intents.near", "amount": "2000000", "memo": null, "msg": evm() }),
            ),
            (
                contract(),
                "on_send_to_intents".into(),
                json!({ "account_id": evm(), "amount": "2000000" }),
            ),
        ]
    );
}

#[test]
#[should_panic(expected = "Insufficient balance")]
fn an_evm_customer_cannot_withdraw_more_than_their_balance() {
    let mut c = setup_evm(5 * USDC);
    let _ = auth(
        &mut c,
        evm(),
        json!({ "withdraw": { "amount": "5000001" } }),
    );
}

#[test]
fn whatever_intents_returns_from_a_withdrawal_goes_back_to_the_balance() {
    for (used, back) in [
        (Ok(U128(2 * USDC)), 0),
        (Ok(U128(0)), 2 * USDC),
        (Ok(U128(USDC / 2)), 3 * USDC / 2),
        (Err(PromiseError::Failed), 2 * USDC),
    ] {
        // Mocked storage outlives each contract value, so compare with the balance after this withdrawal.
        let mut c = setup_evm(5 * USDC);
        let _ = auth(
            &mut c,
            evm(),
            json!({ "withdraw": { "amount": "2000000" } }),
        );
        let after = evm_balance(&c);
        as_(contract());
        c.on_send_to_intents(evm(), U128(2 * USDC), used);
        assert_eq!(evm_balance(&c), after + back);
    }
}

#[test]
fn an_evm_customer_reclaims_through_intents() {
    let mut c = setup_evm(50 * USDC);
    as_(operator());
    let pid = c.purchase(
        evm(),
        U128(10 * USDC),
        Some(Mode::Normal),
        "o-evm".into(),
        U128(u128::MAX),
        None,
    );
    assert_eq!(evm_balance(&c), 40 * USDC);
    call(intents(), 2 * DAY, [0; 32], 0);
    let _ = c.on_auth(
        evm(),
        json!({ "reclaim": { "purchase_id": pid } }).to_string(),
    );
    assert_eq!(evm_balance(&c), 50 * USDC);
}

#[test]
#[should_panic(expected = "Not your purchase")]
fn an_evm_customer_cannot_reclaim_someone_elses_purchase() {
    let mut c = setup(500 * USDC, 50 * USDC);
    let pid = buy(&mut c, 10 * USDC, Mode::Normal, "o-alice");
    as_(usdc());
    let _ = c.ft_on_transfer(intents(), U128(5 * USDC), for_evm());
    call(intents(), 2 * DAY, [0; 32], 0);
    let _ = c.on_auth(
        evm(),
        json!({ "reclaim": { "purchase_id": pid } }).to_string(),
    );
}

#[test]
fn an_evm_customer_reruns_their_draw_through_intents() {
    let mut c = setup_evm(50 * USDC);
    as_(operator());
    let pid = c.purchase(
        evm(),
        U128(10 * USDC),
        Some(Mode::Lucky(2)),
        "o-evm-draw".into(),
        U128(u128::MAX),
        None,
    );
    let _ = c.confirm_delivery(pid);
    let _ = auth(
        &mut c,
        evm(),
        json!({ "retry_draw": { "purchase_id": pid } }),
    );
    assert_eq!(
        sent(),
        vec![(contract(), "on_draw".into(), json!({ "purchase_id": pid }))]
    );
}

#[test]
fn a_near_wallet_withdrawal_is_unchanged() {
    let mut c = setup(0, 5 * USDC);
    call(alice(), DAY, [0; 32], 1);
    let _ = c.withdraw(U128(2 * USDC));
    assert_eq!(sent()[0].1, "ft_transfer");
    assert_eq!(sent()[0].2["receiver_id"], "alice.near");
}

// ---------- the Cashback Cap ----------

fn set_cap(c: &mut Contract, fixed: Option<u128>, reserve_bps: Option<u32>) {
    call(owner(), DAY, [0; 32], 1);
    c.set_cashback_cap(fixed.map(U128), reserve_bps);
}

/// What the free result pays back on a 1,000 USDC purchase in mode `v`.
fn best_cashback(c: &Contract, v: u32) -> u128 {
    let r = 1_000 * USDC;
    let q = c.quote(U128(r), Mode::Lucky(v));
    q.max_price.0 - final_price(r, q.lucky_amount.0, q.max_price.0, 0)
}

#[test]
fn the_cap_starts_at_the_lower_of_50_usdc_and_20_percent_of_free_reserve() {
    let c = setup(200 * USDC, USDC);
    assert_eq!(
        c.get_config()["cashback_cap"],
        json!({ "fixed": "50000000", "reserve_bps": 2_000 })
    );
    assert_eq!(c.get_reserve().max_cashback.0, 40 * USDC);
    assert_eq!(best_cashback(&c, 1), 40 * USDC);
}

#[test]
fn the_owner_raises_the_fixed_limit() {
    let mut c = setup(1_000 * USDC, USDC);
    set_cap(&mut c, Some(100 * USDC), Some(2_000));
    assert_eq!(c.get_reserve().max_cashback.0, 100 * USDC);
    // Rounded down to a whole base unit, never above the cap.
    assert_eq!(
        [0, 1, 2].map(|v| best_cashback(&c, v)),
        [99_999_999, 100 * USDC, 99_999_999]
    );
}

#[test]
fn a_share_only_cap_grows_with_the_reserve() {
    let mut c = setup(1_000 * USDC, USDC);
    set_cap(&mut c, None, Some(3_000));
    assert_eq!(c.get_reserve().max_cashback.0, 300 * USDC);
    assert_eq!(best_cashback(&c, 2), 300 * USDC);
}

#[test]
fn a_fixed_only_cap_still_locks_no_more_than_free_reserve() {
    let mut c = setup(30 * USDC, USDC);
    set_cap(&mut c, Some(100 * USDC), None);
    let q = c.quote(U128(1_000 * USDC), Mode::Lucky(0));
    assert_eq!(q.lucky_amount.0, 30 * USDC);
}

#[test]
fn a_new_cap_leaves_accepted_purchases_alone() {
    let mut c = setup(1_000 * USDC, 1_000 * USDC);
    raise_limits(&mut c);
    let pid = buy(&mut c, 500 * USDC, Mode::Lucky(1), "o-before");
    let before = c.get_purchase(pid).unwrap();
    set_cap(&mut c, Some(USDC), None);
    let after = deliver(&mut c, pid, [7; 32]);
    assert_eq!(
        (after.lucky_amount, after.locked),
        (before.lucky_amount, before.locked)
    );
}

#[test]
#[should_panic(expected = "Only the owner")]
fn only_the_owner_sets_the_cashback_cap() {
    let mut c = setup(0, USDC);
    call(operator(), DAY, [0; 32], 1);
    c.set_cashback_cap(Some(U128(1_000 * USDC)), None);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn setting_the_cashback_cap_needs_a_full_access_key() {
    let mut c = setup(0, USDC);
    as_(owner());
    c.set_cashback_cap(Some(U128(100 * USDC)), None);
}

#[test]
#[should_panic(expected = "Keep at least one limit")]
fn the_cashback_cap_keeps_at_least_one_limit() {
    let mut c = setup(0, USDC);
    set_cap(&mut c, None, None);
}

#[test]
#[should_panic(expected = "at most 50%")]
fn the_reserve_share_is_at_most_half() {
    let mut c = setup(0, USDC);
    set_cap(&mut c, None, Some(5_001));
}

#[test]
#[should_panic(expected = "The fixed limit must be above 0")]
fn the_fixed_limit_is_above_zero() {
    let mut c = setup(0, USDC);
    set_cap(&mut c, Some(0), Some(2_000));
}
