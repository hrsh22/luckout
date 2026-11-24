//! The paths that move USDC, as real wasm on a local NEAR sandbox: what the unit tests in
//! src/tests.rs can't see (gas, the 1 yoctoNEAR on transfers, `#[private]`, deposits on methods that
//! take none, and real callback results from the USDC contract).
//!
//! Build both contracts first, from contract/:
//!   cargo near build non-reproducible-wasm && (cd test-usdc && cargo near build non-reproducible-wasm)
//! then, from contract/sandbox/: cargo test

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const USDC: u128 = 1_000_000;
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
// The gas our callers attach on mainnet: the Web App's deposit and withdrawal (apps/web/lib/actions.ts)
// and the server's operator calls (apps/server/src/Near.ts). The flows must succeed within them.
const DEPOSIT_GAS: Gas = Gas::from_tgas(100);
const WITHDRAW_GAS: Gas = Gas::from_tgas(60);
const OPERATOR_GAS: Gas = Gas::from_tgas(100);
/// The gas `settle` gives `on_draw_many` for a full cart, whatever its caller attaches: 5 Tgas plus 4 a Draw
/// (GAS_DRAW_MANY_BASE, GAS_DRAW_EACH in src/lib.rs).
const DRAW_MANY_STATIC_TGAS: u64 = 5 + 4 * 15;

fn wasm(path: &str) -> Vec<u8> {
    let full = format!("{}/../target/near/{path}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&full).unwrap_or_else(|_| {
        panic!("{full} is missing: build the contracts first (see the top of this file)")
    })
}

struct World {
    // Kept so the sandbox runs until the test ends.
    _worker: Worker<Sandbox>,
    luckout: Contract,
    usdc: Contract,
    owner: Account,
    operator: Account,
    alice: Account,
}

/// Luckout and test USDC deployed, 500 USDC of Cashback Reserve, and Alice holding 100 USDC in her wallet.
async fn world() -> anyhow::Result<World> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let usdc = worker.dev_deploy(&wasm("test_usdc/test_usdc.wasm")).await?;
    usdc.call("new").transact().await?.into_result()?;
    let luckout = worker.dev_deploy(&wasm("luckout.wasm")).await?;
    let mut accounts = vec![];
    for name in ["owner", "server", "alice"] {
        accounts.push(
            root.create_subaccount(name)
                .initial_balance(NearToken::from_near(10))
                .transact()
                .await?
                .into_result()?,
        );
    }
    let [owner, operator, alice] = accounts.try_into().unwrap();
    luckout
        .call("new")
        .args_json(json!({ "owner": owner.id(), "operator": operator.id(), "usdc": usdc.id() }))
        .transact()
        .await?
        .into_result()?;
    // The contract must be registered on the token to receive deposits, as on mainnet.
    usdc.call("storage_deposit")
        .args_json(json!({ "account_id": luckout.id(), "registration_only": true }))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    for _ in 0..5 {
        owner
            .call(usdc.id(), "faucet")
            .transact()
            .await?
            .into_result()?;
    }
    alice
        .call(usdc.id(), "faucet")
        .transact()
        .await?
        .into_result()?;
    let w = World {
        _worker: worker,
        luckout,
        usdc,
        owner,
        operator,
        alice,
    };
    let funded = w.deposit(&w.owner, 500 * USDC, "reserve").await?;
    assert!(funded.is_success(), "{funded:?}");
    Ok(w)
}

impl World {
    /// `ft_transfer_call` of `amount` from `who` to Luckout with `msg`, as a wallet sends it.
    async fn deposit(
        &self,
        who: &Account,
        amount: u128,
        msg: &str,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(who
            .call(self.usdc.id(), "ft_transfer_call")
            .args_json(json!({ "receiver_id": self.luckout.id(), "amount": amount.to_string(), "msg": msg }))
            .deposit(ONE_YOCTO)
            .gas(DEPOSIT_GAS)
            .transact()
            .await?)
    }
    async fn usdc_of(&self, who: &Account) -> anyhow::Result<u128> {
        let s: String = self
            .usdc
            .view("ft_balance_of")
            .args_json(json!({ "account_id": who.id() }))
            .await?
            .json()?;
        Ok(s.parse()?)
    }
    async fn balance_of(&self, who: &Account) -> anyhow::Result<u128> {
        let a: Value = self
            .luckout
            .view("get_account")
            .args_json(json!({ "account_id": who.id() }))
            .await?
            .json()?;
        Ok(a["balance"].as_str().map_or(0, |s| s.parse().unwrap()))
    }
    async fn purchase(&self, id: u64) -> anyhow::Result<Value> {
        Ok(self
            .luckout
            .view("get_purchase")
            .args_json(json!({ "purchase_id": id }))
            .await?
            .json()?)
    }
    /// The USDC the contract holds is exactly what it owes: the `customers`' Balances, the Cashback Reserve (free and
    /// locked) and the Proceeds. Holds whenever no purchase is open, as an open one holds money of its own.
    async fn assert_accounted_for(&self, customers: &[&Account]) -> anyhow::Result<()> {
        let mut owed = 0;
        for c in customers {
            owed += self.balance_of(c).await?;
        }
        let r: Value = self.luckout.view("get_reserve").await?.json()?;
        for part in ["free", "locked", "proceeds"] {
            owed += r[part].as_str().unwrap().parse::<u128>()?;
        }
        let held = self.usdc_of(self.luckout.as_account()).await?;
        assert_eq!(held, owed, "the contract's USDC against Balances + {r}");
        Ok(())
    }
}

/// The contract's panic message, from a failed transaction or any failed receipt in it.
fn failure(r: &ExecutionFinalResult) -> String {
    format!("{:?}", r.receipt_failures())
}

#[tokio::test]
async fn a_deposit_credits_the_balance_and_a_refused_one_is_refunded_by_usdc() -> anyhow::Result<()>
{
    let w = world().await?;
    let r = w.deposit(&w.alice, 40 * USDC, "").await?;
    assert!(r.is_success(), "{r:?}");
    assert_eq!(w.balance_of(&w.alice).await?, 40 * USDC);
    assert_eq!(w.usdc_of(&w.alice).await?, 60 * USDC);

    // An unknown message panics in ft_on_transfer; USDC's ft_resolve_transfer then gives it all back.
    let r = w.deposit(&w.alice, 10 * USDC, "gift").await?;
    assert!(failure(&r).contains("Unknown deposit message"), "{r:?}");
    assert_eq!(w.usdc_of(&w.alice).await?, 60 * USDC);
    assert_eq!(w.balance_of(&w.alice).await?, 40 * USDC);
    Ok(())
}

#[tokio::test]
async fn a_withdrawal_reaches_the_wallet_within_the_gas_the_web_app_attaches() -> anyhow::Result<()>
{
    let w = world().await?;
    assert!(w.deposit(&w.alice, 40 * USDC, "").await?.is_success());
    let r = w
        .alice
        .call(w.luckout.id(), "withdraw")
        .args_json(json!({ "amount": (15 * USDC).to_string() }))
        .deposit(ONE_YOCTO)
        .gas(WITHDRAW_GAS)
        .transact()
        .await?;
    // Every receipt succeeded: the ft_transfer (with its 1 yoctoNEAR) and on_send.
    assert!(r.is_success() && r.receipt_failures().is_empty(), "{r:?}");
    assert!(
        !r.logs().iter().any(|l| l.contains("payout_restored")),
        "{:?}",
        r.logs()
    );
    assert_eq!(w.balance_of(&w.alice).await?, 25 * USDC);
    assert_eq!(w.usdc_of(&w.alice).await?, 75 * USDC);
    Ok(())
}

#[tokio::test]
async fn a_withdrawal_to_an_account_usdc_doesnt_know_is_put_back() -> anyhow::Result<()> {
    let w = world().await?;
    // Alice moves everything in, then leaves USDC (storage_unregister needs a zero USDC balance).
    assert!(w.deposit(&w.alice, 100 * USDC, "").await?.is_success());
    w.alice
        .call(w.usdc.id(), "storage_unregister")
        .args_json(json!({}))
        .deposit(ONE_YOCTO)
        .transact()
        .await?
        .into_result()?;
    let r = w
        .alice
        .call(w.luckout.id(), "withdraw")
        .args_json(json!({ "amount": (30 * USDC).to_string() }))
        .deposit(ONE_YOCTO)
        .gas(WITHDRAW_GAS)
        .transact()
        .await?;
    // The transfer fails in USDC; on_send sees the real failure and restores the Balance.
    assert!(!r.receipt_failures().is_empty(), "{r:?}");
    assert!(
        r.logs().iter().any(|l| l.contains("payout_restored")),
        "{:?}",
        r.logs()
    );
    assert_eq!(w.balance_of(&w.alice).await?, 100 * USDC);
    Ok(())
}

#[tokio::test]
async fn a_confirmed_lucky_buy_is_drawn_in_its_own_receipt_and_nobody_can_call_the_draw(
) -> anyhow::Result<()> {
    let w = world().await?;
    assert!(w.deposit(&w.alice, 50 * USDC, "").await?.is_success());
    let pid: u64 = w
        .operator
        .call(w.luckout.id(), "purchase")
        .args_json(json!({
            "customer": w.alice.id(), "reference_price": (10 * USDC).to_string(), "mode": { "lucky": 1 },
            "order_id": "sandbox-1", "max_debit": (12 * USDC).to_string(),
        }))
        .gas(OPERATOR_GAS)
        .transact()
        .await?
        .json()?;
    let r = w
        .operator
        .call(w.luckout.id(), "confirm_delivery")
        .args_json(json!({ "purchase_id": pid }))
        .gas(OPERATOR_GAS)
        .transact()
        .await?;
    // The Draw ran in the on_draw callback, within the gas the server attaches, and settled the purchase.
    assert!(r.is_success() && r.receipt_failures().is_empty(), "{r:?}");
    assert!(
        r.logs().iter().any(|l| l.contains("\"event\":\"draw\"")),
        "{:?}",
        r.logs()
    );
    let p: Value = w
        .luckout
        .view("get_purchase")
        .args_json(json!({ "purchase_id": pid }))
        .await?
        .json()?;
    assert_eq!(p["status"], "Delivered");
    let reserve: Value = w.luckout.view("get_reserve").await?.json()?;
    assert_eq!(reserve["locked"], "0");

    // `#[private]`: a customer can't run a Draw.
    let r = w
        .alice
        .call(w.luckout.id(), "on_draw")
        .args_json(json!({ "purchase_id": pid }))
        .transact()
        .await?;
    assert!(failure(&r).contains("is private"), "{r:?}");
    // Nor can the contract account's own key, which `#[private]` alone would let through.
    let r = w
        .luckout
        .call("on_draw")
        .args_json(json!({ "purchase_id": pid }))
        .transact()
        .await?;
    assert!(
        failure(&r).contains("The contract's own key can't run a Draw"),
        "{r:?}"
    );
    Ok(())
}

#[tokio::test]
async fn methods_that_take_no_deposit_refuse_one() -> anyhow::Result<()> {
    let w = world().await?;
    let r = w
        .alice
        .call(w.luckout.id(), "reclaim")
        .args_json(json!({ "purchase_id": 0 }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?;
    assert!(failure(&r).contains("doesn't accept deposit"), "{r:?}");
    Ok(())
}

/// A cart of `n` 1 USDC cards for Alice, Lucky on versions 0, 1, 2 in turn.
fn lucky_cart(n: usize) -> Vec<Value> {
    (0..n)
        .map(|i| {
            json!({
                "reference_price": USDC.to_string(), "mode": { "lucky": i % 3 },
                "order_id": format!("cart-{i}"), "max_debit": (2 * USDC).to_string(),
            })
        })
        .collect()
}

#[tokio::test]
async fn a_full_cart_of_lucky_cards_is_admitted_settled_and_drawn_within_the_servers_gas(
) -> anyhow::Result<()> {
    let w = world().await?;
    assert!(w.deposit(&w.alice, 50 * USDC, "").await?.is_success());
    let r = w
        .operator
        .call(w.luckout.id(), "purchase_many")
        .args_json(json!({ "customer": w.alice.id(), "items": lucky_cart(15) }))
        .gas(OPERATOR_GAS)
        .transact()
        .await?;
    assert!(r.is_success(), "{r:?}");
    println!(
        "purchase_many, 15 cards: {} Tgas burnt",
        r.total_gas_burnt.as_tgas()
    );
    let ids: Vec<u64> = r.json()?;
    assert_eq!(ids.len(), 15);

    let r = w
        .operator
        .call(w.luckout.id(), "settle")
        .args_json(json!({ "delivered": ids, "failed": [] }))
        .gas(OPERATOR_GAS)
        .transact()
        .await?;
    assert!(r.is_success() && r.receipt_failures().is_empty(), "{r:?}");
    for o in r.receipt_outcomes() {
        println!(
            "settle receipt on {}: {} Tgas burnt",
            o.executor_id,
            o.gas_burnt.as_tgas()
        );
    }
    println!(
        "settle, 15 Lucky Draws: {} Tgas burnt in all",
        r.total_gas_burnt.as_tgas()
    );
    assert_eq!(
        r.logs()
            .iter()
            .filter(|l| l.contains("\"event\":\"draw\""))
            .count(),
        15
    );
    // The callback also gets whatever gas the caller left over, so the run above would pass even if the callback
    // outgrew its own allowance. It must need far less than that allowance, so no caller can attach just enough gas
    // for one outcome and not another.
    let draws = r
        .receipt_outcomes()
        .iter()
        .find(|o| o.logs.iter().any(|l| l.contains("\"event\":\"draw\"")))
        .expect("the Draws' receipt");
    let burnt = draws.gas_burnt;
    assert!(
        burnt < Gas::from_tgas(30),
        "on_draw_many burnt {:.1} Tgas for 15 Draws (10.5 when measured, 2026-11-25): keep it well under its own {DRAW_MANY_STATIC_TGAS} Tgas",
        burnt.as_gas() as f64 / 1e12
    );
    for id in &ids {
        let p: Value = w
            .luckout
            .view("get_purchase")
            .args_json(json!({ "purchase_id": id }))
            .await?
            .json()?;
        assert_eq!(p["status"], "Delivered");
    }
    let reserve: Value = w.luckout.view("get_reserve").await?.json()?;
    assert_eq!(reserve["locked"], "0");
    w.assert_accounted_for(&[&w.alice]).await?;

    // `#[private]`: the operator can't run the Draws itself.
    let r = w
        .operator
        .call(w.luckout.id(), "on_draw_many")
        .args_json(json!({ "purchase_ids": ids }))
        .transact()
        .await?;
    assert!(failure(&r).contains("is private"), "{r:?}");
    Ok(())
}

#[tokio::test]
async fn a_refused_cart_leaves_nothing_behind() -> anyhow::Result<()> {
    let w = world().await?;
    assert!(w.deposit(&w.alice, 5 * USDC, "").await?.is_success());
    let before: Value = w.luckout.view("get_reserve").await?.json()?;
    // Two cards fit the 5 USDC; the third doesn't, so none is admitted.
    let items: Vec<Value> = (0..3)
        .map(|i| json!({ "reference_price": (2 * USDC).to_string(), "mode": "normal", "order_id": format!("all-{i}"), "max_debit": (2 * USDC).to_string() }))
        .collect();
    let r = w
        .operator
        .call(w.luckout.id(), "purchase_many")
        .args_json(json!({ "customer": w.alice.id(), "items": items }))
        .gas(OPERATOR_GAS)
        .transact()
        .await?;
    assert!(failure(&r).contains("Insufficient balance"), "{r:?}");
    assert_eq!(w.balance_of(&w.alice).await?, 5 * USDC);
    let p: Value = w
        .luckout
        .view("get_purchase")
        .args_json(json!({ "purchase_id": 0 }))
        .await?
        .json()?;
    assert!(p.is_null(), "no card was recorded: {p}");
    let after: Value = w.luckout.view("get_reserve").await?.json()?;
    assert_eq!(before, after);
    w.assert_accounted_for(&[&w.alice]).await?;
    Ok(())
}

#[tokio::test]
async fn a_settle_refunds_its_failed_cards_in_full_and_draws_the_delivered_ones(
) -> anyhow::Result<()> {
    let w = world().await?;
    assert!(w.deposit(&w.alice, 50 * USDC, "").await?.is_success());
    let ids: Vec<u64> = w
        .operator
        .call(w.luckout.id(), "purchase_many")
        .args_json(json!({ "customer": w.alice.id(), "items": lucky_cart(4) }))
        .gas(OPERATOR_GAS)
        .transact()
        .await?
        .json()?;
    let admitted = w.balance_of(&w.alice).await?;
    let amount = |p: &Value, field: &str| p[field].as_str().unwrap().parse::<u128>().unwrap();

    let r = w
        .operator
        .call(w.luckout.id(), "settle")
        .args_json(json!({ "delivered": &ids[..2], "failed": &ids[2..] }))
        .gas(OPERATOR_GAS)
        .transact()
        .await?;
    assert!(r.is_success() && r.receipt_failures().is_empty(), "{r:?}");
    // The failed cards come back whole, Risk Premium included; the delivered ones were drawn and paid their Cashback.
    let mut back = 0;
    for (i, id) in ids.iter().enumerate() {
        let p = w.purchase(*id).await?;
        if i < 2 {
            assert_eq!(p["status"], "Delivered");
            back += amount(&p, "cashback");
        } else {
            assert_eq!(p["status"], "Failed");
            back += amount(&p, "max_price");
        }
    }
    assert_eq!(w.balance_of(&w.alice).await?, admitted + back);
    let reserve: Value = w.luckout.view("get_reserve").await?.json()?;
    assert_eq!(reserve["locked"], "0");
    w.assert_accounted_for(&[&w.alice]).await?;
    Ok(())
}
