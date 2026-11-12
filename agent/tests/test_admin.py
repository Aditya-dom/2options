import pytest

from twooptions_agent import admin
from twooptions_agent.pricing import everlasting

from .fakes import PARAMS


@pytest.mark.parametrize(
    ("spot", "expected"),
    [
        (2_110.0, [2000, 2050, 2100, 2150, 2200]),
        (100_400.0, [95000, 97500, 100000, 102500, 105000]),
        (151.0, [148, 150, 152, 154, 156]),
        (2.4, [1, 2, 3, 4]),  # whole-dollar strikes only; nothing at or below zero
    ],
)
def test_strike_grid(spot: float, expected: list[int]) -> None:
    assert admin.strike_grid(spot) == expected


def test_strike_grid_rejects_bad_spot() -> None:
    with pytest.raises(ValueError):
        admin.strike_grid(0)


def test_every_grid_strike_is_worth_quoting() -> None:
    # The grid is only useful if its furthest strikes still carry a visible premium.
    for k in admin.strike_grid(2_110.0):
        assert everlasting(2_110.0, k, 0.6, k >= 2_110).price > 0.5


def test_preset_only_touches_known_params_and_passes_the_contract_validation() -> None:
    current = {
        **PARAMS,
        "max_quote_ttl_ns": 10 * admin.SEC,
        "max_funding_rate": 40_000_000,
        "max_time_value_bps": 150,
    }
    merged = admin.merged_params(current, admin.PARAMS_PRESET)
    assert set(merged) == set(current)
    # validate_params in lib.rs
    assert 0 < merged["max_quote_ttl_ns"] <= 60 * admin.SEC
    assert merged["max_funding_rate"] <= 100_000_000
    assert merged["max_time_value_bps"] <= 10_000 and merged["tv_reserve_bps"] <= 10_000
    # The funding cap must clear 1/24 of mark, or every out-of-the-money series is clipped.
    assert merged["max_funding_rate"] > 1e9 / 24
    with pytest.raises(ValueError):
        admin.merged_params(current, {"no_such_param": 1})


@pytest.mark.parametrize("vol", [0.5, 0.6, 0.9, 1.5])
def test_preset_band_holds_the_fair_price_up_to_high_vol(vol: float) -> None:
    fair = everlasting(2_110.0, 2_110.0, vol, True).price
    assert fair < 2_110.0 * admin.PARAMS_PRESET["max_time_value_bps"] / 10_000
