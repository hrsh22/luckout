//! Luckout: one contract holding customer Balances in USDC, their Spending
//! Limits and Default Mode, immutable Game Versions, the Cashback Reserve and
//! every Draw. See CONTEXT.md and docs/adr/0001..0005 for the domain language.
//!
//! All amounts are USDC base units (6 decimals) and all rates are basis points.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas,
    IntoStorageKey, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

pub const BPS: u128 = 10_000;
/// Every Game Version averages 105.6% of the Lucky Amount (ADR-0002).
pub const TARGET_FINAL_BPS: u128 = 10_560;
/// The Cashback Cap until the owner sets one: the lower of 50 USDC and 20% of Free Reserve (ADR-0002).
pub const DEFAULT_CASHBACK_CAP: CashbackCap = CashbackCap {
    fixed: Some(U128(50_000_000)),
    reserve_bps: Some(2_000),
};
/// The owner can't set the reserve share above 50%, so one Draw never takes most of the reserve.
pub const MAX_CAP_RESERVE_BPS: u32 = 5_000;
pub const DAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
pub const RECLAIM_AFTER_NS: u64 = DAY_NS;
pub const MIN_DEPOSIT: u128 = 1_000_000; // 1 USDC, keeps dust accounts from bloating storage
/// Every purchase stores a record; a floor keeps a stolen operator key from cheaply filling storage.
pub const MIN_REFERENCE_PRICE: u128 = 500_000; // 0.5 USDC, so ₹50 cards sell (ADR-0001)
/// New accounts' Spending Limits. A customer may set any U128; u128::MAX is "No limit" in the apps.
pub const DEFAULT_PER_PURCHASE_LIMIT: u128 = 200_000_000; // 200 USDC
pub const DEFAULT_DAILY_LIMIT: u128 = 1_000_000_000; // 1,000 USDC
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_ON_SEND: Gas = Gas::from_tgas(10);
/// USDC's `ft_transfer_call` into NEAR Intents: the transfer, Intents' deposit and USDC's resolve.
const GAS_FT_TRANSFER_CALL: Gas = Gas::from_tgas(50);
/// The Draw callback's gas is set here, not by the caller (it uses ~3 Tgas).
const GAS_DRAW: Gas = Gas::from_tgas(20);
/// `on_draw_many`'s gas: a base plus this much per Draw, so a full cart's Draws fit in one callback.
const GAS_DRAW_MANY_BASE: Gas = Gas::from_tgas(5);
const GAS_DRAW_EACH: Gas = Gas::from_tgas(4);
/// The most cards one call admits, quotes or settles: Bitrefill's own cart size.
pub const MAX_CART: usize = 15;

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128>;
}

/// NEAR Intents (ADR-0011): the only caller of `on_auth`, and the only sender that may name the
/// account a deposit credits. Fixed in the code for each network, so only an upgrade can change it.
pub fn intents_account() -> AccountId {
    let id = if env::current_account_id().as_str().ends_with(".testnet") {
        "intents.luckout.testnet"
    } else {
        "intents.near"
    };
    id.parse().unwrap()
}

/// A customer who signs through NEAR Intents, named as their NEAR Intents account is: an EVM address
/// in lowercase (`0x` + 40 hex), or a Solana key as 64 lowercase hex. The second is also how a NEAR
/// implicit account is named, held by the same ed25519 key, so such an account may act either way.
pub fn is_intents_signer(id: &AccountId) -> bool {
    let s = id.as_str();
    let hex = |h: &str| {
        h.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    (s.len() == 42 && s.starts_with("0x") && hex(&s[2..])) || (s.len() == 64 && hex(s))
}

/// A deposit's JSON `msg`. One from NEAR Intents names the EVM or Solana account it credits (`{"for":"0x…"}`); any
/// deposit may carry the Default Mode the account starts with (`"mode"`), which applies only if this deposit
/// creates the account: Welcome asks for it before there is an account to save it on.
#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
struct DepositMsg {
    #[serde(rename = "for")]
    account: Option<AccountId>,
    mode: Option<Mode>,
}

/// What an EVM or Solana customer signs through NEAR Intents' `AuthCall` (ADR-0011): the same calls a NEAR
/// wallet makes itself, e.g. `{"withdraw":{"amount":"5000000"}}`.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
pub enum AuthAction {
    Withdraw { amount: U128 },
    SetLimits { per_purchase: U128, daily: U128 },
    SetDefaultMode { mode: Mode },
    Reclaim { purchase_id: u64 },
    RetryDraw { purchase_id: u64 },
}

#[near]
#[derive(BorshStorageKey)]
enum Key {
    Accounts,
    Versions,
    Purchases,
    Orders,
    /// Stored apart from the contract's main state, so adding it needed no migration.
    CashbackCap,
}

/// The most Cashback one Lucky Buy can pay: the lower of a fixed amount and a share of Free
/// Reserve. A `None` fixed amount is off; the share is always set (it's an Option only in storage).
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CashbackCap {
    pub fixed: Option<U128>,
    pub reserve_bps: Option<u32>,
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

/// One card of a cart, with the same terms `purchase` takes.
#[near(serializers = [json])]
pub struct CartItem {
    pub reference_price: U128,
    pub mode: Option<Mode>,
    pub order_id: String,
    pub max_debit: U128,
    pub lucky_amount: Option<U128>,
}

/// One card to price in a cart. `lucky_amount`: the Lucky Amount the customer confirmed, as in `CartItem`.
#[near(serializers = [json])]
pub struct QuoteItem {
    pub reference_price: U128,
    pub mode: Mode,
    pub lucky_amount: Option<U128>,
}

#[near(serializers = [json])]
pub struct Reserve {
    pub free: U128,
    pub locked: U128,
    /// The most Cashback one Lucky Buy can pay right now, from the Cashback Cap.
    pub max_cashback: U128,
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
    /// Proposed by the owner; becomes the owner only when it accepts, so a typo can't hand the
    /// contract to an account nobody controls.
    pending_owner: Option<AccountId>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, operator: AccountId, usdc: AccountId) -> Self {
        // As in set_operator: the server's key never owns the contract, and the contract never operates itself.
        require!(
            operator != owner && operator != env::current_account_id(),
            "That account can't be the operator"
        );
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
            pending_owner: None,
        };
        for v in default_game_versions() {
            c.push_version(v);
        }
        c
    }

    // ---------- deposits ----------

    /// USDC `ft_transfer_call` hook. msg "" credits the sender's Balance; msg "reserve" (owner only)
    /// funds the Cashback Reserve; msg `{"for":"0x…"}` from NEAR Intents credits that EVM or Solana customer. A JSON msg
    /// may add `"mode"`, the Default Mode a new account starts with (`{"mode":{"lucky":1}}` from a wallet).
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
        let intents = intents_account();
        match msg.as_str() {
            "" => {
                // NEAR Intents always names the customer: crediting `intents.near` itself would strand the money.
                require!(sender_id != intents, "Name the account to credit");
                self.credit(sender_id, amount, None);
            }
            _ if msg.starts_with('{') => {
                let d: DepositMsg = near_sdk::serde_json::from_str(&msg)
                    .unwrap_or_else(|_| env::panic_str("Unknown deposit message"));
                let id = if sender_id == intents {
                    let id = d
                        .account
                        .unwrap_or_else(|| env::panic_str("Name the account to credit"));
                    require!(
                        is_intents_signer(&id),
                        "Only EVM and Solana accounts are credited this way"
                    );
                    id
                } else {
                    // Only NEAR Intents names someone else: a wallet's deposit credits the wallet.
                    require!(d.account.is_none(), "Unknown deposit message");
                    sender_id
                };
                self.credit(id, amount, d.mode);
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
        self.limits(env::predecessor_account_id(), per_purchase, daily);
    }

    /// Like every setting, needs a full-access signature (1 yoctoNEAR).
    #[payable]
    pub fn set_default_mode(&mut self, mode: Mode) {
        assert_one_yocto();
        self.default_mode(env::predecessor_account_id(), mode);
    }

    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        let id = env::predecessor_account_id();
        self.debit_withdrawal(&id, amount, "wallet");
        self.send(id.clone(), amount.0, Payout::Customer(id))
    }

    /// The customer recovers the full amount debited if the operator neither
    /// confirmed nor failed the purchase within 24 hours.
    pub fn reclaim(&mut self, purchase_id: u64) {
        self.reclaim_as(env::predecessor_account_id(), purchase_id);
    }

    /// An EVM or Solana customer's own call, vouched for by NEAR Intents (ADR-0011): `intents.near` checked
    /// that `signer_id` signed `msg` before calling. Only those accounts sign this way, so a customer with a
    /// named NEAR account depends on NEAR Intents for nothing. A withdrawal goes only to the signer's own
    /// NEAR Intents account, never to an address anyone else picks.
    pub fn on_auth(&mut self, signer_id: AccountId, msg: String) -> PromiseOrValue<()> {
        require!(
            env::predecessor_account_id() == intents_account(),
            "Only NEAR Intents vouches for a signer"
        );
        require!(
            is_intents_signer(&signer_id),
            "Only EVM and Solana accounts sign through NEAR Intents"
        );
        let action: AuthAction = near_sdk::serde_json::from_str(&msg)
            .unwrap_or_else(|_| env::panic_str("Unknown action"));
        match action {
            AuthAction::Withdraw { amount } => {
                self.debit_withdrawal(&signer_id, amount, "intents");
                PromiseOrValue::Promise(self.send_to_intents(signer_id, amount.0))
            }
            AuthAction::SetLimits {
                per_purchase,
                daily,
            } => {
                self.limits(signer_id, per_purchase, daily);
                PromiseOrValue::Value(())
            }
            AuthAction::SetDefaultMode { mode } => {
                self.default_mode(signer_id, mode);
                PromiseOrValue::Value(())
            }
            AuthAction::Reclaim { purchase_id } => {
                self.reclaim_as(signer_id, purchase_id);
                PromiseOrValue::Value(())
            }
            AuthAction::RetryDraw { purchase_id } => {
                PromiseOrValue::Promise(self.retry_draw_as(signer_id, purchase_id))
            }
        }
    }

    // ---------- operator (server, function-call key) ----------

    /// Admits a purchase: debits the Maximum Price and locks the reserve.
    /// `mode: None` uses the customer's Default Mode. `order_id` makes admission idempotent:
    /// the same order is admitted once, whatever the retries, and only for the same customer
    /// and price. `max_debit` is the most the customer confirmed; a higher Maximum Price (the
    /// price or the reserve moved) is refused. `lucky_amount` is the Lucky Amount the customer
    /// confirmed: the purchase plays exactly that, or is refused if the reserve no longer covers
    /// it. Without it, the Lucky Amount is the most the reserve allows at admission.
    pub fn purchase(
        &mut self,
        customer: AccountId,
        reference_price: U128,
        mode: Option<Mode>,
        order_id: String,
        max_debit: U128,
        lucky_amount: Option<U128>,
    ) -> u64 {
        self.assert_operator();
        self.admit(
            &customer,
            CartItem {
                reference_price,
                mode,
                order_id,
                max_debit,
                lucky_amount,
            },
        )
    }

    /// Admits a cart: every card, or none. Each card is admitted as `purchase` would admit it, in order,
    /// so the Balance and the daily limit are checked against the cards before it, the per-purchase limit
    /// against each card, and each Lucky card's Cashback Cap and lock come from the Free Reserve the cards
    /// before it left. Any refusal refuses the whole cart. Each card's `order_id` keeps it idempotent.
    pub fn purchase_many(&mut self, customer: AccountId, items: Vec<CartItem>) -> Vec<u64> {
        self.assert_operator();
        require!(
            !items.is_empty() && items.len() <= MAX_CART,
            "A cart holds 1 to 15 cards"
        );
        items
            .into_iter()
            .map(|item| self.admit(&customer, item))
            .collect()
    }

    /// Settles a cart's cards in one call: confirms delivery of `delivered` and fails `failed`, each as
    /// `confirm_delivery` and `fail_purchase` would. The Lucky Buys' Draws then run together in one later
    /// receipt (`on_draw_many`), so, as for one card, no transaction can undo a confirmation after seeing a
    /// result. Each Draw still has its own random value (`draw_random` with its purchase id). A delivered
    /// card whose Draw callback failed is drawn again.
    pub fn settle(&mut self, delivered: Vec<u64>, failed: Vec<u64>) -> PromiseOrValue<()> {
        self.assert_operator();
        require!(
            !(delivered.is_empty() && failed.is_empty())
                && delivered.len() + failed.len() <= MAX_CART,
            "Settle 1 to 15 cards at a time"
        );
        let mut draws = vec![];
        for purchase_id in delivered {
            let p = self.load(purchase_id);
            if p.status == Status::Drawing || self.deliver(purchase_id, p) {
                draws.push(purchase_id);
            }
        }
        for purchase_id in failed {
            let p = self.pending(purchase_id);
            self.unwind(purchase_id, p, Status::Failed);
        }
        if draws.is_empty() {
            return PromiseOrValue::Value(());
        }
        let gas = GAS_DRAW_MANY_BASE
            .saturating_add(Gas::from_gas(GAS_DRAW_EACH.as_gas() * draws.len() as u64));
        PromiseOrValue::Promise(
            Self::ext(env::current_account_id())
                .with_static_gas(gas)
                .on_draw_many(draws),
        )
    }

    /// Confirms delivery. A Lucky Buy's Draw then runs in `on_draw`, a separate receipt with
    /// gas set by the contract, so no transaction can bundle the confirmation with another call
    /// that panics on an outcome it dislikes and so retry the Draw (ADR-0001, amended). The
    /// operator can't fail a purchase after confirming it either. Confirming a purchase whose
    /// Draw callback failed schedules the Draw again.
    pub fn confirm_delivery(&mut self, purchase_id: u64) -> PromiseOrValue<Purchase> {
        self.assert_operator();
        let p = self.load(purchase_id);
        if p.status == Status::Drawing {
            return PromiseOrValue::Promise(self.schedule_draw(purchase_id));
        }
        if self.deliver(purchase_id, p) {
            PromiseOrValue::Promise(self.schedule_draw(purchase_id))
        } else {
            PromiseOrValue::Value(self.load(purchase_id))
        }
    }

    /// The customer (or operator) re-runs a Draw whose callback failed, e.g. out of gas.
    pub fn retry_draw(&mut self, purchase_id: u64) -> Promise {
        self.retry_draw_as(env::predecessor_account_id(), purchase_id)
    }

    /// Runs the Draw and credits the Cashback. Only the contract can call it, with randomness
    /// from a block that didn't exist when delivery was confirmed.
    #[private]
    pub fn on_draw(&mut self, purchase_id: u64) -> Purchase {
        // `#[private]` alone also admits a transaction signed by the contract account's own key,
        // which could bundle this with an action that panics on a bad outcome and so re-roll the
        // Draw. Real callbacks are signed by the operator, the customer or the relayer.
        require!(
            env::signer_account_id() != env::current_account_id(),
            "The contract's own key can't run a Draw"
        );
        require!(
            self.load(purchase_id).status == Status::Drawing,
            "Draw already done"
        );
        self.draw(purchase_id)
    }

    /// Runs the Draws of a cart's Lucky Buys (`settle`), each exactly as `on_draw` runs one. One already
    /// drawn (say, by a `retry_draw` that got there first) is left as it is.
    #[private]
    pub fn on_draw_many(&mut self, purchase_ids: Vec<u64>) {
        require!(
            env::signer_account_id() != env::current_account_id(),
            "The contract's own key can't run a Draw"
        );
        for purchase_id in purchase_ids {
            if self.load(purchase_id).status == Status::Drawing {
                self.draw(purchase_id);
            }
        }
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

    /// The server holds the operator's key: it can't be the owner, the proposed owner, the
    /// treasury, or the contract itself (whose signature the Draw refuses).
    #[payable]
    pub fn set_operator(&mut self, operator: AccountId) {
        self.assert_owner();
        require!(
            operator != env::current_account_id()
                && operator != self.owner
                && Some(&operator) != self.pending_owner.as_ref()
                && Some(&operator) != self.treasury.as_ref(),
            "That account can't be the operator"
        );
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

    /// Sets the Cashback Cap: one Lucky Buy pays at most the lower of `fixed` and `reserve_bps` of
    /// Free Reserve. A `None` fixed amount turns it off; the share is required, so one Draw never takes
    /// most of the reserve. Accepted purchases keep their lock.
    #[payable]
    pub fn set_cashback_cap(&mut self, fixed: Option<U128>, reserve_bps: Option<u32>) {
        self.assert_owner();
        require!(fixed != Some(U128(0)), "The fixed limit must be above 0");
        require!(
            reserve_bps.is_some_and(|b| b > 0 && b <= MAX_CAP_RESERVE_BPS),
            "The reserve share must be above 0% and at most 50%"
        );
        let cap = CashbackCap { fixed, reserve_bps };
        env::storage_write(
            &Key::CashbackCap.into_storage_key(),
            &near_sdk::borsh::to_vec(&cap).unwrap(),
        );
        emit("cashback_cap_set", json!(cap));
    }

    #[payable]
    pub fn withdraw_reserve(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        require!(amount.0 > 0, "Nothing to withdraw");
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
                *t != env::current_account_id()
                    && *t != self.usdc
                    && *t != self.operator
                    && *t != self.owner,
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

    /// The owner proposes a new owner, or withdraws the proposal with `None`. Nothing changes
    /// until the proposed account accepts with its own signature.
    #[payable]
    pub fn propose_owner(&mut self, new_owner: Option<AccountId>) {
        self.assert_owner();
        if let Some(o) = &new_owner {
            require!(*o != self.owner, "Already the owner");
            // The server holds the operator's and the treasury's keys: neither may ever own the contract.
            require!(
                *o != env::current_account_id()
                    && *o != self.operator
                    && Some(o) != self.treasury.as_ref(),
                "That account can't own the contract"
            );
        }
        self.pending_owner = new_owner.clone();
        emit("owner_proposed", json!({ "new_owner": new_owner }));
    }

    /// The proposed owner takes over, with its own full-access signature (1 yoctoNEAR).
    #[payable]
    pub fn accept_owner(&mut self) {
        assert_one_yocto();
        let caller = env::predecessor_account_id();
        require!(
            self.pending_owner.as_ref() == Some(&caller),
            "Not the proposed owner"
        );
        // The treasury or the operator may have been set after the proposal: still never the owner.
        require!(
            Some(&caller) != self.treasury.as_ref() && caller != self.operator,
            "That account can't own the contract"
        );
        let previous = std::mem::replace(&mut self.owner, caller.clone());
        self.pending_owner = None;
        emit(
            "owner_changed",
            json!({ "previous": previous, "owner": caller }),
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

    /// Puts back whatever NEAR Intents didn't take from a withdrawal: all of it if the transfer failed,
    /// and whatever USDC's `ft_transfer_call` returned if Intents refused part or all of it.
    #[private]
    pub fn on_send_to_intents(
        &mut self,
        account_id: AccountId,
        amount: U128,
        #[callback_result] used: Result<U128, PromiseError>,
    ) {
        let back = amount.0 - used.map_or(0, |u| u.0.min(amount.0));
        if back == 0 {
            return;
        }
        emit(
            "payout_restored",
            json!({ "payout": Payout::Customer(account_id.clone()), "amount": U128(back) }),
        );
        let mut a = self.accounts.get(&account_id).cloned().unwrap_or_default();
        a.balance.0 += back;
        self.accounts.insert(account_id, a);
    }

    // ---------- views ----------

    pub fn quote(&self, reference_price: U128, mode: Mode) -> Quote {
        self.quote_internal(reference_price.0, mode, None)
    }

    /// A cart's terms, card by card, as `purchase_many` would admit them now: each Lucky card's Cashback
    /// Cap and lock come from the Free Reserve the cards before it left. A Lucky card the reserve can't
    /// cover at all comes back Normal, at the Reference Price; one it covers in part plays that part. A Lucky card with
    /// a confirmed Lucky Amount the reserve still covers plays and locks exactly that, as admission would; one it no
    /// longer covers is quoted as without one, so the caller sees it moved.
    pub fn quote_many(&self, items: Vec<QuoteItem>) -> Vec<Quote> {
        require!(
            !items.is_empty() && items.len() <= MAX_CART,
            "A cart holds 1 to 15 cards"
        );
        let mut free = self.free_reserve;
        items
            .into_iter()
            .map(|i| {
                let r = i.reference_price.0;
                let (mode, confirmed) = match i.mode {
                    Mode::Lucky(v) => match self.lucky_allowed(free, r, v) {
                        0 => (Mode::Normal, None),
                        // `allowed` is at most `r`, so this is also the check `quote_at` makes, without its panic.
                        allowed => (
                            i.mode,
                            i.lucky_amount
                                .map(|l| l.0)
                                .filter(|&x| x > 0 && x <= allowed),
                        ),
                    },
                    m => (m, None),
                };
                let q = self.quote_at(free, r, mode, confirmed);
                if let Mode::Lucky(v) = mode {
                    free -= q.lucky_amount.0 * self.version(v).max_discount_bps() / BPS;
                }
                q
            })
            .collect()
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
            max_cashback: U128(self.max_cashback()),
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
            "pending_owner": self.pending_owner,
            "operator": self.operator,
            "usdc": self.usdc,
            "intents": intents_account(),
            "paused": self.paused,
            "cashback_cap": self.cashback_cap(),
            "treasury": self.treasury,
            "sweep_daily_cap": U128(self.sweep_daily_cap),
            "swept_today": U128(if self.sweep_day == env::block_timestamp() / DAY_NS { self.swept_today } else { 0 }),
        })
    }
}

impl Contract {
    /// Admits one card (`purchase`, `purchase_many`): debits the Maximum Price and locks the reserve.
    fn admit(&mut self, customer: &AccountId, item: CartItem) -> u64 {
        let CartItem {
            reference_price,
            mode,
            order_id,
            max_debit,
            lucky_amount,
        } = item;
        let customer = customer.clone();
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
        let q = self.quote_internal(r, mode, lucky_amount.map(|l| l.0));
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

    /// A Lucky Buy's Draw (`on_draw`, `on_draw_many`): rolls, credits the Cashback, releases the lock.
    fn draw(&mut self, purchase_id: u64) -> Purchase {
        let mut p = self.load(purchase_id);
        let Mode::Lucky(v) = p.mode else {
            env::panic_str("Not a Lucky Buy")
        };
        let version = self.version(v).clone();
        // The block's seed is never used raw: random = sha256(seed ‖ purchase_id), see draw_random.
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

    /// Confirms one delivery (`confirm_delivery`, `settle`): the card's price becomes proceeds. A Normal
    /// purchase is done; a Lucky Buy waits for its Draw, and true says to schedule it.
    fn deliver(&mut self, purchase_id: u64, mut p: Purchase) -> bool {
        require!(p.status == Status::Pending, "Purchase is already closed");
        self.proceeds += p.reference_price.0;
        emit(
            "delivered",
            json!({ "purchase_id": purchase_id, "customer": p.customer }),
        );
        let lucky = matches!(p.mode, Mode::Lucky(_));
        p.status = if lucky {
            Status::Drawing
        } else {
            Status::Delivered
        };
        self.purchases.insert(purchase_id, p);
        lucky
    }

    /// `confirmed` is the Lucky Amount the customer saw: it is played as is, or refused if the
    /// reserve no longer covers it. Without it, the Lucky Amount is the most the reserve allows now.
    fn quote_internal(&self, r: u128, mode: Mode, confirmed: Option<u128>) -> Quote {
        self.quote_at(self.free_reserve, r, mode, confirmed)
    }

    /// The most of `r` a Lucky Buy on version `v` can play with `free` Free Reserve: its best result pays at
    /// most the Cashback Cap, and its lock always fits in Free Reserve.
    fn lucky_allowed(&self, free: u128, r: u128, v: u32) -> u128 {
        let version = self.version(v);
        r.min(self.max_cashback_at(free).saturating_mul(BPS) / version.max_cashback_bps())
            .min(free * BPS / version.max_discount_bps())
    }

    /// `quote_internal` as if Free Reserve were `free` (`quote_many` prices each card on what the ones before it left).
    fn quote_at(&self, free: u128, r: u128, mode: Mode, confirmed: Option<u128>) -> Quote {
        require!(r >= MIN_REFERENCE_PRICE, "Purchases start at 0.5 USDC");
        let (lucky, premium) = match mode {
            Mode::Normal => {
                require!(
                    confirmed.unwrap_or(0) == 0,
                    "A Normal purchase has no Lucky Amount"
                );
                (0, 0)
            }
            Mode::Lucky(v) => {
                let version = self.version(v);
                let allowed = self.lucky_allowed(free, r, v);
                let lucky = match confirmed {
                    None => allowed,
                    Some(x) => {
                        require!(x > 0 && x <= r, "Invalid Lucky Amount");
                        require!(
                            x <= allowed,
                            "The Cashback Reserve moved since you confirmed; please confirm again"
                        );
                        x
                    }
                };
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

    fn cashback_cap(&self) -> CashbackCap {
        env::storage_read(&Key::CashbackCap.into_storage_key())
            .map(|b| near_sdk::borsh::from_slice(&b).unwrap())
            .unwrap_or(DEFAULT_CASHBACK_CAP)
    }

    /// The most Cashback one Lucky Buy can pay now: the lower of the Cashback Cap's limits.
    fn max_cashback(&self) -> u128 {
        self.max_cashback_at(self.free_reserve)
    }

    fn max_cashback_at(&self, free: u128) -> u128 {
        let c = self.cashback_cap();
        let share = c.reserve_bps.map_or(u128::MAX, |b| free * b as u128 / BPS);
        c.fixed.map_or(u128::MAX, |f| f.0).min(share)
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

    /// `mode` is the Default Mode a new account starts with. It never changes an existing account: anyone can
    /// credit an EVM account through NEAR Intents, and a gift must not change the customer's settings. An
    /// unknown Game Version is ignored rather than refusing the money.
    fn credit(&mut self, id: AccountId, amount: U128, mode: Option<Mode>) {
        require!(amount.0 >= MIN_DEPOSIT, "Deposit at least 1 USDC");
        let new = !self.accounts.contains_key(&id);
        let mode = mode.filter(|m| new && self.known_mode(*m));
        let mut a = self.accounts.get(&id).cloned().unwrap_or_default();
        a.balance.0 += amount.0;
        if let Some(m) = mode {
            a.default_mode = m;
        }
        self.accounts.insert(id.clone(), a);
        emit("deposit", json!({ "account_id": id, "amount": amount }));
        if let Some(m) = mode {
            emit("default_mode", json!({ "account_id": id, "mode": m }));
        }
    }

    fn known_mode(&self, mode: Mode) -> bool {
        match mode {
            Mode::Normal => true,
            Mode::Lucky(v) => self.versions.get(v).is_some(),
        }
    }

    fn limits(&mut self, id: AccountId, per_purchase: U128, daily: U128) {
        let mut a = self.existing_account(&id);
        a.per_purchase_limit = per_purchase;
        a.daily_limit = daily;
        self.accounts.insert(id.clone(), a);
        emit(
            "limits",
            json!({ "account_id": id, "per_purchase": per_purchase, "daily": daily }),
        );
    }

    fn default_mode(&mut self, id: AccountId, mode: Mode) {
        self.assert_mode(mode);
        let mut a = self.existing_account(&id);
        a.default_mode = mode;
        self.accounts.insert(id.clone(), a);
        emit("default_mode", json!({ "account_id": id, "mode": mode }));
    }

    /// `to`: "wallet" (the customer's NEAR account) or "intents" (their NEAR Intents account).
    fn debit_withdrawal(&mut self, id: &AccountId, amount: U128, to: &str) {
        // A transfer of 0 moves nothing, yet costs gas (the relayer's, when relayed) and logs a withdrawal.
        require!(amount.0 > 0, "Nothing to withdraw");
        let mut a = self.existing_account(id);
        require!(a.balance.0 >= amount.0, "Insufficient balance");
        a.balance.0 -= amount.0;
        self.accounts.insert(id.clone(), a);
        emit(
            "withdraw",
            json!({ "account_id": id, "amount": amount, "to": to }),
        );
    }

    fn reclaim_as(&mut self, caller: AccountId, purchase_id: u64) {
        let p = self.pending(purchase_id);
        require!(p.customer == caller, "Not your purchase");
        require!(
            env::block_timestamp() >= p.created_at + RECLAIM_AFTER_NS,
            "Reclaim opens 24 hours after purchase"
        );
        self.unwind(purchase_id, p, Status::Reclaimed);
    }

    fn retry_draw_as(&mut self, caller: AccountId, purchase_id: u64) -> Promise {
        let p = self.load(purchase_id);
        require!(p.status == Status::Drawing, "No Draw to retry");
        require!(
            caller == p.customer || caller == self.operator,
            "Not your purchase"
        );
        self.schedule_draw(purchase_id)
    }

    /// Into the customer's own NEAR Intents account: Intents reads the message as the account to credit.
    fn send_to_intents(&self, to: AccountId, amount: u128) -> Promise {
        ext_ft::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER_CALL)
            .ft_transfer_call(intents_account(), U128(amount), None, to.to_string())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_SEND)
                    .on_send_to_intents(to, U128(amount)),
            )
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

/// The Draw's random value: sha256(block random seed ‖ purchase_id as 8 little-endian bytes).
/// The purchase ID makes Draws in the same block independent. The Draw Proof recomputes this in
/// the browser (apps/web/lib/draw.ts).
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

/// One-time upgrade of a deployed contract from the previous layout (before `pending_owner`).
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
        treasury: Option<AccountId>,
        sweep_daily_cap: u128,
        sweep_day: u64,
        swept_today: u128,
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
                treasury: b.treasury,
                sweep_daily_cap: b.sweep_daily_cap,
                sweep_day: b.sweep_day,
                swept_today: b.swept_today,
                pending_owner: None,
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
                treasury: Some("treasury.near".parse().unwrap()),
                sweep_daily_cap: 500,
                sweep_day: 3,
                swept_today: 9,
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
            assert_eq!(
                c.treasury.as_ref().map(|t| t.as_str()),
                Some("treasury.near")
            );
            assert_eq!((c.sweep_daily_cap, c.sweep_day, c.swept_today), (500, 3, 9));
            assert_eq!(c.pending_owner, None);
        }
    }
}
