"""Vault inventory and net delta, the input to the hedger.

Reads state, not events: the contract keeps `net_trader_size` per series exactly (every trade
and liquidation updates it), the vault holds the opposite side, and `list_series` returns it.
That is authoritative and needs no indexer; NEAR RPC cannot list past events anyway.

    uv run python -m twooptions_agent.inventory --contract twooptions.testnet [--network testnet]
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable
from dataclasses import asdict, dataclass, field

from . import pricing, rpc
from .chain import HOUR_NS, Snapshot
from .quoter import Quoter
from .wire import Underlying

SIZE_SCALE = 10**6
SPOT_SCALE = 10**8
DEFAULT_VOL = pricing.DEFAULT_ATM_VOL

DeltaFn = Callable[[float, float, float, bool], float]


def everlasting_delta(spot: float, strike: float, vol: float, is_call: bool) -> float:
    """Delta under the agent's pricing model (pricing.py), so the hedge matches the quotes."""
    return pricing.everlasting(spot, strike, vol, is_call).delta


@dataclass(frozen=True)
class SeriesState:
    id: str
    underlying: Underlying
    strike: int  # USD x 1e8
    is_call: bool
    net_trader_size: int  # 1e6 per contract; the vault holds -net_trader_size

    @classmethod
    def from_view(cls, j: dict[str, object]) -> SeriesState:
        return cls(
            id=str(j["id"]),
            underlying=Underlying[str(j["underlying"])],
            strike=int(str(j["strike"])),
            is_call=j["kind"] == "Call",
            net_trader_size=int(str(j["net_trader_size"])),
        )


@dataclass(frozen=True)
class Exposure:
    series: str
    underlying: str
    vault_contracts: float
    delta_per_contract: float
    vault_delta: float  # in units of the underlying


@dataclass(frozen=True)
class Inventory:
    exposures: list[Exposure]
    net_delta: dict[str, float]  # per underlying, units of the underlying
    hedge_target: dict[str, float]  # perp position that flattens net_delta
    missing_spot: list[str]  # underlyings with open interest but no spot (not hedgeable)
    #: Vault gamma per underlying: change in net_delta per 1 USD move in spot. Empty unless a
    #: gamma function is given. The hedger sizes its no-trade band from it.
    net_gamma: dict[str, float] = field(default_factory=dict)

    def to_json(self) -> dict[str, object]:
        return asdict(self)


def compute(
    series: list[SeriesState],
    spots: dict[Underlying, int],
    vol: dict[Underlying, float] | None = None,
    delta_fn: DeltaFn = everlasting_delta,
    gamma_fn: DeltaFn | None = None,
) -> Inventory:
    vols = vol or DEFAULT_VOL
    exposures: list[Exposure] = []
    net: dict[str, float] = {}
    gamma: dict[str, float] = {}
    missing: set[str] = set()
    for s in series:
        if s.net_trader_size == 0:
            continue
        spot = spots.get(s.underlying)
        if spot is None:
            missing.add(s.underlying.name)
            continue
        vault = -s.net_trader_size / SIZE_SCALE
        d = delta_fn(spot / SPOT_SCALE, s.strike / SPOT_SCALE, vols[s.underlying], s.is_call)
        exposures.append(Exposure(s.id, s.underlying.name, vault, d, vault * d))
        net[s.underlying.name] = net.get(s.underlying.name, 0.0) + vault * d
        if gamma_fn is not None:
            g = gamma_fn(spot / SPOT_SCALE, s.strike / SPOT_SCALE, vols[s.underlying], s.is_call)
            gamma[s.underlying.name] = gamma.get(s.underlying.name, 0.0) + vault * g
    # Zero the -0.0 that a perfectly flat book would otherwise print.
    hedge = {u: (-x if x != 0 else 0.0) for u, x in net.items()}
    return Inventory(exposures, net, hedge, sorted(missing), gamma)


def from_snapshot(snap: Snapshot, quoter: Quoter, now_ns: int) -> Inventory:
    """Inventory at the contract's fresh spots, with the quoter's own delta for every strike
    (same funding fraction, settlement interval and vol surface), so the hedge offsets exactly
    the exposure the quotes were priced with. A stale spot leaves its underlying in
    `missing_spot` instead of hedging against an old price."""
    interval_h = snap.params.funding_interval_ns / HOUR_NS
    cfg = quoter.cfg

    priced: dict[tuple[float, float, float, bool], pricing.Priced] = {}

    def fair(spot: float, strike: float, atm_vol: float, is_call: bool) -> pricing.Priced:
        key = (spot, strike, atm_vol, is_call)
        if key not in priced:
            iv = pricing.VolSurface(atm_vol, cfg.skew, cfg.smile).iv(spot, strike)
            priced[key] = pricing.everlasting(
                spot, strike, iv, is_call, cfg.funding_fraction, interval_h
            )
        return priced[key]

    def delta(spot: float, strike: float, atm_vol: float, is_call: bool) -> float:
        return fair(spot, strike, atm_vol, is_call).delta

    def gamma(spot: float, strike: float, atm_vol: float, is_call: bool) -> float:
        return fair(spot, strike, atm_vol, is_call).gamma

    series = [
        SeriesState(s.id, s.underlying, s.strike, s.is_call, s.net_trader_size)
        for s in snap.series.values()
    ]
    spots = {u: p for u in snap.spots if (p := snap.fresh_spot(u, now_ns)) is not None}
    vols = {u: quoter.atm_vol(u) for u in snap.spots}
    return compute(series, spots, vols, delta, gamma)


def rebalance(target: float, current: float, deadband: float) -> float:
    """Perp order size to reach `target` from `current`, or 0 inside the deadband (no churn)."""
    gap = target - current
    return 0.0 if abs(gap) <= deadband else gap


def fetch(rpc_url: str, contract_id: str) -> tuple[list[SeriesState], dict[Underlying, int]]:
    series = [SeriesState.from_view(j) for j in rpc.view(rpc_url, contract_id, "list_series")]
    spots: dict[Underlying, int] = {}
    for u in {s.underlying for s in series}:
        sp = rpc.view(rpc_url, contract_id, "get_spot", {"underlying": u.name})
        if sp is not None:
            spots[u] = int(sp[0])
    return series, spots


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Vault inventory and net delta")
    p.add_argument("--contract", required=True)
    p.add_argument("--network", default="testnet", choices=sorted(rpc.DEFAULT_RPC))
    p.add_argument("--rpc")
    a = p.parse_args(argv)
    series, spots = fetch(a.rpc or rpc.DEFAULT_RPC[a.network], a.contract)
    print(json.dumps(compute(series, spots).to_json(), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
