"""Spot price feed for `post_spot`.

Pyth Hermes now answers 401 without an API key (checked Nov 10 2026), so the feed takes the
median of public venue prices instead: Coinbase, Kraken, Binance (USDT book) and Hyperliquid
(the hedge venue). It fails closed: when too few fresh venues agree it holds rather than posts,
which lets the on-chain spot go stale and pauses trading. That is the intended failure mode;
a wrong spot would let trades through at wrong prices.

Contract rules mirrored here (lib.rs post_spot): price > 0, `seq` strictly increasing, `ts_ns`
not before the previous post, and a move of more than `max_spot_jump_bps` is refused while the
previous post is younger than 300 s.

    uv run python -m twooptions_agent.spot --once            # one round, JSON lines
    uv run python -m twooptions_agent.spot --interval 5       # loop
"""

from __future__ import annotations

import argparse
import json
import logging
import statistics
import sys
import time
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from decimal import ROUND_HALF_EVEN, Decimal

from .wire import SpotUpdate, Underlying

log = logging.getLogger(__name__)

SPOT_SCALE = 10**8
NS = 1_000_000_000
TIMEOUT_S = 4.0


@dataclass(frozen=True)
class VenueQuote:
    venue: str
    underlying: Underlying
    price: Decimal
    observed_ns: int


@dataclass(frozen=True)
class FeedConfig:
    """Defaults sit inside the contract's limits (max_spot_age 30 s, max_spot_jump 10%)."""

    max_age_s: float = 10.0
    max_dev_bps: int = 50
    min_sources: int = 2
    max_jump_bps: int = 1_000
    jump_window_s: int = 300


@dataclass(frozen=True)
class Decision:
    underlying: Underlying
    update: SpotUpdate | None
    hold: str | None
    venues: tuple[str, ...] = ()
    rejected: tuple[str, ...] = field(default=())

    def to_json(self) -> dict[str, object]:
        return {
            "underlying": self.underlying.name,
            "update": self.update.to_json() if self.update else None,
            "hold": self.hold,
            "venues": list(self.venues),
            "rejected": list(self.rejected),
        }


def to_spot_units(price: Decimal) -> int:
    return int((price * SPOT_SCALE).to_integral_value(rounding=ROUND_HALF_EVEN))


def aggregate(
    u: Underlying,
    quotes: Iterable[VenueQuote],
    now_ns: int,
    last: SpotUpdate | None,
    cfg: FeedConfig,
) -> Decision:
    """Median of fresh, mutually consistent venue prices, or a reason to hold."""
    fresh = [
        q for q in quotes if q.underlying == u and 0 <= now_ns - q.observed_ns <= cfg.max_age_s * NS
    ]
    if len(fresh) < cfg.min_sources:
        return Decision(u, None, f"only {len(fresh)} fresh venue(s), need {cfg.min_sources}")
    mid = statistics.median(q.price for q in fresh)
    inliers = [q for q in fresh if abs(q.price - mid) * 10_000 <= mid * cfg.max_dev_bps]
    outliers = tuple(q.venue for q in fresh if q not in inliers)
    if len(inliers) < cfg.min_sources:
        return Decision(
            u, None, f"venues disagree by more than {cfg.max_dev_bps} bps", rejected=outliers
        )
    price = to_spot_units(statistics.median(q.price for q in inliers))
    if price <= 0:
        return Decision(u, None, "non-positive price", rejected=outliers)
    if last is not None and now_ns - last.ts_ns <= cfg.jump_window_s * NS:
        if abs(price - last.price) * 10_000 > last.price * cfg.max_jump_bps:
            return Decision(
                u,
                None,
                f"move > {cfg.max_jump_bps} bps since last post; contract would refuse",
                tuple(q.venue for q in inliers),
                outliers,
            )
    ts_ns = max(now_ns, last.ts_ns if last else 0)
    # Millisecond timestamps as seq stay increasing across restarts without stored state.
    seq = max(ts_ns // 1_000_000, (last.seq + 1) if last else 0)
    return Decision(
        u, SpotUpdate(u, price, ts_ns, seq), None, tuple(q.venue for q in inliers), outliers
    )


# ---------------------------------------------------------------------------------------------
# Venues. Each returns what it has; a failing venue is logged and left out of the median.
# ---------------------------------------------------------------------------------------------


def _get(url: str, body: dict[str, object] | None = None) -> object:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "User-Agent": "twooptions-agent"},
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:  # noqa: S310 - fixed https URLs
        return json.loads(r.read())


def _iso_ns(s: str) -> int:
    whole, _, frac = s.rstrip("Z").partition(".")
    secs = int(datetime.fromisoformat(whole + "+00:00").timestamp())
    return secs * NS + int((frac + "000000000")[:9])


def coinbase(us: list[Underlying], now_ns: int) -> list[VenueQuote]:
    sym = {
        Underlying.BTC: "BTC",
        Underlying.ETH: "ETH",
        Underlying.SOL: "SOL",
        Underlying.NEAR: "NEAR",
    }
    out = []
    for u in us:
        d = _get(f"https://api.exchange.coinbase.com/products/{sym[u]}-USD/ticker")
        assert isinstance(d, dict)
        mid = (Decimal(d["bid"]) + Decimal(d["ask"])) / 2
        out.append(VenueQuote("coinbase", u, mid, _iso_ns(d["time"])))
    return out


def kraken(us: list[Underlying], now_ns: int) -> list[VenueQuote]:
    pair = {
        Underlying.BTC: "XXBTZUSD",
        Underlying.ETH: "XETHZUSD",
        Underlying.SOL: "SOLUSD",
        Underlying.NEAR: "NEARUSD",
    }
    q = "XBTUSD,ETHUSD,SOLUSD,NEARUSD"
    d = _get(f"https://api.kraken.com/0/public/Ticker?pair={q}")
    assert isinstance(d, dict)
    if d.get("error"):
        raise RuntimeError(f"kraken: {d['error']}")
    res = d["result"]
    return [
        VenueQuote(
            "kraken", u, (Decimal(res[pair[u]]["a"][0]) + Decimal(res[pair[u]]["b"][0])) / 2, now_ns
        )
        for u in us
        if pair[u] in res
    ]


def binance(us: list[Underlying], now_ns: int) -> list[VenueQuote]:
    """USDT book; USDT/USD basis is usually a few bps, inside the agreement band."""
    sym = {
        Underlying.BTC: "BTCUSDT",
        Underlying.ETH: "ETHUSDT",
        Underlying.SOL: "SOLUSDT",
        Underlying.NEAR: "NEARUSDT",
    }
    symbols = json.dumps([sym[u] for u in us], separators=(",", ":"))
    d = _get(
        f"https://api.binance.com/api/v3/ticker/bookTicker?symbols={urllib.parse.quote(symbols)}"
    )
    assert isinstance(d, list)
    by = {x["symbol"]: x for x in d}
    return [
        VenueQuote(
            "binance",
            u,
            (Decimal(by[sym[u]]["bidPrice"]) + Decimal(by[sym[u]]["askPrice"])) / 2,
            now_ns,
        )
        for u in us
        if sym[u] in by
    ]


def hyperliquid(us: list[Underlying], now_ns: int) -> list[VenueQuote]:
    d = _get("https://api.hyperliquid.xyz/info", {"type": "allMids"})
    assert isinstance(d, dict)
    return [VenueQuote("hyperliquid", u, Decimal(d[u.name]), now_ns) for u in us if u.name in d]


Venue = Callable[[list[Underlying], int], list[VenueQuote]]
VENUES: dict[str, Venue] = {
    "coinbase": coinbase,
    "kraken": kraken,
    "binance": binance,
    "hyperliquid": hyperliquid,
}


class SpotFeed:
    """Polls venues and decides one update (or hold) per underlying. Seed `last` from chain
    (`get_spot`) on start so the jump guard compares against what the contract holds."""

    def __init__(
        self,
        underlyings: list[Underlying],
        venues: dict[str, Venue] | None = None,
        cfg: FeedConfig | None = None,
    ):
        self.underlyings = underlyings
        self.venues = venues if venues is not None else VENUES
        self.cfg = cfg or FeedConfig()
        self.last: dict[Underlying, SpotUpdate] = {}

    def fetch(self, now_ns: int) -> list[VenueQuote]:
        quotes: list[VenueQuote] = []
        with ThreadPoolExecutor(max_workers=len(self.venues)) as pool:
            futures = {
                name: pool.submit(fn, self.underlyings, now_ns) for name, fn in self.venues.items()
            }
            for name, f in futures.items():
                try:
                    quotes.extend(f.result(timeout=TIMEOUT_S + 1))
                except Exception as e:  # one venue down must not stop the feed
                    log.warning("venue %s failed: %s", name, e)
        return quotes

    def poll(self, now_ns: int | None = None) -> list[Decision]:
        now = now_ns if now_ns is not None else time.time_ns()
        quotes = self.fetch(now)
        out = []
        for u in self.underlyings:
            d = aggregate(u, quotes, now, self.last.get(u), self.cfg)
            if d.update:
                # Recorded as posted; a keeper that fails to land it should re-seed from chain.
                self.last[u] = d.update
            out.append(d)
        return out


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--underlyings", default="ETH,BTC,SOL,NEAR")
    p.add_argument("--interval", type=float, default=5.0)
    p.add_argument("--once", action="store_true")
    a = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(levelname)s %(message)s")
    feed = SpotFeed([Underlying[x.strip()] for x in a.underlyings.split(",")])
    while True:
        for d in feed.poll():
            print(json.dumps(d.to_json()), flush=True)
        if a.once:
            return 0
        time.sleep(a.interval)


if __name__ == "__main__":
    sys.exit(main())
