"""A read-only snapshot of the contract state the quoter and keeper price against."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from . import rpc
from .margin import MarginParams
from .wire import Underlying

#: `view(method, args)` against the twooptions contract.
Viewer = Callable[[str, dict[str, Any] | None], Any]

NS = 1_000_000_000
HOUR_NS = 3_600 * NS


def rpc_viewer(rpc_url: str, contract_id: str) -> Viewer:
    """Views at optimistic finality: the freshest spot the next block will see."""

    def view(method: str, args: dict[str, Any] | None = None) -> Any:
        return rpc.view(rpc_url, contract_id, method, args, finality="optimistic")

    return view


def _int(v: object) -> int:
    return int(str(v))


def _opt_int(v: object) -> int | None:
    return None if v is None else int(str(v))


@dataclass(frozen=True)
class Series:
    id: str
    underlying: Underlying
    strike: int  # USD x 1e8
    is_call: bool
    funding_index: int
    last_mark: int
    last_epoch: int
    net_trader_size: int
    active: bool
    # Last funding mark and the spot it was set at; the contract anchors trade prices to them.
    ref_mark: int | None = None
    ref_spot: int | None = None

    @classmethod
    def from_view(cls, j: dict[str, Any]) -> Series:
        return cls(
            id=str(j["id"]),
            underlying=Underlying[str(j["underlying"])],
            strike=_int(j["strike"]),
            is_call=j["kind"] == "Call",
            funding_index=_int(j["funding_index"]),
            last_mark=_int(j["last_mark"]),
            last_epoch=_int(j["last_epoch"]),
            net_trader_size=_int(j["net_trader_size"]),
            active=bool(j["active"]),
            ref_mark=_opt_int(j.get("ref_mark")),
            ref_spot=_opt_int(j.get("ref_spot")),
        )


@dataclass(frozen=True)
class Params:
    max_quote_ttl_ns: int
    max_spot_age_ns: int
    max_funding_rate: int
    funding_interval_ns: int
    liquidation_ratio_bps: int
    vault_ratio_bps: int
    max_spot_jump_bps: int
    margin: MarginParams
    # Defaults match the contract's, for a contract that predates these limits.
    mark_band_bps: int = 100
    max_epoch_outflow_bps: int = 1_000

    @classmethod
    def from_view(cls, j: dict[str, Any]) -> Params:
        return cls(
            max_quote_ttl_ns=_int(j["max_quote_ttl_ns"]),
            max_spot_age_ns=_int(j["max_spot_age_ns"]),
            max_funding_rate=_int(j["max_funding_rate"]),
            funding_interval_ns=_int(j["funding_interval_ns"]),
            liquidation_ratio_bps=_int(j["liquidation_ratio_bps"]),
            vault_ratio_bps=_int(j["vault_ratio_bps"]),
            max_spot_jump_bps=_int(j["max_spot_jump_bps"]),
            margin=MarginParams.from_json(j),
            mark_band_bps=_int(j.get("mark_band_bps", 100)),
            max_epoch_outflow_bps=_int(j.get("max_epoch_outflow_bps", 1_000)),
        )


@dataclass(frozen=True)
class Spot:
    price: int  # USD x 1e8
    ts_ns: int


@dataclass(frozen=True)
class Snapshot:
    params: Params
    series: dict[str, Series]
    spots: dict[Underlying, Spot]
    vault_cash: int
    paused: bool
    fetched_ns: int
    # The vault's net cash paid to traders in the current funding interval, and its cash when
    # the interval began: the contract caps the first at a share of the second.
    epoch: int = 0
    epoch_net_outflow: int = 0
    epoch_start_cash: int = 0

    def fresh_spot(self, u: Underlying, now_ns: int) -> int | None:
        """The spot the contract would accept right now, or None if it would call it stale."""
        sp = self.spots.get(u)
        if sp is None or now_ns - sp.ts_ns > self.params.max_spot_age_ns:
            return None
        return sp.price


def fetch_snapshot(
    view: Viewer, now_ns: int | None = None, slow: tuple[Params, bool] | None = None
) -> Snapshot:
    """`slow` reuses the parameters and pause flag from an earlier snapshot (they rarely change)."""
    params, paused = slow if slow else (Params.from_view(view("get_params", None)), None)
    series = {s.id: s for s in (Series.from_view(j) for j in view("list_series", None))}
    spots: dict[Underlying, Spot] = {}
    for u in sorted({s.underlying for s in series.values()}):
        sp = view("get_spot", {"underlying": u.name})
        if sp is not None:
            spots[u] = Spot(_int(sp[0]), _int(sp[1]))
    vault = view("get_vault", None)
    return Snapshot(
        params=params,
        series=series,
        spots=spots,
        vault_cash=_int(vault["cash"]),
        epoch=_int(vault.get("epoch", 0)),
        epoch_net_outflow=_int(vault.get("epoch_net_outflow", 0)),
        epoch_start_cash=_int(vault.get("epoch_start_cash", vault["cash"])),
        paused=bool(view("is_paused", None)) if paused is None else paused,
        fetched_ns=now_ns if now_ns is not None else time.time_ns(),
    )


@dataclass
class ChainCache:
    """Latest snapshot, shared between the HTTP threads and the keeper."""

    view: Viewer
    max_age_s: float = 4.0
    #: How long the parameters and the pause flag are reused before being read again.
    slow_age_s: float = 30.0
    _snap: Snapshot | None = field(default=None, init=False)
    _slow_ns: int = field(default=0, init=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False)

    def refresh(self) -> Snapshot:
        with self._lock:
            prev, slow_ns = self._snap, self._slow_ns
        now = time.time_ns()
        reuse = prev is not None and now - slow_ns < self.slow_age_s * NS
        snap = fetch_snapshot(
            self.view, slow=(prev.params, prev.paused) if prev and reuse else None
        )
        with self._lock:
            self._snap = snap
            if not reuse:
                self._slow_ns = now
        return snap

    def get(self) -> Snapshot:
        """The cached snapshot, refreshed first if it is older than `max_age_s`."""
        with self._lock:
            snap = self._snap
        if snap is None or time.time_ns() - snap.fetched_ns > self.max_age_s * NS:
            return self.refresh()
        return snap
