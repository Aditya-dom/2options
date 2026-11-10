"""Everlasting option delta for inventory (the Paradigm half-weight series, f = 1 hour).

Kept minimal on purpose: #20 ports the full pricing and vol surface. Swap `everlasting_delta`
for that implementation once it lands; `inventory.compute` takes the delta function as input.
"""

from __future__ import annotations

import math

HOURS_PER_YEAR = 8_760
N_TERMS = 50


def _ncdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def everlasting_delta(
    spot: float, strike: float, vol: float, is_call: bool, period_years: float = 1 / HOURS_PER_YEAR
) -> float:
    """Σ (1/2)^n · Δ_BS(T = n·f), r = 0."""
    if spot <= 0 or strike <= 0 or vol <= 0:
        raise ValueError("spot, strike and vol must be positive")
    delta, w = 0.0, 1.0
    for n in range(1, N_TERMS + 1):
        w *= 0.5
        t = n * period_years
        d1 = (math.log(spot / strike) + 0.5 * vol * vol * t) / (vol * math.sqrt(t))
        delta += w * (_ncdf(d1) if is_call else _ncdf(d1) - 1.0)
    return delta
