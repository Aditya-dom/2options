//! State migrations. Two layouts have been deployed before the current one:
//!
//! - `StateV2`: everything but the index of account ids (`account_ids`).
//! - `OldState` with `OldParams`: before `mark_refs`, the hourly outflow cap and two parameters
//!   (`mark_band_bps`, `max_epoch_outflow_bps`) as well.
//!
//! Each is the deployed layout field for field: borsh reads fields in order, so they must not
//! be edited. Collections keep their storage prefixes, so accounts, series, spots and LP records
//! are untouched; only the root struct is rewritten. The index starts empty: the contract cannot
//! list the accounts it already holds, so they are added afterwards with `index_accounts`.

use crate::types::*;
use crate::*;
use near_sdk::borsh::BorshDeserialize;

/// The layout deployed before the account index.
#[near(serializers = [borsh])]
pub(crate) struct StateV2 {
    pub owner_id: AccountId,
    pub pending_owner: Option<AccountId>,
    pub usdc: AccountId,
    pub paused: bool,
    pub params: Params,
    pub agent_keys: Vec<[u8; 32]>,
    pub accounts: LookupMap<AccountId, Account>,
    pub series: IterableMap<String, Series>,
    pub spot: LookupMap<Underlying, SpotPoint>,
    pub lp_shares: LookupMap<AccountId, u128>,
    pub lp_claims: LookupMap<AccountId, LpClaim>,
    pub total_shares: u128,
    pub locked_shares: u128,
    pub vault_cash: i128,
    pub insurance: i128,
    pub lp_pending_total: i128,
    pub sum_collateral: i128,
    pub net_inflow: i128,
    pub mark_refs: LookupMap<String, MarkRef>,
    pub out_epoch: u64,
    pub epoch_net_out: i128,
    pub epoch_start_cash: i128,
}

/// Read whichever old layout is stored and return the current one. borsh refuses a value with
/// bytes left over, and each layout is longer than the one before, so state is read as exactly
/// one of them, and state that is already current is read as neither.
pub(crate) fn run() -> TwoOptions {
    let bytes = env::storage_read(b"STATE").unwrap_or_else(|| env::panic_str("no state to migrate"));
    if let Ok(v2) = StateV2::try_from_slice(&bytes) {
        return from_v2(v2);
    }
    if let Ok(v1) = OldState::try_from_slice(&bytes) {
        return from_v1(v1);
    }
    env::panic_str("the stored state is not a layout this code migrates from; it may be current already")
}

fn from_v2(old: StateV2) -> TwoOptions {
    TwoOptions {
        owner_id: old.owner_id,
        pending_owner: old.pending_owner,
        usdc: old.usdc,
        paused: old.paused,
        params: old.params,
        agent_keys: old.agent_keys,
        accounts: old.accounts,
        series: old.series,
        spot: old.spot,
        lp_shares: old.lp_shares,
        lp_claims: old.lp_claims,
        total_shares: old.total_shares,
        locked_shares: old.locked_shares,
        vault_cash: old.vault_cash,
        insurance: old.insurance,
        lp_pending_total: old.lp_pending_total,
        sum_collateral: old.sum_collateral,
        net_inflow: old.net_inflow,
        mark_refs: old.mark_refs,
        out_epoch: old.out_epoch,
        epoch_net_out: old.epoch_net_out,
        epoch_start_cash: old.epoch_start_cash,
        account_ids: IterableSet::new(StorageKey::AccountIds),
    }
}

#[near(serializers = [borsh])]
pub(crate) struct OldParams {
    pub max_quote_ttl_ns: u64,
    pub max_spot_age_ns: u64,
    pub max_positions: u8,
    pub max_funding_rate: u64,
    pub funding_interval_ns: u64,
    pub liquidation_reward_bps: u32,
    pub insurance_bps: u32,
    pub lp_cooldown_ns: u64,
    pub min_lp_liquidity: u64,
    pub min_deposit: u64,
    pub initial_ratio_bps: u32,
    pub close_only_ratio_bps: u32,
    pub liquidation_ratio_bps: u32,
    pub vault_ratio_bps: u32,
    pub max_time_value_bps: u32,
    pub min_time_value_bps: u32,
    pub tv_reserve_bps: u32,
    pub min_margin_per_contract: u64,
    pub max_spot_jump_bps: u32,
}

#[near(serializers = [borsh])]
pub(crate) struct OldState {
    pub owner_id: AccountId,
    pub pending_owner: Option<AccountId>,
    pub usdc: AccountId,
    pub paused: bool,
    pub params: OldParams,
    pub agent_keys: Vec<[u8; 32]>,
    pub accounts: LookupMap<AccountId, Account>,
    pub series: IterableMap<String, Series>,
    pub spot: LookupMap<Underlying, SpotPoint>,
    pub lp_shares: LookupMap<AccountId, u128>,
    pub lp_claims: LookupMap<AccountId, LpClaim>,
    pub total_shares: u128,
    pub locked_shares: u128,
    pub vault_cash: i128,
    pub insurance: i128,
    pub lp_pending_total: i128,
    pub sum_collateral: i128,
    pub net_inflow: i128,
}

fn from_v1(old: OldState) -> TwoOptions {
    let p = old.params;
    let defaults = Params::default();
    TwoOptions {
        owner_id: old.owner_id,
        pending_owner: old.pending_owner,
        usdc: old.usdc,
        paused: old.paused,
        params: Params {
            max_quote_ttl_ns: p.max_quote_ttl_ns,
            max_spot_age_ns: p.max_spot_age_ns,
            max_positions: p.max_positions,
            max_funding_rate: p.max_funding_rate,
            funding_interval_ns: p.funding_interval_ns,
            liquidation_reward_bps: p.liquidation_reward_bps,
            insurance_bps: p.insurance_bps,
            lp_cooldown_ns: p.lp_cooldown_ns,
            min_lp_liquidity: p.min_lp_liquidity,
            min_deposit: p.min_deposit,
            initial_ratio_bps: p.initial_ratio_bps,
            close_only_ratio_bps: p.close_only_ratio_bps,
            liquidation_ratio_bps: p.liquidation_ratio_bps,
            vault_ratio_bps: p.vault_ratio_bps,
            max_time_value_bps: p.max_time_value_bps,
            min_time_value_bps: p.min_time_value_bps,
            tv_reserve_bps: p.tv_reserve_bps,
            min_margin_per_contract: p.min_margin_per_contract,
            max_spot_jump_bps: p.max_spot_jump_bps,
            mark_band_bps: defaults.mark_band_bps,
            max_epoch_outflow_bps: defaults.max_epoch_outflow_bps,
        },
        agent_keys: old.agent_keys,
        accounts: old.accounts,
        series: old.series,
        spot: old.spot,
        lp_shares: old.lp_shares,
        lp_claims: old.lp_claims,
        total_shares: old.total_shares,
        locked_shares: old.locked_shares,
        vault_cash: old.vault_cash,
        insurance: old.insurance,
        lp_pending_total: old.lp_pending_total,
        sum_collateral: old.sum_collateral,
        net_inflow: old.net_inflow,
        mark_refs: LookupMap::new(StorageKey::MarkRefs),
        out_epoch: 0,
        epoch_net_out: 0,
        epoch_start_cash: 0,
        account_ids: IterableSet::new(StorageKey::AccountIds),
    }
}
