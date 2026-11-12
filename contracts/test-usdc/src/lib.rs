//! Test USDC: a NEP-141 token with 6 decimals and an open faucet. TESTNET ONLY.
//!
//! Anyone can mint to anyone, up to `MAX_MINT` per call, so the token is worthless by design.
//! It exists so the twooptions contract can be exercised end to end on testnet without depending
//! on someone else's faucet. Never point a mainnet deployment at it.
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
use near_sdk::json_types::U128;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue,
};

/// Largest faucet mint per call: 1,000,000 USDC.
pub const MAX_MINT: u128 = 1_000_000_000_000;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Token,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct TestUsdc {
    token: FungibleToken,
}

#[near]
impl TestUsdc {
    #[init]
    pub fn new() -> Self {
        Self { token: FungibleToken::new(StorageKey::Token) }
    }

    /// Faucet. Registers `account_id` if needed and credits it with `amount` (6 decimals).
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(amount.0 > 0 && amount.0 <= MAX_MINT, "amount must be between 1 and MAX_MINT");
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.0);
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"nep141\",\"version\":\"1.0.0\",\"event\":\"ft_mint\",\"data\":[{{\"owner_id\":\"{account_id}\",\"amount\":\"{}\"}}]}}",
            amount.0
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

    fn as_user(who: &str, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acct("usdc.testnet"))
            .predecessor_account_id(acct(who))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build());
    }

    #[test]
    fn mint_registers_and_credits() {
        as_user("anyone.testnet", 0);
        let mut c = TestUsdc::new();
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
        as_user("anyone.testnet", 0);
        TestUsdc::new().mint(acct("alice.testnet"), U128(MAX_MINT + 1));
    }

    #[test]
    #[should_panic(expected = "amount must be between 1 and MAX_MINT")]
    fn zero_mint_is_rejected() {
        as_user("anyone.testnet", 0);
        TestUsdc::new().mint(acct("alice.testnet"), U128(0));
    }

    #[test]
    fn transfer_moves_balance_between_registered_accounts() {
        as_user("anyone.testnet", 0);
        let mut c = TestUsdc::new();
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
        as_user("anyone.testnet", 0);
        let mut c = TestUsdc::new();
        c.mint(acct("alice.testnet"), U128(10_000_000));
        as_user("alice.testnet", 1);
        c.ft_transfer(acct("carol.testnet"), U128(1), None);
    }
}
