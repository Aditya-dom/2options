//! Fixed-point helpers. Every operation is checked and panics on overflow; nothing
//! here uses floats. Rounding always favours the vault.

use near_sdk::require;

/// 1 USDC in native units.
pub const USDC_UNIT: i128 = 1_000_000;
/// Position sizes: 1 contract = 1e6 size units.
pub const SIZE_SCALE: i128 = 1_000_000;
/// Basis-point denominator.
pub const BPS: i128 = 10_000;
/// Funding rates are fractions of mark scaled by 1e9.
pub const FUNDING_SCALE: i128 = 1_000_000_000;
/// Spot and strike prices are USD scaled by 1e8; USDC has 6 decimals.
pub const SPOT_TO_USDC: i128 = 100;

/// Largest absolute position, in size units (1,000,000 contracts).
pub const MAX_POSITION_SIZE: i128 = 1_000_000_000_000;
/// Smallest tradable size, in size units (0.001 contract).
pub const MIN_TRADE_SIZE: i128 = 1_000;

pub fn mul(a: i128, b: i128) -> i128 {
    a.checked_mul(b).unwrap_or_else(|| near_sdk::env::panic_str("math overflow"))
}

pub fn add(a: i128, b: i128) -> i128 {
    a.checked_add(b).unwrap_or_else(|| near_sdk::env::panic_str("math overflow"))
}

pub fn sub(a: i128, b: i128) -> i128 {
    a.checked_sub(b).unwrap_or_else(|| near_sdk::env::panic_str("math overflow"))
}

/// floor(a * b / d), rounding toward negative infinity.
pub fn mul_div_floor(a: i128, b: i128, d: i128) -> i128 {
    require!(d > 0, "division by zero");
    mul(a, b).div_euclid(d)
}

/// ceil(a * b / d), rounding toward positive infinity.
pub fn mul_div_ceil(a: i128, b: i128, d: i128) -> i128 {
    require!(d > 0, "division by zero");
    let n = mul(a, b);
    // ceil(n / d) = -floor(-n / d); n is bounded far below i128::MIN by callers.
    -((-n).div_euclid(d))
}

/// Intrinsic value of one contract in USDC micros. Spot and strike are 1e8-scaled.
pub fn intrinsic(is_call: bool, spot: i128, strike: i128) -> i128 {
    let diff = if is_call { spot - strike } else { strike - spot };
    if diff <= 0 {
        0
    } else {
        diff / SPOT_TO_USDC
    }
}

/// Spot (1e8 USD) expressed as USDC micros per contract.
pub fn spot_usdc(spot: i128) -> i128 {
    spot / SPOT_TO_USDC
}

/// Apply a signed basis-point shock to a 1e8-scaled price, never below zero.
pub fn shock(price: i128, bps: i128) -> i128 {
    let shocked = mul_div_floor(price, BPS + bps, BPS);
    if shocked < 0 {
        0
    } else {
        shocked
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floor_and_ceil_round_correctly_for_positive_and_negative() {
        assert_eq!(mul_div_floor(7, 1, 2), 3);
        assert_eq!(mul_div_ceil(7, 1, 2), 4);
        assert_eq!(mul_div_floor(-7, 1, 2), -4);
        assert_eq!(mul_div_ceil(-7, 1, 2), -3);
        assert_eq!(mul_div_floor(6, 1, 2), 3);
        assert_eq!(mul_div_ceil(6, 1, 2), 3);
    }

    #[test]
    fn intrinsic_values() {
        let strike = 3_500 * 100_000_000;
        let spot = 3_600 * 100_000_000;
        assert_eq!(intrinsic(true, spot, strike), 100 * USDC_UNIT);
        assert_eq!(intrinsic(false, spot, strike), 0);
        assert_eq!(intrinsic(false, strike - 100_000_000, strike), USDC_UNIT);
    }

    #[test]
    fn shock_is_floored_and_non_negative() {
        assert_eq!(shock(1_000, 2_000), 1_200);
        assert_eq!(shock(1_000, -10_000), 0);
        assert_eq!(shock(1_000, -20_000), 0);
    }

    #[test]
    #[should_panic(expected = "math overflow")]
    fn overflow_panics() {
        mul(i128::MAX, 2);
    }

    #[test]
    fn spec_size_bound_cannot_overflow_funding_math() {
        // size 1e12 * a year of max funding per-contract index (~3.5e14) stays far below i128::MAX.
        let worst = mul(MAX_POSITION_SIZE, 350_000_000_000_000);
        assert!(worst < i128::MAX / 100);
    }
}
