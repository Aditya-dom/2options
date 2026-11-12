"""Everlasting option pricing and a small vol surface for the quoter (#20).

Prior work, disclosed: the Black-Scholes and everlasting-series code is a port of
`core/black_scholes.py`, `core/everlasting.py` and the skew/smile idea in
`core/vol_surface.py` from the pre-hackathon Perennia code.

The model. Every settlement interval `dt`, a long pays the short a fraction `c` of the option's
time value: `c * (mark - intrinsic)`. Holding one interval then gives

    V(t) = (1 - c) * E[V(t + dt)] + c * E[intrinsic(t + dt)]

and unrolling it, the everlasting option is a basket of ordinary options:

    V = sum_{n>=1} c * (1 - c)^(n-1) * BS(S, K, sigma, T = n * dt),   r = 0

With c = 1/2 this is Paradigm's half-weight series (the one in `core/everlasting.py`). The
contract settles hourly, and its funding cap (at most 10% of mark per hour) rules c = 1/2 out,
so the agent uses c = 1/24: `(mark - intrinsic) / 24` per hour, an average option life of one
day.

The weights and the funding fraction are one parameter on purpose. Pricing with one `c` and
charging funding with another misprices every quote: charge less than the price assumes and a
delta-hedged long earns more gamma than it pays (the vault bleeds); charge more and sellers are
overpaid. `tests/test_pricing.py` checks the one-interval identity above numerically.

Floats on purpose: prices here are proposals. The contract bounds every one of them with
integer math before any money moves.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .wire import Underlying

HOURS_PER_YEAR = 8_760
#: Share of time value a long pays each settlement interval. Also sets the series weights.
DEFAULT_FUNDING_FRACTION = 1 / 24
#: Series terms are added until the remaining weight is below this.
TAIL_WEIGHT = 1e-12
MAX_TERMS = 5_000

FUNDING_SCALE = 10**9
USDC_UNIT = 10**6


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def intrinsic(spot: float, strike: float, is_call: bool) -> float:
    return max(spot - strike if is_call else strike - spot, 0.0)


@dataclass(frozen=True)
class Priced:
    price: float  # USD per contract
    delta: float
    gamma: float
    vega: float  # per 1 vol point (0.01)
    theta: float  # per year


def black_scholes(spot: float, strike: float, t: float, vol: float, is_call: bool) -> Priced:
    """Black-Scholes with r = 0. `t` in years."""
    if spot <= 0 or strike <= 0 or vol <= 0 or t <= 0:
        raise ValueError("spot, strike, vol and t must be positive")
    sqrt_t = math.sqrt(t)
    d1 = (math.log(spot / strike) + 0.5 * vol * vol * t) / (vol * sqrt_t)
    d2 = d1 - vol * sqrt_t
    pdf = norm_pdf(d1)
    gamma = pdf / (spot * vol * sqrt_t)
    vega = spot * pdf * sqrt_t * 0.01
    theta = -(spot * pdf * vol) / (2.0 * sqrt_t)
    if is_call:
        return Priced(spot * norm_cdf(d1) - strike * norm_cdf(d2), norm_cdf(d1), gamma, vega, theta)
    return Priced(
        strike * norm_cdf(-d2) - spot * norm_cdf(-d1), norm_cdf(d1) - 1.0, gamma, vega, theta
    )


def n_terms(funding_fraction: float) -> int:
    """Terms needed for the weights still left out to sum to less than TAIL_WEIGHT."""
    if not 0 < funding_fraction < 1:
        raise ValueError("funding_fraction must be between 0 and 1")
    return min(MAX_TERMS, math.ceil(math.log(TAIL_WEIGHT) / math.log(1.0 - funding_fraction)))


def everlasting(
    spot: float,
    strike: float,
    vol: float,
    is_call: bool,
    funding_fraction: float = DEFAULT_FUNDING_FRACTION,
    interval_hours: float = 1.0,
) -> Priced:
    """Fair value and greeks of one everlasting contract that pays `funding_fraction` of its
    time value every `interval_hours`."""
    if interval_hours <= 0:
        raise ValueError("interval_hours must be positive")
    dt = interval_hours / HOURS_PER_YEAR
    price = delta = gamma = vega = theta = 0.0
    w = funding_fraction
    for n in range(1, n_terms(funding_fraction) + 1):
        g = black_scholes(spot, strike, n * dt, vol, is_call)
        price += w * g.price
        delta += w * g.delta
        gamma += w * g.gamma
        vega += w * g.vega
        theta += w * g.theta
        w *= 1.0 - funding_fraction
    return Priced(price, delta, gamma, vega, theta)


def funding_rate(mark_micros: int, intrinsic_micros: int, funding_fraction: float, cap: int) -> int:
    """Funding for one settlement as a 1e9 fraction of mark, clamped to `cap`.

    Positive means longs pay. This is `FundingUpdate.rate`; the contract charges
    `floor(rate * mark / 1e9)` per contract, which is `funding_fraction * (mark - intrinsic)`.
    """
    if mark_micros <= 0:
        return 0
    frac = (mark_micros - intrinsic_micros) / mark_micros * funding_fraction
    return max(-cap, min(cap, round(frac * FUNDING_SCALE)))


# ---------------------------------------------------------------------------------------------
# Vol surface
# ---------------------------------------------------------------------------------------------

#: Flat ATM vols until a live source is wired in. Same numbers the app uses for local pricing.
DEFAULT_ATM_VOL: dict[Underlying, float] = {
    Underlying.BTC: 0.5,
    Underlying.ETH: 0.6,
    Underlying.SOL: 0.8,
    Underlying.NEAR: 0.9,
}


@dataclass(frozen=True)
class VolSurface:
    """ATM vol with a linear skew and a quadratic smile in log-moneyness.

        iv(K) = atm * (1 + skew * m + smile * m^2),   m = ln(K / S)

    A negative `skew` bids up downside strikes (crash premium). The result is clamped to
    [floor, cap] so a far strike can never produce a non-positive or absurd vol.
    """

    atm: float
    skew: float = -0.5
    smile: float = 4.0
    floor: float = 0.05
    cap: float = 3.0

    def __post_init__(self) -> None:
        if not 0 < self.floor <= self.atm <= self.cap:
            raise ValueError("need 0 < floor <= atm <= cap")

    def iv(self, spot: float, strike: float) -> float:
        if spot <= 0 or strike <= 0:
            raise ValueError("spot and strike must be positive")
        m = math.log(strike / spot)
        return max(self.floor, min(self.cap, self.atm * (1.0 + self.skew * m + self.smile * m * m)))


class RealizedVol:
    """EWMA of squared log returns, annualised. Feed it each spot the keeper posts.

    Used to lift the ATM vol when the market is moving more than the configured level: a
    quoter that sells options below realized vol loses to anyone who delta-hedges.
    """

    def __init__(self, halflife_s: float = 1_800.0, min_dt_s: float = 1.0) -> None:
        self.halflife_s = halflife_s
        self.min_dt_s = min_dt_s
        self._var_per_s: float | None = None
        self._last: tuple[float, float] | None = None  # (price, ts seconds)
        self._weight_s = 0.0

    def update(self, price: float, ts_s: float) -> None:
        if price <= 0:
            return
        if self._last is None:
            self._last = (price, ts_s)
            return
        last_price, last_ts = self._last
        dt = ts_s - last_ts
        if dt < self.min_dt_s:
            return
        r = math.log(price / last_price)
        sample = r * r / dt
        decay = 0.5 ** (dt / self.halflife_s)
        self._var_per_s = (
            sample if self._var_per_s is None else decay * self._var_per_s + (1 - decay) * sample
        )
        self._weight_s += dt
        self._last = (price, ts_s)

    def value(self, min_history_s: float = 600.0) -> float | None:
        """Annualised vol, or None until there is enough history to trust it."""
        if self._var_per_s is None or self._weight_s < min_history_s:
            return None
        return math.sqrt(self._var_per_s * HOURS_PER_YEAR * 3_600)


def to_micros(usd: float) -> int:
    return round(usd * USDC_UNIT)
