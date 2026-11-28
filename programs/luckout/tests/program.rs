//! The program on LiteSVM, with ORAO's real VRF program and network state copied from mainnet (`../fixtures.sh`).
//! The only thing faked is ORAO's oracles: a test writes a filled randomness account where ORAO's would be.
//! Run `anchor build` first, so `target/deploy/luckout.so` is current.

use anchor_lang::{
    prelude::{Clock, Pubkey},
    solana_program::{instruction::{AccountMeta, Instruction}, system_program},
    AccountDeserialize, AccountSerialize, AnchorDeserialize, InstructionData, ToAccountMetas,
};
use anchor_spl::token::TokenAccount;
use litesvm::LiteSVM;
use luckout::{error::LuckoutError, game::Quote, state::*, CardOrder, QuoteItem};
use orao_solana_vrf::state::{FulfilledRequest, RandomnessV2, RequestAccount};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

const USDC: u64 = 1_000_000;
const TOKEN: Pubkey = anchor_spl::token::ID;
const VRF: Pubkey = orao_solana_vrf::ID;
const COMPUTE_BUDGET: Pubkey = anchor_lang::pubkey!("ComputeBudget111111111111111111111111111111");

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &luckout::ID).0
}

struct Env {
    svm: LiteSVM,
    owner: Keypair,
    operator: Keypair,
    fee_payer: Keypair,
    mint: Pubkey,
    pay_wallet: Pubkey,
    owner_usdc: Pubkey,
    treasury: Pubkey,
}

struct Shopper {
    kp: Keypair,
    usdc: Pubkey,
}

impl Shopper {
    fn wallet(&self) -> Pubkey {
        self.kp.pubkey()
    }
    fn account(&self) -> Pubkey {
        pda(&[CUSTOMER_SEED, self.wallet().as_ref()])
    }
    fn checkout(&self, number: u64) -> Pubkey {
        pda(&[CHECKOUT_SEED, self.wallet().as_ref(), &number.to_le_bytes()])
    }
}

type Sent = Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>;

/// Anchor's custom errors start at 6000, in enum order.
fn assert_fails(res: Sent, e: LuckoutError) {
    let code = 6000 + e as u32;
    match res {
        Ok(_) => panic!("expected {e:?}, but it went through"),
        Err(f) => assert!(
            format!("{:?}", f.err).contains(&format!("Custom({code})")),
            "expected {e:?} ({code}), got {:?}\n{}",
            f.err,
            f.meta.logs.join("\n")
        ),
    }
}

fn ok(res: Sent) -> litesvm::types::TransactionMetadata {
    res.unwrap_or_else(|f| panic!("{:?}\n{}", f.err, f.meta.logs.join("\n")))
}

fn mint_data(authority: &Pubkey) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    d[0..4].copy_from_slice(&1u32.to_le_bytes());
    d[4..36].copy_from_slice(authority.as_ref());
    d[44] = 6;
    d[45] = 1;
    d
}

fn token_data(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // Initialized
    d
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(luckout::ID, include_bytes!("../../target/deploy/luckout.so")).unwrap();
        svm.add_program(VRF, include_bytes!("fixtures/orao_vrf.so")).unwrap();
        let state: serde_json::Value =
            serde_json::from_str(include_str!("fixtures/orao_network_state.json")).unwrap();
        let data = base64_decode(state["account"]["data"][0].as_str().unwrap());
        let treasury = Pubkey::try_from(&data[40..72]).unwrap();
        let network_state = Pubkey::find_program_address(&[orao_solana_vrf::CONFIG_ACCOUNT_SEED], &VRF).0;
        svm.set_account(network_state, Account { lamports: 10_000_000_000, data, owner: VRF, executable: false, rent_epoch: 0 })
            .unwrap();

        let (owner, operator, fee_payer) = (Keypair::new(), Keypair::new(), Keypair::new());
        for k in [&owner, &operator, &fee_payer] {
            svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
        }
        svm.airdrop(&treasury, 1_000_000_000).unwrap();

        // LiteSVM deploys with no upgrade authority: make the owner the program's upgrade authority.
        let programdata = Pubkey::find_program_address(&[luckout::ID.as_ref()], &anchor_lang::solana_program::bpf_loader_upgradeable::ID).0;
        let mut pd = svm.get_account(&programdata).unwrap();
        pd.data[12] = 1;
        pd.data[13..45].copy_from_slice(owner.pubkey().as_ref());
        svm.set_account(programdata, pd).unwrap();

        let mint = Pubkey::new_unique();
        svm.set_account(mint, Account { lamports: 1_461_600, data: mint_data(&owner.pubkey()), owner: TOKEN, executable: false, rent_epoch: 0 })
            .unwrap();
        let mut env = Env { svm, owner, operator, fee_payer, mint, pay_wallet: Pubkey::default(), owner_usdc: Pubkey::default(), treasury };
        env.pay_wallet = env.token_account(&Pubkey::new_unique(), 0);
        env.owner_usdc = env.token_account(&env.owner.pubkey(), 10_000 * USDC);

        let ix = Instruction {
            program_id: luckout::ID,
            accounts: luckout::accounts::Initialize {
                owner: env.owner.pubkey(),
                config: pda(&[CONFIG_SEED]),
                vault_authority: pda(&[VAULT_AUTHORITY_SEED]),
                vault: pda(&[VAULT_SEED]),
                usdc_mint: mint,
                pay_wallet: env.pay_wallet,
                program: luckout::ID,
                program_data: programdata,
                token_program: TOKEN,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: luckout::instruction::Initialize { operator: env.operator.pubkey() }.data(),
        };
        let owner = env.owner.insecure_clone();
        ok(env.send(&[ix], &[&owner]));
        env
    }

    fn token_account(&mut self, owner: &Pubkey, amount: u64) -> Pubkey {
        let k = Pubkey::new_unique();
        self.svm
            .set_account(k, Account { lamports: 2_039_280, data: token_data(&self.mint, owner, amount), owner: TOKEN, executable: false, rent_epoch: 0 })
            .unwrap();
        k
    }

    fn tokens(&self, k: &Pubkey) -> u64 {
        TokenAccount::try_deserialize(&mut &self.svm.get_account(k).unwrap().data[..]).unwrap().amount
    }

    fn give(&mut self, k: &Pubkey, amount: u64) {
        let mut a = self.svm.get_account(k).unwrap();
        let now = u64::from_le_bytes(a.data[64..72].try_into().unwrap());
        a.data[64..72].copy_from_slice(&(now + amount).to_le_bytes());
        self.svm.set_account(*k, a).unwrap();
    }

    /// The fee payer pays every transaction, as on mainnet.
    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Sent {
        let mut all: Vec<&Keypair> = vec![&self.fee_payer];
        all.extend(signers.iter().filter(|s| s.pubkey() != self.fee_payer.pubkey()));
        let msg = Message::new_with_blockhash(ixs, Some(&self.fee_payer.pubkey()), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &all).unwrap();
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res
    }

    fn config(&self) -> Config {
        self.read(&pda(&[CONFIG_SEED]))
    }

    fn read<T: AccountDeserialize>(&self, k: &Pubkey) -> T {
        T::try_deserialize(&mut &self.svm.get_account(k).unwrap().data[..]).unwrap()
    }

    fn customer(&self, s: &Shopper) -> Customer {
        self.read(&s.account())
    }

    fn warp(&mut self, seconds: i64) {
        let mut c = self.svm.get_sysvar::<Clock>();
        c.unix_timestamp += seconds;
        c.slot += 1;
        self.svm.set_sysvar(&c);
    }

    fn fund_reserve(&mut self, amount: u64) {
        let ix = Instruction {
            program_id: luckout::ID,
            accounts: luckout::accounts::FundReserve {
                owner: self.owner.pubkey(),
                config: pda(&[CONFIG_SEED]),
                from: self.owner_usdc,
                vault: pda(&[VAULT_SEED]),
                token_program: TOKEN,
            }
            .to_account_metas(None),
            data: luckout::instruction::FundReserve { amount }.data(),
        };
        let owner = self.owner.insecure_clone();
        ok(self.send(&[ix], &[&owner]));
    }

    /// A new customer: opens their account and approves the Vault's authority once, as the app does.
    fn shopper(&mut self, mode: Mode) -> Shopper {
        let kp = Keypair::new();
        let usdc = self.token_account(&kp.pubkey(), 0);
        let s = Shopper { kp, usdc };
        let approve = Instruction {
            program_id: TOKEN,
            accounts: vec![
                AccountMeta::new(s.usdc, false),
                AccountMeta::new_readonly(pda(&[VAULT_AUTHORITY_SEED]), false),
                AccountMeta::new_readonly(s.wallet(), true),
            ],
            data: [&[4u8][..], &u64::MAX.to_le_bytes()].concat(),
        };
        let kp = s.kp.insecure_clone();
        ok(self.send(&[approve, self.open_ix(&s, mode)], &[&kp]));
        s
    }

    fn open_ix(&self, s: &Shopper, mode: Mode) -> Instruction {
        Instruction {
            program_id: luckout::ID,
            accounts: luckout::accounts::Open {
                wallet: s.wallet(),
                payer: self.fee_payer.pubkey(),
                config: pda(&[CONFIG_SEED]),
                customer: s.account(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: luckout::instruction::Open { default_mode: mode }.data(),
        }
    }

    fn deposit_ix(&self, customer: Pubkey, source: Pubkey) -> Instruction {
        Instruction {
            program_id: luckout::ID,
            accounts: luckout::accounts::DepositFor {
                config: pda(&[CONFIG_SEED]),
                customer,
                source,
                vault: pda(&[VAULT_SEED]),
                vault_authority: pda(&[VAULT_AUTHORITY_SEED]),
                token_program: TOKEN,
            }
            .to_account_metas(None),
            data: luckout::instruction::DepositFor {}.data(),
        }
    }

    /// Money arrives at the Deposit Address, and anyone moves it into the Balance.
    fn deposit(&mut self, s: &Shopper, amount: u64) {
        self.give(&s.usdc, amount);
        let ix = self.deposit_ix(s.account(), s.usdc);
        ok(self.send(&[ix], &[]));
    }

    fn admit_ix(&self, s: &Shopper, number: u64, cards: Vec<CardOrder>) -> Instruction {
        Instruction {
            program_id: luckout::ID,
            accounts: luckout::accounts::Admit {
                operator: self.operator.pubkey(),
                payer: self.fee_payer.pubkey(),
                config: pda(&[CONFIG_SEED]),
                customer: s.account(),
                checkout: s.checkout(number),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: luckout::instruction::Admit { number, cards }.data(),
        }
    }

    fn admit(&mut self, s: &Shopper, number: u64, cards: Vec<CardOrder>) -> Sent {
        let ix = self.admit_ix(s, number, cards);
        let op = self.operator.insecure_clone();
        self.send(&[budget(), ix], &[&op])
    }

    fn request_address(&self, checkout: &Pubkey, round: u8) -> Pubkey {
        orao_solana_vrf::randomness_account_address(&VRF, &luckout::game::draw_seed(checkout, round))
    }

    fn settle_ix(&self, s: &Shopper, number: u64, delivered: Vec<u8>, failed: Vec<u8>, with_vrf: bool) -> Instruction {
        let checkout = s.checkout(number);
        let round = self.svm.get_account(&checkout).map(|_| self.read::<Checkout>(&checkout).rounds).unwrap_or(0);
        let vrf = |k: Pubkey| if with_vrf { Some(k) } else { None };
        Instruction {
            program_id: luckout::ID,
            accounts: luckout::accounts::Settle {
                operator: self.operator.pubkey(),
                payer: self.fee_payer.pubkey(),
                config: pda(&[CONFIG_SEED]),
                customer: s.account(),
                checkout,
                vault: pda(&[VAULT_SEED]),
                vault_authority: pda(&[VAULT_AUTHORITY_SEED]),
                pay_wallet: self.pay_wallet,
                checkout_payer: self.fee_payer.pubkey(),
                token_program: TOKEN,
                system_program: system_program::ID,
                vrf: vrf(VRF),
                network_state: vrf(Pubkey::find_program_address(&[orao_solana_vrf::CONFIG_ACCOUNT_SEED], &VRF).0),
                treasury: vrf(self.treasury),
                request: vrf(self.request_address(&checkout, round)),
            }
            .to_account_metas(None),
            data: luckout::instruction::Settle { delivered, failed }.data(),
        }
    }

    fn settle(&mut self, s: &Shopper, number: u64, delivered: Vec<u8>, failed: Vec<u8>) -> Sent {
        let ix = self.settle_ix(s, number, delivered, failed, true);
        let op = self.operator.insecure_clone();
        self.send(&[budget(), ix], &[&op])
    }

    /// Stands in for ORAO's oracles: writes the filled request where ORAO keeps it.
    fn fill(&mut self, checkout: &Pubkey, round: u8, randomness: [u8; 64]) {
        let k = self.request_address(checkout, round);
        let mut a = self.svm.get_account(&k).expect("the request exists");
        let pending: RandomnessV2 = RandomnessV2::try_deserialize(&mut &a.data[..]).unwrap();
        let p = pending.pending().unwrap();
        let filled = RandomnessV2 {
            request: RequestAccount::Fulfilled(FulfilledRequest { client: p.client, seed: p.seed, randomness }),
        };
        let mut data = vec![];
        filled.try_serialize(&mut data).unwrap();
        a.data = data;
        self.svm.set_account(k, a).unwrap();
    }

    fn finish_ix(&self, s: &Shopper, number: u64, round: u8, randomness: Pubkey) -> Instruction {
        Instruction {
            program_id: luckout::ID,
            accounts: luckout::accounts::FinishDraw {
                config: pda(&[CONFIG_SEED]),
                customer: s.account(),
                checkout: s.checkout(number),
                randomness,
                checkout_payer: self.fee_payer.pubkey(),
                event_authority: pda(&[b"__event_authority"]),
                program: luckout::ID,
            }
            .to_account_metas(None),
            data: luckout::instruction::FinishDraw { round }.data(),
        }
    }

    fn finish(&mut self, s: &Shopper, number: u64, round: u8) -> Sent {
        let ix = self.finish_ix(s, number, round, self.request_address(&s.checkout(number), round));
        self.send(&[budget(), ix], &[])
    }

    fn request_again(&mut self, s: &Shopper, number: u64, round: u8) -> Sent {
        let checkout = s.checkout(number);
        let next = self.read::<Checkout>(&checkout).rounds;
        let ix = Instruction {
            program_id: luckout::ID,
            accounts: luckout::accounts::RequestAgain {
                payer: self.fee_payer.pubkey(),
                checkout,
                old_request: self.request_address(&checkout, round),
                vrf: VRF,
                network_state: Pubkey::find_program_address(&[orao_solana_vrf::CONFIG_ACCOUNT_SEED], &VRF).0,
                treasury: self.treasury,
                request: self.request_address(&checkout, next),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: luckout::instruction::RequestAgain { round }.data(),
        };
        self.send(&[ix], &[])
    }

    fn reclaim(&mut self, s: &Shopper, number: u64, card: u8) -> Sent {
        let ix = Instruction {
            program_id: luckout::ID,
            accounts: luckout::accounts::Reclaim {
                wallet: s.wallet(),
                config: pda(&[CONFIG_SEED]),
                customer: s.account(),
                checkout: s.checkout(number),
                checkout_payer: self.fee_payer.pubkey(),
            }
            .to_account_metas(None),
            data: luckout::instruction::Reclaim { card }.data(),
        };
        let kp = s.kp.insecure_clone();
        self.send(&[ix], &[&kp])
    }

    fn owner_ix(&self, signer: &Pubkey, data: Vec<u8>) -> Instruction {
        Instruction {
            program_id: luckout::ID,
            accounts: luckout::accounts::OwnerOnly { owner: *signer, config: pda(&[CONFIG_SEED]) }.to_account_metas(None),
            data,
        }
    }

    /// Every USDC in the Vault is someone's: Balances, the reserve and Proceeds.
    fn assert_conserved(&self, shoppers: &[&Shopper]) {
        let c = self.config();
        let balances: u64 = shoppers.iter().map(|s| self.customer(s).balance).sum();
        assert_eq!(
            self.tokens(&pda(&[VAULT_SEED])),
            balances + c.free_reserve + c.locked_reserve + c.proceeds + self.in_flight(shoppers),
            "the Vault holds exactly what is owed"
        );
    }

    /// What open Checkouts debited and the Vault still holds: Pending and Drawing cards' Maximum Prices,
    /// less the Reference Prices of Drawing cards already repaid or held as Proceeds.
    fn in_flight(&self, shoppers: &[&Shopper]) -> u64 {
        let mut total = 0;
        for s in shoppers {
            for n in 0..self.customer(s).checkouts {
                if let Some(a) = self.svm.get_account(&s.checkout(n)) {
                    if a.data.is_empty() {
                        continue;
                    }
                    let co: Checkout = self.read(&s.checkout(n));
                    for card in co.cards {
                        total += match card.status {
                            Status::Pending => card.max_price,
                            Status::Drawing => card.max_price - card.reference_price,
                            _ => 0,
                        };
                    }
                }
            }
        }
        total
    }
}

fn budget() -> Instruction {
    Instruction { program_id: COMPUTE_BUDGET, accounts: vec![], data: [&[2u8][..], &1_400_000u32.to_le_bytes()].concat() }
}

fn base64_decode(s: &str) -> Vec<u8> {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = vec![];
    let (mut buf, mut bits) = (0u32, 0);
    for c in s.bytes().filter(|&c| c != b'=') {
        buf = buf << 6 | T.iter().position(|&t| t == c).unwrap() as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    out
}

fn card(price: u64, mode: Mode) -> CardOrder {
    CardOrder { reference_price: price, mode: Some(mode), max_debit: u64::MAX, lucky_amount: None }
}

// ---------- deposits ----------

#[test]
fn a_deposit_moves_everything_approved_into_that_customers_balance() {
    let mut e = Env::new();
    let alice = e.shopper(Mode::Normal);
    e.deposit(&alice, 25 * USDC);
    assert_eq!(e.customer(&alice).balance, 25 * USDC);
    assert_eq!(e.tokens(&alice.usdc), 0);
    assert_eq!(e.tokens(&pda(&[VAULT_SEED])), 25 * USDC);
}

#[test]
fn a_deposit_goes_only_to_the_approving_customer() {
    let mut e = Env::new();
    let (alice, mallory) = (e.shopper(Mode::Normal), e.shopper(Mode::Normal));
    e.give(&alice.usdc, 10 * USDC);
    // Mallory names her own account with Alice's money: refused, the account isn't hers.
    let ix = e.deposit_ix(mallory.account(), alice.usdc);
    assert_fails(e.send(&[ix], &[]), LuckoutError::WrongTokenAccount);
    // An account that never approved the Vault can't be moved at all.
    let stranger = e.token_account(&mallory.wallet(), 10 * USDC);
    let ix = e.deposit_ix(mallory.account(), stranger);
    assert_fails(e.send(&[ix], &[]), LuckoutError::WrongTokenAccount);
    assert_eq!(e.customer(&mallory).balance, 0);
}

#[test]
fn deposits_start_at_1_usdc() {
    let mut e = Env::new();
    let alice = e.shopper(Mode::Normal);
    e.give(&alice.usdc, 999_999);
    let ix = e.deposit_ix(alice.account(), alice.usdc);
    assert_fails(e.send(&[ix], &[]), LuckoutError::DepositTooSmall);
}

#[test]
fn withdrawals_go_where_the_customer_says_and_only_from_their_balance() {
    let mut e = Env::new();
    let alice = e.shopper(Mode::Normal);
    e.deposit(&alice, 10 * USDC);
    let to = e.token_account(&Pubkey::new_unique(), 0);
    let ix = |amount| Instruction {
        program_id: luckout::ID,
        accounts: luckout::accounts::Withdraw {
            wallet: alice.wallet(),
            config: pda(&[CONFIG_SEED]),
            customer: alice.account(),
            vault: pda(&[VAULT_SEED]),
            vault_authority: pda(&[VAULT_AUTHORITY_SEED]),
            to,
            token_program: TOKEN,
        }
        .to_account_metas(None),
        data: luckout::instruction::Withdraw { amount }.data(),
    };
    let kp = alice.kp.insecure_clone();
    assert_fails(e.send(&[ix(11 * USDC)], &[&kp]), LuckoutError::InsufficientBalance);
    ok(e.send(&[ix(4 * USDC)], &[&kp]));
    assert_eq!((e.customer(&alice).balance, e.tokens(&to)), (6 * USDC, 4 * USDC));
}

// ---------- Checkouts ----------

#[test]
fn a_full_cart_is_admitted_card_by_card_settled_and_drawn() {
    let mut e = Env::new();
    e.fund_reserve(1_000 * USDC);
    let alice = e.shopper(Mode::Lucky(1));
    e.deposit(&alice, 500 * USDC);
    let limits = Instruction {
        program_id: luckout::ID,
        accounts: luckout::accounts::CustomerSetting { wallet: alice.wallet(), config: pda(&[CONFIG_SEED]), customer: alice.account() }
            .to_account_metas(None),
        data: luckout::instruction::SetLimits { per_purchase: u64::MAX, daily: u64::MAX }.data(),
    };
    let kp = alice.kp.insecure_clone();
    ok(e.send(&[limits], &[&kp]));

    // 15 cards, the Default Mode (Classic) on each but one Normal.
    let mut cards: Vec<CardOrder> = (0..15).map(|_| CardOrder { mode: None, ..card(6 * USDC, Mode::Normal) }).collect();
    cards[14].mode = Some(Mode::Normal);
    let admitted = ok(e.admit(&alice, 0, cards.clone()));
    let co: Checkout = e.read(&alice.checkout(0));
    assert_eq!(co.cards.len(), 15);
    assert_eq!(co.cards[0].max_price, 7_200_000);
    assert_eq!(co.cards[14].max_price, 6 * USDC);
    assert_eq!(e.customer(&alice).balance, 500 * USDC - 14 * 7_200_000 - 6 * USDC);
    // Each card's lock came from what the cards before it left.
    assert_eq!(e.config().locked_reserve, co.cards.iter().map(|c| c.locked).sum::<u64>());
    e.assert_conserved(&[&alice]);

    // Delivered 13, failed 2: the Pay Wallet gets the 13 Reference Prices, the 2 come back in full.
    let settled = ok(e.settle(&alice, 0, (0..13).collect(), vec![13, 14]));
    assert_eq!(e.tokens(&e.pay_wallet), 13 * 6 * USDC);
    let co: Checkout = e.read(&alice.checkout(0));
    assert!(co.cards[..13].iter().all(|c| c.status == Status::Drawing && c.round == 0));
    assert_eq!(co.rounds, 1);
    let request = e.svm.get_account(&e.request_address(&alice.checkout(0), 0)).unwrap();
    assert_eq!(request.owner, VRF, "ORAO made the request");
    e.assert_conserved(&[&alice]);

    // Not filled yet: nothing to finish.
    assert_fails(e.finish(&alice, 0, 0), LuckoutError::RandomnessNotFilled);
    let mut value = [0u8; 64];
    value[..8].copy_from_slice(b"luckout!");
    e.fill(&alice.checkout(0), 0, value);
    let finished = ok(e.finish(&alice, 0, 0));
    assert!(e.svm.get_account(&alice.checkout(0)).map_or(true, |a| a.data.is_empty()), "the Checkout closed");
    let c = e.config();
    assert_eq!((c.locked_reserve, c.lucky_settled), (0, 13));
    e.assert_conserved(&[&alice]);
    // Recompute every card's Draw from ORAO's value, the way the Draw Proof page does.
    let classic = &luckout::game::default_game_versions()[1].outcomes;
    let expected: u64 = (0..13u8)
        .map(|i| {
            let roll = luckout::game::roll_from_random(&luckout::game::card_random(&value, i));
            7_200_000 - luckout::game::final_price(6 * USDC, 6 * USDC, 7_200_000, luckout::game::final_bps_for_roll(classic, roll))
        })
        .sum();
    assert_eq!(e.customer(&alice).cashback_received, expected);

    // Finishing again can't re-run anything: the Checkout is gone.
    assert!(e.finish(&alice, 0, 0).is_err());

    println!(
        "15-card admit: {} bytes, {} CU; settle with ORAO's request: {} bytes, {} CU; finish 13 Draws: {} CU",
        tx_size(&e, &[budget(), e.admit_ix(&alice, 1, cards)]),
        admitted.compute_units_consumed,
        tx_size(&e, &[budget(), e.settle_ix(&alice, 0, (0..13).collect(), vec![13, 14], true)]),
        settled.compute_units_consumed,
        finished.compute_units_consumed
    );
}

fn tx_size(e: &Env, ixs: &[Instruction]) -> usize {
    let msg = Message::new_with_blockhash(ixs, Some(&e.fee_payer.pubkey()), &e.svm.latest_blockhash());
    let sigs = msg.header.num_required_signatures as usize;
    1 + sigs * 64 + VersionedMessage::Legacy(msg).serialize().len()
}

#[test]
fn a_checkout_number_is_used_once_even_after_its_account_closed() {
    let mut e = Env::new();
    let alice = e.shopper(Mode::Normal);
    e.deposit(&alice, 50 * USDC);
    assert_fails(e.admit(&alice, 1, vec![card(5 * USDC, Mode::Normal)]), LuckoutError::WrongCheckoutNumber);
    ok(e.admit(&alice, 0, vec![card(5 * USDC, Mode::Normal)]));
    // A retry while it's open: its address is taken.
    assert!(e.admit(&alice, 0, vec![card(5 * USDC, Mode::Normal)]).is_err());
    ok(e.settle(&alice, 0, vec![0], vec![]));
    assert!(e.svm.get_account(&alice.checkout(0)).map_or(true, |a| a.data.is_empty()), "a Normal Checkout closes at settle");
    // A retry after it closed: the address is free, but the number is spent.
    assert_fails(e.admit(&alice, 0, vec![card(5 * USDC, Mode::Normal)]), LuckoutError::WrongCheckoutNumber);
    assert_eq!(e.customer(&alice).balance, 45 * USDC);
}

#[test]
fn admission_checks_price_limits_balance_pause_and_the_operator() {
    let mut e = Env::new();
    e.fund_reserve(1_000 * USDC);
    let alice = e.shopper(Mode::Normal);
    e.deposit(&alice, 300 * USDC);
    let one = |m| vec![card(10 * USDC, m)];
    assert_fails(
        e.admit(&alice, 0, vec![CardOrder { max_debit: 11 * USDC, ..card(10 * USDC, Mode::Lucky(1)) }]),
        LuckoutError::PriceChanged,
    );
    assert_fails(e.admit(&alice, 0, vec![card(250 * USDC, Mode::Normal)]), LuckoutError::OverPerPurchaseLimit);
    assert_fails(e.admit(&alice, 0, vec![card(100 * USDC, Mode::Normal), card(200 * USDC, Mode::Normal), card(100 * USDC, Mode::Normal)]), LuckoutError::InsufficientBalance);
    assert_fails(e.admit(&alice, 0, vec![card(USDC, Mode::Lucky(0))]), LuckoutError::LuckyCheckoutTooSmall);
    assert_fails(e.admit(&alice, 0, vec![card(499_999, Mode::Normal)]), LuckoutError::BelowMinimumPrice);

    // Only the operator admits.
    let mut ix = e.admit_ix(&alice, 0, one(Mode::Normal));
    let stranger = Keypair::new();
    ix.accounts[0].pubkey = stranger.pubkey();
    assert_fails(e.send(&[ix], &[&stranger]), LuckoutError::NotOperator);

    // Pause stops new Checkouts only.
    let owner = e.owner.insecure_clone();
    let pause = e.owner_ix(&owner.pubkey(), luckout::instruction::SetPaused { paused: true }.data());
    ok(e.send(&[pause], &[&owner]));
    assert_fails(e.admit(&alice, 0, one(Mode::Normal)), LuckoutError::Paused);
    let unpause = e.owner_ix(&owner.pubkey(), luckout::instruction::SetPaused { paused: false }.data());
    ok(e.send(&[unpause], &[&owner]));
    ok(e.admit(&alice, 0, one(Mode::Lucky(2))));
    // Nothing was debited by the refusals.
    assert_eq!(e.customer(&alice).balance, 300 * USDC - 15 * USDC);
}

#[test]
fn the_daily_limit_resets_the_next_day() {
    let mut e = Env::new();
    let alice = e.shopper(Mode::Normal);
    e.deposit(&alice, 2_000 * USDC);
    for n in 0..5 {
        ok(e.admit(&alice, n, vec![card(200 * USDC, Mode::Normal)]));
    }
    assert_fails(e.admit(&alice, 5, vec![card(USDC, Mode::Normal)]), LuckoutError::OverDailyLimit);
    e.warp(luckout::DAY);
    ok(e.admit(&alice, 5, vec![card(USDC, Mode::Normal)]));
}

#[test]
fn past_the_daily_repay_cap_prices_wait_as_proceeds() {
    let mut e = Env::new();
    let alice = e.shopper(Mode::Normal);
    e.deposit(&alice, 1_000 * USDC);
    let owner = e.owner.insecure_clone();
    let cap = e.owner_ix(&owner.pubkey(), luckout::instruction::SetRepayCap { daily: 15 * USDC }.data());
    ok(e.send(&[cap], &[&owner]));
    ok(e.admit(&alice, 0, vec![card(10 * USDC, Mode::Normal), card(10 * USDC, Mode::Normal)]));
    ok(e.settle(&alice, 0, vec![0, 1], vec![]));
    assert_eq!((e.tokens(&e.pay_wallet), e.config().proceeds), (15 * USDC, 5 * USDC));
    e.warp(luckout::DAY);
    ok(e.admit(&alice, 1, vec![card(10 * USDC, Mode::Normal)]));
    ok(e.settle(&alice, 1, vec![0], vec![]));
    assert_eq!(e.tokens(&e.pay_wallet), 25 * USDC);
    e.assert_conserved(&[&alice]);
}

#[test]
fn reclaim_opens_24_hours_after_admission() {
    let mut e = Env::new();
    e.fund_reserve(1_000 * USDC);
    let alice = e.shopper(Mode::Normal);
    e.deposit(&alice, 50 * USDC);
    ok(e.admit(&alice, 0, vec![card(10 * USDC, Mode::Lucky(1)), card(5 * USDC, Mode::Normal)]));
    assert_fails(e.reclaim(&alice, 0, 0), LuckoutError::TooEarlyToReclaim);
    e.warp(luckout::RECLAIM_AFTER);
    ok(e.reclaim(&alice, 0, 0));
    assert_fails(e.reclaim(&alice, 0, 0), LuckoutError::NotPending);
    assert_eq!(e.config().locked_reserve, 0);
    ok(e.reclaim(&alice, 0, 1));
    assert_eq!(e.customer(&alice).balance, 50 * USDC);
    assert!(e.svm.get_account(&alice.checkout(0)).map_or(true, |a| a.data.is_empty()));
    // Someone else can't reclaim Alice's cards: the Checkout's address is derived from the signer.
    e.assert_conserved(&[&alice]);
}

// ---------- the Draw can't be re-rolled ----------

#[test]
fn a_forged_or_foreign_randomness_account_is_refused() {
    let mut e = Env::new();
    e.fund_reserve(1_000 * USDC);
    let alice = e.shopper(Mode::Normal);
    e.deposit(&alice, 50 * USDC);
    ok(e.admit(&alice, 0, vec![card(10 * USDC, Mode::Lucky(2))]));
    ok(e.settle(&alice, 0, vec![0], vec![]));

    // A filled-looking account owned by someone else, at any address.
    let fake = Pubkey::new_unique();
    let mut data = vec![];
    RandomnessV2 { request: RequestAccount::Fulfilled(FulfilledRequest { client: fake, seed: [0; 32], randomness: [9; 64] }) }
        .try_serialize(&mut data)
        .unwrap();
    e.svm.set_account(fake, Account { lamports: 10_000_000, data: data.clone(), owner: Pubkey::new_unique(), executable: false, rent_epoch: 0 }).unwrap();
    let ix = e.finish_ix(&alice, 0, 0, fake);
    assert_fails(e.send(&[ix], &[]), LuckoutError::WrongRandomnessAccount);
    // ORAO's, filled, but another request's.
    let other = Pubkey::new_unique();
    e.svm.set_account(other, Account { lamports: 10_000_000, data, owner: VRF, executable: false, rent_epoch: 0 }).unwrap();
    let ix = e.finish_ix(&alice, 0, 0, other);
    assert_fails(e.send(&[ix], &[]), LuckoutError::WrongRandomnessAccount);
}

#[test]
fn an_unfilled_request_is_replaced_after_an_hour_and_never_a_filled_one() {
    let mut e = Env::new();
    e.fund_reserve(1_000 * USDC);
    let alice = e.shopper(Mode::Normal);
    e.deposit(&alice, 50 * USDC);
    ok(e.admit(&alice, 0, vec![card(10 * USDC, Mode::Lucky(1))]));
    ok(e.settle(&alice, 0, vec![0], vec![]));
    assert_fails(e.request_again(&alice, 0, 0), LuckoutError::TooEarlyToRequestAgain);
    e.warp(luckout::REQUEST_AGAIN_AFTER);
    ok(e.request_again(&alice, 0, 0));
    let co: Checkout = e.read(&alice.checkout(0));
    assert_eq!((co.rounds, co.cards[0].round), (2, 1));
    // The old request arriving late draws nothing: its card moved on.
    e.fill(&alice.checkout(0), 0, [1; 64]);
    assert_fails(e.finish(&alice, 0, 0), LuckoutError::NothingToDraw);
    // Once the new one is filled, it can't be replaced, only finished.
    e.fill(&alice.checkout(0), 1, [2; 64]);
    e.warp(luckout::REQUEST_AGAIN_AFTER);
    assert_fails(e.request_again(&alice, 0, 1), LuckoutError::RandomnessFilled);
    ok(e.finish(&alice, 0, 1));
    e.assert_conserved(&[&alice]);
}

#[test]
fn a_settle_with_lucky_cards_needs_the_randomness_accounts() {
    let mut e = Env::new();
    e.fund_reserve(1_000 * USDC);
    let alice = e.shopper(Mode::Normal);
    e.deposit(&alice, 50 * USDC);
    ok(e.admit(&alice, 0, vec![card(10 * USDC, Mode::Lucky(0)), card(5 * USDC, Mode::Normal)]));
    let ix = e.settle_ix(&alice, 0, vec![0], vec![], false);
    let op = e.operator.insecure_clone();
    assert_fails(e.send(&[ix], &[&op]), LuckoutError::MissingRandomnessAccounts);
    assert_fails(e.settle(&alice, 0, vec![0, 0], vec![]), LuckoutError::DuplicateCard);
    assert_fails(e.settle(&alice, 0, vec![2], vec![]), LuckoutError::UnknownCard);
}

// ---------- owner ----------

#[test]
fn ownership_moves_only_when_the_new_owner_accepts() {
    let mut e = Env::new();
    let (owner, heir, stranger) = (e.owner.insecure_clone(), Keypair::new(), Keypair::new());
    let accept = |who: &Keypair| Instruction {
        program_id: luckout::ID,
        accounts: luckout::accounts::AcceptOwner { new_owner: who.pubkey(), config: pda(&[CONFIG_SEED]) }.to_account_metas(None),
        data: luckout::instruction::AcceptOwner {}.data(),
    };
    let propose = |to| e.owner_ix(&owner.pubkey(), luckout::instruction::ProposeOwner { new_owner: to }.data());
    let (p_heir, p_op) = (propose(Some(heir.pubkey())), propose(Some(e.operator.pubkey())));
    assert_fails(e.send(&[p_op], &[&owner]), LuckoutError::BadRole);
    ok(e.send(&[p_heir], &[&owner]));
    assert_fails(e.send(&[accept(&stranger)], &[&stranger]), LuckoutError::NotProposedOwner);
    assert_eq!(e.config().owner, owner.pubkey());
    ok(e.send(&[accept(&heir)], &[&heir]));
    assert_eq!(e.config().owner, heir.pubkey());
    // The old owner can no longer pause.
    let pause = e.owner_ix(&owner.pubkey(), luckout::instruction::SetPaused { paused: true }.data());
    assert_fails(e.send(&[pause], &[&owner]), LuckoutError::NotOwner);
}

#[test]
fn the_guardian_can_only_pause() {
    let mut e = Env::new();
    let (owner, guardian, stranger) = (e.owner.insecure_clone(), Keypair::new(), Keypair::new());
    let pause = |who: &Keypair| Instruction {
        program_id: luckout::ID,
        accounts: luckout::accounts::Pause { guardian: who.pubkey(), config: pda(&[CONFIG_SEED]) }.to_account_metas(None),
        data: luckout::instruction::Pause {}.data(),
    };
    let set = |to| e.owner_ix(&owner.pubkey(), luckout::instruction::SetGuardian { guardian: to }.data());
    let (appoint, remove) = (set(Some(guardian.pubkey())), set(None));
    assert_eq!(e.config().guardian, Pubkey::default(), "none until the owner appoints one");
    assert_fails(e.send(&[pause(&guardian)], &[&guardian]), LuckoutError::NotGuardian);
    let by_guardian = e.owner_ix(&guardian.pubkey(), luckout::instruction::SetGuardian { guardian: Some(guardian.pubkey()) }.data());
    assert_fails(e.send(&[by_guardian], &[&guardian]), LuckoutError::NotOwner);
    ok(e.send(&[appoint], &[&owner]));
    assert_fails(e.send(&[pause(&stranger)], &[&stranger]), LuckoutError::NotGuardian);
    ok(e.send(&[pause(&guardian)], &[&guardian]));
    assert!(e.config().paused);
    // Only the owner starts Checkouts again.
    let unpause = |who: &Keypair| e.owner_ix(&who.pubkey(), luckout::instruction::SetPaused { paused: false }.data());
    let (unpause_g, unpause_o) = (unpause(&guardian), unpause(&owner));
    assert_fails(e.send(&[unpause_g], &[&guardian]), LuckoutError::NotOwner);
    ok(e.send(&[unpause_o.clone()], &[&owner]));
    assert!(!e.config().paused);
    // The owner can pause the same way, and removing the guardian takes the power away.
    ok(e.send(&[pause(&owner)], &[&owner]));
    ok(e.send(&[unpause_o], &[&owner]));
    ok(e.send(&[remove], &[&owner]));
    assert_fails(e.send(&[pause(&guardian)], &[&guardian]), LuckoutError::NotGuardian);
}

#[test]
fn only_the_owner_moves_the_reserve_and_never_the_locked_part() {
    let mut e = Env::new();
    e.fund_reserve(100 * USDC);
    let alice = e.shopper(Mode::Normal);
    e.deposit(&alice, 50 * USDC);
    ok(e.admit(&alice, 0, vec![card(10 * USDC, Mode::Lucky(2))]));
    let locked = e.config().locked_reserve;
    let ix = |signer: Pubkey, to: Pubkey, amount| Instruction {
        program_id: luckout::ID,
        accounts: luckout::accounts::OwnerPayout {
            owner: signer,
            config: pda(&[CONFIG_SEED]),
            vault: pda(&[VAULT_SEED]),
            vault_authority: pda(&[VAULT_AUTHORITY_SEED]),
            to,
            token_program: TOKEN,
        }
        .to_account_metas(None),
        data: luckout::instruction::WithdrawReserve { amount }.data(),
    };
    let (owner, stranger) = (e.owner.insecure_clone(), Keypair::new());
    let theirs = e.token_account(&stranger.pubkey(), 0);
    assert_fails(e.send(&[ix(stranger.pubkey(), theirs, USDC)], &[&stranger]), LuckoutError::NotOwner);
    assert_fails(e.send(&[ix(owner.pubkey(), theirs, USDC)], &[&owner]), LuckoutError::WrongTokenAccount);
    assert_fails(e.send(&[ix(owner.pubkey(), e.owner_usdc, 100 * USDC - locked + 1)], &[&owner]), LuckoutError::ExceedsFreeReserve);
    ok(e.send(&[ix(owner.pubkey(), e.owner_usdc, 100 * USDC - locked)], &[&owner]));
    e.assert_conserved(&[&alice]);
}

// ---------- upgrades ----------

#[test]
fn an_account_written_by_a_newer_build_is_refused() {
    let mut e = Env::new();
    let alice = e.shopper(Mode::Normal);
    e.deposit(&alice, 5 * USDC);
    let mut a = e.svm.get_account(&alice.account()).unwrap();
    a.data[8] = LAYOUT + 1;
    e.svm.set_account(alice.account(), a).unwrap();
    e.give(&alice.usdc, 5 * USDC);
    let ix = e.deposit_ix(alice.account(), alice.usdc);
    assert_fails(e.send(&[ix], &[]), LuckoutError::NewerLayout);
}

// ---------- quotes ----------

#[test]
fn quote_many_prices_a_full_cart_as_admit_would() {
    let mut e = Env::new();
    e.fund_reserve(1_000 * USDC);
    let items: Vec<QuoteItem> =
        (0..15).map(|i| QuoteItem { reference_price: (i + 1) * 10 * USDC, mode: Mode::Lucky((i % 3) as u32), lucky_amount: None }).collect();
    let ix = Instruction {
        program_id: luckout::ID,
        accounts: luckout::accounts::ReadConfig { config: pda(&[CONFIG_SEED]) }.to_account_metas(None),
        data: luckout::instruction::QuoteMany { items }.data(),
    };
    let res = ok(e.send(&[ix], &[]));
    let quotes: Vec<Quote> = Vec::<Quote>::deserialize(&mut &res.return_data.data[..]).unwrap();
    assert_eq!(quotes.len(), 15);
    assert!(quotes.iter().all(|q| q.lucky_amount > 0));
    println!("quote_many for 15 cards returns {} of 1,024 bytes", res.return_data.data.len());
}
