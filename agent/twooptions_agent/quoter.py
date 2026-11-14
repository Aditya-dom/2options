"""RFQ quoter (#21): prices the option chain and signs quotes the contract will accept.

The quoter prices off the contract's own cached spot, not a fresher off-chain one. The contract
checks every price against a band around that cached spot, so pricing from the same number means
a signed quote cannot land outside the band just because the two prices disagreed.

Before signing, it runs the contract's own checks (band, vault cash, vault risk limit, pause,
size limits) so a user is not handed a valid signature for a trade that will revert.
"""

from __future__ import annotations

import math
import re
import threading
import time
from dataclasses import dataclass, field

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from . import margin, pricing, wire
from .chain import HOUR_NS, NS, Series, Snapshot
from .wire import Side, Underlying

ACCOUNT_ID_RE = re.compile(r"^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$")


class QuoteError(Exception):
    """A request the agent will not sign. `status` is the HTTP status to answer with."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class QuoterConfig:
    funding_fraction: float = pricing.DEFAULT_FUNDING_FRACTION
    #: Half-spread: this share of time value...
    spread_tv_frac: float = 0.02
    #: ...but at least this many bps of delta-weighted spot (deep in the money is not free)...
    spread_delta_bps: float = 0.5
    #: ...and at least this many dollars (far out of the money still has a market).
    spread_min_usd: float = 0.005
    #: Lifetime of a signed quote. Capped by the contract's `max_quote_ttl_ns`.
    quote_ttl_s: float = 30.0
    #: Kept between a quote's expiry and the contract's TTL limit, for clock differences.
    ttl_safety_s: float = 2.0
    atm_vol: dict[Underlying, float] = field(default_factory=lambda: dict(pricing.DEFAULT_ATM_VOL))
    skew: float = -0.5
    smile: float = 4.0
    #: Lift the ATM vol to realized vol when the market moves more than configured.
    use_realized_vol: bool = True
    #: Size limits, in size units (1e6 = one contract); None means no limit. They bound how much
    #: the vault, and the hedge that follows it, can be asked to carry. A trade that only reduces
    #: the taker's position is always allowed, whatever its size.
    #: Largest single trade.
    max_trade_size: int | None = None
    #: Largest position one account may hold in one series.
    max_position: int | None = None
    #: Largest open interest per underlying: the sum over its series of |net trader size|.
    max_open_interest: int | None = None

    @property
    def has_limits(self) -> bool:
        return any(
            x is not None for x in (self.max_trade_size, self.max_position, self.max_open_interest)
        )


def _opt_str(v: int | None) -> str | None:
    return None if v is None else str(v)


def _contracts(units: int) -> str:
    return f"{units / 1_000_000:g}"


@dataclass(frozen=True)
class Row:
    series: str
    bid: int  # USDC micros per contract
    ask: int
    mark: int
    delta: float
    gamma: float
    iv: float
    funding_rate: int  # 1e9 fraction of mark per settlement
    #: False when the fair price sits outside the contract band on that side.
    can_buy: bool
    can_sell: bool

    def to_json(self) -> dict[str, object]:
        return {
            "series": self.series,
            "bid": str(self.bid),
            "ask": str(self.ask),
            "mark": str(self.mark),
            "delta": round(self.delta, 6),
            "gamma": round(self.gamma, 8),
            "iv": round(self.iv, 6),
            "funding_rate_hourly": str(self.funding_rate),
        }


@dataclass(frozen=True)
class SignedQuote:
    quote: wire.Quote
    signature: str

    def to_json(self) -> dict[str, object]:
        return {"quote": self.quote.to_json(), "signature": self.signature}


class Quoter:
    def __init__(self, key: Ed25519PrivateKey, contract_id: str, cfg: QuoterConfig | None = None):
        self.key = key
        self.contract_id = contract_id
        self.cfg = cfg or QuoterConfig()
        self.realized: dict[Underlying, pricing.RealizedVol] = {}
        self._nonce = 0
        self._lock = threading.Lock()

    # -- vol ----------------------------------------------------------------------------------

    def observe_spot(self, u: Underlying, price: int, ts_ns: int) -> None:
        """Feed each posted spot; drives the realized-vol floor under the ATM vol."""
        with self._lock:
            rv = self.realized.setdefault(u, pricing.RealizedVol())
            rv.update(price / 1e8, ts_ns / NS)

    def atm_vol(self, u: Underlying) -> float:
        base = self.cfg.atm_vol[u]
        if not self.cfg.use_realized_vol:
            return base
        with self._lock:
            rv = self.realized.get(u)
            realized = rv.value() if rv else None
        return max(base, min(realized, 3.0)) if realized else base

    def surface(self, u: Underlying) -> pricing.VolSurface:
        return pricing.VolSurface(self.atm_vol(u), self.cfg.skew, self.cfg.smile)

    # -- pricing ------------------------------------------------------------------------------

    def row(self, s: Series, spot: int, snap: Snapshot) -> Row:
        spot_usd, strike_usd = spot / 1e8, s.strike / 1e8
        iv = self.surface(s.underlying).iv(spot_usd, strike_usd)
        interval_h = snap.params.funding_interval_ns / HOUR_NS
        fair = pricing.everlasting(
            spot_usd, strike_usd, iv, s.is_call, self.cfg.funding_fraction, interval_h
        )
        time_value = max(fair.price - pricing.intrinsic(spot_usd, strike_usd, s.is_call), 0.0)
        half = max(
            time_value * self.cfg.spread_tv_frac,
            spot_usd * abs(fair.delta) * self.cfg.spread_delta_bps / 10_000,
            self.cfg.spread_min_usd,
        )
        lo, hi = margin.price_band(s.is_call, spot, s.strike, snap.params.margin)
        want_bid = math.floor((fair.price - half) * 1e6)
        want_ask = math.ceil((fair.price + half) * 1e6)

        def clamp(v: int) -> int:
            return max(lo, min(hi, v))

        mark = clamp(pricing.to_micros(fair.price))
        intr = margin.intrinsic(s.is_call, spot, s.strike)
        return Row(
            series=s.id,
            bid=clamp(max(want_bid, 0)),
            ask=clamp(want_ask),
            mark=mark,
            delta=fair.delta,
            gamma=fair.gamma,
            iv=iv,
            funding_rate=pricing.funding_rate(
                mark, intr, self.cfg.funding_fraction, snap.params.max_funding_rate
            ),
            # Selling above the band is impossible, and clamping down would sell below fair.
            can_buy=want_ask <= hi,
            # A bid forced up to the band floor would overpay; a zero bid is no bid.
            can_sell=0 < want_bid and lo <= want_bid,
        )

    def rows(self, snap: Snapshot, now_ns: int | None = None) -> list[Row]:
        """One row per series that has a fresh spot on chain."""
        now = now_ns if now_ns is not None else time.time_ns()
        out = []
        for s in snap.series.values():
            spot = snap.fresh_spot(s.underlying, now)
            if spot is not None:
                out.append(self.row(s, spot, snap))
        return out

    # -- quoting ------------------------------------------------------------------------------

    def _next_nonce(self, now_ns: int) -> int:
        with self._lock:
            self._nonce = max(now_ns // 1_000, self._nonce + 1)  # microseconds, never repeats
            return self._nonce

    def check_limits(
        self, snap: Snapshot, series_id: str, side: Side, size: int, held: int
    ) -> None:
        """Refuse a trade that would grow exposure past the configured limits. `held` is the
        taker's current position in the series (signed size units)."""
        c = self.cfg
        s = snap.series.get(series_id)
        if s is None or not c.has_limits:
            return
        change = size if side == Side.Buy else -size
        new = held + change
        if abs(new) <= abs(held) and new * held >= 0:
            return  # only reduces the position: always allowed, so anyone can close
        if c.max_trade_size is not None and size > c.max_trade_size:
            raise QuoteError(
                409,
                f"size is above the limit of {_contracts(c.max_trade_size)} contracts per trade",
            )
        if c.max_position is not None and abs(new) > c.max_position:
            raise QuoteError(
                409,
                f"position would exceed the limit of {_contracts(c.max_position)} contracts per account in {series_id}",
            )
        if c.max_open_interest is not None:
            same = [x for x in snap.series.values() if x.underlying == s.underlying]
            before = sum(abs(x.net_trader_size) for x in same)
            after = before - abs(s.net_trader_size) + abs(s.net_trader_size + change)
            if after > c.max_open_interest and after > before:
                raise QuoteError(
                    409,
                    f"open interest in {s.underlying.name} would exceed the limit of "
                    f"{_contracts(c.max_open_interest)} contracts",
                )

    def limits_json(self) -> dict[str, str | None]:
        c = self.cfg
        return {
            "max_trade_size": _opt_str(c.max_trade_size),
            "max_position": _opt_str(c.max_position),
            "max_open_interest": _opt_str(c.max_open_interest),
        }

    def quote(
        self,
        snap: Snapshot,
        series_id: str,
        side: Side,
        size: int,
        taker: str,
        now_ns: int | None = None,
    ) -> SignedQuote:
        now = now_ns if now_ns is not None else time.time_ns()
        if not ACCOUNT_ID_RE.match(taker):
            raise QuoteError(400, "taker is not a valid NEAR account id")
        if not margin.MIN_TRADE_SIZE <= size <= margin.MAX_POSITION_SIZE:
            raise QuoteError(400, "size out of range")
        if snap.paused:
            raise QuoteError(503, "trading is paused")
        s = snap.series.get(series_id)
        if s is None:
            raise QuoteError(404, "unknown series")
        if not s.active:
            raise QuoteError(409, "series is not active")
        # A spot past half its allowed age means the keeper is behind: by the time the user has
        # confirmed in the wallet, the contract would likely refuse it as stale.
        spot = snap.fresh_spot(s.underlying, now, snap.params.max_spot_age_ns // 2)
        if spot is None:
            raise QuoteError(503, "spot price is stale")

        row = self.row(s, spot, snap)
        if side == Side.Buy and not row.can_buy:
            raise QuoteError(409, "fair price is above the contract's price band; not offering")
        if side == Side.Sell and not row.can_sell:
            raise QuoteError(409, "no bid for this series")
        price = row.ask if side == Side.Buy else row.bid
        self._check_mark_band(snap, s, spot, price)
        self._check_vault(snap, s, side, size, price, now)

        ttl_ns = min(
            int(self.cfg.quote_ttl_s * NS),
            snap.params.max_quote_ttl_ns - int(self.cfg.ttl_safety_s * NS),
        )
        if ttl_ns < NS:
            raise QuoteError(503, "contract quote TTL is too short to quote safely")
        q = wire.Quote(series_id, taker, side, size, price, self._next_nonce(now), now + ttl_ns)
        return SignedQuote(q, wire.sign(self.key, self.contract_id, q))

    def _check_mark_band(self, snap: Snapshot, s: Series, spot: int, price: int) -> None:
        """Mirror of `trade`'s anchor: within the last funding mark, plus spot's move since,
        plus `mark_band_bps` of spot. Usually only fails if volatility moved sharply this hour."""
        if s.ref_mark is None or s.ref_spot is None:
            return
        moved = abs(spot - s.ref_spot) // margin.SPOT_TO_USDC
        allowance = margin.mul_div_floor(
            margin.spot_usdc(spot), snap.params.mark_band_bps, margin.BPS
        )
        if abs(price - s.ref_mark) > moved + allowance:
            raise QuoteError(409, "price is too far from the last funding mark")

    def _check_vault(
        self, snap: Snapshot, s: Series, side: Side, size: int, price: int, now_ns: int
    ) -> None:
        """Mirror of the vault checks in `trade` (lib.rs): cash, then the risk limit."""
        p = snap.params.margin
        spots: dict[Underlying, int] = {}
        for other in snap.series.values():
            if other.net_trader_size == 0 and other.id != s.id:
                continue
            sp = snap.fresh_spot(other.underlying, now_ns)
            if sp is None:
                raise QuoteError(503, "spot price is stale")
            spots[other.underlying] = sp

        def legs(net: dict[str, int], marks: dict[str, int]) -> list[margin.Leg]:
            return [
                margin.Leg(x.underlying, x.is_call, x.strike, -net[x.id], marks[x.id])
                for x in snap.series.values()
                if net[x.id] != 0
            ]

        net = {x.id: x.net_trader_size for x in snap.series.values()}
        marks = {x.id: x.last_mark for x in snap.series.values()}
        _, req_before = margin.risk(snap.vault_cash, legs(net, marks), spots, p)

        if side == Side.Buy:
            cash_after = snap.vault_cash + margin.mul_div_ceil(price, size, margin.SIZE_SCALE)
            net[s.id] += size
            marks[s.id] = max(marks[s.id], price)  # buys ratchet the mark up
        else:
            cash_after = snap.vault_cash - margin.mul_div_floor(price, size, margin.SIZE_SCALE)
            net[s.id] -= size
        if cash_after < 0:
            raise QuoteError(409, "vault cannot fund this trade")
        # Hourly outflow cap (lib.rs `trade`): what the vault pays out, net, this funding interval.
        paid = snap.vault_cash - cash_after
        if paid > 0:
            same = snap.epoch == now_ns // snap.params.funding_interval_ns
            net_out = (snap.epoch_net_outflow if same else 0) + paid
            start = snap.epoch_start_cash if same else snap.vault_cash
            if net_out * margin.BPS > start * snap.params.max_epoch_outflow_bps:
                raise QuoteError(409, "vault outflow limit reached for this hour")
        if abs(net[s.id]) > margin.MAX_POSITION_SIZE:
            raise QuoteError(409, "position too large")
        equity, req_after = margin.risk(cash_after, legs(net, marks), spots, p)
        if req_after > req_before and equity * margin.BPS < req_after * snap.params.vault_ratio_bps:
            raise QuoteError(409, "vault risk limit reached")
