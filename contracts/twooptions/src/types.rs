//! Data types: persisted state, signed messages, parameters and view structs.
//!
//! Internal state uses plain integers and is borsh-only. Anything that crosses the JSON
//! boundary wraps 64/128-bit integers in `U64`/`U128`/`I128`.

use near_sdk::json_types::{I128, U128, U64};
use near_sdk::{near, AccountId};
use std::fmt;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[allow(clippy::upper_case_acronyms)]
pub enum Underlying {
    BTC,
    ETH,
    SOL,
    NEAR,
}

impl fmt::Display for Underlying {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Underlying::BTC => "BTC",
            Underlying::ETH => "ETH",
            Underlying::SOL => "SOL",
            Underlying::NEAR => "NEAR",
        };
        f.write_str(s)
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Buy,
    Sell,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Call,
    Put,
}

// ---------------------------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------------------------

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Series {
    pub underlying: Underlying,
    /// USD strike scaled by 1e8.
    pub strike: i128,
    pub kind: Kind,
    /// Cumulative funding in USDC micros per contract. Positive means longs pay.
    pub funding_index: i128,
    /// Last agent-attested option price in USDC micros per contract.
    pub last_mark: i128,
    pub last_mark_ts: u64,
    pub last_epoch: u64,
    /// Sum of all traders' signed sizes. The vault holds the opposite side.
    pub net_trader_size: i128,
    pub active: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct PositionEntry {
    pub series: String,
    pub size: i128,
    pub entry_index: i128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct Account {
    /// Cash balance in USDC micros. Only funding can take it below zero (a buy must be paid in
    /// full); an account whose equity is negative can be liquidated.
    pub collateral: i128,
    pub positions: Vec<PositionEntry>,
    /// Highest quote nonce consumed. Quotes must use a strictly larger nonce.
    pub last_nonce: u64,
}

impl Account {
    pub fn is_empty(&self) -> bool {
        self.collateral == 0 && self.positions.is_empty()
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug)]
pub struct SpotPoint {
    /// USD scaled by 1e8.
    pub price: i128,
    pub ts: u64,
    pub seq: u64,
}

/// The last funding mark of a series and the spot it was set at: the anchor for trade prices.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug)]
pub struct MarkRef {
    /// USDC micros per contract.
    pub mark: i128,
    /// USD scaled by 1e8.
    pub spot: i128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug)]
pub struct LpClaim {
    pub amount: u128,
    pub unlock_ns: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Params {
    pub max_quote_ttl_ns: u64,
    pub max_spot_age_ns: u64,
    pub max_positions: u8,
    /// Per-hour funding cap, 1e9-scaled (40_000_000 = 4%).
    pub max_funding_rate: u64,
    pub funding_interval_ns: u64,
    pub liquidation_reward_bps: u32,
    pub insurance_bps: u32,
    pub lp_cooldown_ns: u64,
    /// Shares permanently locked by the first LP deposit.
    pub min_lp_liquidity: u64,
    /// Smallest accepted deposit in USDC micros.
    pub min_deposit: u64,
    /// A new trade must leave equity / requirement at or above this.
    pub initial_ratio_bps: u32,
    /// Below this ratio only risk-reducing trades are allowed.
    pub close_only_ratio_bps: u32,
    /// Below this ratio anyone can liquidate.
    pub liquidation_ratio_bps: u32,
    /// The vault must keep equity / vault requirement at or above this.
    pub vault_ratio_bps: u32,
    /// Quote price must not exceed intrinsic plus this share of spot (bps). Real everlasting
    /// time value is about 0.35% of spot at 60% vol and about 0.9% at 150% vol (hourly funding
    /// period), so 150 leaves room for extreme volatility without inviting mispricing.
    pub max_time_value_bps: u32,
    /// Quote price must not fall below intrinsic minus this share of spot (bps).
    pub min_time_value_bps: u32,
    /// Reserve on each short contract for time value, as a share of spot (bps).
    pub tv_reserve_bps: u32,
    /// Floor on the requirement for each short contract, in USDC micros.
    pub min_margin_per_contract: u64,
    /// Largest accepted move between consecutive spot posts while the previous one is fresh.
    pub max_spot_jump_bps: u32,
    /// A trade's price must be within this share of spot (bps), plus however far spot has moved,
    /// of the series' last funding mark. An option's price moves no more than spot does, so an
    /// honest quote fits; a skewed one does not.
    pub mark_band_bps: u32,
    /// Net cash the vault may pay out to traders within one funding interval, as a share (bps)
    /// of its cash at the start of that interval. Bounds what a misbehaving agent key can drain
    /// before the owner pauses the contract and rotates the key.
    pub max_epoch_outflow_bps: u32,
}

impl Default for Params {
    fn default() -> Self {
        const SEC: u64 = 1_000_000_000;
        Params {
            max_quote_ttl_ns: 10 * SEC,
            max_spot_age_ns: 30 * SEC,
            max_positions: 16,
            max_funding_rate: 40_000_000,
            funding_interval_ns: 3_600 * SEC,
            liquidation_reward_bps: 50,
            insurance_bps: 50,
            lp_cooldown_ns: 3_600 * SEC,
            min_lp_liquidity: 1_000_000,
            min_deposit: 1_000_000,
            initial_ratio_bps: 15_000,
            close_only_ratio_bps: 13_000,
            liquidation_ratio_bps: 11_500,
            vault_ratio_bps: 12_000,
            max_time_value_bps: 150,
            min_time_value_bps: 20,
            tv_reserve_bps: 100,
            min_margin_per_contract: 5_000_000,
            max_spot_jump_bps: 1_000,
            mark_band_bps: 100,
            max_epoch_outflow_bps: 1_000,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Signed messages. Field order and types are part of the wire format (borsh).
// ---------------------------------------------------------------------------------------------

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Quote {
    pub series: String,
    pub taker: AccountId,
    pub side: Side,
    /// Size units, 1e6 per contract.
    pub size: U128,
    /// USDC micros per contract.
    pub price: U128,
    pub nonce: U64,
    pub expiry_ns: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct SpotUpdate {
    pub underlying: Underlying,
    /// USD scaled by 1e8.
    pub price: U128,
    pub ts_ns: U64,
    /// Strictly increasing per underlying.
    pub seq: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct FundingUpdate {
    pub series: String,
    /// floor(timestamp / funding_interval_ns). Strictly increasing per series.
    pub epoch: U64,
    /// Hourly funding as a fraction of mark, 1e9-scaled, signed. Positive means longs pay.
    pub rate: I128,
    /// Mark price in USDC micros per contract.
    pub mark: U128,
}

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PositionView {
    pub series: String,
    pub size: I128,
    pub mark: U128,
    pub value: I128,
    /// The series funding index this position last settled at. Funding owed on the next touch
    /// is `size * (series.funding_index - entry_index) / 1e6`, positive when the trader pays.
    pub entry_index: I128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AccountView {
    pub collateral: I128,
    pub positions: Vec<PositionView>,
    pub last_nonce: U64,
    /// Present when a fresh spot exists for every underlying held.
    pub equity: Option<I128>,
    pub requirement: Option<I128>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SeriesView {
    pub id: String,
    pub underlying: Underlying,
    pub strike: U128,
    pub kind: Kind,
    pub funding_index: I128,
    pub last_mark: U128,
    pub last_epoch: U64,
    pub net_trader_size: I128,
    pub active: bool,
    /// Last funding mark and the spot it was set at; trade prices are anchored to them.
    pub ref_mark: Option<U128>,
    pub ref_spot: Option<U128>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct VaultView {
    pub cash: I128,
    pub total_shares: U128,
    pub pending_claims: U128,
    pub insurance: I128,
    /// Present when a fresh spot exists for every underlying with open interest.
    pub equity: Option<I128>,
    pub requirement: Option<I128>,
    /// The current funding interval and the vault's net cash paid to traders within it.
    pub epoch: U64,
    pub epoch_net_outflow: I128,
    /// Vault cash at the start of the interval; the outflow cap is a share of this.
    pub epoch_start_cash: I128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SolvencyView {
    /// Sum of trader cash, vault cash, insurance and pending LP claims.
    pub ledger_total: I128,
    /// Net USDC ever received minus paid out by this contract.
    pub net_inflow: I128,
}
