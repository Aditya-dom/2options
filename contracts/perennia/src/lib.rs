//! Perennia: an everlasting-options vault and settlement contract for NEAR.
//!
//! The contract holds all USDC. Prices come from an off-chain agent that signs quotes, spot
//! updates and funding updates with an ed25519 key registered here. The contract verifies
//! every signature and bounds every number, so a compromised agent can move prices only within
//! the bands defined in `Params`.
//!
//! Safety properties worth keeping in mind when changing this file:
//! - Checks, then effects, then external calls. Withdrawals debit before the transfer promise
//!   and refund in the callback if it fails.
//! - A panic reverts the whole transaction, so any `require!` after a state change is safe.
//! - All money is integer fixed-point with checked arithmetic (see `math.rs`). Rounding always
//!   favours the vault.
//! - `ledger_total() == net_inflow` after every operation (the solvency invariant, tested).

pub mod margin;
pub mod math;
pub mod types;

use margin::*;
use math::*;
use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::{Base64VecU8, I128, U128, U64};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, near, require, serde_json, AccountId, BorshStorageKey, CurveType, Gas, NearToken,
    PanicOnDefault, Promise, PromiseOrValue, PublicKey,
};
use types::*;

const QUOTE_DOMAIN: &[u8] = b"perennia:quote:v1";
const SPOT_DOMAIN: &[u8] = b"perennia:spot:v1";
const FUNDING_DOMAIN: &[u8] = b"perennia:funding:v1";

const MAX_AGENT_KEYS: usize = 4;
const MAX_SERIES: u32 = 32;
/// Largest accepted option price, USDC micros per contract ($1M).
const MAX_PRICE_MICROS: i128 = 1_000_000_000_000;
/// Largest accepted spot, 1e8-scaled USD ($10M).
const MAX_SPOT: i128 = 1_000_000_000_000_000;
/// How far a signed timestamp may run ahead of block time.
const CLOCK_SKEW_NS: u64 = 5_000_000_000;
/// Spot jump limits only apply while the previous post is younger than this.
const JUMP_WINDOW_NS: u64 = 300_000_000_000;

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(30);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Accounts,
    Series,
    Spot,
    LpShares,
    LpClaims,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Perennia {
    owner_id: AccountId,
    pending_owner: Option<AccountId>,
    usdc: AccountId,
    paused: bool,
    params: Params,
    /// Raw ed25519 public keys allowed to sign quotes, spot and funding updates.
    agent_keys: Vec<[u8; 32]>,

    accounts: LookupMap<AccountId, Account>,
    series: IterableMap<String, Series>,
    spot: LookupMap<Underlying, SpotPoint>,

    lp_shares: LookupMap<AccountId, u128>,
    lp_claims: LookupMap<AccountId, LpClaim>,
    total_shares: u128,
    /// Shares permanently locked by the first deposit. Counted in `total_shares`.
    locked_shares: u128,

    /// USDC the vault owns outright, micros. Counterparty cash for every trade.
    vault_cash: i128,
    insurance: i128,
    /// Redeemed LP value waiting out the cooldown, micros.
    lp_pending_total: i128,
    /// Sum of every trader's cash balance, kept in step with each account.
    sum_collateral: i128,
    /// USDC ever received minus USDC ever sent out, micros.
    net_inflow: i128,
}

#[near]
impl Perennia {
    #[init]
    pub fn new(owner_id: AccountId, usdc: AccountId, agent_keys: Vec<PublicKey>) -> Self {
        let mut this = Self {
            owner_id,
            pending_owner: None,
            usdc,
            paused: false,
            params: Params::default(),
            agent_keys: Vec::new(),
            accounts: LookupMap::new(StorageKey::Accounts),
            series: IterableMap::new(StorageKey::Series),
            spot: LookupMap::new(StorageKey::Spot),
            lp_shares: LookupMap::new(StorageKey::LpShares),
            lp_claims: LookupMap::new(StorageKey::LpClaims),
            total_shares: 0,
            locked_shares: 0,
            vault_cash: 0,
            insurance: 0,
            lp_pending_total: 0,
            sum_collateral: 0,
            net_inflow: 0,
        };
        this.agent_keys = Self::parse_keys(agent_keys);
        this
    }

    // -----------------------------------------------------------------------------------------
    // Funds in: NEP-141 receiver
    // -----------------------------------------------------------------------------------------

    /// Called by the USDC contract after `ft_transfer_call`. `msg` is `deposit` for trader
    /// collateral or `lp` to mint vault shares. A panic here makes the token contract refund
    /// the sender in full.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.usdc, "only USDC can call this");
        require!(!self.paused, "deposits are paused");
        require!(amount.0 >= self.params.min_deposit as u128, "deposit below minimum");
        let amt = to_i128(amount.0);

        match msg.as_str() {
            "deposit" => {
                let mut acct = self.accounts.get(&sender_id).cloned().unwrap_or_default();
                self.change_collateral(&mut acct, amt);
                self.accounts.insert(sender_id.clone(), acct);
                self.net_inflow = add(self.net_inflow, amt);
                emit("Deposit", serde_json::json!({"account": sender_id, "amount": amount}));
            }
            "lp" => {
                let shares = self.shares_for_deposit(amt);
                self.vault_cash = add(self.vault_cash, amt);
                self.net_inflow = add(self.net_inflow, amt);
                self.total_shares = self
                    .total_shares
                    .checked_add(shares)
                    .unwrap_or_else(|| env::panic_str("math overflow"));
                let held = self.lp_shares.get(&sender_id).copied().unwrap_or(0);
                self.lp_shares.insert(sender_id.clone(), held + shares);
                emit(
                    "LpMint",
                    serde_json::json!({"account": sender_id, "amount": amount, "shares": U128(shares)}),
                );
            }
            _ => env::panic_str("msg must be `deposit` or `lp`"),
        }
        PromiseOrValue::Value(U128(0))
    }

    // -----------------------------------------------------------------------------------------
    // Funds out
    // -----------------------------------------------------------------------------------------

    /// Withdraw free collateral to the caller. Funds can only go to the caller's own account.
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        let account_id = env::predecessor_account_id();
        let amt = to_i128(amount.0);
        require!(amt > 0, "amount must be positive");
        // Circuit breaker: no cash leaves while the books show a shortfall.
        require!(
            add(self.vault_cash, self.insurance) >= 0,
            "system is under-collateralized, withdrawals are halted"
        );

        let mut acct = self.accounts.get(&account_id).cloned().expect("no account");
        self.apply_funding(&mut acct);
        require!(acct.collateral >= amt, "insufficient collateral");
        acct.collateral = sub(acct.collateral, amt);
        self.sum_collateral = sub(self.sum_collateral, amt);

        if !acct.positions.is_empty() {
            let (equity, req) = self.account_risk(&acct).expect("spot price is stale");
            require!(
                mul(equity, BPS) >= mul(req, self.params.initial_ratio_bps as i128),
                "withdrawal would leave the account under-margined"
            );
        } else {
            require!(acct.collateral >= 0, "account owes funding, cannot withdraw");
        }
        self.net_inflow = sub(self.net_inflow, amt);
        self.save_account(&account_id, acct);
        emit("Withdraw", serde_json::json!({"account": account_id, "amount": amount}));

        self.send_usdc(&account_id, amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .on_withdraw(account_id, amount),
        )
    }

    #[private]
    pub fn on_withdraw(&mut self, account_id: AccountId, amount: U128) {
        if env::promise_result_checked(0, 1024).is_ok() {
            return;
        }
        // The transfer failed (for example the receiver is not registered with USDC): give the
        // money back as collateral.
        let amt = to_i128(amount.0);
        let mut acct = self.accounts.get(&account_id).cloned().unwrap_or_default();
        self.change_collateral(&mut acct, amt);
        self.net_inflow = add(self.net_inflow, amt);
        self.accounts.insert(account_id.clone(), acct);
        emit("WithdrawRefunded", serde_json::json!({"account": account_id, "amount": amount}));
    }

    // -----------------------------------------------------------------------------------------
    // LP vault
    // -----------------------------------------------------------------------------------------

    /// Burn shares for a claim at the current share price. The claim pays out after the
    /// cooldown. Reverts if the vault would be left too thin for its open risk.
    pub fn lp_request_redeem(&mut self, shares: U128) {
        let holder = env::predecessor_account_id();
        let held = self.lp_shares.get(&holder).copied().unwrap_or(0);
        require!(shares.0 > 0 && shares.0 <= held, "invalid share amount");
        require!(
            self.total_shares - shares.0 >= self.locked_shares,
            "cannot redeem the locked liquidity"
        );

        let (equity, req) = self.vault_risk().expect("spot price is stale");
        require!(equity > 0, "vault has no equity");
        let amount = mul_div_floor(to_i128(shares.0), equity, to_i128(self.total_shares));
        require!(amount > 0, "redeem amount rounds to zero");
        require!(amount <= self.vault_cash, "vault has insufficient free cash");
        let equity_after = sub(equity, amount);
        require!(
            mul(equity_after, BPS) >= mul(req, self.params.vault_ratio_bps as i128),
            "redeeming would leave the vault under-margined"
        );

        if held == shares.0 {
            self.lp_shares.remove(&holder);
        } else {
            self.lp_shares.insert(holder.clone(), held - shares.0);
        }
        self.total_shares -= shares.0;
        self.vault_cash = sub(self.vault_cash, amount);
        self.lp_pending_total = add(self.lp_pending_total, amount);

        let unlock = env::block_timestamp().saturating_add(self.params.lp_cooldown_ns);
        let prior = self.lp_claims.get(&holder).copied().unwrap_or(LpClaim { amount: 0, unlock_ns: 0 });
        self.lp_claims.insert(
            holder.clone(),
            LpClaim { amount: prior.amount + amount as u128, unlock_ns: unlock },
        );
        emit(
            "LpRedeemRequest",
            serde_json::json!({"account": holder, "shares": shares, "amount": U128(amount as u128)}),
        );
    }

    /// Pay out a matured redeem claim.
    pub fn lp_claim(&mut self) -> Promise {
        let holder = env::predecessor_account_id();
        let claim = self.lp_claims.get(&holder).copied().expect("no claim");
        require!(env::block_timestamp() >= claim.unlock_ns, "claim is still in cooldown");
        require!(
            add(self.vault_cash, self.insurance) >= 0,
            "system is under-collateralized, withdrawals are halted"
        );
        self.lp_claims.remove(&holder);
        let amt = to_i128(claim.amount);
        self.lp_pending_total = sub(self.lp_pending_total, amt);
        self.net_inflow = sub(self.net_inflow, amt);
        emit("LpClaim", serde_json::json!({"account": holder, "amount": U128(claim.amount)}));
        self.send_usdc(&holder, U128(claim.amount)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .on_lp_claim(holder, U128(claim.amount)),
        )
    }

    #[private]
    pub fn on_lp_claim(&mut self, account_id: AccountId, amount: U128) {
        if env::promise_result_checked(0, 1024).is_ok() {
            return;
        }
        let amt = to_i128(amount.0);
        self.lp_pending_total = add(self.lp_pending_total, amt);
        self.net_inflow = add(self.net_inflow, amt);
        let prior = self
            .lp_claims
            .get(&account_id)
            .copied()
            .unwrap_or(LpClaim { amount: 0, unlock_ns: 0 });
        self.lp_claims.insert(
            account_id.clone(),
            LpClaim { amount: prior.amount + amount.0, unlock_ns: env::block_timestamp() },
        );
        emit("LpClaimRefunded", serde_json::json!({"account": account_id, "amount": amount}));
    }

    // -----------------------------------------------------------------------------------------
    // Trading
    // -----------------------------------------------------------------------------------------

    /// Execute an agent-signed quote. The caller must be the quote's taker.
    pub fn trade(&mut self, quote: Quote, signature: Base64VecU8) {
        require!(!self.paused, "trading is paused");
        let taker = env::predecessor_account_id();
        require!(taker == quote.taker, "quote is for a different taker");
        let now = env::block_timestamp();
        require!(now <= quote.expiry_ns.0, "quote expired");
        require!(
            quote.expiry_ns.0 - now <= self.params.max_quote_ttl_ns,
            "quote expiry is too far in the future"
        );
        self.verify_agent_signature(QUOTE_DOMAIN, &quote, &signature.0);

        require!(
            quote.size.0 >= MIN_TRADE_SIZE as u128 && quote.size.0 <= MAX_POSITION_SIZE as u128,
            "size out of range"
        );
        require!(quote.price.0 <= MAX_PRICE_MICROS as u128, "price out of range");
        let size = quote.size.0 as i128;
        let price = quote.price.0 as i128;

        let series = self.series.get(&quote.series).cloned().expect("unknown series");
        require!(series.active, "series is not active");
        let spot = self.spot_or_panic(series.underlying);
        let (lo, hi) = price_band(series.kind, spot, series.strike, &self.params);
        require!(price >= lo && price <= hi, "price is outside the allowed band");

        let mut acct = self.accounts.get(&taker).cloned().expect("deposit first");
        require!(quote.nonce.0 > acct.last_nonce, "nonce already used");
        acct.last_nonce = quote.nonce.0;

        // Risk before the trade, measured after pending funding is settled.
        let vault_before = self.vault_risk().expect("spot price is stale");
        self.apply_funding(&mut acct);
        let (_, req_before) = self.account_risk(&acct).expect("spot price is stale");

        // Cash leg. Round against the trader.
        let delta = if quote.side == Side::Buy { size } else { -size };
        let cash = if quote.side == Side::Buy {
            mul_div_ceil(price, size, SIZE_SCALE)
        } else {
            mul_div_floor(price, size, SIZE_SCALE)
        };
        let trader_cash_change = if quote.side == Side::Buy { -cash } else { cash };
        self.change_collateral(&mut acct, trader_cash_change);
        self.vault_cash = sub(self.vault_cash, trader_cash_change);
        require!(self.vault_cash >= 0, "vault cannot fund this trade");

        // Position leg.
        let idx = acct.positions.iter().position(|p| p.series == quote.series);
        let old = idx.map(|i| acct.positions[i].size).unwrap_or(0);
        let new_size = add(old, delta);
        require!(new_size.abs() <= MAX_POSITION_SIZE, "position too large");
        match (idx, new_size) {
            (Some(i), 0) => {
                acct.positions.swap_remove(i);
            }
            (Some(i), n) => acct.positions[i].size = n,
            (None, n) => {
                require!(
                    acct.positions.len() < self.params.max_positions as usize,
                    "too many open series"
                );
                acct.positions.push(PositionEntry {
                    series: quote.series.clone(),
                    size: n,
                    entry_index: series.funding_index,
                });
            }
        }
        let s = self.series.get_mut(&quote.series).unwrap();
        s.net_trader_size = add(s.net_trader_size, delta);
        // Marks only ratchet up here. A higher mark can only raise what shorts owe, so a trade
        // can never flatter the vault's or a trader's equity. The next funding update resets it.
        if quote.side == Side::Buy && price > s.last_mark {
            s.last_mark = price;
            s.last_mark_ts = now;
        }

        // Risk after the trade.
        let (equity, req_after) = self.account_risk(&acct).expect("spot price is stale");
        if req_after > req_before {
            require!(
                mul(equity, BPS) >= mul(req_after, self.params.initial_ratio_bps as i128),
                "insufficient margin for this trade"
            );
        }
        if acct.positions.is_empty() {
            require!(acct.collateral >= 0, "trade would leave a negative balance");
        }
        let (v_equity, v_req) = self.vault_risk().expect("spot price is stale");
        if v_req > vault_before.1 {
            require!(
                mul(v_equity, BPS) >= mul(v_req, self.params.vault_ratio_bps as i128),
                "vault risk limit reached"
            );
        }

        self.save_account(&taker, acct);
        emit(
            "Trade",
            serde_json::json!({
                "taker": taker, "series": quote.series, "side": quote.side,
                "size": quote.size, "price": quote.price, "nonce": quote.nonce,
            }),
        );
    }

    // -----------------------------------------------------------------------------------------
    // Keeper methods. Anyone may relay a signed update.
    // -----------------------------------------------------------------------------------------

    pub fn post_spot(&mut self, update: SpotUpdate, signature: Base64VecU8) {
        self.verify_agent_signature(SPOT_DOMAIN, &update, &signature.0);
        let now = env::block_timestamp();
        let ts = update.ts_ns.0;
        require!(ts <= now.saturating_add(CLOCK_SKEW_NS), "timestamp is in the future");
        require!(now.saturating_sub(ts) <= self.params.max_spot_age_ns, "spot update is stale");
        require!(update.price.0 > 0 && update.price.0 as i128 <= MAX_SPOT, "price out of range");
        let price = update.price.0 as i128;

        if let Some(prev) = self.spot.get(&update.underlying) {
            require!(update.seq.0 > prev.seq, "sequence must increase");
            require!(ts >= prev.ts, "timestamp must not go backwards");
            if now.saturating_sub(prev.ts) <= JUMP_WINDOW_NS {
                let diff = (price - prev.price).abs();
                require!(
                    mul(diff, BPS) <= mul(prev.price, self.params.max_spot_jump_bps as i128),
                    "spot moved too far since the last update"
                );
            }
        }
        self.spot.insert(update.underlying, SpotPoint { price, ts, seq: update.seq.0 });
        emit(
            "SpotUpdated",
            serde_json::json!({"underlying": update.underlying, "price": update.price, "ts": update.ts_ns}),
        );
    }

    pub fn settle_funding(&mut self, update: FundingUpdate, signature: Base64VecU8) {
        self.verify_agent_signature(FUNDING_DOMAIN, &update, &signature.0);
        let now = env::block_timestamp();
        let now_epoch = now / self.params.funding_interval_ns;
        let epoch = update.epoch.0;
        require!(epoch <= now_epoch && epoch + 1 >= now_epoch, "epoch is not current");

        let series = self.series.get(&update.series).cloned().expect("unknown series");
        require!(epoch > series.last_epoch, "epoch already settled");
        let spot = self.spot_or_panic(series.underlying);
        require!(update.mark.0 <= MAX_PRICE_MICROS as u128, "mark out of range");
        let mark = update.mark.0 as i128;
        let (lo, hi) = price_band(series.kind, spot, series.strike, &self.params);
        require!(mark >= lo && mark <= hi, "mark is outside the allowed band");

        let cap = self.params.max_funding_rate as i128;
        let rate = update.rate.0.clamp(-cap, cap);
        // Per-contract funding for this epoch, in USDC micros.
        let per_contract = mul_div_floor(rate, mark, FUNDING_SCALE);

        let s = self.series.get_mut(&update.series).unwrap();
        s.funding_index = add(s.funding_index, per_contract);
        s.last_mark = mark;
        s.last_mark_ts = now;
        s.last_epoch = epoch;
        emit(
            "FundingSettled",
            serde_json::json!({
                "series": update.series, "epoch": update.epoch, "rate": I128(rate),
                "mark": update.mark, "index": I128(s.funding_index),
            }),
        );
    }

    /// Close every position of an account that has fallen below the liquidation ratio. The caller
    /// needs an account (any deposit) to receive the reward.
    pub fn liquidate(&mut self, account_id: AccountId) {
        let liquidator_id = env::predecessor_account_id();
        // Two clones of one account would overwrite each other when saved.
        require!(liquidator_id != account_id, "cannot liquidate your own account");
        let mut liquidator = self
            .accounts
            .get(&liquidator_id)
            .cloned()
            .expect("liquidator needs an account to receive the reward");
        let mut victim = self.accounts.get(&account_id).cloned().expect("no such account");
        require!(!victim.positions.is_empty(), "account has no positions");

        self.apply_funding(&mut victim);
        let (equity, req) = self.account_risk(&victim).expect("spot price is stale");
        require!(
            req > 0 && mul(equity, BPS) < mul(req, self.params.liquidation_ratio_bps as i128),
            "account is not liquidatable"
        );

        // Close everything at the liability mark (a fair mid between asset and liability value).
        let mut value: i128 = 0;
        let mut notional: i128 = 0;
        for pos in &victim.positions {
            let s = self.series.get(&pos.series).cloned().expect("series missing");
            let spot = self.spot_or_panic(s.underlying);
            let mark = liability_mark(s.kind, spot, s.strike, s.last_mark, &self.params);
            value = add(value, position_value(pos.size, mark));
            notional = add(notional, mul_div_ceil(pos.size.abs(), spot_usdc(spot), SIZE_SCALE));
            let sm = self.series.get_mut(&pos.series).unwrap();
            sm.net_trader_size = sub(sm.net_trader_size, pos.size);
        }
        victim.positions.clear();

        let settle = add(victim.collateral, value);
        // The trader's cash balance is rebuilt below; take the old one out of the running sum.
        self.sum_collateral = sub(self.sum_collateral, victim.collateral);
        let mut reward = 0;
        let mut shortfall = 0;
        if settle >= 0 {
            reward = mul_div_floor(notional, self.params.liquidation_reward_bps as i128, BPS).min(settle);
            let ins = mul_div_floor(notional, self.params.insurance_bps as i128, BPS).min(settle - reward);
            victim.collateral = settle - reward - ins;
            self.vault_cash = sub(self.vault_cash, value);
            self.insurance = add(self.insurance, ins);
            self.change_collateral(&mut liquidator, reward);
        } else {
            // Underwater: the trader's cash goes to the vault, insurance covers what it can.
            shortfall = -settle;
            let draw = shortfall.min(self.insurance.max(0));
            self.insurance = sub(self.insurance, draw);
            self.vault_cash = add(self.vault_cash, add(victim.collateral, draw));
            victim.collateral = 0;
        }
        self.sum_collateral = add(self.sum_collateral, victim.collateral);

        self.save_account(&account_id, victim);
        self.save_account(&liquidator_id, liquidator);
        emit(
            "Liquidation",
            serde_json::json!({
                "account": account_id, "liquidator": liquidator_id,
                "notional": U128(notional as u128), "reward": U128(reward as u128),
                "shortfall": U128(shortfall as u128),
            }),
        );
    }

    // -----------------------------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------------------------

    pub fn add_series(&mut self, underlying: Underlying, strike: U128, kind: Kind) -> String {
        self.assert_owner();
        let k = strike.0 as i128;
        require!(k > 0 && k <= MAX_SPOT, "strike out of range");
        require!(k % 100_000_000 == 0, "strike must be a whole USD amount");
        require!(self.series.len() < MAX_SERIES, "series limit reached");
        let id = series_id(underlying, k, kind);
        require!(self.series.get(&id).is_none(), "series already exists");
        self.series.insert(
            id.clone(),
            Series {
                underlying,
                strike: k,
                kind,
                funding_index: 0,
                last_mark: 0,
                last_mark_ts: 0,
                last_epoch: 0,
                net_trader_size: 0,
                active: true,
            },
        );
        emit("SeriesAdded", serde_json::json!({"series": id}));
        id
    }

    /// Deactivating a series blocks new trades in it. Existing positions keep accruing funding
    /// and can still be liquidated.
    pub fn set_series_active(&mut self, series: String, active: bool) {
        self.assert_owner();
        self.series.get_mut(&series).expect("unknown series").active = active;
    }

    pub fn set_agent_keys(&mut self, keys: Vec<PublicKey>) {
        self.assert_owner();
        self.agent_keys = Self::parse_keys(keys);
        emit("AgentKeysSet", serde_json::json!({"count": self.agent_keys.len()}));
    }

    pub fn set_params(&mut self, params: Params) {
        self.assert_owner();
        Self::validate_params(&params);
        self.params = params;
    }

    /// Blocks deposits and trading. Withdrawals, claims and liquidations stay open.
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        emit("Paused", serde_json::json!({"paused": paused}));
    }

    pub fn propose_owner(&mut self, new_owner: AccountId) {
        self.assert_owner();
        self.pending_owner = Some(new_owner);
    }

    pub fn accept_owner(&mut self) {
        let caller = env::predecessor_account_id();
        require!(self.pending_owner.as_ref() == Some(&caller), "not the pending owner");
        self.owner_id = caller;
        self.pending_owner = None;
    }

    // -----------------------------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------------------------

    pub fn get_account(&self, account_id: AccountId) -> Option<AccountView> {
        let acct = self.accounts.get(&account_id)?;
        let risk = self.account_risk(acct);
        let positions = acct
            .positions
            .iter()
            .map(|p| {
                let s = self.series.get(&p.series).unwrap();
                let (mark, value) = match self.try_spot(s.underlying) {
                    Some(spot) => {
                        let v = leg_value(s.kind, spot, s.strike, s.last_mark, p.size, &self.params);
                        (s.last_mark, v)
                    }
                    None => (s.last_mark, 0),
                };
                PositionView {
                    series: p.series.clone(),
                    size: I128(p.size),
                    mark: U128(mark as u128),
                    value: I128(value),
                    entry_index: I128(p.entry_index),
                }
            })
            .collect();
        Some(AccountView {
            collateral: I128(acct.collateral),
            positions,
            last_nonce: U64(acct.last_nonce),
            equity: risk.map(|r| I128(r.0)),
            requirement: risk.map(|r| I128(r.1)),
        })
    }

    pub fn get_series(&self, series: String) -> Option<SeriesView> {
        self.series.get(&series).map(|s| series_view(&series, s))
    }

    pub fn list_series(&self) -> Vec<SeriesView> {
        self.series.iter().map(|(id, s)| series_view(id, s)).collect()
    }

    pub fn get_vault(&self) -> VaultView {
        let risk = self.vault_risk();
        VaultView {
            cash: I128(self.vault_cash),
            total_shares: U128(self.total_shares),
            pending_claims: U128(self.lp_pending_total as u128),
            insurance: I128(self.insurance),
            equity: risk.map(|r| I128(r.0)),
            requirement: risk.map(|r| I128(r.1)),
        }
    }

    pub fn get_lp_shares(&self, account_id: AccountId) -> U128 {
        U128(self.lp_shares.get(&account_id).copied().unwrap_or(0))
    }

    pub fn get_lp_claim(&self, account_id: AccountId) -> Option<(U128, U64)> {
        self.lp_claims.get(&account_id).map(|c| (U128(c.amount), U64(c.unlock_ns)))
    }

    pub fn get_params(&self) -> Params {
        self.params.clone()
    }

    pub fn get_spot(&self, underlying: Underlying) -> Option<(U128, U64)> {
        self.spot.get(&underlying).map(|s| (U128(s.price as u128), U64(s.ts)))
    }

    pub fn get_solvency(&self) -> SolvencyView {
        SolvencyView { ledger_total: I128(self.ledger_total()), net_inflow: I128(self.net_inflow) }
    }

    pub fn is_agent_key(&self, key: PublicKey) -> bool {
        Self::raw_key(&key).map(|k| self.agent_keys.contains(&k)).unwrap_or(false)
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }
}

// ---------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------

impl Perennia {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
    }

    fn raw_key(key: &PublicKey) -> Option<[u8; 32]> {
        if key.curve_type() != CurveType::ED25519 {
            return None;
        }
        key.as_bytes().get(1..).and_then(|b| b.try_into().ok())
    }

    fn parse_keys(keys: Vec<PublicKey>) -> Vec<[u8; 32]> {
        require!(keys.len() <= MAX_AGENT_KEYS, "too many agent keys");
        keys.iter()
            .map(|k| Self::raw_key(k).unwrap_or_else(|| env::panic_str("agent keys must be ed25519")))
            .collect()
    }

    fn validate_params(p: &Params) {
        const SEC: u64 = 1_000_000_000;
        require!(p.max_quote_ttl_ns > 0 && p.max_quote_ttl_ns <= 60 * SEC, "bad quote ttl");
        require!(p.max_spot_age_ns > 0 && p.max_spot_age_ns <= 120 * SEC, "bad spot age");
        require!(p.max_positions >= 1 && p.max_positions <= 32, "bad position cap");
        require!(p.max_funding_rate <= 100_000_000, "funding cap above 10%");
        require!(p.funding_interval_ns >= 60 * SEC, "funding interval too short");
        require!(
            p.liquidation_ratio_bps >= 10_000
                && p.liquidation_ratio_bps < p.close_only_ratio_bps
                && p.close_only_ratio_bps < p.initial_ratio_bps,
            "ratios must satisfy 1.0 <= liquidation < close-only < initial"
        );
        require!(p.vault_ratio_bps >= 10_000, "vault ratio below 1.0");
        require!(p.liquidation_reward_bps + p.insurance_bps <= 1_000, "liquidation fees too high");
        require!(p.max_time_value_bps <= 10_000 && p.min_time_value_bps <= 10_000, "bad band");
        require!(p.tv_reserve_bps <= 10_000, "bad reserve");
        require!(p.max_spot_jump_bps >= 100 && p.max_spot_jump_bps <= 5_000, "bad jump limit");
        require!(p.min_deposit >= 1, "min deposit must be positive");
        require!(p.min_lp_liquidity >= 1, "min lp liquidity must be positive");
    }

    fn verify_agent_signature<T: BorshSerialize>(&self, domain: &[u8], msg: &T, signature: &[u8]) {
        let sig: [u8; 64] = signature
            .try_into()
            .unwrap_or_else(|_| env::panic_str("signature must be 64 bytes"));
        let me = env::current_account_id();
        let mut bytes = domain.to_vec();
        bytes.extend_from_slice(&(me.as_str().len() as u32).to_le_bytes());
        bytes.extend_from_slice(me.as_bytes());
        bytes.extend(near_sdk::borsh::to_vec(msg).unwrap_or_else(|_| env::panic_str("encode failed")));
        let digest = env::sha256(&bytes);
        require!(
            self.agent_keys.iter().any(|k| env::ed25519_verify(&sig, &digest, k)),
            "invalid agent signature"
        );
    }

    fn send_usdc(&self, receiver: &AccountId, amount: U128) -> Promise {
        Promise::new(self.usdc.clone()).function_call(
            "ft_transfer".to_string(),
            serde_json::json!({"receiver_id": receiver, "amount": amount}).to_string().into_bytes(),
            NearToken::from_yoctonear(1),
            GAS_FT_TRANSFER,
        )
    }

    fn change_collateral(&mut self, acct: &mut Account, delta: i128) {
        acct.collateral = add(acct.collateral, delta);
        self.sum_collateral = add(self.sum_collateral, delta);
    }

    fn save_account(&mut self, id: &AccountId, acct: Account) {
        if acct.is_empty() {
            self.accounts.remove(id);
        } else {
            self.accounts.insert(id.clone(), acct);
        }
    }

    fn ledger_total(&self) -> i128 {
        self.sum_collateral + self.vault_cash + self.insurance + self.lp_pending_total
    }

    fn try_spot(&self, u: Underlying) -> Option<i128> {
        let sp = self.spot.get(&u)?;
        let now = env::block_timestamp();
        if sp.ts > now.saturating_add(CLOCK_SKEW_NS) || now.saturating_sub(sp.ts) > self.params.max_spot_age_ns {
            return None;
        }
        Some(sp.price)
    }

    fn spot_or_panic(&self, u: Underlying) -> i128 {
        self.try_spot(u).unwrap_or_else(|| env::panic_str("spot price is stale"))
    }

    /// Settle funding accrued since each position's entry index. Positive means the trader pays.
    fn apply_funding(&mut self, acct: &mut Account) {
        let mut payment: i128 = 0;
        for pos in acct.positions.iter_mut() {
            let s = self.series.get(&pos.series).expect("series missing");
            let diff = sub(s.funding_index, pos.entry_index);
            if diff != 0 {
                payment = add(payment, mul_div_ceil(pos.size, diff, SIZE_SCALE));
                pos.entry_index = s.funding_index;
            }
        }
        if payment != 0 {
            self.change_collateral(acct, -payment);
            self.vault_cash = add(self.vault_cash, payment);
            emit("FundingApplied", serde_json::json!({"amount": I128(payment)}));
        }
    }

    /// Equity and requirement for an account. `None` when a needed spot is missing or stale.
    fn account_risk(&self, acct: &Account) -> Option<(i128, i128)> {
        let mut spots: Vec<(Underlying, i128)> = Vec::new();
        let mut legs: Vec<Leg> = Vec::new();
        let mut equity = acct.collateral;
        for pos in &acct.positions {
            let s = self.series.get(&pos.series)?;
            let spot = match spots.iter().find(|(u, _)| *u == s.underlying) {
                Some((_, p)) => *p,
                None => {
                    let p = self.try_spot(s.underlying)?;
                    spots.push((s.underlying, p));
                    p
                }
            };
            equity = add(equity, leg_value(s.kind, spot, s.strike, s.last_mark, pos.size, &self.params));
            legs.push(Leg { underlying: s.underlying, kind: s.kind, strike: s.strike, size: pos.size });
        }
        let spot_of = |u: Underlying| spots.iter().find(|(x, _)| *x == u).map(|x| x.1).unwrap_or(0);
        Some((equity, requirement(&legs, &spot_of, &self.params)))
    }

    /// Equity and requirement for the vault, which holds the opposite side of every trader.
    fn vault_risk(&self) -> Option<(i128, i128)> {
        let mut spots: Vec<(Underlying, i128)> = Vec::new();
        let mut legs: Vec<Leg> = Vec::new();
        let mut equity = self.vault_cash;
        for (_, s) in self.series.iter() {
            if s.net_trader_size == 0 {
                continue;
            }
            let spot = match spots.iter().find(|(u, _)| *u == s.underlying) {
                Some((_, p)) => *p,
                None => {
                    let p = self.try_spot(s.underlying)?;
                    spots.push((s.underlying, p));
                    p
                }
            };
            let vault_size = -s.net_trader_size;
            equity = add(equity, leg_value(s.kind, spot, s.strike, s.last_mark, vault_size, &self.params));
            legs.push(Leg { underlying: s.underlying, kind: s.kind, strike: s.strike, size: vault_size });
        }
        let spot_of = |u: Underlying| spots.iter().find(|(x, _)| *x == u).map(|x| x.1).unwrap_or(0);
        Some((equity, requirement(&legs, &spot_of, &self.params)))
    }

    /// Shares minted for an LP deposit of `amount` micros at the current share price.
    fn shares_for_deposit(&mut self, amount: i128) -> u128 {
        if self.total_shares == 0 {
            let locked = self.params.min_lp_liquidity as u128;
            require!(amount as u128 > locked, "first deposit must exceed the locked liquidity");
            self.locked_shares = locked;
            self.total_shares = locked;
            return amount as u128 - locked;
        }
        let (equity, _) = self.vault_risk().expect("spot price is stale");
        require!(equity > 0, "vault has no equity, deposits are closed");
        let shares = mul_div_floor(amount, to_i128(self.total_shares), equity);
        require!(shares > 0, "deposit rounds to zero shares");
        shares as u128
    }
}

fn to_i128(x: u128) -> i128 {
    i128::try_from(x).unwrap_or_else(|_| env::panic_str("amount too large"))
}

fn series_id(underlying: Underlying, strike: i128, kind: Kind) -> String {
    let letter = if kind == Kind::Call { "C" } else { "P" };
    format!("{}-{}-{}", underlying, strike / 100_000_000, letter)
}

fn series_view(id: &str, s: &Series) -> SeriesView {
    SeriesView {
        id: id.to_string(),
        underlying: s.underlying,
        strike: U128(s.strike as u128),
        kind: s.kind,
        funding_index: I128(s.funding_index),
        last_mark: U128(s.last_mark as u128),
        last_epoch: U64(s.last_epoch),
        net_trader_size: I128(s.net_trader_size),
        active: s.active,
    }
}

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        serde_json::json!({"standard": "perennia", "version": "1.0.0", "event": event, "data": [data]})
    ));
}

#[cfg(test)]
mod tests;
