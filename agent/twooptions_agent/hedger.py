"""Delta hedger (#38): keeps a perp position on an external venue equal to the vault's hedge
target, so LPs carry the spread and funding rather than the direction of the market.

    target   = -(sum over series of vault position x delta)        (inventory.py)
    gap      = target - the venue's position
    order    = gap, when it is larger than the deadband, as an immediate-or-cancel order

What this is and is not. The hedge sits in an exchange account the operator holds, not in the
NEAR contract. Its profit and loss does not flow into vault equity or the LP share price. It
lowers the risk LPs carry; it is a trusted, off-chain piece and the app says so.

Rules it follows:

- The venue is the source of truth for the position. It is read every pass and after every
  order; nothing here remembers a position and nothing trusts an order's own answer for it.
- When in doubt it sends nothing: a stale contract spot, an unreadable venue, an asset the venue
  does not list, a venue price far from the contract's spot, or an order whose fate is unknown.
  Holding the last hedge is the safe side: with a stale spot the contract refuses trades, so the
  book it hedges cannot change either.
- When the book is empty the hedge is closed completely, down to the last lot, rather than left
  inside the deadband.
- It never closes a position it did not open. With an empty book, a position that was on the
  account before this process traded there is left alone and reported: it belongs to a
  different agent or to a person. (Checked the hard way: an agent with an empty book closed
  another deployment's hedge.)
- One hedger per exchange account. If the position on the venue changes without an order from
  this hedger, something else is trading the account (a second agent, a person, the venue's own
  liquidation). It then stops for that asset until the agent is restarted, instead of trading
  against whatever it is. Seen on Nov 14: two hedgers with different books on one account bought
  and sold the same 0.585 ETH seven times in 70 seconds.
- Orders never rest. Each is immediate-or-cancel with a price limit and an expiry, so a request
  that is delayed in transit is refused by the venue instead of filling late, and the next pass
  works from the position actually held.
- It runs on its own thread. A slow venue must not delay the keeper's spot posts.

Costs, and why the no-trade band follows gamma. Each rebalance pays half the venue's spread plus
its taker fee. When traders are net long options the vault is short gamma, so hedging buys
after rises and sells after falls; the funding the vault collects is what pays for that. These
options live about a day, so their delta moves fast: a band fixed in dollars re-trades on every
few basis points of spot. On Nov 14 a 25 USD band made 41 fills and traded about 5,000 USD in
21 minutes to hedge options worth 11 USD. The band is therefore the larger of the dollar
deadband and the delta drift that a `rehedge_move_bps` move in spot causes (gamma x spot x
move). Between re-hedges the vault carries that drift; a wider band trades less and tracks
worse.
"""

from __future__ import annotations

import logging
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Protocol

from . import inventory
from .chain import ChainCache
from .hyperliquid import AccountState, Asset, OrderResult, floor_size, round_price, to_wire
from .quoter import Quoter
from .store import Store

log = logging.getLogger(__name__)

SPOT_SCALE = 10**8


class Venue(Protocol):
    """The part of `hyperliquid.Hyperliquid` the hedger needs."""

    name: str
    network: str
    account: str

    def assets(self) -> dict[str, Asset]: ...

    def mids(self) -> dict[str, Decimal]: ...

    def state(self) -> AccountState: ...

    def ioc(
        self,
        coin: str,
        is_buy: bool,
        size: Decimal,
        limit_px: Decimal,
        reduce_only: bool,
        expires_after_ms: int,
        cloid: str | None = None,
    ) -> OrderResult: ...


@dataclass(frozen=True)
class HedgeConfig:
    interval_s: float = 5.0
    #: No order while the gap is worth less than this. Below it, trading costs more than the
    #: risk it removes.
    deadband_usd: float = 25.0
    #: Nor while the gap is smaller than the delta drift a spot move of this size causes
    #: (|gamma| x spot x move). 50 bps is about a sixth of ETH's daily standard deviation.
    rehedge_move_bps: float = 50.0
    #: The venue's smallest order.
    min_order_usd: float = 10.0
    #: Largest single order; a bigger gap is worked off over several passes.
    max_order_usd: float = 5_000.0
    #: The hedge never grows past this, whatever the target says.
    max_position_usd: float = 50_000.0
    #: How far through the mid an order may fill.
    slippage_bps: float = 100.0
    #: Hold when the venue's mid is further than this from the contract's spot: one of the two
    #: prices is wrong, and a hedge placed against the wrong one is a new position, not a hedge.
    max_basis_bps: float = 500.0
    #: An order is refused by the venue this long after it was signed.
    order_ttl_s: float = 8.0
    #: After the venue refuses an order, wait before trying that asset again.
    reject_backoff_s: float = 30.0
    #: When the venue's position is not the one this hedger left, read it once more after this
    #: long before concluding that something else is trading the account.
    recheck_s: float = 1.0


@dataclass(frozen=True)
class Decision:
    #: "balanced" (nothing to do), "trade" or "hold" (something is wrong; send nothing).
    state: str
    reason: str
    #: Signed order size in units of the underlying; positive buys.
    size: Decimal = Decimal(0)
    reduce_only: bool = False
    #: The target after the position limit, when one could be computed.
    target: float | None = None
    basis_bps: float | None = None
    #: Half-width of the no-trade band, in units of the underlying.
    band: float | None = None


def decide(
    target: float | None,
    position: Decimal,
    mid: Decimal | None,
    spot_usd: float | None,
    sz_decimals: int,
    cfg: HedgeConfig,
    net_gamma: float = 0.0,
) -> Decision:
    """What to do about one underlying. Pure: every input is passed in. `net_gamma` is the
    change in the vault's delta per 1 USD move in spot."""
    if target is None or spot_usd is None or spot_usd <= 0:
        return Decision("hold", "the contract's spot is stale or missing")
    if mid is None or mid <= 0:
        return Decision("hold", "the venue has no price for this asset")
    m = float(mid)
    basis = (m / spot_usd - 1.0) * 10_000
    if abs(basis) > cfg.max_basis_bps:
        return Decision(
            "hold",
            f"venue price is {basis:+.0f} bps from the contract's spot "
            f"(limit {cfg.max_basis_bps:.0f})",
            basis_bps=basis,
        )
    limit = cfg.max_position_usd / m
    capped = max(-limit, min(limit, target))
    note = "" if capped == target else " (target capped at the position limit)"
    gap = capped - float(position)
    if capped == 0 and net_gamma == 0 and position != 0:
        # Nothing is left to hedge, so nothing is gained by tolerating a remainder: close all of
        # it. The venue accepts a reduce-only order that closes a whole position even under its
        # minimum order size (checked on testnet with an 8.52 USD close), so no dust is left.
        size = min(abs(position), floor_size(Decimal(repr(cfg.max_order_usd / m)), sz_decimals))
        signed = -size if position > 0 else size
        return Decision(
            "trade", "closing the hedge: the book is flat", signed, True, 0.0, basis, 0.0
        )
    dollar_band = max(cfg.deadband_usd, cfg.min_order_usd) / m
    gamma_band = abs(net_gamma) * m * cfg.rehedge_move_bps / 10_000
    band = max(dollar_band, gamma_band)
    if abs(gap) <= band:
        why = "inside the deadband" if band == dollar_band else "inside the gamma band"
        return Decision("balanced", why + note, target=capped, basis_bps=basis, band=band)
    size = floor_size(Decimal(repr(min(abs(gap), cfg.max_order_usd / m))), sz_decimals)
    if size * mid < Decimal(repr(cfg.min_order_usd)):
        return Decision(
            "balanced",
            "below the venue's minimum order" + note,
            target=capped,
            basis_bps=basis,
            band=band,
        )
    signed = size if gap > 0 else -size
    # Reduce-only when the order only shrinks the position: the venue then refuses to let a
    # late or duplicated order open exposure in the other direction.
    reduce_only = position != 0 and (signed > 0) != (position > 0) and size <= abs(position)
    return Decision("trade", "rebalancing" + note, signed, reduce_only, capped, basis, band)


class Hedger:
    def __init__(
        self,
        venue: Venue,
        cache: ChainCache,
        quoter: Quoter,
        store: Store,
        cfg: HedgeConfig | None = None,
        clock: Callable[[], int] = time.time_ns,
    ):
        self.venue = venue
        self.cache = cache
        self.quoter = quoter
        self.store = store
        self.cfg = cfg or HedgeConfig()
        self._clock = clock
        self._lock = threading.Lock()
        self._rows: dict[str, dict[str, Any]] = {}
        self._account: dict[str, str] = {}
        self._error: str | None = None
        self._updated_ns = 0
        #: Per asset: no new order before this time (ms). Set when an order's fate is unknown
        #: (until it has expired on the venue) and after a refusal (back-off).
        self._blocked_until_ms: dict[str, int] = {}
        #: Per asset: the position this hedger left on the venue, as a closed range. A single
        #: value normally; a range after an order whose outcome is unknown. Unset until the
        #: first pass, which adopts whatever the account holds.
        self._expected: dict[str, tuple[Decimal, Decimal]] = {}
        #: Per asset: why hedging is stopped, once the position was seen to change without an
        #: order from this hedger. Cleared only by a restart.
        self._foreign: dict[str, str] = {}
        #: Assets this process has sent an order for. Only their positions are its to close.
        self._traded: set[str] = set()

    # -- one pass -----------------------------------------------------------------------------

    def tick(self) -> None:
        now = self._clock()
        snap = self.cache.get()
        underlyings = sorted({s.underlying for s in snap.series.values()})
        inv = inventory.from_snapshot(snap, self.quoter, now)
        # Any of these failing ends the pass before an order: no position, no trade.
        assets = self.venue.assets()
        mids = self.venue.mids()
        state = self.venue.state()

        rows: dict[str, dict[str, Any]] = {}
        for u in underlyings:
            coin = u.name
            spot = snap.fresh_spot(u, now)
            stale = spot is None or coin in inv.missing_spot
            target = None if stale else inv.hedge_target.get(coin, 0.0)
            held = state.positions.get(coin)
            position = held.size if held else Decimal(0)
            left = self._expected.get(coin)
            if (
                coin not in self._foreign
                and left is not None
                and not left[0] <= position <= left[1]
            ):
                time.sleep(self.cfg.recheck_s)  # this hedger's own fill may not be visible yet
                state = self.venue.state()
                held = state.positions.get(coin)
                position = held.size if held else Decimal(0)
                if not left[0] <= position <= left[1]:
                    was = to_wire(left[0]) if left[0] == left[1] else f"{to_wire(left[0])}..{to_wire(left[1])}"  # fmt: skip
                    self._foreign[coin] = (
                        f"the position on the venue went from {was} to {to_wire(position)} with no "
                        "order from this hedger, so something else is trading this account; "
                        "hedging is stopped until the agent is restarted"
                    )
                    log.error("hedger stopped for %s: %s", coin, self._foreign[coin])
            asset = assets.get(coin)
            book_is_empty = target == 0 and inv.net_gamma.get(coin, 0.0) == 0
            if coin in self._foreign:
                d = Decision("hold", self._foreign[coin])
            elif position != 0 and book_is_empty and coin not in self._traded:
                d = Decision(
                    "hold",
                    f"the account holds {to_wire(position)} {coin} that this agent did not open, "
                    "and its own book is empty, so it leaves the position alone; it belongs to "
                    "another agent or was opened by hand",
                    target=0.0,
                )
            elif asset is None:
                d = Decision("hold", f"{self.venue.name} does not list {coin}")
            else:
                spot_usd = spot / SPOT_SCALE if spot is not None else None
                d = decide(
                    target,
                    position,
                    mids.get(coin),
                    spot_usd,
                    asset.sz_decimals,
                    self.cfg,
                    inv.net_gamma.get(coin, 0.0),
                )
            if d.state == "trade" and now // 1_000_000 < self._blocked_until_ms.get(coin, 0):
                d = Decision(
                    "hold",
                    "waiting after an order that was refused or whose outcome is unknown",
                    target=d.target,
                    basis_bps=d.basis_bps,
                    band=d.band,
                )
            if d.state == "trade" and asset is not None:
                self._traded.add(coin)
                try:
                    res = self._send(coin, asset, d, mids[coin])
                except Exception:
                    # Unknown outcome: anything from untouched to fully filled is this hedger's.
                    lo, hi = sorted((position, position + d.size))
                    self._expected[coin] = (lo, hi)
                    raise
                # What this order did, from its own answer. Only used to tell this hedger's fills
                # from someone else's on the next pass; the position shown and hedged is always
                # the venue's.
                after = position + (res.filled if d.size > 0 else -res.filled)
                self._expected[coin] = (after, after)
                state = self.venue.state()  # the venue, not the order's answer, says what we hold
                held = state.positions.get(coin)
                position = held.size if held else Decimal(0)
            elif coin not in self._foreign:
                self._expected[coin] = (position, position)
            shown = d.target if d.target is not None else target
            rows[coin] = {
                "target": None if shown is None else round(shown, 6),
                "position": to_wire(position),
                "gap": None if shown is None else round(shown - float(position), 6),
                "band": None if d.band is None else round(d.band, 6),
                "state": d.state,
                "reason": d.reason,
                "venue_mid": None if mids.get(coin) is None else str(mids[coin]),
                "basis_bps": None if d.basis_bps is None else round(d.basis_bps, 1),
                "entry_px": None if held is None or held.entry_px is None else str(held.entry_px),
                "unrealized_pnl": None if held is None else str(held.unrealized_pnl),
            }
        with self._lock:
            self._rows = rows
            self._account = {
                "account_value": str(state.account_value),
                "margin_used": str(state.margin_used),
                "withdrawable": str(state.withdrawable),
            }
            self._updated_ns = now
            self._error = None

    def _send(self, coin: str, asset: Asset, d: Decision, mid: Decimal) -> OrderResult:
        is_buy = d.size > 0
        size = abs(d.size)
        slip = Decimal(repr(self.cfg.slippage_bps)) / 10_000
        limit_px = round_price(mid * (1 + slip if is_buy else 1 - slip), asset.sz_decimals)
        sent_ns = self._clock()
        expires_ms = sent_ns // 1_000_000 + int(self.cfg.order_ttl_s * 1_000)
        cloid = "0x" + secrets.token_hex(16)
        event: dict[str, Any] = {
            "ts_ns": str(sent_ns),
            "venue": self.venue.name,
            "coin": coin,
            "side": "buy" if is_buy else "sell",
            "size": to_wire(size),
            "limit_px": to_wire(limit_px),
            "reduce_only": d.reduce_only,
            "cloid": cloid,
        }
        try:
            res = self.venue.ioc(coin, is_buy, size, limit_px, d.reduce_only, expires_ms, cloid)
        except Exception as e:
            # It may or may not have reached the venue. It cannot fill after it expires, so no
            # new order for this asset until then; the position read decides what happens next.
            self._blocked_until_ms[coin] = expires_ms + 1_000
            self.store.add_hedge_order({**event, "status": "unknown", "detail": str(e)[:200]})
            raise
        if res.status == "rejected":
            self._blocked_until_ms[coin] = sent_ns // 1_000_000 + int(
                self.cfg.reject_backoff_s * 1_000
            )
        self.store.add_hedge_order(
            {
                **event,
                "status": res.status,
                "filled": to_wire(res.filled),
                "avg_px": None if res.avg_px is None else str(res.avg_px),
                "oid": res.oid,
                "detail": res.detail,
            }
        )
        log.info(
            "hedge %s %s %s @ <= %s: %s filled %s%s",
            event["side"],
            event["size"],
            coin,
            event["limit_px"],
            res.status,
            res.filled,
            f" ({res.detail})" if res.detail else "",
        )
        return res

    # -- reporting ----------------------------------------------------------------------------

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "enabled": True,
                "venue": self.venue.name,
                "network": self.venue.network,
                "account": self.venue.account,
                "updated_ns": str(self._updated_ns),
                "error": self._error,
                **self._account,
                "underlyings": {k: dict(v) for k, v in self._rows.items()},
                "orders": self.store.hedge_orders(20),
                "limits": {
                    "deadband_usd": self.cfg.deadband_usd,
                    "rehedge_move_bps": self.cfg.rehedge_move_bps,
                    "max_order_usd": self.cfg.max_order_usd,
                    "max_position_usd": self.cfg.max_position_usd,
                    "slippage_bps": self.cfg.slippage_bps,
                    "max_basis_bps": self.cfg.max_basis_bps,
                },
            }

    # -- loop ---------------------------------------------------------------------------------

    def run(self, stop: threading.Event) -> None:
        while not stop.is_set():
            try:
                self.tick()
            except Exception as e:
                text = f"{type(e).__name__}: {e}"[:300]
                with self._lock:
                    repeated = text == self._error
                    self._error = text
                if repeated:
                    log.debug("hedger pass failed again: %s", text)
                else:
                    log.exception("hedger pass failed; no order sent")
            stop.wait(self.cfg.interval_s)
