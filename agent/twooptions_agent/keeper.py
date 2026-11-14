"""Keeper (#23): posts spot, settles hourly funding and liquidates accounts that can no longer
carry their positions (shorts under the margin ratio, longs that cannot pay their funding).

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
        wait: str = ...,
    ) -> TxResult: ...


@dataclass(frozen=True)
class KeeperConfig:
    spot_interval_s: float = 5.0
    funding_check_s: float = 3.0
    #: Settlements per pass. Each one is a transaction of about 2 s (longer when the RPC is slow)
    #: and the spot must be posted every few seconds, so a backlog is worked off one settlement
    #: at a time between spot posts.
    funding_per_pass: int = 1
    #: Resync the feed when the chain's spot is this many spot intervals older than the last
    #: post sent: posts go out without waiting for their outcome, so a refused one is only
    #: visible this way.
    resync_after_intervals: float = 4.0
    liquidation_interval_s: float = 15.0
    #: Wait this long into a new epoch before settling it, so a slightly fast local clock cannot
    #: name an epoch the chain has not reached ("epoch is not current").
    settle_delay_s: float = 15.0


@dataclass
class KeeperStatus:
    last_spot_post_ns: dict[str, int] = field(default_factory=dict)
    last_spot_hold: dict[str, str] = field(default_factory=dict)
    last_funding_epoch: dict[str, int] = field(default_factory=dict)
    liquidations: int = 0
    #: The most recent liquidations, newest first: account, who sent it, transaction and when.
    liquidated: list[dict[str, str]] = field(default_factory=list)
    errors: dict[str, str] = field(default_factory=dict)

    def to_json(self) -> dict[str, object]:
        return {
            "last_spot_post_ns": {k: str(v) for k, v in self.last_spot_post_ns.items()},
            "last_spot_hold": dict(self.last_spot_hold),
            "last_funding_epoch": dict(self.last_funding_epoch),
            "liquidations": self.liquidations,
            "liquidated": [dict(x) for x in self.liquidated],
            "errors": dict(self.errors),
        }


def pending_funding(positions: list[dict[str, Any]], snap: Snapshot) -> int:
    """Funding an account owes that has not been charged yet, in USDC micros, rounded as the
    contract's `apply_funding` rounds it. Positive means the account pays."""
    owed = 0
    for p in positions:
        s = snap.series.get(str(p.get("series")))
        if s is None or p.get("entry_index") is None:
            continue
        diff = s.funding_index - int(str(p["entry_index"]))
        if diff:
            owed += margin.mul_div_ceil(int(str(p["size"])), diff, margin.SIZE_SCALE)
    return owed


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
        self._seeded = False
        self._warned_no_account = False
        #: Series whose last settlement attempt failed, by epoch: tried after the others, so a
        #: series that keeps failing cannot hold the rest back.
        self._funding_failed: dict[str, int] = {}

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
        interval_ns = int(self.cfg.spot_interval_s * NS)
        for u, sp in snap.spots.items():
            sent = self.status.last_spot_post_ns.get(u.name)
            if (
                self._seeded
                and sent
                and sent - sp.ts_ns > self.cfg.resync_after_intervals * interval_ns
            ):
                log.warning(
                    "spot %s: the chain holds a price %.0f s older than the last post; resyncing",
                    u.name,
                    (sent - sp.ts_ns) / NS,
                )
                self._seeded = False
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
                # Return once the transaction is in a block rather than waiting for it to run:
                # a slow RPC then delays one post by a second or two, not the whole feed.
                self.sender.call(
                    self.contract_id,
                    "post_spot",
                    {
                        "update": d.update.to_json(),
                        "signature": wire.sign(self.agent_key, self.contract_id, d.update),
                    },
                    wait="INCLUDED",
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
            self.cache.refresh()

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
        due = [s for s in snap.series.values() if s.last_epoch < epoch]
        due.sort(key=lambda s: self._funding_failed.get(s.id, -1) == epoch)
        for s in due:
            if sent >= self.cfg.funding_per_pass:
                break  # the rest on the next pass, after the spot job has had its turn
            row = rows.get(s.id)
            spot = snap.fresh_spot(s.underlying, now)
            if row is None or spot is None:
                log.warning("funding %s epoch %d waits for a fresh spot", s.id, epoch)
                continue
            # The current mark. The contract anchors the next hour's trade prices to it and to
            # the spot it records with it, so it must be the price at that spot, not an average.
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
                self._funding_failed[s.id] = epoch
                first_error = first_error or e
                continue
            self._funding_failed.pop(s.id, None)
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
            # The view shows equity before funding the account owes but has not yet been charged;
            # `liquidate` charges it first, so the scan has to count it too. Without this a long
            # whose cash has run out looks solvent for ever: nothing else touches its account.
            owed = pending_funding(acct["positions"], snap)
            equity, req = int(acct["equity"]) - owed, int(acct["requirement"])
            # The contract's test (lib.rs `liquidate`): negative equity, or under the ratio.
            if not (equity < 0 or (req > 0 and equity * margin.BPS < req * ratio)):
                continue
            try:
                res = self.sender.call(
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
            self.status.liquidated.insert(
                0,
                {
                    "account": account_id,
                    "liquidator": self.sender.account_id,
                    "tx_hash": res.tx_hash,
                    "ts_ns": str(time.time_ns()),
                },
            )
            del self.status.liquidated[20:]
            log.warning(
                "liquidated %s in %s (equity %d after %d of funding owed, requirement %d)",
                account_id,
                res.tx_hash,
                equity,
                owed,
                req,
            )

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
