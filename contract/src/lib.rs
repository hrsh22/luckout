//! Luckout: one contract holding customer Balances in USDC, their Spending
//! Limits and Default Mode, immutable Game Versions, the Cashback Reserve and
//! every Draw. See CONTEXT.md and docs/adr/0001..0005 for the domain language.
//!
//! All amounts are USDC base units (6 decimals) and all rates are basis points.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

pub const BPS: u128 = 10_000;
/// Every Game Version averages 105.6% of the Lucky Amount (ADR-0002).
pub const TARGET_FINAL_BPS: u128 = 10_560;
/// The Discount Cap: 20% of Free Reserve.
pub const DISCOUNT_CAP_BPS: u128 = 2_000;
/// The most Cashback one Lucky Buy can pay, so a 1,000 USDC reserve serves many buyers (ADR-0002).
pub const MAX_CASHBACK: u128 = 50_000_000; // 50 USDC
pub const DAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
pub const RECLAIM_AFTER_NS: u64 = DAY_NS;
pub const MIN_DEPOSIT: u128 = 1_000_000; // 1 USDC, keeps dust accounts from bloating storage
/// Every purchase stores a record; a floor keeps a stolen operator key from cheaply filling storage.
pub const MIN_REFERENCE_PRICE: u128 = 500_000; // 0.5 USDC, so ₹50 cards sell (ADR-0001)
pub const DEFAULT_PER_PURCHASE_LIMIT: u128 = 50_000_000; // 50 USDC
pub const DEFAULT_DAILY_LIMIT: u128 = 100_000_000; // 100 USDC
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_ON_SEND: Gas = Gas::from_tgas(10);
/// The Draw callback's gas is set here, not by the caller (it uses ~3 Tgas).
const GAS_DRAW: Gas = Gas::from_tgas(20);

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near]
#[derive(BorshStorageKey)]
enum Key {
    Accounts,
    Versions,
    Purchases,
    Orders,
}

/// Normal is a Standard Purchase; Lucky(n) is a Lucky Buy on Game Version n.
/// JSON: `"normal"` or `{"lucky": 0}`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Normal,
    Lucky(u32),
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Outcome {
    /// Final Price on the Lucky Amount, e.g. 5_000 = pays half.
    pub final_bps: u32,
    pub chance_bps: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct GameVersion {
    pub name: String,
    pub premium_bps: u32,
    pub outcomes: Vec<Outcome>,
}

impl GameVersion {
    fn min_final_bps(&self) -> u32 {
        self.outcomes.iter().map(|o| o.final_bps).min().unwrap()
    }
    /// Largest Reference Discount as a share of the Lucky Amount.
    fn max_discount_bps(&self) -> u128 {
        BPS - self.min_final_bps() as u128
    }
    /// Largest Cashback as a share of the Lucky Amount.
    fn max_cashback_bps(&self) -> u128 {
        BPS + self.premium_bps as u128 - self.min_final_bps() as u128
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Pending,
    Delivered,
    Failed,
    Reclaimed,
    /// A Lucky Buy whose delivery is confirmed and whose Draw runs in the next receipt.
    /// Appended last so stored statuses keep their Borsh tags.
    Drawing,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Account {
    pub balance: U128,
    pub per_purchase_limit: U128,
    pub daily_limit: U128,
    pub default_mode: Mode,
    pub day: u64,
    pub spent_today: U128,
    /// Running Total = cashback_received - premiums_paid.
    pub premiums_paid: U128,
    pub cashback_received: U128,
}

impl Default for Account {
    fn default() -> Self {
        Self {
            balance: U128(0),
            per_purchase_limit: U128(DEFAULT_PER_PURCHASE_LIMIT),
            daily_limit: U128(DEFAULT_DAILY_LIMIT),
            default_mode: Mode::Normal,
            day: 0,
            spent_today: U128(0),
            premiums_paid: U128(0),
            cashback_received: U128(0),
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Purchase {
    pub customer: AccountId,
    pub mode: Mode,
    pub reference_price: U128,
    pub lucky_amount: U128,
    /// Amount debited at admission: Maximum Price, or Reference Price for Normal.
    pub max_price: U128,
    /// Free Reserve locked for this purchase: its largest Reference Discount.
    pub locked: U128,
    pub created_at: u64,
    pub status: Status,
    pub cashback: U128,
}

#[near(serializers = [json])]
pub struct Quote {
    pub mode: Mode,
    pub reference_price: U128,
    pub lucky_amount: U128,
    pub max_price: U128,
}

#[near(serializers = [json])]
pub struct Reserve {
    pub free: U128,
    pub locked: U128,
    pub discount_cap: U128,
    pub proceeds: U128,
}

/// Live Average = lucky_paid_total / lucky_amount_total, promised to be ~105.6%.
#[near(serializers = [json])]
pub struct Stats {
    pub lucky_settled: u64,
    pub lucky_amount_total: U128,
    pub lucky_paid_total: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum Payout {
    Customer(AccountId),
    Reserve,
    Proceeds,
    /// Proceeds the treasury pulled on `day` (ADR-0009); a failed transfer also gives back the cap.
    Sweep {
        day: u64,
    },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    operator: AccountId,
    usdc: AccountId,
    paused: bool,
    accounts: LookupMap<AccountId, Account>,
    versions: Vector<GameVersion>,
    // ponytail: purchases are kept forever (~0.002 NEAR storage each); prune settled ones if volume grows.
    purchases: LookupMap<u64, Purchase>,
    next_purchase_id: u64,
    free_reserve: u128,
    locked_reserve: u128,
    /// Reference Prices of delivered purchases, owed to the operator for Bitrefill.
    proceeds: u128,
    lucky_settled: u64,
    lucky_amount_total: u128,
    lucky_paid_total: u128,
    /// The server's order id → purchase id, so admitting the same order twice is a no-op.
    orders: LookupMap<String, u64>,
    /// The account that refills Bitrefill (ADR-0009). Only it can pull proceeds, and only to itself.
    treasury: Option<AccountId>,
    /// The most proceeds the treasury may pull per UTC day. 0: only the owner moves proceeds.
    sweep_daily_cap: u128,
    sweep_day: u64,
    swept_today: u128,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, operator: AccountId, usdc: AccountId) -> Self {
        let mut c = Self {
            owner,
            operator,
            usdc,
            paused: false,
            accounts: LookupMap::new(Key::Accounts),
            versions: Vector::new(Key::Versions),
            purchases: LookupMap::new(Key::Purchases),
            next_purchase_id: 0,
            free_reserve: 0,
            locked_reserve: 0,
            proceeds: 0,
            lucky_settled: 0,
            lucky_amount_total: 0,
            lucky_paid_total: 0,
            orders: LookupMap::new(Key::Orders),
            treasury: None,
            sweep_daily_cap: 0,
            sweep_day: 0,
            swept_today: 0,
        };
        for v in default_game_versions() {
            c.push_version(v);
        }
        c
    }

    // ---------- deposits ----------

    /// USDC `ft_transfer_call` hook. msg "" credits the sender's Balance;
    /// msg "reserve" (owner only) funds the Cashback Reserve.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.usdc,
            "Only USDC is accepted"
        );
        match msg.as_str() {
            "" => {
                require!(amount.0 >= MIN_DEPOSIT, "Deposit at least 1 USDC");
                let mut a = self.accounts.get(&sender_id).cloned().unwrap_or_default();
                a.balance.0 += amount.0;
                self.accounts.insert(sender_id.clone(), a);
                emit(
                    "deposit",
                    json!({ "account_id": sender_id, "amount": amount }),
                );
            }
            "reserve" => {
                require!(sender_id == self.owner, "Only the owner funds the reserve");
                self.free_reserve += amount.0;
                emit("reserve_funded", json!({ "amount": amount }));
            }
            _ => env::panic_str("Unknown deposit message"),
        }
        PromiseOrValue::Value(U128(0))
    }

    // ---------- customer ----------

    /// Needs a full-access signature (1 yoctoNEAR), so no app key can raise limits.
    #[payable]
    pub fn set_limits(&mut self, per_purchase: U128, daily: U128) {
        assert_one_yocto();
        let id = env::predecessor_account_id();
        let mut a = self.existing_account(&id);
        a.per_purchase_limit = per_purchase;
        a.daily_limit = daily;
        self.accounts.insert(id.clone(), a);
        emit(
            "limits",
            json!({ "account_id": id, "per_purchase": per_purchase, "daily": daily }),
        );
    }

    /// Like every setting, needs a full-access signature (1 yoctoNEAR).
    #[payable]
    pub fn set_default_mode(&mut self, mode: Mode) {
        assert_one_yocto();
        self.assert_mode(mode);
        let id = env::predecessor_account_id();
        let mut a = self.existing_account(&id);
        a.default_mode = mode;
        self.accounts.insert(id.clone(), a);
        emit("default_mode", json!({ "account_id": id, "mode": mode }));
    }

    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        let id = env::predecessor_account_id();
        let mut a = self.existing_account(&id);
        require!(a.balance.0 >= amount.0, "Insufficient balance");
        a.balance.0 -= amount.0;
        self.accounts.insert(id.clone(), a);
        emit("withdraw", json!({ "account_id": id, "amount": amount }));
        self.send(id.clone(), amount.0, Payout::Customer(id))
    }

    /// The customer recovers the full amount debited if the operator neither
    /// confirmed nor failed the purchase within 24 hours.
    pub fn reclaim(&mut self, purchase_id: u64) {
        let p = self.pending(purchase_id);
        require!(
            p.customer == env::predecessor_account_id(),
            "Not your purchase"
        );
        require!(
            env::block_timestamp() >= p.created_at + RECLAIM_AFTER_NS,
            "Reclaim opens 24 hours after purchase"
        );
        self.unwind(purchase_id, p, Status::Reclaimed);
    }

    // ---------- operator (server, function-call key) ----------

    /// Admits a purchase: debits the Maximum Price and locks the reserve.
    /// `mode: None` uses the customer's Default Mode. `order_id` makes admission idempotent:
    /// the same order is admitted once, whatever the retries, and only for the same customer
    /// and price. `max_debit` is the most the customer confirmed; a higher Maximum Price (the
    /// price or the reserve moved) is refused.
    pub fn purchase(
        &mut self,
        customer: AccountId,
        reference_price: U128,
        mode: Option<Mode>,
        order_id: String,
        max_debit: U128,
    ) -> u64 {
        self.assert_operator();
        require!(
            !order_id.is_empty() && order_id.len() <= 64,
            "Invalid order id"
        );
        if let Some(&id) = self.orders.get(&order_id) {
            let p = self.purchases.get(&id).unwrap();
            require!(
                p.customer == customer && p.reference_price.0 == reference_price.0,
                "Order id belongs to another purchase"
            );
            return id;
        }
        require!(!self.paused, "New purchases are paused");
        let r = reference_price.0;
        let mut a = self.existing_account(&customer);
        let mode = mode.unwrap_or(a.default_mode);
        let q = self.quote_internal(r, mode);
        let debit = q.max_price.0;
        require!(
            debit <= max_debit.0,
            "Price changed since you confirmed; please confirm again"
        );

        require!(
            debit <= a.per_purchase_limit.0,
            "Over the per-purchase spending limit"
        );
        let day = env::block_timestamp() / DAY_NS;
        if a.day != day {
            a.day = day;
            a.spent_today = U128(0);
        }
        require!(
            a.spent_today.0 + debit <= a.daily_limit.0,
            "Over the daily spending limit"
        );
        require!(a.balance.0 >= debit, "Insufficient balance");
        a.balance.0 -= debit;
        a.spent_today.0 += debit;
        self.accounts.insert(customer.clone(), a);

        let lock = match mode {
            Mode::Normal => 0,
            Mode::Lucky(v) => q.lucky_amount.0 * self.version(v).max_discount_bps() / BPS,
        };
        self.free_reserve -= lock;
        self.locked_reserve += lock;

        let id = self.next_purchase_id;
        self.next_purchase_id += 1;
        self.orders.insert(order_id, id);
        let p = Purchase {
            customer,
            mode,
            reference_price,
            lucky_amount: q.lucky_amount,
            max_price: q.max_price,
            locked: U128(lock),
            created_at: env::block_timestamp(),
            status: Status::Pending,
            cashback: U128(0),
        };
        emit("purchase", json!({ "purchase_id": id, "purchase": &p }));
        self.purchases.insert(id, p);
        id
    }

    /// Confirms delivery. A Lucky Buy's Draw then runs in `on_draw`, a separate receipt with
    /// gas set by the contract, so no transaction can bundle the confirmation with another call
    /// that panics on an outcome it dislikes and so retry the Draw (ADR-0001, amended). The
    /// operator can't fail a purchase after confirming it either. Confirming a purchase whose
    /// Draw callback failed schedules the Draw again.
    pub fn confirm_delivery(&mut self, purchase_id: u64) -> PromiseOrValue<Purchase> {
        self.assert_operator();
        let mut p = self.load(purchase_id);
        if p.status == Status::Drawing {
            return PromiseOrValue::Promise(self.schedule_draw(purchase_id));
        }
        require!(p.status == Status::Pending, "Purchase is already closed");
        self.proceeds += p.reference_price.0;
        emit(
            "delivered",
            json!({ "purchase_id": purchase_id, "customer": p.customer }),
        );
        match p.mode {
            Mode::Normal => {
                p.status = Status::Delivered;
                self.purchases.insert(purchase_id, p.clone());
                PromiseOrValue::Value(p)
            }
            Mode::Lucky(_) => {
                p.status = Status::Drawing;
                self.purchases.insert(purchase_id, p);
                PromiseOrValue::Promise(self.schedule_draw(purchase_id))
            }
        }
    }

    /// The customer (or operator) re-runs a Draw whose callback failed, e.g. out of gas.
    pub fn retry_draw(&mut self, purchase_id: u64) -> Promise {
        let p = self.load(purchase_id);
        require!(p.status == Status::Drawing, "No Draw to retry");
        let caller = env::predecessor_account_id();
        require!(
            caller == p.customer || caller == self.operator,
            "Not your purchase"
        );
        self.schedule_draw(purchase_id)
    }

    /// Runs the Draw and credits the Cashback. Only the contract can call it, with randomness
    /// from a block that didn't exist when delivery was confirmed.
    #[private]
    pub fn on_draw(&mut self, purchase_id: u64) -> Purchase {
        let mut p = self.load(purchase_id);
        require!(p.status == Status::Drawing, "Draw already done");
        let Mode::Lucky(v) = p.mode else {
            env::panic_str("Not a Lucky Buy")
        };
        let version = self.version(v).clone();
        let seed = env::random_seed_array();
        let random = draw_random(&seed, purchase_id);
        let roll = roll_from_random(&random);
        let final_bps = final_bps_for_roll(&version.outcomes, roll);
        let r = p.reference_price.0;
        let lucky = p.lucky_amount.0;
        let max_price = p.max_price.0;
        let final_price = final_price(r, lucky, max_price, final_bps);
        let cashback = max_price - final_price;
        let premium = max_price - r;

        let mut a = self.existing_account(&p.customer);
        a.balance.0 += cashback;
        a.premiums_paid.0 += premium;
        a.cashback_received.0 += cashback;
        self.accounts.insert(p.customer.clone(), a);

        // Free Reserve changes by Risk Premium - Cashback once the lock is released.
        self.locked_reserve -= p.locked.0;
        self.free_reserve = self.free_reserve + p.locked.0 + premium - cashback;
        self.lucky_settled += 1;
        self.lucky_amount_total += lucky;
        self.lucky_paid_total += lucky + premium - cashback;
        p.cashback = U128(cashback);
        p.status = Status::Delivered;

        emit(
            "draw",
            json!({
                "purchase_id": purchase_id,
                "customer": p.customer,
                "game_version": v,
                "reference_price": p.reference_price,
                "lucky_amount": p.lucky_amount,
                "max_price": p.max_price,
                "seed": hex(&seed),
                "random": hex(&random),
                "roll": roll,
                "final_bps": final_bps,
                "final_price": U128(final_price),
                "cashback": U128(cashback),
            }),
        );
        self.purchases.insert(purchase_id, p.clone());
        p
    }

    /// Bitrefill could not deliver: everything returns to the customer, no Draw.
    pub fn fail_purchase(&mut self, purchase_id: u64) {
        self.assert_operator();
        let p = self.pending(purchase_id);
        self.unwind(purchase_id, p, Status::Failed);
    }

    // ---------- owner ----------

    #[payable]
    pub fn add_game_version(&mut self, version: GameVersion) -> u32 {
        self.assert_owner();
        let id = self.push_version(version.clone());
        emit(
            "game_version_added",
            json!({ "game_version": id, "version": version }),
        );
        id
    }

    #[payable]
    pub fn set_operator(&mut self, operator: AccountId) {
        self.assert_owner();
        emit("set_operator", json!({ "operator": operator }));
        self.operator = operator;
    }

    /// Pausing only stops new purchases; confirm, fail, reclaim and withdraw keep working.
    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        emit("set_paused", json!({ "paused": paused }));
    }

    #[payable]
    pub fn withdraw_reserve(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        require!(self.free_reserve >= amount.0, "Exceeds free reserve");
        self.free_reserve -= amount.0;
        emit("reserve_withdrawn", json!({ "amount": amount }));
        self.send(self.owner.clone(), amount.0, Payout::Reserve)
    }

    /// Proceeds go to the owner, or with `to_treasury` straight to the treasury (no daily cap: the owner signed it).
    #[payable]
    pub fn withdraw_proceeds(&mut self, amount: U128, to_treasury: Option<bool>) -> Promise {
        self.assert_owner();
        require!(amount.0 > 0, "Nothing to withdraw");
        require!(self.proceeds >= amount.0, "Exceeds proceeds");
        let to = if to_treasury.unwrap_or(false) {
            self.treasury
                .clone()
                .unwrap_or_else(|| env::panic_str("No treasury is set"))
        } else {
            self.owner.clone()
        };
        self.proceeds -= amount.0;
        emit("proceeds_withdrawn", json!({ "amount": amount, "to": to }));
        self.send(to, amount.0, Payout::Proceeds)
    }

    /// Sets the treasury and how much of the proceeds it may pull per UTC day (ADR-0009).
    /// A cap of 0 turns automatic pulls off: proceeds then move only when the owner signs.
    #[payable]
    pub fn set_treasury(&mut self, treasury: Option<AccountId>, daily_cap: U128) {
        self.assert_owner();
        if let Some(t) = &treasury {
            require!(
                *t != env::current_account_id() && *t != self.usdc && *t != self.operator,
                "The treasury must be its own account"
            );
        } else {
            require!(daily_cap.0 == 0, "A daily cap needs a treasury");
        }
        self.treasury = treasury.clone();
        self.sweep_daily_cap = daily_cap.0;
        emit(
            "treasury_set",
            json!({ "treasury": treasury, "daily_cap": daily_cap }),
        );
    }

    // ---------- treasury ----------

    /// The treasury pulls proceeds to itself to refill Bitrefill, within the owner's daily cap.
    /// Needs the treasury's full-access signature (1 yoctoNEAR); the money can go nowhere else.
    #[payable]
    pub fn sweep_proceeds(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        let treasury = self
            .treasury
            .clone()
            .unwrap_or_else(|| env::panic_str("No treasury is set"));
        require!(
            env::predecessor_account_id() == treasury,
            "Only the treasury"
        );
        require!(amount.0 > 0, "Nothing to sweep");
        require!(self.proceeds >= amount.0, "Exceeds proceeds");
        let day = env::block_timestamp() / DAY_NS;
        if self.sweep_day != day {
            self.sweep_day = day;
            self.swept_today = 0;
        }
        require!(
            self.swept_today + amount.0 <= self.sweep_daily_cap,
            "Over the treasury's daily cap"
        );
        self.swept_today += amount.0;
        self.proceeds -= amount.0;
        emit(
            "proceeds_swept",
            json!({ "amount": amount, "to": treasury, "swept_today": U128(self.swept_today) }),
        );
        self.send(treasury, amount.0, Payout::Sweep { day })
    }

    #[private]
    pub fn on_send(
        &mut self,
        payout: Payout,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_ok() {
            return;
        }
        // The transfer failed (e.g. the receiver isn't registered on USDC): put the money back.
        emit(
            "payout_restored",
            json!({ "payout": &payout, "amount": amount }),
        );
        match payout {
            Payout::Customer(id) => {
                let mut a = self.accounts.get(&id).cloned().unwrap_or_default();
                a.balance.0 += amount.0;
                self.accounts.insert(id, a);
            }
            Payout::Reserve => self.free_reserve += amount.0,
            Payout::Proceeds => self.proceeds += amount.0,
            Payout::Sweep { day } => {
                self.proceeds += amount.0;
                if self.sweep_day == day {
                    self.swept_today = self.swept_today.saturating_sub(amount.0);
                }
            }
        }
    }

    // ---------- views ----------

    pub fn quote(&self, reference_price: U128, mode: Mode) -> Quote {
        self.quote_internal(reference_price.0, mode)
    }

    pub fn get_account(&self, account_id: AccountId) -> Option<Account> {
        self.accounts.get(&account_id).cloned()
    }

    pub fn get_purchase(&self, purchase_id: u64) -> Option<Purchase> {
        self.purchases.get(&purchase_id).cloned()
    }

    pub fn get_game_versions(&self) -> Vec<GameVersion> {
        self.versions.iter().cloned().collect()
    }

    pub fn get_reserve(&self) -> Reserve {
        Reserve {
            free: U128(self.free_reserve),
            locked: U128(self.locked_reserve),
            discount_cap: U128(self.free_reserve * DISCOUNT_CAP_BPS / BPS),
            proceeds: U128(self.proceeds),
        }
    }

    pub fn get_stats(&self) -> Stats {
        Stats {
            lucky_settled: self.lucky_settled,
            lucky_amount_total: U128(self.lucky_amount_total),
            lucky_paid_total: U128(self.lucky_paid_total),
        }
    }

    pub fn get_config(&self) -> Value {
        json!({
            "owner": self.owner,
            "operator": self.operator,
            "usdc": self.usdc,
            "paused": self.paused,
            "max_cashback": U128(MAX_CASHBACK),
            "treasury": self.treasury,
            "sweep_daily_cap": U128(self.sweep_daily_cap),
            "swept_today": U128(if self.sweep_day == env::block_timestamp() / DAY_NS { self.swept_today } else { 0 }),
        })
    }
}

impl Contract {
    fn quote_internal(&self, r: u128, mode: Mode) -> Quote {
        require!(r >= MIN_REFERENCE_PRICE, "Purchases start at 0.5 USDC");
        let (lucky, premium) = match mode {
            Mode::Normal => (0, 0),
            Mode::Lucky(v) => {
                let version = self.version(v);
                let cap = self.free_reserve * DISCOUNT_CAP_BPS / BPS;
                let lucky = r
                    .min(cap * BPS / version.max_discount_bps())
                    .min(MAX_CASHBACK * BPS / version.max_cashback_bps());
                require!(lucky > 0, "Reserve too small for a Lucky Buy; use Normal");
                // Rounded up, so even tiny Lucky Amounts average at least 105.6% (ADR-0004).
                (lucky, (lucky * version.premium_bps as u128).div_ceil(BPS))
            }
        };
        Quote {
            mode,
            reference_price: U128(r),
            lucky_amount: U128(lucky),
            max_price: U128(r + premium),
        }
    }

    fn unwind(&mut self, purchase_id: u64, mut p: Purchase, status: Status) {
        let mut a = self.existing_account(&p.customer);
        a.balance.0 += p.max_price.0;
        self.accounts.insert(p.customer.clone(), a);
        self.locked_reserve -= p.locked.0;
        self.free_reserve += p.locked.0;
        emit(
            if status == Status::Failed {
                "failed"
            } else {
                "reclaimed"
            },
            json!({ "purchase_id": purchase_id, "customer": p.customer, "amount": p.max_price }),
        );
        p.status = status;
        self.purchases.insert(purchase_id, p);
    }

    fn send(&self, to: AccountId, amount: u128, payout: Payout) -> Promise {
        ext_ft::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(to, U128(amount), None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_SEND)
                    .on_send(payout, U128(amount)),
            )
    }

    fn push_version(&mut self, v: GameVersion) -> u32 {
        validate_game_version(&v);
        self.versions.push(v);
        self.versions.len() - 1
    }

    fn version(&self, v: u32) -> &GameVersion {
        self.versions
            .get(v)
            .unwrap_or_else(|| env::panic_str("Unknown game version"))
    }

    fn assert_mode(&self, mode: Mode) {
        if let Mode::Lucky(v) = mode {
            self.version(v);
        }
    }

    fn existing_account(&self, id: &AccountId) -> Account {
        self.accounts
            .get(id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("No balance; deposit first"))
    }

    fn load(&self, purchase_id: u64) -> Purchase {
        self.purchases
            .get(&purchase_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Unknown purchase"))
    }

    fn pending(&self, purchase_id: u64) -> Purchase {
        let p = self.load(purchase_id);
        require!(p.status == Status::Pending, "Purchase is already closed");
        p
    }

    fn schedule_draw(&self, purchase_id: u64) -> Promise {
        Self::ext(env::current_account_id())
            .with_static_gas(GAS_DRAW)
            .on_draw(purchase_id)
    }

    fn assert_operator(&self) {
        require!(
            env::predecessor_account_id() == self.operator,
            "Only the operator"
        );
    }

    /// Owner calls need a full-access signature.
    fn assert_owner(&self) {
        assert_one_yocto();
        require!(
            env::predecessor_account_id() == self.owner,
            "Only the owner"
        );
    }
}

// ---------- pure game logic (mirrored by the Web App's Draw Proof) ----------

/// Each table lists (Cashback as a % of what the customer paid, chance in bps); the rest of the
/// chance gets no Cashback. Stored as Final Price shares of the Lucky Amount.
pub fn default_game_versions() -> Vec<GameVersion> {
    let v = |name: &str, premium_bps: u32, cashback: &[(u32, u32)]| {
        let paid = BPS as u32 + premium_bps;
        let none = BPS as u32 - cashback.iter().map(|&(_, chance)| chance).sum::<u32>();
        let mut outcomes: Vec<Outcome> = cashback
            .iter()
            .map(|&(pct, chance_bps)| Outcome {
                final_bps: paid * (100 - pct) / 100,
                chance_bps,
            })
            .collect();
        outcomes.push(Outcome {
            final_bps: paid,
            chance_bps: none,
        });
        GameVersion {
            name: name.into(),
            premium_bps,
            outcomes,
        }
    };
    vec![
        v(
            "Lite",
            1_000,
            &[(100, 100), (50, 100), (30, 100), (20, 200), (10, 1_800)],
        ),
        v(
            "Classic",
            2_000,
            &[(100, 200), (50, 300), (40, 400), (30, 700), (20, 2_400)],
        ),
        v("Jackpot", 5_000, &[(100, 1_000), (50, 1_200), (40, 3_400)]),
    ]
}

/// Chances sum to 100%, no outcome exceeds the Maximum Price, any Cashback leaves the customer
/// below the Reference Price, at least one outcome is a discount, and the average is exactly 105.6%.
pub fn validate_game_version(v: &GameVersion) {
    require!(
        !v.name.is_empty() && !v.outcomes.is_empty(),
        "Empty game version"
    );
    require!(v.premium_bps > 0, "Premium must be positive");
    let max = BPS as u32 + v.premium_bps;
    let mut chance = 0u128;
    let mut weighted = 0u128;
    for o in &v.outcomes {
        require!(o.chance_bps > 0, "Zero-chance outcome");
        require!(o.final_bps <= max, "Outcome above maximum price");
        require!(
            o.final_bps == max || o.final_bps < BPS as u32,
            "Any cashback must leave the price below normal"
        );
        chance += o.chance_bps as u128;
        weighted += o.chance_bps as u128 * o.final_bps as u128;
    }
    require!(chance == BPS, "Chances must sum to 100%");
    require!(
        weighted == TARGET_FINAL_BPS * BPS,
        "Average must be exactly 105.6%"
    );
    require!(
        (v.min_final_bps() as u128) < BPS,
        "Needs at least one discount"
    );
}

pub fn draw_random(seed: &[u8; 32], purchase_id: u64) -> [u8; 32] {
    let mut input = seed.to_vec();
    input.extend_from_slice(&purchase_id.to_le_bytes());
    env::sha256_array(&input)
}

/// 0..10_000; modulo bias is below 1e-15.
pub fn roll_from_random(random: &[u8; 32]) -> u32 {
    (u64::from_le_bytes(random[..8].try_into().unwrap()) % BPS as u64) as u32
}

pub fn final_bps_for_roll(outcomes: &[Outcome], roll: u32) -> u32 {
    let mut cumulative = 0;
    for o in outcomes {
        cumulative += o.chance_bps;
        if roll < cumulative {
            return o.final_bps;
        }
    }
    env::panic_str("Roll outside table")
}

/// Unlucky part at Reference Price plus the drawn share of the Lucky Amount,
/// rounded up to the house by under one base unit and never above Maximum Price.
pub fn final_price(reference: u128, lucky: u128, max_price: u128, final_bps: u32) -> u128 {
    let lucky_paid = (lucky * final_bps as u128).div_ceil(BPS);
    (reference - lucky + lucky_paid).min(max_price)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "luckout", "version": "1.0.0", "event": event, "data": [data] })
    ));
}

#[cfg(test)]
mod tests;

/// One-time upgrade of a deployed contract from the layout before the treasury (ADR-0009).
/// Compiled only with `--features migrate` and deployed together with the `migrate` call;
/// the normal build is deployed right after, so the method never stays on chain.
#[cfg(feature = "migrate")]
mod migrate {
    use super::*;

    #[near(serializers = [borsh])]
    struct Before {
        owner: AccountId,
        operator: AccountId,
        usdc: AccountId,
        paused: bool,
        accounts: LookupMap<AccountId, Account>,
        versions: Vector<GameVersion>,
        purchases: LookupMap<u64, Purchase>,
        next_purchase_id: u64,
        free_reserve: u128,
        locked_reserve: u128,
        proceeds: u128,
        lucky_settled: u64,
        lucky_amount_total: u128,
        lucky_paid_total: u128,
        orders: LookupMap<String, u64>,
    }

    #[near]
    impl Contract {
        #[private]
        #[init(ignore_state)]
        pub fn migrate() -> Self {
            let b: Before =
                env::state_read().unwrap_or_else(|| env::panic_str("No state to migrate"));
            Self {
                owner: b.owner,
                operator: b.operator,
                usdc: b.usdc,
                paused: b.paused,
                accounts: b.accounts,
                versions: b.versions,
                purchases: b.purchases,
                next_purchase_id: b.next_purchase_id,
                free_reserve: b.free_reserve,
                locked_reserve: b.locked_reserve,
                proceeds: b.proceeds,
                lucky_settled: b.lucky_settled,
                lucky_amount_total: b.lucky_amount_total,
                lucky_paid_total: b.lucky_paid_total,
                orders: b.orders,
                treasury: None,
                sweep_daily_cap: 0,
                sweep_day: 0,
                swept_today: 0,
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::testing_env;

        #[test]
        fn migrate_keeps_every_field() {
            let me: AccountId = "luckout.near".parse().unwrap();
            testing_env!(VMContextBuilder::new()
                .current_account_id(me.clone())
                .predecessor_account_id(me)
                .build());
            let mut versions = Vector::new(Key::Versions);
            for v in default_game_versions() {
                versions.push(v);
            }
            versions.flush();
            let mut accounts = LookupMap::new(Key::Accounts);
            accounts.insert(
                "alice.near".parse().unwrap(),
                Account {
                    balance: U128(7),
                    ..Default::default()
                },
            );
            accounts.flush();
            env::state_write(&Before {
                owner: "owner.near".parse().unwrap(),
                operator: "server.near".parse().unwrap(),
                usdc: "usdc.near".parse().unwrap(),
                paused: true,
                accounts,
                versions,
                purchases: LookupMap::new(Key::Purchases),
                next_purchase_id: 42,
                free_reserve: 1_000,
                locked_reserve: 50,
                proceeds: 236,
                lucky_settled: 4,
                lucky_amount_total: 40,
                lucky_paid_total: 37,
                orders: LookupMap::new(Key::Orders),
            });
            let c = Contract::migrate();
            assert_eq!(c.owner.as_str(), "owner.near");
            assert_eq!(c.operator.as_str(), "server.near");
            assert!(c.paused);
            assert_eq!(
                (
                    c.next_purchase_id,
                    c.free_reserve,
                    c.locked_reserve,
                    c.proceeds
                ),
                (42, 1_000, 50, 236)
            );
            assert_eq!(
                (c.lucky_settled, c.lucky_amount_total, c.lucky_paid_total),
                (4, 40, 37)
            );
            assert_eq!(c.versions.len(), 3);
            assert_eq!(
                c.get_account("alice.near".parse().unwrap())
                    .unwrap()
                    .balance
                    .0,
                7
            );
            assert_eq!((c.treasury.clone(), c.sweep_daily_cap), (None, 0));
        }
    }
}
