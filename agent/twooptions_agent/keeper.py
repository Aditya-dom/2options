"""Keeper (#23): posts spot, settles hourly funding and scans for liquidations.

Three jobs on one thread, each isolated: a failure in one is logged and retried on its next
turn and never stops the others. All of them go through one NEAR account, one transaction at a
time, because access-key nonces must increase one by one.

What the keeper can and cannot do: it relays messages signed by the agent key. The contract
checks every signature and bounds every number, so a keeper bug can delay a spot or a funding
settlement but cannot move a price outside the contract's limits.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from . import margin, wire
from .chain import NS, ChainCache, Snapshot
from .near import TGAS, TxResult
from .pricing import funding_rate
from .quoter import Quoter
from .spot import SpotFeed
from .store import Store
from .wire import FundingUpdate, SpotUpdate

log = logging.getLogger(__name__)


class Sender(Protocol):
    """The part of `near.Account` the keeper needs."""

    account_id: str

    def call(
        self,
        receiver_id: str,
        method: str,
        args: dict[str, Any] | None = None,
        gas: int = ...,
        deposit: int = ...,
    ) -> TxResult: ...


@dataclass(frozen=True)
class KeeperConfig:
    spot_interval_s: float = 5.0
    funding_check_s: float = 3.0
    #: Settlements per pass. Each one is a transaction of about 2 s and the spot must be posted
    #: every few seconds, so a backlog is worked off a little at a time between spot posts.
    funding_per_pass: int = 2
    liquidation_interval_s: float = 15.0
    #: Wait this long into a new epoch before settling it, so a slightly fast local clock cannot
    #: name an epoch the chain has not reached ("epoch is not current").
    settle_delay_s: float = 15.0


@dataclass
class _Twap:
    epoch: int
    total: int = 0
    n: int = 0

    def mean(self) -> int:
        return self.total // self.n


@dataclass
class KeeperStatus:
    last_spot_post_ns: dict[str, int] = field(default_factory=dict)
    last_spot_hold: dict[str, str] = field(default_factory=dict)
    last_funding_epoch: dict[str, int] = field(default_factory=dict)
    liquidations: int = 0
    errors: dict[str, str] = field(default_factory=dict)

    def to_json(self) -> dict[str, object]:
        return {
            "last_spot_post_ns": {k: str(v) for k, v in self.last_spot_post_ns.items()},
            "last_spot_hold": dict(self.last_spot_hold),
            "last_funding_epoch": dict(self.last_funding_epoch),
            "liquidations": self.liquidations,
            "errors": dict(self.errors),
        }


class Keeper:
    def __init__(
        self,
        contract_id: str,
        sender: Sender,
        agent_key: Ed25519PrivateKey,
        cache: ChainCache,
        quoter: Quoter,
        feed: SpotFeed,
        store: Store,
        cfg: KeeperConfig | None = None,
    ):
        self.contract_id = contract_id
        self.sender = sender
        self.agent_key = agent_key
        self.cache = cache
        self.quoter = quoter
        self.feed = feed
        self.store = store
        self.cfg = cfg or KeeperConfig()
        self.status = KeeperStatus()
        # Marks sampled during the running epoch and the finished one before it, per series.
        self._twap: dict[str, _Twap] = {}
        self._twap_done: dict[str, _Twap] = {}
        self._seeded = False
        self._warned_no_account = False

    # -- spot ---------------------------------------------------------------------------------

    def _seed_feed(self, snap: Snapshot) -> None:
        """Start the feed's jump guard and sequence from what the contract holds."""
        for u, sp in snap.spots.items():
            # The contract does not expose `seq`. Posts use the millisecond timestamp, so the
            # stored one is at most this; the feed then uses max(now_ms, this + 1).
            self.feed.last[u] = SpotUpdate(u, sp.price, sp.ts_ns, sp.ts_ns // 1_000_000)
        self._seeded = True

    def tick_spot(self, now_ns: int | None = None) -> None:
        snap = self.cache.get()
        wanted = sorted({s.underlying for s in snap.series.values()})
        if not wanted:
            return
        self.feed.underlyings = wanted
        if not self._seeded:
            self._seed_feed(snap)
        posted = False
        for d in self.feed.poll(now_ns):
            name = d.underlying.name
            if d.update is None:
                self.status.last_spot_hold[name] = d.hold or "held"
                log.warning("spot %s held: %s", name, d.hold)
                continue
            try:
                self.sender.call(
                    self.contract_id,
                    "post_spot",
                    {
                        "update": d.update.to_json(),
                        "signature": wire.sign(self.agent_key, self.contract_id, d.update),
                    },
                )
            except Exception:
                # The feed recorded this update as posted; put it back in step with the chain.
                self._seeded = False
                raise
            posted = True
            self.status.last_spot_post_ns[name] = d.update.ts_ns
            self.status.last_spot_hold.pop(name, None)
            self.quoter.observe_spot(d.underlying, d.update.price, d.update.ts_ns)
        if posted:
            self._sample_marks(self.cache.refresh(), now_ns)

    def _sample_marks(self, snap: Snapshot, now_ns: int | None) -> None:
        now = now_ns if now_ns is not None else time.time_ns()
        epoch = now // snap.params.funding_interval_ns
        for row in self.quoter.rows(snap, now):
            t = self._twap.get(row.series)
            if t is None or t.epoch != epoch:
                if t is not None and t.n:
                    self._twap_done[row.series] = t
                t = self._twap[row.series] = _Twap(epoch)
            t.total += row.mark
            t.n += 1

    # -- funding ------------------------------------------------------------------------------

    def tick_funding(self, now_ns: int | None = None) -> None:
        now = now_ns if now_ns is not None else time.time_ns()
        snap = self.cache.get()
        interval = snap.params.funding_interval_ns
        epoch = now // interval
        if now - epoch * interval < self.cfg.settle_delay_s * NS:
            return
        rows = {r.series: r for r in self.quoter.rows(snap, now)}
        first_error: Exception | None = None
        sent = 0
        for s in snap.series.values():
            if s.last_epoch >= epoch:
                continue
            if sent >= self.cfg.funding_per_pass:
                break  # the rest on the next pass, after the spot job has had its turn
            row = rows.get(s.id)
            spot = snap.fresh_spot(s.underlying, now)
            if row is None or spot is None:
                log.warning("funding %s epoch %d waits for a fresh spot", s.id, epoch)
                continue
            # Average mark over the epoch that just ended, when we watched it; else the mark now.
            # Either way it must sit in the band around the current spot, as the contract checks.
            done = self._twap_done.get(s.id)
            running = self._twap.get(s.id)
            if done is not None and done.epoch == epoch - 1:
                mark = done.mean()
            elif running is not None and running.epoch == epoch - 1 and running.n:
                mark = running.mean()
            else:
                mark = row.mark
            lo, hi = margin.price_band(s.is_call, spot, s.strike, snap.params.margin)
            mark = max(lo, min(hi, mark))
            intr = margin.intrinsic(s.is_call, spot, s.strike)
            rate = funding_rate(
                mark, intr, self.quoter.cfg.funding_fraction, snap.params.max_funding_rate
            )
            update = FundingUpdate(s.id, epoch, rate, mark)
            sent += 1
            try:
                res = self.sender.call(
                    self.contract_id,
                    "settle_funding",
                    {
                        "update": update.to_json(),
                        "signature": wire.sign(self.agent_key, self.contract_id, update),
                    },
                )
            except Exception as e:  # one series failing must not block the rest
                log.error("funding %s epoch %d failed: %s", s.id, epoch, e)
                first_error = first_error or e
                continue
            per_contract = margin.mul_div_floor(rate, mark, 10**9)
            self.status.last_funding_epoch[s.id] = epoch
            self.store.add_funding(
                {
                    "series": s.id,
                    "epoch": str(epoch),
                    "rate": str(rate),
                    "mark": str(mark),
                    "per_contract": str(per_contract),
                    "index": str(s.funding_index + per_contract),
                    "ts_ns": str(now),
                    "tx_hash": res.tx_hash,
                }
            )
            log.info("funding %s epoch %d rate %d mark %d", s.id, epoch, rate, mark)
        if sent:
            self.cache.refresh()
        if first_error is not None:
            raise first_error

    # -- liquidations -------------------------------------------------------------------------

    def tick_liquidations(self) -> None:
        snap = self.cache.get()
        ratio = snap.params.liquidation_ratio_bps
        for account_id in self.store.takers():
            if account_id == self.sender.account_id:
                continue
            acct = self.cache.view("get_account", {"account_id": account_id})
            if acct is None:
                self.store.remove_taker(account_id)  # emptied and removed on chain
                continue
            if not acct["positions"] or acct["equity"] is None or acct["requirement"] is None:
                continue
            equity, req = int(acct["equity"]), int(acct["requirement"])
            if not (req > 0 and equity * margin.BPS < req * ratio):
                continue
            try:
                self.sender.call(
                    self.contract_id, "liquidate", {"account_id": account_id}, gas=100 * TGAS
                )
            except Exception as e:
                if "liquidator needs an account" in str(e) and not self._warned_no_account:
                    self._warned_no_account = True
                    log.error(
                        "keeper %s cannot liquidate: it needs a deposit in the contract to "
                        "receive rewards",
                        self.sender.account_id,
                    )
                if "not liquidatable" in str(e):
                    continue  # recovered between the view and the call
                raise
            self.status.liquidations += 1
            log.warning("liquidated %s (equity %d, requirement %d)", account_id, equity, req)

    # -- loop ---------------------------------------------------------------------------------

    def run(self, stop: threading.Event) -> None:
        jobs = [
            ("spot", self.tick_spot, self.cfg.spot_interval_s),
            ("funding", self.tick_funding, self.cfg.funding_check_s),
            ("liquidations", self.tick_liquidations, self.cfg.liquidation_interval_s),
        ]
        due = {name: 0.0 for name, _, _ in jobs}
        while not stop.is_set():
            for name, job, every in jobs:
                if time.monotonic() < due[name]:
                    continue
                due[name] = time.monotonic() + every
                try:
                    job()
                    self.status.errors.pop(name, None)
                except Exception as e:
                    self.status.errors[name] = str(e)[:300]
                    log.exception("keeper job %s failed", name)
            stop.wait(0.25)
