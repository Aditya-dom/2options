use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult};

const SEC: u64 = 1_000_000_000;
const T0: u64 = 10_000 * 3_600 * SEC; // start of a funding epoch
const USD: i128 = 100_000_000; // 1e8 price scale
const USDC: u128 = 1_000_000;
const ONE: u128 = 1_000_000; // one contract in size units

fn acct(name: &str) -> AccountId {
    name.parse().unwrap()
}

struct Harness {
    c: TwoOptions,
    agent: SigningKey,
    now: u64,
    nonce: u64,
    seq: u64,
}

fn ctx(predecessor: &str, now: u64) -> near_sdk::VMContext {
    VMContextBuilder::new()
        .current_account_id(acct("twooptions.near"))
        .predecessor_account_id(acct(predecessor))
        .signer_account_id(acct(predecessor))
        .block_timestamp(now)
        .build()
}

impl Harness {
    fn new() -> Self {
        let agent = SigningKey::from_bytes(&[7u8; 32]);
        let pk = PublicKey::from_parts(CurveType::ED25519, agent.verifying_key().to_bytes().to_vec()).unwrap();
        testing_env!(ctx("owner.near", T0));
        let mut c = TwoOptions::new(acct("owner.near"), acct("usdc.near"), vec![pk]);
        c.add_series(Underlying::ETH, U128(3_500 * USD as u128), Kind::Call);
        c.add_series(Underlying::ETH, U128(3_500 * USD as u128), Kind::Put);
        c.add_series(Underlying::ETH, U128(4_000 * USD as u128), Kind::Call);
        Harness { c, agent, now: T0, nonce: 0, seq: 0 }
    }

    fn as_user(&self, who: &str) {
        testing_env!(ctx(who, self.now));
    }

    fn advance(&mut self, secs: u64) {
        self.now += secs * SEC;
    }

    fn digest<T: BorshSerialize>(&self, domain: &[u8], msg: &T) -> Vec<u8> {
        let me = "twooptions.near";
        let mut bytes = domain.to_vec();
        bytes.extend_from_slice(&(me.len() as u32).to_le_bytes());
        bytes.extend_from_slice(me.as_bytes());
        bytes.extend(near_sdk::borsh::to_vec(msg).unwrap());
        env::sha256(&bytes)
    }

    fn sign<T: BorshSerialize>(&self, key: &SigningKey, domain: &[u8], msg: &T) -> Base64VecU8 {
        Base64VecU8(key.sign(&self.digest(domain, msg)).to_bytes().to_vec())
    }

    fn deposit(&mut self, who: &str, usdc: u128) {
        testing_env!(ctx("usdc.near", self.now));
        let _ = self.c.ft_on_transfer(acct(who), U128(usdc * USDC), "deposit".into());
    }

    fn lp(&mut self, who: &str, usdc: u128) {
        testing_env!(ctx("usdc.near", self.now));
        let _ = self.c.ft_on_transfer(acct(who), U128(usdc * USDC), "lp".into());
    }

    fn spot(&mut self, price_usd: i128) {
        self.seq += 1;
        let update = SpotUpdate {
            underlying: Underlying::ETH,
            price: U128((price_usd * USD) as u128),
            ts_ns: U64(self.now),
            seq: U64(self.seq),
        };
        let sig = self.sign(&self.agent, SPOT_DOMAIN, &update);
        testing_env!(ctx("keeper.near", self.now));
        self.c.post_spot(update, sig);
    }

    fn quote(&mut self, who: &str, series: &str, side: Side, contracts: f64, price_usd: f64) -> (Quote, Base64VecU8) {
        self.nonce += 1;
        let q = Quote {
            series: series.into(),
            taker: acct(who),
            side,
            size: U128((contracts * ONE as f64) as u128),
            price: U128((price_usd * USDC as f64) as u128),
            nonce: U64(self.nonce),
            expiry_ns: U64(self.now + 5 * SEC),
        };
        let sig = self.sign(&self.agent, QUOTE_DOMAIN, &q);
        (q, sig)
    }

    fn trade(&mut self, who: &str, series: &str, side: Side, contracts: f64, price_usd: f64) {
        let (q, sig) = self.quote(who, series, side, contracts, price_usd);
        self.as_user(who);
        self.c.trade(q, sig);
    }

    fn funding(&mut self, series: &str, rate: i128, mark_usd: f64) {
        let epoch = self.now / (3_600 * SEC);
        let u = FundingUpdate {
            series: series.into(),
            epoch: U64(epoch),
            rate: I128(rate),
            mark: U128((mark_usd * USDC as f64) as u128),
        };
        let sig = self.sign(&self.agent, FUNDING_DOMAIN, &u);
        testing_env!(ctx("keeper.near", self.now));
        self.c.settle_funding(u, sig);
    }

    fn assert_solvent(&self) {
        assert_eq!(self.c.ledger_total(), self.c.net_inflow, "ledger must equal net inflow");
    }

    fn collateral(&self, who: &str) -> i128 {
        self.c.accounts.get(&acct(who)).map(|a| a.collateral).unwrap_or(0)
    }
}

/// Harness with a funded vault, a fresh spot, and a funded trader.
fn ready() -> Harness {
    let mut h = Harness::new();
    h.lp("lp.near", 100_000);
    h.deposit("alice.near", 10_000);
    h.deposit("keeper.near", 100);
    h.spot(3_500);
    h
}

// ---------------------------------------------------------------------------------------------
// Funds in
// ---------------------------------------------------------------------------------------------

#[test]
fn deposit_credits_collateral_and_stays_solvent() {
    let h = ready();
    assert_eq!(h.collateral("alice.near"), 10_000 * USDC as i128);
    h.assert_solvent();
}

#[test]
#[should_panic(expected = "only USDC can call this")]
fn deposit_from_wrong_token_is_rejected() {
    let mut h = Harness::new();
    testing_env!(ctx("fake-usdc.near", h.now));
    let _ = h.c.ft_on_transfer(acct("alice.near"), U128(5 * USDC), "deposit".into());
}

#[test]
#[should_panic(expected = "deposit below minimum")]
fn dust_deposit_is_rejected() {
    let mut h = Harness::new();
    testing_env!(ctx("usdc.near", h.now));
    let _ = h.c.ft_on_transfer(acct("alice.near"), U128(10), "deposit".into());
}

#[test]
#[should_panic(expected = "msg must be")]
fn unknown_deposit_message_is_rejected() {
    let mut h = Harness::new();
    testing_env!(ctx("usdc.near", h.now));
    let _ = h.c.ft_on_transfer(acct("alice.near"), U128(5 * USDC), "gift".into());
}

#[test]
#[should_panic(expected = "deposits are paused")]
fn paused_contract_refuses_deposits() {
    let mut h = Harness::new();
    h.as_user("owner.near");
    h.c.set_paused(true);
    h.deposit("alice.near", 10);
}

// ---------------------------------------------------------------------------------------------
// LP vault
// ---------------------------------------------------------------------------------------------

#[test]
fn first_lp_deposit_locks_minimum_liquidity() {
    let h = ready();
    assert_eq!(h.c.locked_shares, 1_000_000);
    assert_eq!(h.c.get_lp_shares(acct("lp.near")).0, 100_000 * USDC - 1_000_000);
    assert_eq!(h.c.total_shares, 100_000 * USDC);
    h.assert_solvent();
}

#[test]
fn second_lp_gets_shares_at_current_price() {
    let mut h = ready();
    h.lp("lp2.near", 50_000);
    assert_eq!(h.c.get_lp_shares(acct("lp2.near")).0, 50_000 * USDC);
    h.assert_solvent();
}

#[test]
fn redeem_then_claim_after_cooldown() {
    let mut h = ready();
    h.as_user("lp.near");
    h.c.lp_request_redeem(U128(10_000 * USDC));
    assert_eq!(h.c.get_vault().pending_claims.0, 10_000 * USDC);
    h.assert_solvent();

    h.advance(10);
    h.as_user("lp.near");
    let claim = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = h.c.lp_claim();
    }));
    assert!(claim.is_err(), "claim before cooldown must fail");

    h.advance(3_600);
    h.as_user("lp.near");
    let _ = h.c.lp_claim();
    assert_eq!(h.c.get_vault().pending_claims.0, 0);
    h.assert_solvent();
}

#[test]
fn full_redemption_leaves_the_locked_liquidity_behind() {
    let mut h = ready();
    h.as_user("lp.near");
    let all = h.c.get_lp_shares(acct("lp.near"));
    h.c.lp_request_redeem(all);
    assert_eq!(h.c.total_shares, h.c.locked_shares);
    // The locked shares keep the share price defined: 1 USDC stays in the vault.
    assert_eq!(h.c.vault_cash, 1_000_000);
    h.assert_solvent();
}

#[test]
#[should_panic(expected = "invalid share amount")]
fn cannot_redeem_more_shares_than_held() {
    let mut h = ready();
    h.as_user("lp.near");
    h.c.lp_request_redeem(U128(100_000 * USDC));
}

#[test]
#[should_panic(expected = "under-margined")]
fn lp_cannot_redeem_capital_backing_open_risk() {
    let mut h = ready();
    h.deposit("whale.near", 50_000);
    h.trade("whale.near", "ETH-3500-C", Side::Buy, 40.0, 12.0);
    // The vault is short 40 ATM calls. Pulling almost everything out must be refused.
    h.as_user("lp.near");
    h.c.lp_request_redeem(U128(90_000 * USDC));
}

// ---------------------------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------------------------

#[test]
fn buy_moves_premium_from_trader_to_vault() {
    let mut h = ready();
    let vault_before = h.c.vault_cash;
    h.trade("alice.near", "ETH-3500-C", Side::Buy, 1.0, 12.0);
    assert_eq!(h.collateral("alice.near"), (10_000 - 12) * USDC as i128);
    assert_eq!(h.c.vault_cash, vault_before + 12 * USDC as i128);
    let view = h.c.get_account(acct("alice.near")).unwrap();
    assert_eq!(view.positions.len(), 1);
    assert_eq!(view.positions[0].size.0, ONE as i128);
    h.assert_solvent();
}

#[test]
fn round_trip_costs_the_spread_and_never_favours_the_trader() {
    let mut h = ready();
    h.trade("alice.near", "ETH-3500-C", Side::Buy, 1.0, 12.0);
    h.trade("alice.near", "ETH-3500-C", Side::Sell, 1.0, 11.0);
    assert_eq!(h.collateral("alice.near"), (10_000 - 1) * USDC as i128);
    assert!(h.c.get_account(acct("alice.near")).unwrap().positions.is_empty());
    h.assert_solvent();
}

#[test]
fn rounding_favours_the_vault() {
    let mut h = ready();
    // 0.001 contract at 12.345678 USDC: exact cost 12345.678 micros.
    h.trade("alice.near", "ETH-3500-C", Side::Buy, 0.001, 12.345678);
    let paid = 10_000 * USDC as i128 - h.collateral("alice.near");
    assert_eq!(paid, 12_346, "buy rounds the premium up");
    h.assert_solvent();
}

#[test]
#[should_panic(expected = "quote is for a different taker")]
fn quote_cannot_be_used_by_someone_else() {
    let mut h = ready();
    let (q, sig) = h.quote("alice.near", "ETH-3500-C", Side::Buy, 1.0, 12.0);
    h.deposit("mallory.near", 1_000);
    h.as_user("mallory.near");
    h.c.trade(q, sig);
}

#[test]
#[should_panic(expected = "quote expired")]
fn expired_quote_is_rejected() {
    let mut h = ready();
    let (q, sig) = h.quote("alice.near", "ETH-3500-C", Side::Buy, 1.0, 12.0);
    h.advance(6);
    h.as_user("alice.near");
    h.c.trade(q, sig);
}

#[test]
#[should_panic(expected = "too far in the future")]
fn quote_with_long_ttl_is_rejected() {
    let mut h = ready();
    let (mut q, _) = h.quote("alice.near", "ETH-3500-C", Side::Buy, 1.0, 12.0);
    q.expiry_ns = U64(h.now + 600 * SEC);
    let sig = h.sign(&h.agent, QUOTE_DOMAIN, &q);
    h.as_user("alice.near");
    h.c.trade(q, sig);
}

#[test]
#[should_panic(expected = "nonce already used")]
fn replayed_quote_is_rejected() {
    let mut h = ready();
    let (q, sig) = h.quote("alice.near", "ETH-3500-C", Side::Buy, 1.0, 12.0);
    h.as_user("alice.near");
    h.c.trade(q.clone(), sig.clone());
    h.as_user("alice.near");
    h.c.trade(q, sig);
}

#[test]
#[should_panic(expected = "invalid agent signature")]
fn quote_signed_by_unknown_key_is_rejected() {
    let mut h = ready();
    let rogue = SigningKey::from_bytes(&[9u8; 32]);
    let (q, _) = h.quote("alice.near", "ETH-3500-C", Side::Buy, 1.0, 12.0);
    let sig = h.sign(&rogue, QUOTE_DOMAIN, &q);
    h.as_user("alice.near");
    h.c.trade(q, sig);
}

#[test]
#[should_panic(expected = "invalid agent signature")]
fn tampering_with_a_signed_quote_is_rejected() {
    let mut h = ready();
    let (mut q, sig) = h.quote("alice.near", "ETH-3500-C", Side::Buy, 1.0, 12.0);
    q.price = U128(1 * USDC); // cheaper than what the agent signed
    h.as_user("alice.near");
    h.c.trade(q, sig);
}

#[test]
#[should_panic(expected = "invalid agent signature")]
fn signature_for_another_message_type_is_rejected() {
    let mut h = ready();
    // A valid spot signature must not pass as a quote signature (domain separation).
    let (q, _) = h.quote("alice.near", "ETH-3500-C", Side::Buy, 1.0, 12.0);
    let sig = h.sign(&h.agent, SPOT_DOMAIN, &q);
    h.as_user("alice.near");
    h.c.trade(q, sig);
}

#[test]
#[should_panic(expected = "outside the allowed band")]
fn absurd_price_is_rejected_even_when_signed() {
    let mut h = ready();
    h.trade("alice.near", "ETH-3500-C", Side::Buy, 1.0, 2_000.0);
}

#[test]
#[should_panic(expected = "outside the allowed band")]
fn free_option_is_rejected_for_an_in_the_money_series() {
    let mut h = ready();
    h.advance(1);
    h.spot(3_600); // ETH-3500-C now has 100 intrinsic and a lower band edge near it
    h.spot(3_700);
    h.trade("alice.near", "ETH-3500-C", Side::Buy, 1.0, 0.0);
}

#[test]
#[should_panic(expected = "spot price is stale")]
fn stale_spot_blocks_trading() {
    let mut h = ready();
    h.advance(60);
    h.trade("alice.near", "ETH-3500-C", Side::Buy, 1.0, 12.0);
}

#[test]
#[should_panic(expected = "unknown series")]
fn unknown_series_is_rejected() {
    let mut h = ready();
    h.trade("alice.near", "ETH-9999-C", Side::Buy, 1.0, 12.0);
}

#[test]
#[should_panic(expected = "insufficient margin")]
fn naked_short_without_margin_is_rejected() {
    let mut h = ready();
    h.deposit("bob.near", 100);
    h.trade("bob.near", "ETH-3500-C", Side::Sell, 5.0, 11.0);
}

#[test]
fn short_with_enough_margin_is_accepted() {
    let mut h = ready();
    h.trade("alice.near", "ETH-3500-C", Side::Sell, 1.0, 11.0);
    let view = h.c.get_account(acct("alice.near")).unwrap();
    assert_eq!(view.positions[0].size.0, -(ONE as i128));
    assert!(view.equity.unwrap().0 >= view.requirement.unwrap().0);
    h.assert_solvent();
}

#[test]
#[should_panic(expected = "vault risk limit reached")]
fn vault_refuses_risk_beyond_its_capital() {
    let mut h = ready();
    h.deposit("whale.near", 500_000);
    // The vault holds ~100k USDC; selling it 300 ATM calls needs far more than that.
    h.trade("whale.near", "ETH-3500-C", Side::Buy, 300.0, 12.0);
}

#[test]
fn closing_trades_are_allowed_while_close_only() {
    let mut h = ready();
    h.trade("alice.near", "ETH-3500-C", Side::Sell, 1.0, 11.0);
    // Spot rises until the account is deep in the close-only zone, then it buys back to reduce.
    h.advance(1);
    h.spot(3_800);
    h.advance(1);
    h.spot(4_100);
    h.trade("alice.near", "ETH-3500-C", Side::Buy, 1.0, 640.0);
    assert!(h.c.get_account(acct("alice.near")).unwrap().positions.is_empty());
    h.assert_solvent();
}

// ---------------------------------------------------------------------------------------------
// Spot updates
// ---------------------------------------------------------------------------------------------

#[test]
#[should_panic(expected = "sequence must increase")]
fn spot_replay_is_rejected() {
    let mut h = ready();
    let update = SpotUpdate {
        underlying: Underlying::ETH,
        price: U128((3_500 * USD) as u128),
        ts_ns: U64(h.now),
        seq: U64(h.seq), // already used
    };
    let sig = h.sign(&h.agent, SPOT_DOMAIN, &update);
    testing_env!(ctx("keeper.near", h.now));
    h.c.post_spot(update, sig);
}

#[test]
#[should_panic(expected = "spot moved too far")]
fn spot_jump_is_rejected_while_the_previous_price_is_fresh() {
    let mut h = ready();
    h.advance(5);
    h.spot(5_000);
}

#[test]
fn spot_may_jump_after_a_long_gap() {
    let mut h = ready();
    h.advance(1_000);
    h.spot(5_000);
    assert_eq!(h.c.get_spot(Underlying::ETH).unwrap().0 .0, (5_000 * USD) as u128);
}

#[test]
#[should_panic(expected = "timestamp is in the future")]
fn future_dated_spot_is_rejected() {
    let mut h = ready();
    let update = SpotUpdate {
        underlying: Underlying::ETH,
        price: U128((3_500 * USD) as u128),
        ts_ns: U64(h.now + 60 * SEC),
        seq: U64(h.seq + 1),
    };
    let sig = h.sign(&h.agent, SPOT_DOMAIN, &update);
    testing_env!(ctx("keeper.near", h.now));
    h.c.post_spot(update, sig);
}

// ---------------------------------------------------------------------------------------------
// Funding
// ---------------------------------------------------------------------------------------------

#[test]
fn funding_moves_cash_from_longs_to_the_vault_and_conserves_the_ledger() {
    let mut h = ready();
    h.trade("alice.near", "ETH-3500-C", Side::Buy, 10.0, 12.0);
    let cash_before = h.collateral("alice.near");
    h.advance(60);
    h.spot(3_500);
    // 1% per hour on a 12 USDC mark = 0.12 USDC per contract, so 1.2 USDC for 10 contracts.
    h.funding("ETH-3500-C", 10_000_000, 12.0);
    // Funding is applied on the next touch.
    h.deposit("alice.near", 1);
    h.as_user("alice.near");
    let mut a = h.c.accounts.get(&acct("alice.near")).cloned().unwrap();
    h.c.apply_funding(&mut a);
    h.c.accounts.insert(acct("alice.near"), a);
    assert_eq!(h.collateral("alice.near"), cash_before + USDC as i128 - 1_200_000);
    h.assert_solvent();
}

#[test]
fn account_view_exposes_entry_index_until_funding_is_applied() {
    let mut h = ready();
    h.trade("alice.near", "ETH-3500-C", Side::Buy, 10.0, 12.0);
    h.advance(60);
    h.spot(3_500);
    h.funding("ETH-3500-C", 10_000_000, 12.0);

    // Settled on the series, not yet on the account: the gap is what the UI shows as accrued.
    let index = h.c.get_series("ETH-3500-C".into()).unwrap().funding_index.0;
    assert_eq!(index, 120_000);
    let view = h.c.get_account(acct("alice.near")).unwrap();
    assert_eq!(view.positions[0].entry_index.0, 0);

    // Any touch settles it and moves the entry index up to the series index.
    h.trade("alice.near", "ETH-3500-C", Side::Buy, 1.0, 12.0);
    let view = h.c.get_account(acct("alice.near")).unwrap();
    assert_eq!(view.positions[0].entry_index.0, index);
    h.assert_solvent();
}

#[test]
fn funding_rate_is_clamped_to_the_cap() {
    let mut h = ready();
    h.advance(60);
    h.spot(3_500);
    h.funding("ETH-3500-C", 900_000_000, 12.0); // 90% asked, 4% cap
    let s = h.c.get_series("ETH-3500-C".into()).unwrap();
    assert_eq!(s.funding_index.0, 480_000); // 4% of a 12 USDC mark
}

#[test]
#[should_panic(expected = "epoch already settled")]
fn funding_epoch_cannot_be_replayed() {
    let mut h = ready();
    h.advance(60);
    h.spot(3_500);
    h.funding("ETH-3500-C", 1_000_000, 12.0);
    h.advance(1);
    h.spot(3_500);
    h.funding("ETH-3500-C", 1_000_000, 12.0);
}

#[test]
#[should_panic(expected = "epoch is not current")]
fn funding_for_an_old_epoch_is_rejected() {
    let mut h = ready();
    h.advance(3 * 3_600);
    h.spot(3_500);
    let u = FundingUpdate {
        series: "ETH-3500-C".into(),
        epoch: U64(h.now / (3_600 * SEC) - 2),
        rate: I128(1_000_000),
        mark: U128(12 * USDC),
    };
    let sig = h.sign(&h.agent, FUNDING_DOMAIN, &u);
    testing_env!(ctx("keeper.near", h.now));
    h.c.settle_funding(u, sig);
}

#[test]
#[should_panic(expected = "mark is outside the allowed band")]
fn funding_mark_outside_the_band_is_rejected() {
    let mut h = ready();
    h.advance(60);
    h.spot(3_500);
    h.funding("ETH-3500-C", 1_000_000, 5_000.0);
}

// ---------------------------------------------------------------------------------------------
// Liquidation
// ---------------------------------------------------------------------------------------------

fn short_then_squeeze() -> Harness {
    let mut h = ready();
    h.deposit("bob.near", 1_700);
    // Margin: ~910 requirement per short ATM call, 1.5x initial ratio, so one call fits.
    h.trade("bob.near", "ETH-3500-C", Side::Sell, 1.0, 11.0);
    h
}

#[test]
#[should_panic(expected = "account is not liquidatable")]
fn healthy_account_cannot_be_liquidated() {
    let mut h = short_then_squeeze();
    h.as_user("keeper.near");
    h.c.liquidate(acct("bob.near"));
}

#[test]
fn squeezed_short_is_liquidated_and_the_ledger_balances() {
    let mut h = short_then_squeeze();
    for p in [3_800, 4_100, 4_400] {
        h.advance(20);
        h.spot(p);
    }
    h.as_user("keeper.near");
    let keeper_before = h.collateral("keeper.near");
    h.c.liquidate(acct("bob.near"));
    assert!(h.c.get_account(acct("bob.near")).map(|a| a.positions.is_empty()).unwrap_or(true));
    assert!(h.collateral("keeper.near") >= keeper_before);
    h.assert_solvent();
}

#[test]
fn underwater_liquidation_is_absorbed_by_insurance_then_the_vault() {
    let mut h = short_then_squeeze();
    // Seed the insurance fund as if earlier liquidations had paid into it.
    h.c.insurance = 50 * USDC as i128;
    h.c.vault_cash += 50 * USDC as i128;
    h.c.net_inflow += 100 * USDC as i128;
    // Ten percent steps keep each spot post inside the jump limit.
    for p in [3_800, 4_100, 4_400, 4_700, 5_000, 5_300, 5_700, 6_200, 6_800] {
        h.advance(20);
        h.spot(p);
    }
    // Measure the vault at the same spot as the liquidation so the comparison is like for like.
    let vault_equity_before = h.c.vault_risk().unwrap().0;
    h.as_user("keeper.near");
    h.c.liquidate(acct("bob.near"));
    assert_eq!(h.collateral("bob.near"), 0);
    assert_eq!(h.c.insurance, 0, "insurance is drawn first");
    assert!(h.c.vault_risk().unwrap().0 < vault_equity_before, "the vault takes the remaining loss");
    h.assert_solvent();
}

#[test]
#[should_panic(expected = "cannot liquidate your own account")]
fn self_liquidation_is_rejected() {
    let mut h = short_then_squeeze();
    h.as_user("bob.near");
    h.c.liquidate(acct("bob.near"));
}

#[test]
fn fully_redeemed_lp_entry_is_removed() {
    let mut h = ready();
    h.as_user("lp.near");
    let all = h.c.get_lp_shares(acct("lp.near"));
    h.c.lp_request_redeem(all);
    assert!(h.c.lp_shares.get(&acct("lp.near")).is_none());
}

#[test]
#[should_panic(expected = "needs an account")]
fn liquidator_must_have_an_account() {
    let mut h = short_then_squeeze();
    h.as_user("stranger.near");
    h.c.liquidate(acct("bob.near"));
}

// ---------------------------------------------------------------------------------------------
// The long side: premiums are paid in full, and a long that cannot pay its funding is closed
// ---------------------------------------------------------------------------------------------

/// A trader holding one ATM call bought for 12 with exactly 12 on deposit: no cash left.
fn long_with_no_spare_cash() -> Harness {
    let mut h = ready();
    h.deposit("carol.near", 12);
    h.trade("carol.near", "ETH-3500-C", Side::Buy, 1.0, 12.0);
    assert_eq!(h.collateral("carol.near"), 0);
    h
}

/// One hourly settlement at 4% of a 12 USDC mark: each long contract owes 0.48 USDC.
fn settle_an_hour(h: &mut Harness, spot: i128, mark: f64) {
    h.advance(3_600);
    h.spot(spot);
    h.funding("ETH-3500-C", 40_000_000, mark);
}

fn liquidate_err(h: &mut Harness, who: &str) -> String {
    h.as_user("keeper.near");
    let before = Snapshot::take(&h.c);
    let c = &mut h.c;
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.liquidate(acct(who))));
    match r {
        Ok(()) => String::new(),
        Err(e) => {
            before.restore(&mut h.c);
            e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()
        }
    }
}

#[test]
fn a_buy_must_be_paid_in_full() {
    let mut h = ready();
    h.deposit("bob.near", 1);
    // 1,200 USDC of premium against 1 USDC of cash. The requirement of a long is zero, so the
    // margin check alone would let this through.
    let err = trade_err(&mut h, "bob.near", "ETH-3500-C", Side::Buy, 100.0, 12.0);
    assert_eq!(err, "not enough cash to pay the premium");
    assert_eq!(h.collateral("bob.near"), USDC as i128);
    assert!(h.c.get_account(acct("bob.near")).unwrap().positions.is_empty());
    // One micro short of the premium is still refused; the exact premium is accepted.
    h.deposit("bob.near", 10);
    assert_eq!(trade_err(&mut h, "bob.near", "ETH-3500-C", Side::Buy, 1.0, 11.000001), "not enough cash to pay the premium");
    assert_eq!(trade_err(&mut h, "bob.near", "ETH-3500-C", Side::Buy, 1.0, 11.0), "");
    assert_eq!(h.collateral("bob.near"), 0);
    h.assert_solvent();
}

#[test]
fn a_buy_that_closes_a_short_is_also_paid_from_cash() {
    let mut h = short_then_squeeze(); // bob: 1,711 cash, short one ATM call
    for p in [3_800, 4_100, 4_400, 4_700, 5_000, 5_300] {
        h.advance(20);
        h.spot(p);
    }
    // Buying the call back at its intrinsic value of 1,800 costs more cash than bob has.
    assert_eq!(trade_err(&mut h, "bob.near", "ETH-3500-C", Side::Buy, 1.0, 1_800.0), "not enough cash to pay the premium");
    // Liquidation is what closes an account like this.
    assert_eq!(liquidate_err(&mut h, "bob.near"), "");
    h.assert_solvent();
}

#[test]
fn a_long_that_can_pay_its_funding_is_not_liquidatable() {
    let mut h = ready();
    h.deposit("carol.near", 13); // 1 USDC to spare after the premium
    h.trade("carol.near", "ETH-3500-C", Side::Buy, 1.0, 12.0);
    assert_eq!(liquidate_err(&mut h, "carol.near"), "account is not liquidatable");
    settle_an_hour(&mut h, 3_500, 12.0);
    settle_an_hour(&mut h, 3_500, 12.0);
    // 0.96 owed, 1.00 on hand.
    assert_eq!(liquidate_err(&mut h, "carol.near"), "account is not liquidatable");
    settle_an_hour(&mut h, 3_500, 12.0);
    // 1.44 owed: the cash has run out.
    assert_eq!(liquidate_err(&mut h, "carol.near"), "");
    h.assert_solvent();
}

#[test]
fn a_long_that_cannot_pay_its_funding_is_closed_at_the_mark() {
    let mut h = long_with_no_spare_cash();
    assert_eq!(liquidate_err(&mut h, "carol.near"), "account is not liquidatable");
    settle_an_hour(&mut h, 3_500, 12.0);

    let keeper_before = h.collateral("keeper.near");
    let vault_before = h.c.vault_cash;
    let insurance_before = h.c.insurance;
    h.as_user("keeper.near");
    h.c.liquidate(acct("carol.near"));

    // Funding owed: 0.48. Position bought back at the 12.00 mark. Fees are 0.5% + 0.5% of that
    // value, not of the 3,500 spot notional, which would have taken all of it.
    let (funding, value, fee) = (480_000, 12_000_000, 60_000);
    assert_eq!(h.collateral("carol.near"), value - funding - 2 * fee);
    assert_eq!(h.collateral("keeper.near") - keeper_before, fee);
    assert_eq!(h.c.insurance - insurance_before, fee);
    assert_eq!(h.c.vault_cash - vault_before, funding - value, "the vault collects the funding and pays the mark");
    assert!(h.c.get_account(acct("carol.near")).unwrap().positions.is_empty());
    assert_eq!(h.c.get_series("ETH-3500-C".into()).unwrap().net_trader_size.0, 0);
    h.assert_solvent();
    // What is left is the trader's to withdraw.
    h.as_user("carol.near");
    let _ = h.c.withdraw(U128((value - funding - 2 * fee) as u128));
    assert!(h.c.get_account(acct("carol.near")).is_none());
    h.assert_solvent();
}

#[test]
fn an_in_the_money_long_is_carried_by_its_intrinsic_value_until_that_goes() {
    let mut h = long_with_no_spare_cash();
    for p in [3_800, 3_900] {
        h.advance(20);
        h.spot(p);
    }
    settle_an_hour(&mut h, 3_900, 412.0);
    // Cash is negative after funding, but the call is worth 400 at intrinsic: equity is positive.
    assert_eq!(liquidate_err(&mut h, "carol.near"), "account is not liquidatable");
    for p in [3_700, 3_500] {
        h.advance(20);
        h.spot(p);
    }
    // Back at the money the intrinsic value is gone and the unpaid funding is all that is left.
    assert_eq!(liquidate_err(&mut h, "carol.near"), "");
    h.assert_solvent();
}

#[test]
fn unpaid_funding_beyond_a_longs_value_is_a_shortfall_not_a_free_ride() {
    let mut h = long_with_no_spare_cash();
    h.c.insurance = 5 * USDC as i128;
    h.c.net_inflow += 5 * USDC as i128;
    // The keeper was away for two days: 48 settlements of 0.48 = 23.04 owed against a call
    // worth 12.00.
    for _ in 0..48 {
        settle_an_hour(&mut h, 3_500, 12.0);
    }
    let vault_before = h.c.vault_cash;
    h.as_user("keeper.near");
    h.c.liquidate(acct("carol.near"));
    assert_eq!(h.collateral("carol.near"), 0);
    assert!(h.c.get_account(acct("carol.near")).is_none(), "nothing is left to withdraw");
    assert_eq!(h.c.insurance, 0, "insurance covers what it can of the 11.04 shortfall");
    // The vault takes the option back without paying its 12.00 mark, and its cash moves only by
    // the 5.00 drawn from insurance: of the 23.04 owed it ends up 6.04 short.
    assert_eq!(h.c.vault_cash - vault_before, 5_000_000);
    assert_eq!(h.c.get_series("ETH-3500-C".into()).unwrap().net_trader_size.0, 0);
    h.assert_solvent();
}

#[test]
fn a_short_is_still_charged_on_spot_notional() {
    let mut h = short_then_squeeze();
    for p in [3_800, 4_100, 4_400] {
        h.advance(20);
        h.spot(p);
    }
    let keeper_before = h.collateral("keeper.near");
    h.as_user("keeper.near");
    h.c.liquidate(acct("bob.near"));
    // 0.5% of one contract at a 4,400 spot.
    assert_eq!(h.collateral("keeper.near") - keeper_before, 22 * USDC as i128);
    h.assert_solvent();
}

// ---------------------------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------------------------

#[test]
fn withdraw_debits_before_the_transfer_and_stays_solvent() {
    let mut h = ready();
    h.as_user("alice.near");
    let _ = h.c.withdraw(U128(4_000 * USDC));
    assert_eq!(h.collateral("alice.near"), 6_000 * USDC as i128);
    h.assert_solvent();
}

#[test]
fn failed_transfer_refunds_collateral() {
    let mut h = ready();
    h.as_user("alice.near");
    let _ = h.c.withdraw(U128(4_000 * USDC));
    testing_env!(
        ctx("twooptions.near", h.now),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    h.c.on_withdraw(acct("alice.near"), U128(4_000 * USDC));
    assert_eq!(h.collateral("alice.near"), 10_000 * USDC as i128);
    h.assert_solvent();
}

#[test]
#[should_panic(expected = "insufficient collateral")]
fn cannot_withdraw_more_than_the_balance() {
    let mut h = ready();
    h.as_user("alice.near");
    let _ = h.c.withdraw(U128(10_001 * USDC));
}

#[test]
#[should_panic(expected = "under-margined")]
fn cannot_withdraw_the_margin_behind_an_open_short() {
    let mut h = ready();
    h.trade("alice.near", "ETH-3500-C", Side::Sell, 1.0, 11.0);
    h.as_user("alice.near");
    let _ = h.c.withdraw(U128(9_500 * USDC));
}

#[test]
fn emptied_account_is_removed_from_storage() {
    let mut h = ready();
    h.as_user("alice.near");
    let _ = h.c.withdraw(U128(10_000 * USDC));
    assert!(h.c.get_account(acct("alice.near")).is_none());
}

#[test]
#[should_panic(expected = "withdrawals are halted")]
fn withdrawals_halt_when_the_books_show_a_shortfall() {
    let mut h = ready();
    h.c.vault_cash = -1;
    h.as_user("alice.near");
    let _ = h.c.withdraw(U128(USDC));
}

// ---------------------------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------------------------

#[test]
#[should_panic(expected = "owner only")]
fn only_the_owner_can_add_series() {
    let mut h = Harness::new();
    h.as_user("alice.near");
    h.c.add_series(Underlying::BTC, U128(60_000 * USD as u128), Kind::Call);
}

#[test]
#[should_panic(expected = "series already exists")]
fn duplicate_series_is_rejected() {
    let mut h = Harness::new();
    h.as_user("owner.near");
    h.c.add_series(Underlying::ETH, U128(3_500 * USD as u128), Kind::Call);
}

#[test]
#[should_panic(expected = "whole USD")]
fn fractional_strike_is_rejected() {
    let mut h = Harness::new();
    h.as_user("owner.near");
    h.c.add_series(Underlying::ETH, U128(3_500 * USD as u128 + 1), Kind::Call);
}

#[test]
#[should_panic(expected = "liquidation < close-only < initial")]
fn bad_ratio_ordering_is_rejected() {
    let mut h = Harness::new();
    h.as_user("owner.near");
    let mut p = h.c.get_params();
    p.liquidation_ratio_bps = 16_000;
    h.c.set_params(p);
}

#[test]
#[should_panic(expected = "funding cap above 10%")]
fn funding_cap_cannot_be_raised_above_ten_percent() {
    let mut h = Harness::new();
    h.as_user("owner.near");
    let mut p = h.c.get_params();
    p.max_funding_rate = 200_000_000;
    h.c.set_params(p);
}

#[test]
fn ownership_transfer_is_two_step() {
    let mut h = Harness::new();
    h.as_user("owner.near");
    h.c.propose_owner(acct("new-owner.near"));
    assert_eq!(h.c.get_owner(), acct("owner.near"));
    h.as_user("new-owner.near");
    h.c.accept_owner();
    assert_eq!(h.c.get_owner(), acct("new-owner.near"));
}

#[test]
#[should_panic(expected = "not the pending owner")]
fn random_account_cannot_accept_ownership() {
    let mut h = Harness::new();
    h.as_user("owner.near");
    h.c.propose_owner(acct("new-owner.near"));
    h.as_user("mallory.near");
    h.c.accept_owner();
}

#[test]
fn revoking_agent_keys_blocks_quotes() {
    let mut h = ready();
    h.as_user("owner.near");
    h.c.set_agent_keys(vec![]);
    let (q, sig) = h.quote("alice.near", "ETH-3500-C", Side::Buy, 1.0, 12.0);
    h.as_user("alice.near");
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| h.c.trade(q, sig)));
    assert!(r.is_err());
}

#[test]
fn pause_blocks_trading_but_not_withdrawals_or_liquidation() {
    let mut h = ready();
    h.as_user("owner.near");
    h.c.set_paused(true);
    h.as_user("alice.near");
    let _ = h.c.withdraw(U128(USDC));
    assert!(h.c.is_paused());
    let (q, sig) = h.quote("alice.near", "ETH-3500-C", Side::Buy, 1.0, 12.0);
    h.as_user("alice.near");
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| h.c.trade(q, sig)));
    assert!(r.is_err());
}

// ---------------------------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------------------------

/// Everything the random run can touch, so a rejected call can be rolled back the way a real
/// NEAR transaction would be. Unit tests keep in-memory state across a panic, a chain does not.
struct Snapshot {
    vault_cash: i128,
    insurance: i128,
    lp_pending_total: i128,
    sum_collateral: i128,
    net_inflow: i128,
    total_shares: u128,
    locked_shares: u128,
    accounts: Vec<(AccountId, Option<Account>)>,
    series: Vec<(String, Series)>,
    spot: Option<SpotPoint>,
    mark_refs: Vec<(String, Option<MarkRef>)>,
    out_epoch: u64,
    epoch_net_out: i128,
    epoch_start_cash: i128,
}

const TOUCHED: [&str; 4] = ["alice.near", "bob.near", "carol.near", "keeper.near"];
const SERIES_IDS: [&str; 3] = ["ETH-3500-C", "ETH-3500-P", "ETH-4000-C"];

impl Snapshot {
    fn take(c: &TwoOptions) -> Self {
        Snapshot {
            vault_cash: c.vault_cash,
            insurance: c.insurance,
            lp_pending_total: c.lp_pending_total,
            sum_collateral: c.sum_collateral,
            net_inflow: c.net_inflow,
            total_shares: c.total_shares,
            locked_shares: c.locked_shares,
            accounts: TOUCHED.iter().map(|n| (acct(n), c.accounts.get(&acct(n)).cloned())).collect(),
            series: SERIES_IDS.iter().map(|id| (id.to_string(), c.series.get(*id).cloned().unwrap())).collect(),
            spot: c.spot.get(&Underlying::ETH).copied(),
            mark_refs: SERIES_IDS.iter().map(|id| (id.to_string(), c.mark_refs.get(*id).copied())).collect(),
            out_epoch: c.out_epoch,
            epoch_net_out: c.epoch_net_out,
            epoch_start_cash: c.epoch_start_cash,
        }
    }

    fn restore(self, c: &mut TwoOptions) {
        for (id, r) in self.mark_refs {
            match r {
                Some(r) => {
                    c.mark_refs.insert(id, r);
                }
                None => {
                    c.mark_refs.remove(&id);
                }
            }
        }
        c.out_epoch = self.out_epoch;
        c.epoch_net_out = self.epoch_net_out;
        c.epoch_start_cash = self.epoch_start_cash;
        c.vault_cash = self.vault_cash;
        c.insurance = self.insurance;
        c.lp_pending_total = self.lp_pending_total;
        c.sum_collateral = self.sum_collateral;
        c.net_inflow = self.net_inflow;
        c.total_shares = self.total_shares;
        c.locked_shares = self.locked_shares;
        for (id, a) in self.accounts {
            match a {
                Some(a) => {
                    c.accounts.insert(id, a);
                }
                None => {
                    c.accounts.remove(&id);
                }
            }
        }
        for (id, s) in self.series {
            c.series.insert(id, s);
        }
        if let Some(sp) = self.spot {
            c.spot.insert(Underlying::ETH, sp);
        }
    }
}

/// Deterministic pseudo-random operation mix. Every call either completes or is rolled back like
/// a reverted transaction; after each one the ledger must equal net inflow and the vault must
/// hold non-negative cash.
#[test]
fn ledger_invariant_holds_over_a_random_operation_mix() {
    let mut h = ready();
    h.deposit("bob.near", 5_000);
    h.deposit("carol.near", 5_000);
    let users = ["alice.near", "bob.near", "carol.near"];
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let mut spot_price: i128 = 3_500;
    let (mut completed, mut reverted, mut trades, mut liquidations) = (0, 0, 0, 0);
    let mut buys = 0;

    for step in 0..2_000 {
        h.advance(20);
        let r = next();
        let snap = Snapshot::take(&h.c);
        let (nonce, seq) = (h.nonce, h.seq);
        let kind = r % 8;
        let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match kind {
            0 => {
                // Trend in 150-step phases so shorts actually get squeezed, then the market reverts.
                let step_pct = ((r >> 8) % 9) as i128;
                let drift = if (step / 150) % 2 == 0 { step_pct } else { -step_pct };
                spot_price = (spot_price * (100 + drift) / 100).clamp(2_500, 6_000);
                h.spot(spot_price);
            }
            1 | 2 | 3 => {
                let who = users[(r >> 8) as usize % 3];
                let s = SERIES_IDS[(r >> 12) as usize % 3];
                let side = if (r >> 16) % 10 < 3 { Side::Buy } else { Side::Sell };
                let size = 0.1 + ((r >> 20) % 40) as f64 / 10.0;
                let strike = if s.contains("4000") { 4_000 } else { 3_500 };
                let intr = if s.ends_with('C') { (spot_price - strike).max(0) } else { (strike - spot_price).max(0) };
                let price = intr as f64 + 1.0 + ((r >> 24) % 25) as f64;
                h.trade(who, s, side, size, price);
            }
            4 => {
                let s = SERIES_IDS[(r >> 8) as usize % 3];
                let strike = if s.contains("4000") { 4_000 } else { 3_500 };
                let intr = if s.ends_with('C') { (spot_price - strike).max(0) } else { (strike - spot_price).max(0) };
                h.funding(s, ((r >> 12) % 20_000_000) as i128 - 10_000_000, intr as f64 + 10.0);
            }
            5 => {
                let who = users[(r >> 8) as usize % 3];
                h.as_user(who);
                let _ = h.c.withdraw(U128(((r >> 12) % 300 + 1) as u128 * USDC));
            }
            6 => {
                let who = users[(r >> 8) as usize % 3];
                h.as_user("keeper.near");
                h.c.liquidate(acct(who));
            }
            _ => {
                let who = users[(r >> 8) as usize % 3];
                h.deposit(who, ((r >> 12) % 400 + 1) as u128);
            }
        }));
        let attempt_ok = attempt.is_ok();
        match attempt {
            Ok(()) => {
                completed += 1;
                if (1..=3).contains(&kind) {
                    trades += 1;
                }
                if kind == 6 {
                    liquidations += 1;
                }
            }
            Err(_) => {
                reverted += 1;
                snap.restore(&mut h.c);
                h.nonce = nonce;
                h.seq = seq;
            }
        }
        assert_eq!(h.c.ledger_total(), h.c.net_inflow, "ledger drift at step {step}");
        // The long side: a completed buy is always paid for, and only an account that still
        // holds positions can carry a negative balance (through funding it has yet to settle).
        if attempt_ok && (1..=3).contains(&kind) && (r >> 16) % 10 < 3 {
            let who = users[(r >> 8) as usize % 3];
            assert!(h.collateral(who) >= 0, "a buy left {who} with negative cash at step {step}");
            buys += 1;
        }
        for who in users {
            if let Some(a) = h.c.accounts.get(&acct(who)) {
                assert!(a.collateral >= 0 || !a.positions.is_empty(), "{who} is flat with negative cash at step {step}");
            }
        }
        assert!(h.c.vault_cash >= 0 || kind == 6, "vault cash went negative at step {step}");
    }
    // The run must exercise both accepted and rejected paths, not just one.
    assert!(completed > 200, "completed {completed}");
    assert!(reverted > 100, "reverted {reverted}");
    assert!(trades > 20, "trades {trades}");
    assert!(liquidations > 0, "the run never liquidated anything");
    assert!(buys > 5, "the run completed only {buys} buys");
    println!("random run: {completed} completed, {reverted} reverted, {trades} trades ({buys} buys), {liquidations} liquidations");
}

// ---------------------------------------------------------------------------------------------
// Limits on a misbehaving agent key: prices anchored to the funding mark, hourly outflow cap
// ---------------------------------------------------------------------------------------------

fn trade_err(h: &mut Harness, who: &str, series: &str, side: Side, contracts: f64, price_usd: f64) -> String {
    let (q, sig) = h.quote(who, series, side, contracts, price_usd);
    h.as_user(who);
    // A failed transaction changes nothing on chain; undo what the panic left behind here.
    let before = Snapshot::take(&h.c);
    let c = &mut h.c;
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.trade(q, sig)));
    match r {
        Ok(()) => String::new(),
        Err(e) => {
            before.restore(&mut h.c);
            e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()
        }
    }
}

#[test]
fn a_signed_price_far_from_the_funding_mark_is_rejected() {
    let mut h = ready();
    h.funding("ETH-3500-C", 0, 12.0);
    // 50 is inside the static band (intrinsic 0 + 1.5% of 3,500 = 52.5) but 38 from the mark,
    // more than the 1% allowance (35).
    assert!(trade_err(&mut h, "alice.near", "ETH-3500-C", Side::Buy, 1.0, 50.0).contains("too far from the last funding mark"));
    assert_eq!(trade_err(&mut h, "alice.near", "ETH-3500-C", Side::Buy, 1.0, 45.0), "");
    h.assert_solvent();
}

#[test]
fn the_mark_allowance_widens_by_however_far_spot_has_moved() {
    let mut h = ready();
    h.funding("ETH-3500-C", 0, 12.0);
    h.advance(10);
    h.spot(3_560);
    // Spot is up 60: the call may now trade up to 12 + 60 + 35.6 = 107.6.
    assert_eq!(trade_err(&mut h, "alice.near", "ETH-3500-C", Side::Buy, 1.0, 100.0), "");
    assert!(trade_err(&mut h, "alice.near", "ETH-3500-C", Side::Buy, 1.0, 110.0).contains("too far from the last funding mark"));
    let view = h.c.get_series("ETH-3500-C".into()).unwrap();
    assert_eq!((view.ref_mark.unwrap().0, view.ref_spot.unwrap().0), (12 * USDC, (3_500 * USD) as u128));
}

#[test]
fn round_trips_at_the_band_edges_stop_at_the_hourly_outflow_cap() {
    // A stolen agent key signs buys at the bottom of the band and sells at the top. Each round
    // trip lowers the vault's risk, so the risk limit never stops it; the outflow cap does.
    let mut h = ready();
    let start = h.c.vault_cash;
    let cap = start / 10; // 10% of vault cash per funding interval
    let mut trips = 0;
    loop {
        assert_eq!(trade_err(&mut h, "alice.near", "ETH-4000-C", Side::Buy, 10.0, 0.0), "");
        let err = trade_err(&mut h, "alice.near", "ETH-4000-C", Side::Sell, 10.0, 52.0);
        if !err.is_empty() {
            assert!(err.contains("vault outflow limit reached"), "{err}");
            break;
        }
        trips += 1;
        assert!(trips < 100, "the cap never triggered");
    }
    let paid = start - h.c.vault_cash;
    assert!(paid <= cap && paid > cap - 520 * USDC as i128, "paid {paid}, cap {cap}");
    let v = h.c.get_vault();
    assert_eq!(v.epoch_net_outflow.0, paid);
    assert_eq!(v.epoch_start_cash.0, start);
    h.assert_solvent();

    // The next funding interval starts from zero, capped at 10% of the cash left.
    h.advance(3_600);
    h.spot(3_500);
    assert_eq!(trade_err(&mut h, "alice.near", "ETH-4000-C", Side::Sell, 10.0, 52.0), "");
    assert_eq!(h.c.get_vault().epoch_start_cash.0, start - paid);
}

#[test]
fn trades_the_vault_is_paid_for_never_count_against_the_cap() {
    let mut h = ready();
    for _ in 0..30 {
        assert_eq!(trade_err(&mut h, "alice.near", "ETH-3500-C", Side::Buy, 1.0, 40.0), "");
    }
    assert!(h.c.get_vault().epoch_net_outflow.0 < 0);
}

#[test]
fn the_new_limits_are_validated() {
    let mut h = ready();
    h.as_user("owner.near");
    let c = &mut h.c;
    for (band, cap, msg) in [(5u32, 1_000u32, "bad mark band"), (100, 0, "bad outflow cap"), (100, 10_001, "bad outflow cap")] {
        let p = Params { mark_band_bps: band, max_epoch_outflow_bps: cap, ..Params::default() };
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_params(p)));
        let e = r.unwrap_err();
        let text = e.downcast_ref::<String>().cloned().unwrap_or_default();
        assert!(text.contains(msg), "{text}");
    }
}

#[test]
fn migration_keeps_every_balance_and_adds_the_new_limits() {
    let mut h = ready();
    h.trade("alice.near", "ETH-3500-C", Side::Buy, 2.0, 12.0);
    let alice_before = h.collateral("alice.near");
    let cash_before = h.c.vault_cash;
    let solvency_before = h.c.get_solvency();

    // Write the state exactly as the previous contract version stored it.
    let mut c = std::mem::replace(&mut h.c, TwoOptions::new(acct("x.near"), acct("y.near"), vec![]));
    c.accounts.flush();
    c.series.flush();
    c.spot.flush();
    c.lp_shares.flush();
    c.lp_claims.flush();
    let old = migrate::OldState {
        owner_id: c.owner_id.clone(),
        pending_owner: c.pending_owner.clone(),
        usdc: c.usdc.clone(),
        paused: c.paused,
        params: migrate::OldParams {
            max_quote_ttl_ns: c.params.max_quote_ttl_ns, max_spot_age_ns: c.params.max_spot_age_ns,
            max_positions: c.params.max_positions, max_funding_rate: c.params.max_funding_rate,
            funding_interval_ns: c.params.funding_interval_ns, liquidation_reward_bps: c.params.liquidation_reward_bps,
            insurance_bps: c.params.insurance_bps, lp_cooldown_ns: c.params.lp_cooldown_ns,
            min_lp_liquidity: c.params.min_lp_liquidity, min_deposit: c.params.min_deposit,
            initial_ratio_bps: c.params.initial_ratio_bps, close_only_ratio_bps: c.params.close_only_ratio_bps,
            liquidation_ratio_bps: c.params.liquidation_ratio_bps, vault_ratio_bps: c.params.vault_ratio_bps,
            max_time_value_bps: 400, min_time_value_bps: c.params.min_time_value_bps,
            tv_reserve_bps: c.params.tv_reserve_bps, min_margin_per_contract: c.params.min_margin_per_contract,
            max_spot_jump_bps: c.params.max_spot_jump_bps,
        },
        agent_keys: c.agent_keys.clone(),
        accounts: c.accounts,
        series: c.series,
        spot: c.spot,
        lp_shares: c.lp_shares,
        lp_claims: c.lp_claims,
        total_shares: c.total_shares,
        locked_shares: c.locked_shares,
        vault_cash: c.vault_cash,
        insurance: c.insurance,
        lp_pending_total: c.lp_pending_total,
        sum_collateral: c.sum_collateral,
        net_inflow: c.net_inflow,
    };
    env::state_write(&old);

    h.c = TwoOptions::migrate();
    assert_eq!(h.collateral("alice.near"), alice_before);
    assert_eq!(h.c.vault_cash, cash_before);
    assert_eq!(h.c.list_series().len(), 3);
    assert_eq!(h.c.get_params().max_time_value_bps, 400); // carried over, not reset
    assert_eq!((h.c.get_params().mark_band_bps, h.c.get_params().max_epoch_outflow_bps), (100, 1_000));
    let s = h.c.get_solvency();
    assert_eq!((s.ledger_total.0, s.net_inflow.0), (solvency_before.ledger_total.0, solvency_before.net_inflow.0));
    // Trading works after the upgrade.
    assert_eq!(trade_err(&mut h, "alice.near", "ETH-3500-C", Side::Sell, 1.0, 12.0), "");
    h.assert_solvent();
}
