"""Integer port of the contract's margin and valuation (contracts/twooptions/src/margin.rs, math.rs).

The quoter uses it to answer one question before signing: would this trade push the vault past
its risk limit? A quote that the contract will reject is worse than no quote.

Checked against `app/src/lib/fixtures/margin_vectors.json`, which is generated from the
contract's own code (`make near-fixtures`). Regenerate and rerun the tests after changing
`margin.rs` or `math.rs`.
"""

from __future__ import annotations

from dataclasses import dataclass

from .wire import Underlying

USDC_UNIT = 1_000_000
SIZE_SCALE = 1_000_000
BPS = 10_000
SPOT_TO_USDC = 100
SHOCKS_BPS = (-2_000, -1_000, 1_000, 2_000)

MIN_TRADE_SIZE = 1_000
MAX_POSITION_SIZE = 1_000_000_000_000


@dataclass(frozen=True)
class MarginParams:
    min_time_value_bps: int
    max_time_value_bps: int
    tv_reserve_bps: int
    min_margin_per_contract: int

    @classmethod
    def from_json(cls, p: dict[str, object]) -> MarginParams:
        return cls(
            int(str(p["min_time_value_bps"])),
            int(str(p["max_time_value_bps"])),
            int(str(p["tv_reserve_bps"])),
            int(str(p["min_margin_per_contract"])),
        )


@dataclass(frozen=True)
class Leg:
    underlying: Underlying
    is_call: bool
    strike: int  # USD x 1e8
    size: int  # signed, 1e6 per contract
    last_mark: int = 0  # USDC micros per contract


def mul_div_floor(a: int, b: int, d: int) -> int:
    if d <= 0:
        raise ZeroDivisionError("division by zero")
    return (a * b) // d  # Python floors toward negative infinity, like div_euclid for d > 0


def mul_div_ceil(a: int, b: int, d: int) -> int:
    if d <= 0:
        raise ZeroDivisionError("division by zero")
    return -((-(a * b)) // d)


def intrinsic(is_call: bool, spot: int, strike: int) -> int:
    """Intrinsic value of one contract in USDC micros. Spot and strike are 1e8-scaled."""
    diff = spot - strike if is_call else strike - spot
    # Rust `/` truncates; diff is positive here so truncation and floor agree.
    return 0 if diff <= 0 else diff // SPOT_TO_USDC


def spot_usdc(spot: int) -> int:
    return spot // SPOT_TO_USDC


def shock(price: int, bps: int) -> int:
    return max(mul_div_floor(price, BPS + bps, BPS), 0)


def price_band(is_call: bool, spot: int, strike: int, p: MarginParams) -> tuple[int, int]:
    intr = intrinsic(is_call, spot, strike)
    s = spot_usdc(spot)
    lo = max(intr - mul_div_floor(s, p.min_time_value_bps, BPS), 0)
    hi = intr + mul_div_floor(s, p.max_time_value_bps, BPS)
    return lo, hi


def liability_mark(is_call: bool, spot: int, strike: int, last_mark: int, p: MarginParams) -> int:
    _, hi = price_band(is_call, spot, strike, p)
    return max(intrinsic(is_call, spot, strike), min(last_mark, hi))


def leg_value(leg: Leg, spot: int, p: MarginParams) -> int:
    """Longs at intrinsic, shorts at the band-clamped mark; floored."""
    if leg.size >= 0:
        mark = intrinsic(leg.is_call, spot, leg.strike)
    else:
        mark = liability_mark(leg.is_call, spot, leg.strike, leg.last_mark, p)
    return mul_div_floor(leg.size, mark, SIZE_SCALE)


def requirement(legs: list[Leg], spots: dict[Underlying, int], p: MarginParams) -> int:
    """Worst-case loss requirement in USDC micros, as `margin::requirement`."""
    seen: list[Underlying] = []
    scenario_total = reserve = floor_total = 0
    for leg in legs:
        if leg.underlying not in seen:
            seen.append(leg.underlying)
        if leg.size < 0:
            size = -leg.size
            s = spot_usdc(spots.get(leg.underlying, 0))
            reserve += mul_div_ceil(size * s, p.tv_reserve_bps, SIZE_SCALE * BPS)
            floor_total += mul_div_ceil(size, p.min_margin_per_contract, SIZE_SCALE)
    for u in seen:
        mine = [leg for leg in legs if leg.underlying == u]
        if not any(leg.size < 0 for leg in mine):
            continue
        spot = spots.get(u, 0)
        worst = 0
        for bps in SHOCKS_BPS:
            shocked = shock(spot, bps)
            change = sum(
                leg.size
                * (
                    intrinsic(leg.is_call, shocked, leg.strike)
                    - intrinsic(leg.is_call, spot, leg.strike)
                )
                for leg in mine
            )
            if change < 0:
                worst = max(worst, mul_div_ceil(-change, 1, SIZE_SCALE))
        scenario_total += worst
    return max(scenario_total + reserve, floor_total)


def risk(
    cash: int, legs: list[Leg], spots: dict[Underlying, int], p: MarginParams
) -> tuple[int, int]:
    """(equity, requirement) for a cash balance and a set of legs."""
    equity = cash + sum(leg_value(leg, spots[leg.underlying], p) for leg in legs)
    return equity, requirement(legs, spots, p)
