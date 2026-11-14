//! Margin and valuation. Pure functions so they can be tested without a contract context.
//!
//! v1 uses integer-only shocks on intrinsic value plus a time-value reserve, no Black-Scholes
//! on chain. The shocks are not calibrated yet (contracts/README.md, "Known limitations").

use crate::math::*;
use crate::types::{Kind, Params, Underlying};

/// Spot shocks, in basis points, applied to each underlying independently.
pub const SHOCKS_BPS: [i128; 4] = [-2_000, -1_000, 1_000, 2_000];

#[derive(Clone, Copy, Debug)]
pub struct Leg {
    pub underlying: Underlying,
    pub kind: Kind,
    /// 1e8-scaled USD.
    pub strike: i128,
    /// Signed size units, 1e6 per contract.
    pub size: i128,
}

pub fn is_call(kind: Kind) -> bool {
    kind == Kind::Call
}

/// The price band a quote or mark must sit in, in USDC micros per contract.
pub fn price_band(kind: Kind, spot: i128, strike: i128, p: &Params) -> (i128, i128) {
    let intr = intrinsic(is_call(kind), spot, strike);
    let s = spot_usdc(spot);
    let lo = (intr - mul_div_floor(s, p.min_time_value_bps as i128, BPS)).max(0);
    let hi = intr + mul_div_floor(s, p.max_time_value_bps as i128, BPS);
    (lo, hi)
}

/// Value of one contract that the holder owes (a short), in USDC micros: the last attested mark
/// clamped between intrinsic and the upper band edge. Never below intrinsic, so a stale or
/// missing mark cannot make a short look cheaper than what it owes today.
pub fn liability_mark(kind: Kind, spot: i128, strike: i128, last_mark: i128, p: &Params) -> i128 {
    let (_, hi) = price_band(kind, spot, strike, p);
    last_mark.clamp(intrinsic(is_call(kind), spot, strike), hi)
}

/// Value of one contract that the holder owns (a long): intrinsic only. Time value is ignored,
/// which keeps equity conservative and independent of a possibly stale mark.
pub fn asset_mark(kind: Kind, spot: i128, strike: i128) -> i128 {
    intrinsic(is_call(kind), spot, strike)
}

/// Value of a signed position: longs at [`asset_mark`], shorts at [`liability_mark`].
pub fn leg_value(kind: Kind, spot: i128, strike: i128, last_mark: i128, size: i128, p: &Params) -> i128 {
    let mark = if size >= 0 {
        asset_mark(kind, spot, strike)
    } else {
        liability_mark(kind, spot, strike, last_mark, p)
    };
    position_value(size, mark)
}

/// Market value of a position in USDC micros, floored. Floor is conservative for both longs
/// (smaller asset) and shorts (larger liability).
pub fn position_value(size: i128, mark: i128) -> i128 {
    mul_div_floor(size, mark, SIZE_SCALE)
}

/// Worst-case loss requirement for a set of legs, in USDC micros, rounded up.
///
/// - Scenario losses are computed per underlying (no netting across underlyings), across
///   the shocks in [`SHOCKS_BPS`], and only for underlyings that have a short leg. A long-only
///   holder has no scenario loss, so it has no requirement. It still owes funding every hour:
///   `trade` makes it pay the premium in full and `liquidate` closes it once its equity is
///   negative (lib.rs).
/// - A time-value reserve and a per-contract floor apply to every short contract.
pub fn requirement(legs: &[Leg], spot_of: &dyn Fn(Underlying) -> i128, p: &Params) -> i128 {
    let mut seen: Vec<Underlying> = Vec::new();
    let mut scenario_total: i128 = 0;
    let mut reserve: i128 = 0;
    let mut floor_total: i128 = 0;

    for leg in legs {
        if !seen.contains(&leg.underlying) {
            seen.push(leg.underlying);
        }
        if leg.size < 0 {
            let abs = -leg.size;
            let spot = spot_of(leg.underlying);
            let s = spot_usdc(spot);
            reserve = add(
                reserve,
                mul_div_ceil(mul(abs, s), p.tv_reserve_bps as i128, mul(SIZE_SCALE, BPS)),
            );
            floor_total =
                add(floor_total, mul_div_ceil(abs, p.min_margin_per_contract as i128, SIZE_SCALE));
        }
    }

    for u in seen {
        if !legs.iter().any(|l| l.underlying == u && l.size < 0) {
            continue;
        }
        let spot = spot_of(u);
        let mut worst: i128 = 0;
        for bps in SHOCKS_BPS {
            let shocked = shock(spot, bps);
            let mut change_numerator: i128 = 0;
            for l in legs.iter().filter(|l| l.underlying == u) {
                let call = is_call(l.kind);
                let delta = intrinsic(call, shocked, l.strike) - intrinsic(call, spot, l.strike);
                change_numerator = add(change_numerator, mul(l.size, delta));
            }
            if change_numerator < 0 {
                let loss = mul_div_ceil(-change_numerator, 1, SIZE_SCALE);
                if loss > worst {
                    worst = loss;
                }
            }
        }
        scenario_total = add(scenario_total, worst);
    }

    add(scenario_total, reserve).max(floor_total)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn eth(price_usd: i128) -> i128 {
        price_usd * 100_000_000
    }
    fn spot_3500(_: Underlying) -> i128 {
        eth(3_500)
    }
    fn contracts(n: i128) -> i128 {
        n * SIZE_SCALE
    }
    fn call_leg(strike_usd: i128, size: i128) -> Leg {
        Leg { underlying: Underlying::ETH, kind: Kind::Call, strike: eth(strike_usd), size }
    }

    #[test]
    fn long_only_has_no_requirement() {
        let p = Params::default();
        let legs = [call_leg(3_500, contracts(10))];
        assert_eq!(requirement(&legs, &spot_3500, &p), 0);
    }

    #[test]
    fn short_call_requirement_grows_with_size_and_covers_up_shock() {
        let p = Params::default();
        let one = requirement(&[call_leg(3_500, -contracts(1))], &spot_3500, &p);
        let two = requirement(&[call_leg(3_500, -contracts(2))], &spot_3500, &p);
        assert_eq!(one * 2, two);
        // +20% shock on an ATM call is 700 USD of intrinsic, plus the reserve.
        assert!(one >= 700 * USDC_UNIT);
    }

    #[test]
    fn spread_requires_less_than_naked_short() {
        let p = Params::default();
        let naked = requirement(&[call_leg(3_500, -contracts(1))], &spot_3500, &p);
        let spread = requirement(
            &[call_leg(3_500, -contracts(1)), call_leg(4_000, contracts(1))],
            &spot_3500,
            &p,
        );
        assert!(spread < naked);
    }

    #[test]
    fn requirement_never_below_per_contract_floor() {
        let p = Params::default();
        // Deep out-of-the-money short: scenarios lose nothing, the floor still applies.
        let r = requirement(&[call_leg(10_000, -contracts(2))], &spot_3500, &p);
        assert!(r >= 2 * p.min_margin_per_contract as i128);
    }

    #[test]
    fn marks_are_conservative_for_each_side() {
        let p = Params::default();
        let spot = eth(3_600);
        let strike = eth(3_500);
        let (lo, hi) = price_band(Kind::Call, spot, strike, &p);
        let intr = intrinsic(true, spot, strike);
        // The lower edge sits just under intrinsic (0.2% of spot), no longer near zero.
        assert!(lo < intr && lo > intr * 9 / 10);
        // A long is valued at intrinsic no matter what the mark says.
        assert_eq!(asset_mark(Kind::Call, spot, strike), intr);
        // A short with no mark is valued at intrinsic, never at zero.
        assert_eq!(liability_mark(Kind::Call, spot, strike, 0, &p), intr);
        // A wild mark is capped at the upper band edge.
        assert_eq!(liability_mark(Kind::Call, spot, strike, i128::from(u64::MAX), &p), hi);
        // Short value is a bigger negative than the matching long is positive.
        let size = contracts(1);
        let long = leg_value(Kind::Call, spot, strike, hi, size, &p);
        let short = leg_value(Kind::Call, spot, strike, hi, -size, &p);
        assert!(-short > long);
    }
}
