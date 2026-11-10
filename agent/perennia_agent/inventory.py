"""Vault inventory and net delta (#24), the input to the hedger.

Reads state, not events: the contract keeps `net_trader_size` per series exactly (every trade
and liquidation updates it), the vault holds the opposite side, and `list_series` returns it.
That is authoritative and needs no indexer; NEAR RPC cannot list past events anyway.

    uv run python -m perennia_agent.inventory --contract perennia.testnet [--network testnet]
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable
from dataclasses import asdict, dataclass

from . import rpc
from .greeks import everlasting_delta
from .wire import Underlying

SIZE_SCALE = 10**6
SPOT_SCALE = 10**8
DEFAULT_VOL = {Underlying.BTC: 0.5, Underlying.ETH: 0.6, Underlying.SOL: 0.8, Underlying.NEAR: 0.9}

DeltaFn = Callable[[float, float, float, bool], float]


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

    def to_json(self) -> dict[str, object]:
        return asdict(self)


def compute(
    series: list[SeriesState],
    spots: dict[Underlying, int],
    vol: dict[Underlying, float] | None = None,
    delta_fn: DeltaFn = everlasting_delta,
) -> Inventory:
    vols = vol or DEFAULT_VOL
    exposures: list[Exposure] = []
    net: dict[str, float] = {}
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
    # Zero the -0.0 that a perfectly flat book would otherwise print.
    hedge = {u: (-x if x != 0 else 0.0) for u, x in net.items()}
    return Inventory(exposures, net, hedge, sorted(missing))


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
