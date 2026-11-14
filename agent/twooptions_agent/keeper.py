"""Keeper: posts spot, settles hourly funding and liquidates accounts that can no longer
carry their positions (shorts under the margin ratio, longs that cannot pay their funding).

Three jobs on one thread, each isolated: a failure in one is logged and retried on its next
turn and never stops the others. All of them go through one NEAR account, one transaction at a
time, because access-key nonces must increase one by one.

No job may hold the thread for long, because the spot must be posted every few seconds or the
contract stops trading. Funding settles one series per pass, and the liquidation scan reads for
a bounded time per pass.

The scan has two forms. A contract that keeps an index of its accounts is asked, a page at a
time, which of them it would let be liquidated (`list_liquidatable`): the contract applies its
own test, so every account is covered and nothing here depends on a file. A contract from
before the index cannot list its accounts, so there the keeper reads, one RPC call each, the
accounts this agent has quoted for (its watch list), most urgent first.

What the keeper can and cannot do: it relays messages signed by the agent key. The contract
checks every signature and bounds every number, so a keeper bug can delay a spot or a funding
settlement but cannot move a price outside the contract's limits.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
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
    #: How often the liquidation scan gets a turn, and how long a turn may spend reading
    #: accounts. Whatever is still due waits for the next turn, most urgent first.
    liquidation_interval_s: float = 3.0
    liquidation_budget_s: float = 2.0
    #: An account with open positions is read again after this long,
    recheck_s: float = 15.0
    #: on every turn once its equity is within this factor of the point of liquidation,
    near_factor: float = 1.25
    #: and after this long when it holds nothing: it has to trade before it can be liquidated.
    recheck_idle_s: float = 120.0
    #: An account this agent quoted may be about to trade, so for this long it is read as if it
    #: held positions.
    quoted_watch_s: float = 180.0
    #: Accounts per `list_liquidatable` call. Halved when a call runs out of gas.
    liquidation_page: int = 100
    #: How long to wait before asking a contract without the account index whether it has
    #: been upgraded.
    reprobe_s: float = 600.0
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
    #: The liquidation scan: accounts watched, how many hold positions, how many reads are
    #: due, and how late the most overdue read of an account with positions is, in seconds.
    watch: dict[str, object] = field(default_factory=dict)
    errors: dict[str, str] = field(default_factory=dict)

    def to_json(self) -> dict[str, object]:
        return {
            "last_spot_post_ns": {k: str(v) for k, v in self.last_spot_post_ns.items()},
            "last_spot_hold": dict(self.last_spot_hold),
            "last_funding_epoch": dict(self.last_funding_epoch),
            "liquidations": self.liquidations,
            "liquidated": [dict(x) for x in self.liquidated],
            "watch": dict(self.watch),
            "errors": dict(self.errors),
        }


#: How urgently an account is read: close to liquidation, holding positions (or not read yet),
#: holding nothing.
NEAR, OPEN, IDLE = 0, 1, 2
#: A long has no requirement to measure against; under this much equity (USDC micros) it is
#: treated as close to liquidation.
NEAR_EQUITY = 1_000_000


@dataclass
class Watch:
    """One account on the liquidation watch list."""

    due: float = 0.0  # when to read it next, on the keeper's clock; 0 is "now"
    tier: int = OPEN
    quoted: float = float("-inf")  # when this agent last quoted it


#: What an RPC node answers when a contract has no such method: a contract from before the index.
NO_SUCH_METHOD = ("MethodNotFound", "MethodResolveError")
#: What it answers when a view ran out of gas: the page was too large.
OUT_OF_GAS = ("GasLimitExceeded", "GasExceeded", "Exceeded the prepaid gas")
MIN_PAGE = 5
#: Account ids per `index_accounts` call (the contract accepts up to 100).
INDEX_BATCH = 50


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
        clock: Callable[[], float] = time.monotonic,
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
        self._clock = clock
        self._watch: dict[str, Watch] = {}
        self._watch_lock = threading.Lock()
        #: Whether the contract keeps an index of its accounts; None until it has been asked.
        self._indexed: bool | None = None
        self._probed = float("-inf")
        self._cursor = 0
        self._page = self.cfg.liquidation_page
        self._round_done = clock()
        self._round_s = 0.0
        #: Watch-list accounts not yet offered to the contract's index (None: not yet read).
        self._backfill: list[str] | None = None
        self._report_watch()  # so /health has the fields before the first turn of the scan

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

    def touch(self, account_id: str) -> None:
        """This agent has just quoted `account_id`: read it soon, and keep reading it as if it
        held positions for a while, because a trade may follow. Safe from any thread."""
        with self._watch_lock:
            w = self._watch.setdefault(account_id, Watch())
            w.quoted = self._clock()
            if w.tier == IDLE:
                w.tier = OPEN
                w.due = min(w.due, w.quoted + self.cfg.recheck_s)

    def tick_liquidations(self) -> None:
        """One turn of the scan, through the contract's index when it has one."""
        if self._has_index():
            self._scan_index()
        else:
            self._scan_watch_list()

    def _has_index(self) -> bool:
        """Whether the contract lists its accounts. A contract without the index is asked again
        now and then, so an upgrade is picked up without a restart."""
        now = self._clock()
        if self._indexed is None or (
            not self._indexed and now - self._probed >= self.cfg.reprobe_s
        ):
            try:
                self.cache.view("get_account_count", None)
            except Exception as e:
                if not any(m in str(e) for m in NO_SUCH_METHOD):
                    raise  # the RPC failed: still unknown, ask again next turn
                if self._indexed is None:
                    log.warning(
                        "the contract has no account index: liquidations cover only the "
                        "accounts this agent has quoted for"
                    )
                self._indexed = False
            else:
                if not self._indexed:
                    log.info("the contract lists its accounts: scanning through its index")
                self._indexed = True
            self._probed = now
        return bool(self._indexed)

    def _scan_index(self) -> None:
        """Ask the contract, a page at a time, which accounts it would let be liquidated, and
        liquidate them. The pages of one round are spread over as many turns as they need."""
        started = self._clock()
        if self._offer_watch_list():
            return  # that was a transaction: the turn's time is spent
        total = int(self.cache.view("get_account_count", None))
        first_error: Exception | None = None
        pages = 0
        while total and not (pages and self._clock() - started >= self.cfg.liquidation_budget_s):
            try:
                ids = self.cache.view(
                    "list_liquidatable", {"from_index": self._cursor, "limit": self._page}
                )
            except Exception as e:
                if any(m in str(e) for m in OUT_OF_GAS) and self._page > MIN_PAGE:
                    self._page = max(MIN_PAGE, self._page // 2)
                    log.warning("list_liquidatable ran out of gas: page is now %d", self._page)
                    break  # the same accounts again next turn, in smaller pages
                raise
            pages += 1
            self._cursor += self._page
            for account_id in ids:
                if account_id == self.sender.account_id:
                    continue
                try:
                    self._liquidate(account_id)
                except Exception as e:  # one account failing must not hide the others
                    first_error = first_error or e
            if self._cursor >= total:
                now = self._clock()
                self._cursor, self._round_s, self._round_done = 0, now - self._round_done, now
                break  # one round at most per turn
            if ids:
                break  # liquidating took the turn's time
        if not total:
            self._round_done = self._clock()
        self.status.watch = {
            "source": "contract",
            "accounts": total,
            "page": self._page,
            "round_s": round(self._round_s, 1),
            "behind_s": round(max(0.0, self._clock() - self._round_done - self.cfg.recheck_s), 1),
        }
        if first_error is not None:
            raise first_error

    def _offer_watch_list(self) -> bool:
        """Accounts opened before the contract kept its index are not in it until they act or
        are added. Offer the ones this agent knows, one batch per turn; the contract adds those
        that exist and are not listed yet. Returns whether a batch was sent."""
        if self._backfill is None:
            self._backfill = self.store.takers()
        if not self._backfill:
            return False
        batch = self._backfill[:INDEX_BATCH]
        res = self.sender.call(
            self.contract_id, "index_accounts", {"account_ids": batch}, gas=100 * TGAS
        )
        del self._backfill[:INDEX_BATCH]
        log.info(
            "offered %d watch-list accounts to the contract's index in %s", len(batch), res.tx_hash
        )
        return True

    def _scan_watch_list(self) -> None:
        """One turn of the scan: read the accounts that are due, most urgent first, until the
        turn's time is up. An account whose read or liquidation fails is tried again on its
        next turn; the first such error is raised once the others have had theirs."""
        snap = self.cache.get()
        started = self._clock()
        takers = [a for a in self.store.takers() if a != self.sender.account_id]
        with self._watch_lock:
            for gone in set(self._watch).difference(takers):
                del self._watch[gone]
            for a in takers:
                self._watch.setdefault(a, Watch())
            # Most urgent first; among equals, in the order they joined the watch list.
            due = [(self._watch[a].tier, self._watch[a].due, a) for a in takers]
            due = sorted((x for x in due if x[1] <= started), key=lambda x: x[:2])
        first_error: Exception | None = None
        for n, (_, _, account_id) in enumerate(due):
            if n and self._clock() - started >= self.cfg.liquidation_budget_s:
                break
            try:
                tier = self._check_account(account_id, snap)
            except Exception as e:  # one account failing must not hide the others
                first_error = first_error or e
                tier = OPEN
            now = self._clock()
            with self._watch_lock:
                w = self._watch.get(account_id)
                if w is None or tier is None:
                    self._watch.pop(account_id, None)
                    continue
                if tier == IDLE and now - w.quoted < self.cfg.quoted_watch_s:
                    tier = OPEN
                w.tier = tier
                w.due = now + (
                    self.cfg.recheck_idle_s
                    if tier == IDLE
                    else self.cfg.recheck_s
                    if tier == OPEN
                    else 0.0
                )
        self._report_watch()
        if first_error is not None:
            raise first_error

    def _report_watch(self) -> None:
        now = self._clock()
        with self._watch_lock:
            watched = list(self._watch.values())
        late = [now - w.due for w in watched if w.tier != IDLE and w.due > 0]
        self.status.watch = {
            "source": "watch list",
            "accounts": len(watched),
            "with_positions": sum(w.tier != IDLE for w in watched),
            "due": sum(w.due <= now for w in watched),
            "behind_s": round(max([0.0, *late]), 1),
        }

    def _check_account(self, account_id: str, snap: Snapshot) -> int | None:
        """Read one account and liquidate it if the contract would allow it. Returns how
        urgently to read it again, or None when the account no longer exists."""
        ratio = snap.params.liquidation_ratio_bps
        acct = self.cache.view("get_account", {"account_id": account_id})
        if acct is None:
            self.store.remove_taker(account_id)  # emptied and removed on chain
            return None
        if not acct["positions"]:
            return IDLE
        if acct["equity"] is None or acct["requirement"] is None:
            return OPEN  # the contract cannot value it now (stale spot); read again soon
        # The view shows equity before funding the account owes but has not yet been charged;
        # `liquidate` charges it first, so the scan has to count it too. Without this a long
        # whose cash has run out looks solvent for ever: nothing else touches its account.
        owed = pending_funding(acct["positions"], snap)
        equity, req = int(acct["equity"]) - owed, int(acct["requirement"])
        # The contract's test (lib.rs `liquidate`): negative equity, or under the ratio.
        if not (equity < 0 or (req > 0 and equity * margin.BPS < req * ratio)):
            near = (
                equity * margin.BPS < req * ratio * self.cfg.near_factor
                if req > 0
                else equity < NEAR_EQUITY
            )
            return NEAR if near else OPEN
        self._liquidate(
            account_id, f"equity {equity} after {owed} of funding owed, requirement {req}"
        )
        return NEAR  # read it again at once: it may need a second pass, or be gone

    def _liquidate(self, account_id: str, why: str = "named by the contract") -> None:
        """Send `liquidate` for one account and record it. An account that recovered between
        the read and the call is not an error."""
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
                return
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
        log.warning("liquidated %s in %s (%s)", account_id, res.tx_hash, why)

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
