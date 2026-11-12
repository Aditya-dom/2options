import math

import pytest

from perennia_agent import pricing
from perennia_agent.greeks import everlasting_delta
from perennia_agent.wire import Underlying


def test_half_weights_reproduce_the_paradigm_series() -> None:
    # c = 1/2 hourly is the earlier project's series (gks2022004/nerf@00fe59b, core/everlasting.py); HANDOFF_GAURAV.md section 2 quotes these.
    hourly = pricing.everlasting(3_500, 3_500, 0.6, True, funding_fraction=0.5, interval_hours=1)
    daily = pricing.everlasting(3_500, 3_500, 0.6, True, funding_fraction=0.5, interval_hours=24)
    assert hourly.price == pytest.approx(12.06, abs=0.01)
    assert daily.price == pytest.approx(59.07, abs=0.02)
    assert hourly.delta == pytest.approx(0.5, abs=0.01)


def test_delta_agrees_with_the_inventory_module() -> None:
    for strike in (3_300, 3_500, 3_700):
        for call in (True, False):
            mine = pricing.everlasting(3_500, strike, 0.6, call, 0.5, 1).delta
            assert mine == pytest.approx(everlasting_delta(3_500, strike, 0.6, call), abs=1e-12)


def test_default_model_price_level() -> None:
    # 1/24 of time value per hour: about 1.1% of spot at the money at 60% vol.
    g = pricing.everlasting(3_500, 3_500, 0.6, True)
    assert g.price == pytest.approx(38.9, abs=0.3)
    assert pricing.n_terms(1 / 24) < 700
    assert pricing.n_terms(0.5) == 40


@pytest.mark.parametrize("c", [0.5, 1 / 24])
@pytest.mark.parametrize("strike", [3_300.0, 3_500.0, 3_800.0])
def test_price_and_funding_are_consistent_over_one_interval(c: float, strike: float) -> None:
    """V(t) = (1 - c) E[V(t + dt)] + c E[intrinsic(t + dt)]: buying, paying one funding and
    holding on is a fair bet. This is what breaks if price and funding use different `c`."""
    s0, vol, dt_h = 3_500.0, 0.6, 1.0
    sd = vol * math.sqrt(dt_h / pricing.HOURS_PER_YEAR)
    n, width = 481, 8.0
    step = 2 * width / (n - 1)
    cont = intr = 0.0
    for i in range(n):
        z = -width + i * step
        w = pricing.norm_pdf(z) * step * (0.5 if i in (0, n - 1) else 1.0)
        s1 = s0 * math.exp(sd * z - 0.5 * sd * sd)
        cont += w * pricing.everlasting(s1, strike, vol, True, c, dt_h).price
        intr += w * pricing.intrinsic(s1, strike, True)
    v0 = pricing.everlasting(s0, strike, vol, True, c, dt_h).price
    assert v0 == pytest.approx((1 - c) * cont + c * intr, rel=2e-4)


def test_mismatched_funding_is_detectably_unfair() -> None:
    """Half-weight daily price with 1/24 hourly funding (HANDOFF_GAURAV.md option B as written)
    prices the option about 50% above what its funding stream is worth."""
    quoted = pricing.everlasting(3_500, 3_500, 0.6, True, funding_fraction=0.5, interval_hours=24)
    fair = pricing.everlasting(3_500, 3_500, 0.6, True, funding_fraction=1 / 24, interval_hours=1)
    assert quoted.price / fair.price == pytest.approx(1.52, abs=0.03)


def test_put_call_parity_with_zero_rates() -> None:
    for strike in (3_000, 3_500, 4_100):
        c = pricing.everlasting(3_500, strike, 0.7, True)
        p = pricing.everlasting(3_500, strike, 0.7, False)
        assert c.price - p.price == pytest.approx(3_500 - strike, abs=1e-6)
        assert c.delta - p.delta == pytest.approx(1.0, abs=1e-9)
        assert c.gamma == pytest.approx(p.gamma, rel=1e-9)


def test_greeks_match_finite_differences() -> None:
    s, k, v = 2_110.0, 2_150.0, 0.65
    g = pricing.everlasting(s, k, v, True)
    h = 0.01
    up = pricing.everlasting(s + h, k, v, True).price
    dn = pricing.everlasting(s - h, k, v, True).price
    assert g.delta == pytest.approx((up - dn) / (2 * h), rel=1e-5)
    assert g.gamma == pytest.approx((up - 2 * g.price + dn) / (h * h), rel=1e-3)
    bumped = pricing.everlasting(s, k, v + 0.01, True).price
    assert g.vega == pytest.approx(bumped - g.price, rel=0.02)


def test_price_is_never_below_intrinsic_and_rises_with_vol() -> None:
    for strike in (1_800, 2_100, 2_400):
        for call in (True, False):
            lo = pricing.everlasting(2_100, strike, 0.3, call).price
            hi = pricing.everlasting(2_100, strike, 0.9, call).price
            assert lo >= pricing.intrinsic(2_100, strike, call) - 1e-9
            assert hi > lo


def test_funding_rate_scale_sign_and_cap() -> None:
    cap = 50_000_000
    # Out of the money: 1/24 of mark.
    assert pricing.funding_rate(59_000_000, 0, 1 / 24, cap) == round(1e9 / 24)
    # Half of mark per hour is above the cap: clamped.
    assert pricing.funding_rate(12_000_000, 0, 0.5, cap) == cap
    # Mark below intrinsic (inside the band's lower edge): shorts pay, negative, clamped.
    assert pricing.funding_rate(100_000_000, 400_000_000, 1 / 24, cap) == -cap
    assert pricing.funding_rate(0, 0, 1 / 24, cap) == 0
    # In the money: only the time value is charged.
    assert pricing.funding_rate(120_000_000, 100_000_000, 1 / 24, cap) == round(20 / 120 / 24 * 1e9)


def test_vol_surface_skew_smile_and_clamps() -> None:
    surf = pricing.VolSurface(atm=0.6)
    assert surf.iv(2_000, 2_000) == pytest.approx(0.6)
    assert surf.iv(2_000, 1_800) > 0.6 > surf.iv(2_000, 2_200)  # downside bid near the money
    assert surf.iv(2_000, 3_200) > 0.6  # the smile lifts the far upside wing
    assert surf.iv(2_000, 1) == surf.cap
    flat = pricing.VolSurface(atm=0.6, skew=0.0, smile=0.0)
    assert flat.iv(2_000, 3_000) == pytest.approx(0.6)
    with pytest.raises(ValueError):
        pricing.VolSurface(atm=0.01)
    assert set(pricing.DEFAULT_ATM_VOL) == set(Underlying)


def test_realized_vol_recovers_a_known_vol() -> None:
    rv = pricing.RealizedVol(halflife_s=3_600)
    assert rv.value() is None
    vol, dt = 0.8, 5.0
    step = vol * math.sqrt(dt / (pricing.HOURS_PER_YEAR * 3_600))
    price, ts = 2_000.0, 0.0
    for i in range(2_000):
        price *= math.exp(step if i % 2 == 0 else -step)
        ts += dt
        rv.update(price, ts)
    assert rv.value() == pytest.approx(vol, rel=1e-6)


def test_invalid_inputs_raise() -> None:
    with pytest.raises(ValueError):
        pricing.everlasting(0, 100, 0.5, True)
    with pytest.raises(ValueError):
        pricing.everlasting(100, 100, 0.5, True, interval_hours=0)
    with pytest.raises(ValueError):
        pricing.everlasting(100, 100, 0.5, True, funding_fraction=1.0)
