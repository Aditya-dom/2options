//! Emits test vectors from the contract's margin code so the frontend's TypeScript port
//! (app/src/lib/margin.ts) can be checked for exact parity.
//!
//!   cd contracts/perennia
//!   cargo run --example margin_vectors > ../../app/src/lib/fixtures/margin_vectors.json

use near_sdk::serde_json::{json, Value};
use perennia::margin::*;
use perennia::math::*;
use perennia::types::{Kind, Params, Underlying};

/// xorshift64*: deterministic, so the fixture is stable across runs.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn range(&mut self, lo: i128, hi: i128) -> i128 {
        lo + (self.next() % (hi - lo + 1) as u64) as i128
    }
}

const UNDERLYINGS: [Underlying; 4] = [Underlying::BTC, Underlying::ETH, Underlying::SOL, Underlying::NEAR];
const BASE_SPOT_USD: [i128; 4] = [90_000, 3_500, 180, 5];

fn params_json(p: &Params) -> Value {
    json!({
        "min_time_value_bps": p.min_time_value_bps.to_string(),
        "max_time_value_bps": p.max_time_value_bps.to_string(),
        "tv_reserve_bps": p.tv_reserve_bps.to_string(),
        "min_margin_per_contract": p.min_margin_per_contract.to_string(),
    })
}

fn kind_str(k: Kind) -> &'static str {
    if k == Kind::Call { "Call" } else { "Put" }
}

fn main() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut param_sets = vec![Params::default()];
    let mut alt = Params::default();
    alt.min_time_value_bps = 55;
    alt.max_time_value_bps = 333;
    alt.tv_reserve_bps = 77;
    alt.min_margin_per_contract = 1_234_567;
    param_sets.push(alt);

    let mut cases = Vec::new();
    for i in 0..160 {
        let p = &param_sets[i % param_sets.len()];
        // Spot per underlying: base ±40%, with sub-dollar noise so truncation paths are hit.
        let spots: Vec<i128> = BASE_SPOT_USD
            .iter()
            .map(|usd| {
                let base = usd * 100_000_000;
                let jitter = rng.range(-4_000, 4_000);
                base + base / 10_000 * jitter + rng.range(0, 99_999_999)
            })
            .collect();
        let n_legs = rng.range(1, 6) as usize;
        let mut legs = Vec::new();
        for _ in 0..n_legs {
            let ui = rng.range(0, 3) as usize;
            let spot = spots[ui];
            let strike_usd = (spot / 100_000_000) * rng.range(60, 140) / 100;
            let strike = strike_usd.max(1) * 100_000_000;
            let kind = if rng.range(0, 1) == 0 { Kind::Call } else { Kind::Put };
            // Sizes from 0.001 to 50 contracts, either sign, sometimes odd amounts.
            let size = rng.range(1_000, 50_000_000) * if rng.range(0, 1) == 0 { 1 } else { -1 };
            let last_mark = rng.range(0, intrinsic(kind == Kind::Call, spot, strike) + spot_usdc(spot) / 50);
            legs.push((UNDERLYINGS[ui], kind, strike, size, last_mark));
        }
        let spot_of = |u: Underlying| spots[UNDERLYINGS.iter().position(|x| *x == u).unwrap()];
        let margin_legs: Vec<Leg> = legs
            .iter()
            .map(|(u, k, strike, size, _)| Leg { underlying: *u, kind: *k, strike: *strike, size: *size })
            .collect();
        let req = requirement(&margin_legs, &spot_of, p);
        let leg_json: Vec<Value> = legs
            .iter()
            .map(|(u, k, strike, size, last_mark)| {
                let spot = spot_of(*u);
                let (lo, hi) = price_band(*k, spot, *strike, p);
                json!({
                    "underlying": u.to_string(),
                    "kind": kind_str(*k),
                    "strike": strike.to_string(),
                    "size": size.to_string(),
                    "last_mark": last_mark.to_string(),
                    "intrinsic": intrinsic(*k == Kind::Call, spot, *strike).to_string(),
                    "band_lo": lo.to_string(),
                    "band_hi": hi.to_string(),
                    "liability_mark": liability_mark(*k, spot, *strike, *last_mark, p).to_string(),
                    "leg_value": leg_value(*k, spot, *strike, *last_mark, *size, p).to_string(),
                })
            })
            .collect();
        let spot_json: Value = UNDERLYINGS
            .iter()
            .zip(&spots)
            .map(|(u, s)| (u.to_string(), Value::String(s.to_string())))
            .collect::<near_sdk::serde_json::Map<String, Value>>()
            .into();
        cases.push(json!({
            "params": params_json(p),
            "spots": spot_json,
            "legs": leg_json,
            "requirement": req.to_string(),
        }));
    }

    let rounding: Vec<Value> = (0..120)
        .map(|_| {
            let a = rng.range(-1_000_000_000_000, 1_000_000_000_000);
            let b = rng.range(-5_000_000, 5_000_000);
            let d = rng.range(1, 10_000_000);
            let bps = rng.range(-10_000, 10_000);
            json!({
                "a": a.to_string(), "b": b.to_string(), "d": d.to_string(), "bps": bps.to_string(),
                "floor": mul_div_floor(a, b, d).to_string(),
                "ceil": mul_div_ceil(a, b, d).to_string(),
                "shock": shock(a.abs(), bps).to_string(),
            })
        })
        .collect();

    println!("{}", json!({ "generator": "contracts/perennia/examples/margin_vectors.rs", "cases": cases, "rounding": rounding }));
}
