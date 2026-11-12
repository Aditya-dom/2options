//! Test USDC: a NEP-141 token with 6 decimals and a rate-limited faucet. TESTNET ONLY.
//!
//! Anyone can call `faucet` for `FAUCET_AMOUNT` once per `FAUCET_COOLDOWN_NS` per account; the
//! owner can `mint` any amount up to `MAX_MINT` per call (bootstrap, LP seeding). The token is
//! worthless by design. It exists so the twooptions contract can be exercised end to end on
//! testnet without depending on someone else's faucet. Never point a mainnet deployment at it.
//!
//! The token logic is `near-contract-standards`' `FungibleToken`; this file only adds the
//! faucet and wires the standard traits.

use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue,
};

/// Largest owner mint per call: 1,000,000 USDC.
pub const MAX_MINT: u128 = 1_000_000_000_000;
/// What one faucet claim pays: 2,000 USDC.
pub const FAUCET_AMOUNT: u128 = 2_000_000_000;
/// Time between two faucet claims by the same account: 24 hours.
pub const FAUCET_COOLDOWN_NS: u64 = 24 * 3_600 * 1_000_000_000;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Token,
    FaucetClaims,
}

/// Faucet terms and when `account_id` may claim next.
#[near(serializers = [json])]
pub struct FaucetStatus {
    pub amount: U128,
    pub cooldown_ns: U64,
    /// Block time (ns) of the next allowed claim; `None` when a claim would succeed now.
    pub next_claim_ns: Option<U64>,
}

/// State layout before the owner and the faucet limit existed (open `mint`).
#[near(serializers = [borsh])]
struct OldTestUsdc {
    token: FungibleToken,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct TestUsdc {
    token: FungibleToken,
    owner_id: AccountId,
    /// Block time (ns) of each account's last faucet claim.
    last_claim: LookupMap<AccountId, u64>,
}

#[near]
impl TestUsdc {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            token: FungibleToken::new(StorageKey::Token),
            owner_id,
            last_claim: LookupMap::new(StorageKey::FaucetClaims),
        }
    }

    /// Rewrites the pre-faucet layout (`{ token }`) and sets the owner. Balances are kept.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(owner_id: AccountId) -> Self {
        let old: OldTestUsdc = env::state_read().expect("no state to migrate");
        Self { token: old.token, owner_id, last_claim: LookupMap::new(StorageKey::FaucetClaims) }
    }

    /// Owner only. Registers `account_id` if needed and credits it with `amount` (6 decimals).
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(env::predecessor_account_id() == self.owner_id, "only the owner can mint; use faucet");
        require!(amount.0 > 0 && amount.0 <= MAX_MINT, "amount must be between 1 and MAX_MINT");
        self.credit(&account_id, amount.0);
    }

    /// Pays `FAUCET_AMOUNT` to the caller, at most once per `FAUCET_COOLDOWN_NS`. The contract
    /// pays the caller's storage registration. Returns the amount paid.
    pub fn faucet(&mut self) -> U128 {
        let who = env::predecessor_account_id();
        let now = env::block_timestamp();
        if let Some(next) = self.next_claim(&who, now) {
            let mins = (next - now).div_ceil(60 * 1_000_000_000);
            env::panic_str(&format!("faucet already claimed; try again in {}h {}m", mins / 60, mins % 60));
        }
        self.last_claim.insert(who.clone(), now);
        self.credit(&who, FAUCET_AMOUNT);
        U128(FAUCET_AMOUNT)
    }

    pub fn faucet_status(&self, account_id: AccountId) -> FaucetStatus {
        FaucetStatus {
            amount: U128(FAUCET_AMOUNT),
            cooldown_ns: U64(FAUCET_COOLDOWN_NS),
            next_claim_ns: self.next_claim(&account_id, env::block_timestamp()).map(U64),
        }
    }

    pub fn owner_id(&self) -> AccountId {
        self.owner_id.clone()
    }

    fn next_claim(&self, who: &AccountId, now: u64) -> Option<u64> {
        let next = self.last_claim.get(who)?.saturating_add(FAUCET_COOLDOWN_NS);
        (now < next).then_some(next)
    }

    fn credit(&mut self, account_id: &AccountId, amount: u128) {
        if !self.token.accounts.contains_key(account_id) {
            self.token.internal_register_account(account_id);
        }
        self.token.internal_deposit(account_id, amount);
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"nep141\",\"version\":\"1.0.0\",\"event\":\"ft_mint\",\"data\":[{{\"owner_id\":\"{account_id}\",\"amount\":\"{amount}\"}}]}}"
        ));
    }
}

#[near]
impl FungibleTokenCore for TestUsdc {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for TestUsdc {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, _burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for TestUsdc {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for TestUsdc {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Test USDC (TwoOptions testnet faucet)".to_string(),
            symbol: "USDC".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    const OWNER: &str = "owner.testnet";
    const HOUR_NS: u64 = 3_600 * 1_000_000_000;

    fn as_user_at(who: &str, deposit: u128, now: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acct("usdc.testnet"))
            .predecessor_account_id(acct(who))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(now)
            .build());
    }

    fn as_user(who: &str, deposit: u128) {
        as_user_at(who, deposit, 1_000 * HOUR_NS);
    }

    fn token() -> TestUsdc {
        TestUsdc::new(acct(OWNER))
    }

    #[test]
    fn mint_registers_and_credits() {
        as_user(OWNER, 0);
        let mut c = token();
        c.mint(acct("alice.testnet"), U128(5_000_000));
        c.mint(acct("alice.testnet"), U128(1));
        assert_eq!(c.ft_balance_of(acct("alice.testnet")).0, 5_000_001);
        assert_eq!(c.ft_total_supply().0, 5_000_001);
        assert!(c.storage_balance_of(acct("alice.testnet")).is_some());
        assert_eq!(c.ft_metadata().decimals, 6);
    }

    #[test]
    #[should_panic(expected = "amount must be between 1 and MAX_MINT")]
    fn mint_is_capped() {
        as_user(OWNER, 0);
        token().mint(acct("alice.testnet"), U128(MAX_MINT + 1));
    }

    #[test]
    #[should_panic(expected = "amount must be between 1 and MAX_MINT")]
    fn zero_mint_is_rejected() {
        as_user(OWNER, 0);
        token().mint(acct("alice.testnet"), U128(0));
    }

    #[test]
    fn transfer_moves_balance_between_registered_accounts() {
        as_user(OWNER, 0);
        let mut c = token();
        c.mint(acct("alice.testnet"), U128(10_000_000));
        c.mint(acct("bob.testnet"), U128(1));
        as_user("alice.testnet", 1);
        c.ft_transfer(acct("bob.testnet"), U128(4_000_000), None);
        assert_eq!(c.ft_balance_of(acct("alice.testnet")).0, 6_000_000);
        assert_eq!(c.ft_balance_of(acct("bob.testnet")).0, 4_000_001);
    }

    #[test]
    #[should_panic(expected = "is not registered")]
    fn transfer_to_an_unregistered_account_fails() {
        as_user(OWNER, 0);
        let mut c = token();
        c.mint(acct("alice.testnet"), U128(10_000_000));
        as_user("alice.testnet", 1);
        c.ft_transfer(acct("carol.testnet"), U128(1), None);
    }

    #[test]
    #[should_panic(expected = "only the owner can mint")]
    fn mint_is_owner_only() {
        as_user("anyone.testnet", 0);
        token().mint(acct("anyone.testnet"), U128(1));
    }

    #[test]
    fn faucet_pays_the_caller_once_per_day() {
        let t0 = 1_000 * HOUR_NS;
        as_user_at("alice.testnet", 0, t0);
        let mut c = token();
        let st = c.faucet_status(acct("alice.testnet"));
        assert!(st.next_claim_ns.is_none());
        assert_eq!(st.amount.0, FAUCET_AMOUNT);
        assert_eq!(c.faucet().0, FAUCET_AMOUNT);
        assert_eq!(c.ft_balance_of(acct("alice.testnet")).0, FAUCET_AMOUNT);
        assert!(c.storage_balance_of(acct("alice.testnet")).is_some());
        assert_eq!(c.faucet_status(acct("alice.testnet")).next_claim_ns.unwrap().0, t0 + FAUCET_COOLDOWN_NS);

        // Another account is not affected by alice's claim.
        as_user_at("bob.testnet", 0, t0 + HOUR_NS);
        c.faucet();
        assert_eq!(c.ft_balance_of(acct("bob.testnet")).0, FAUCET_AMOUNT);

        // Exactly one cooldown later alice can claim again.
        as_user_at("alice.testnet", 0, t0 + FAUCET_COOLDOWN_NS);
        assert!(c.faucet_status(acct("alice.testnet")).next_claim_ns.is_none());
        c.faucet();
        assert_eq!(c.ft_balance_of(acct("alice.testnet")).0, 2 * FAUCET_AMOUNT);
        assert_eq!(c.ft_total_supply().0, 3 * FAUCET_AMOUNT);
    }

    #[test]
    #[should_panic(expected = "faucet already claimed; try again in 23h 0m")]
    fn faucet_refuses_a_second_claim_within_the_cooldown() {
        as_user_at("alice.testnet", 0, 1_000 * HOUR_NS);
        let mut c = token();
        c.faucet();
        as_user_at("alice.testnet", 0, 1_001 * HOUR_NS);
        c.faucet();
    }

    #[test]
    fn migrate_keeps_balances_and_sets_the_owner() {
        as_user("usdc.testnet", 0);
        let mut old = OldTestUsdc { token: FungibleToken::new(StorageKey::Token) };
        old.token.internal_register_account(&acct("alice.testnet"));
        old.token.internal_deposit(&acct("alice.testnet"), 7_000_000);
        env::state_write(&old);

        let mut c = TestUsdc::migrate(acct(OWNER));
        assert_eq!(c.ft_balance_of(acct("alice.testnet")).0, 7_000_000);
        assert_eq!(c.ft_total_supply().0, 7_000_000);
        assert_eq!(c.owner_id(), acct(OWNER));
        as_user_at("alice.testnet", 0, 1_000 * HOUR_NS);
        c.faucet();
        assert_eq!(c.ft_balance_of(acct("alice.testnet")).0, 7_000_000 + FAUCET_AMOUNT);
    }
}
