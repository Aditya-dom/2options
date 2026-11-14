"""The hedger against a fake venue that refuses what the real one would (bad tick or lot, an
order under the minimum, an expired order, a reduce-only order that would open exposure)."""

import json
import os
import random
import threading
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from twooptions_agent import hyperliquid as hl
from twooptions_agent.chain import ChainCache
from twooptions_agent.hedger import Decision, HedgeConfig, Hedger, decide
from twooptions_agent.quoter import Quoter
from twooptions_agent.store import Store

from .fakes import CONTRACT, SEC, FakeChain

KEY = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
ONE = 10**6
CFG = HedgeConfig()
D = Decimal


# ---------------------------------------------------------------------------------------------
# decide(): one underlying, every input passed in
# ---------------------------------------------------------------------------------------------


def d(target: float | None, position: str, mid: str | None = "2000", spot: float | None = 2_000.0,
      cfg: HedgeConfig = CFG) -> Decision:  # fmt: skip
    return decide(target, D(position), None if mid is None else D(mid), spot, 4, cfg)


def test_a_gap_beyond_the_deadband_is_traded_in_full_and_floored_to_the_lot() -> None:
    got = d(2.20009, "0")
    assert (got.state, got.size, got.reduce_only) == ("trade", D("2.2000"), False)
    got = d(-1.5, "0.25")
    assert (got.state, got.size, got.reduce_only) == ("trade", D("-1.7500"), False)


def test_inside_the_deadband_nothing_trades() -> None:
    # 25 USD at a 2,000 mid is 0.0125 ETH.
    assert d(0.512, "0.5").state == "balanced"
    assert d(0.5125, "0.5").state == "balanced"  # exactly at the edge: still no trade
    assert d(0.513, "0.5").state == "trade"
    assert d(0.0, "0").state == "balanced"


def test_the_band_widens_with_gamma_so_a_short_dated_book_is_not_re_traded_on_noise() -> None:
    """Gamma 0.02 ETH per USD (three one-day ATM contracts at 2,000): a 50 bps move in spot,
    10 USD, shifts delta by 0.2 ETH. Smaller drifts than that are left alone."""
    g = 0.02
    held = d(0.69, "0.5", cfg=CFG)  # 380 USD of gap: far outside the 25 USD band on its own
    assert held.state == "trade"
    inside = decide(0.69, D("0.5"), D("2000"), 2_000.0, 4, CFG, g)
    assert (inside.state, inside.reason) == ("balanced", "inside the gamma band")
    assert inside.band == pytest.approx(0.2)
    outside = decide(0.75, D("0.5"), D("2000"), 2_000.0, 4, CFG, g)
    assert (outside.state, outside.size) == ("trade", D("0.2500"))
    # The sign of gamma does not matter, and the band follows the configured move.
    assert decide(0.69, D("0.5"), D("2000"), 2_000.0, 4, CFG, -g).state == "balanced"
    tight = HedgeConfig(rehedge_move_bps=10.0)
    assert decide(0.69, D("0.5"), D("2000"), 2_000.0, 4, tight, g).state == "trade"
    # With no gamma left (the book closed) only the dollar band applies, so the hedge is
    # flattened promptly.
    flat = decide(0.0, D("0.19"), D("2000"), 2_000.0, 4, CFG, 0.0)
    assert (flat.state, flat.size, flat.reduce_only) == ("trade", D("-0.1900"), True)


def test_an_empty_book_closes_the_hedge_completely_even_under_the_venue_minimum() -> None:
    """Seen live: 0.0045 ETH (8.52 USD) was left on the venue after the book closed, inside the
    25 USD deadband and under the 10 USD minimum. The venue takes a reduce-only order that closes
    a whole position at any size, so the hedger sends one."""
    dust = decide(0.0, D("0.0045"), D("1893.9"), 1_900.0, 4, CFG, 0.0)
    assert (dust.state, dust.size, dust.reduce_only) == ("trade", D("-0.0045"), True)
    assert dust.reason == "closing the hedge: the book is flat" and dust.band == 0.0
    short = decide(0.0, D("-0.0045"), D("1893.9"), 1_900.0, 4, CFG, 0.0)
    assert (short.size, short.reduce_only) == (D("0.0045"), True)
    # While options are still open (gamma is not zero) a small remainder is ordinary drift.
    assert decide(0.0, D("0.0045"), D("1893.9"), 1_900.0, 4, CFG, 0.01).state == "balanced"
    assert decide(0.004, D("0.0045"), D("1893.9"), 1_900.0, 4, CFG, 0.0).state == "balanced"
    # Nothing held: nothing to do. A large remainder is still closed in capped orders.
    assert decide(0.0, D("0"), D("1893.9"), 1_900.0, 4, CFG, 0.0).state == "balanced"
    big = decide(0.0, D("10"), D("2000"), 2_000.0, 4, CFG, 0.0)
    assert (big.size, big.reduce_only) == (D("-2.5000"), True)
    # The safety checks still come first.
    assert decide(0.0, D("0.0045"), D("2400"), 1_900.0, 4, CFG, 0.0).state == "hold"


def test_an_order_under_the_venue_minimum_is_not_sent() -> None:
    # A deadband of zero still cannot send less than the venue's 10 USD minimum.
    tight = HedgeConfig(deadband_usd=0.0)
    assert d(0.004, "0", cfg=tight).state == "balanced"  # 8 USD
    assert d(0.0051, "0", cfg=tight).state == "trade"  # 10.2 USD
    # 10.015 USD of gap, but the lot floors the order to 0.0050 ETH = 9.995 USD.
    got = d(0.00501, "0", mid="1999", spot=1_999.0, cfg=tight)
    assert got.state == "balanced" and "minimum order" in got.reason


def test_orders_and_the_position_are_capped() -> None:
    got = d(10.0, "0")  # 20,000 USD of gap, 5,000 USD per order
    assert (got.state, got.size) == ("trade", D("2.5000"))
    got = d(40.0, "24.9")  # the position limit is 50,000 USD = 25 ETH
    assert got.target == 25.0 and got.size == D("0.1000") and "capped" in got.reason
    got = d(-40.0, "-25")
    assert got.state == "balanced" and got.target == -25.0


def test_reduce_only_exactly_when_the_order_only_shrinks_the_position() -> None:
    assert d(0.0, "0.5").reduce_only is True  # flatten a long
    assert d(0.2, "0.5").reduce_only is True  # trim a long
    assert d(0.0, "-0.5").reduce_only is True  # flatten a short
    assert d(-0.3, "0.5").reduce_only is False  # through zero: opens a short
    assert d(0.9, "0.5").reduce_only is False  # adds to a long
    assert d(0.5, "0").reduce_only is False


@pytest.mark.parametrize(
    ("kwargs", "why"),
    [
        ({"target": None}, "stale"),
        ({"spot": None}, "stale"),
        ({"spot": 0.0}, "stale"),
        ({"mid": None}, "no price"),
        ({"mid": "0"}, "no price"),
        ({"mid": "2101"}, "bps from the contract's spot"),  # +505 bps
        ({"mid": "1899"}, "bps from the contract's spot"),  # -505 bps
    ],
)
def test_it_holds_when_an_input_cannot_be_trusted(kwargs: dict[str, Any], why: str) -> None:
    args: dict[str, Any] = {"target": 2.0, "position": "0", "mid": "2000", "spot": 2_000.0}
    got = d(**{**args, **kwargs})
    assert got.state == "hold" and got.size == 0 and why in got.reason


def test_a_basis_inside_the_limit_trades_and_is_reported() -> None:
    got = d(2.0, "0", mid="2099")  # +495 bps against a limit of 500
    assert got.state == "trade" and got.basis_bps == pytest.approx(495.0)
    got = d(2.0, "0", mid="1901")
    assert got.state == "trade" and got.basis_bps == pytest.approx(-495.0)


# ---------------------------------------------------------------------------------------------
# Hedger: fake chain + fake venue
# ---------------------------------------------------------------------------------------------


class FakeVenue:
    name = "hyperliquid"
    network = "testnet"
    account = "0x" + "11" * 20

    def __init__(self, clock: Any) -> None:
        self.clock = clock
        self.listed = {"ETH": hl.Asset("ETH", 4, 4), "BTC": hl.Asset("BTC", 3, 5)}
        self.mid = D("2100")
        self.position = D(0)
        self.orders: list[dict[str, Any]] = []
        self.fail_reads = False
        #: Raised by `ioc` after the order has (or has not) been applied.
        self.ioc_error: Exception | None = None
        self.lands_despite_error = False
        self.reject: str | None = None
        self.fill_fraction = D(1)
        #: This many reads still show `lag_position`, as when a fill is not visible yet.
        self.lag_reads = 0
        self.lag_position = D(0)

    def assets(self) -> dict[str, hl.Asset]:
        return self.listed

    def mids(self) -> dict[str, Decimal]:
        if self.fail_reads:
            raise hl.TransportError("/info: timed out")
        return {"ETH": self.mid}

    def state(self) -> hl.AccountState:
        if self.fail_reads:
            raise hl.TransportError("/info: timed out")
        shown = self.position
        if self.lag_reads > 0:
            self.lag_reads -= 1
            shown = self.lag_position
        pos = {"ETH": hl.Position("ETH", shown, D("2100"), D("0"))} if shown else {}
        return hl.AccountState(D("1000"), D("0"), D("1000"), pos)

    def _apply(self, is_buy: bool, size: Decimal) -> Decimal:
        filled = hl.floor_size(size * self.fill_fraction, 4)
        self.position += filled if is_buy else -filled
        return filled

    def ioc(
        self,
        coin: str,
        is_buy: bool,
        size: Decimal,
        limit_px: Decimal,
        reduce_only: bool,
        expires_after_ms: int,
        cloid: str | None = None,
    ) -> hl.OrderResult:
        self.orders.append(
            {"coin": coin, "is_buy": is_buy, "size": size, "limit_px": limit_px,
             "reduce_only": reduce_only, "expires_after_ms": expires_after_ms, "cloid": cloid}
        )  # fmt: skip
        # What the real venue refuses.
        assert size > 0 and size == hl.floor_size(size, 4), "size is not a multiple of the lot"
        assert limit_px == hl.round_price(limit_px, 4), "price is not on the tick"
        # The venue's 10 USD minimum does not apply to a reduce-only order closing the position.
        closes_all = reduce_only and size == abs(self.position)
        assert size * self.mid >= 10 or closes_all, "order under the venue minimum"
        assert expires_after_ms > self.clock() // 1_000_000, "order already expired"
        assert (limit_px >= self.mid) if is_buy else (limit_px <= self.mid), "would not cross"
        assert cloid is not None and len(cloid) == 34
        if reduce_only:
            after = self.position + (size if is_buy else -size)
            assert abs(after) < abs(self.position) and after * self.position >= 0, (
                "reduce-only order would open exposure"
            )
        if self.ioc_error is not None:
            if self.lands_despite_error:
                self._apply(is_buy, size)
            raise self.ioc_error
        if self.reject is not None:
            return hl.OrderResult("rejected", D(0), None, None, self.reject)
        filled = self._apply(is_buy, size)
        return hl.OrderResult("filled", filled, self.mid, len(self.orders))


class Rig:
    def __init__(self, cfg: HedgeConfig | None = None) -> None:
        self.chain = FakeChain(KEY)
        self.chain.add_series("ETH-2100-C", "ETH-2100-P", "ETH-2300-C")
        self.chain.set_spot("ETH", 2_110)
        self.venue = FakeVenue(lambda: self.chain.now_ns)
        self.store = Store(None)
        self.quoter = Quoter(KEY, CONTRACT)
        self.hedger = Hedger(
            self.venue,
            ChainCache(self.chain.view, max_age_s=0),
            self.quoter,
            self.store,
            cfg or HedgeConfig(recheck_s=0.0),
            clock=lambda: self.chain.now_ns,
        )

    def traders_hold(self, series: str, contracts: float) -> None:
        self.chain.series[series]["net_trader_size"] = str(round(contracts * ONE))

    def advance(self, secs: float, keep_spot_fresh: bool = True) -> None:
        self.chain.now_ns += int(secs * SEC)
        if keep_spot_fresh:
            self.chain.set_spot("ETH", self.chain.spots["ETH"][0] / 10**8)

    def row(self) -> dict[str, Any]:
        return dict(self.hedger.status()["underlyings"]["ETH"])


@pytest.fixture
def rig() -> Rig:
    return Rig()


def test_it_buys_the_vaults_short_call_delta_then_rests(rig: Rig) -> None:
    rig.traders_hold("ETH-2100-C", 4)  # the vault is short 4 calls
    rig.hedger.tick()
    (order,) = rig.venue.orders
    delta = next(
        r.delta for r in rig.quoter.rows(rig.hedger.cache.get(), rig.chain.now_ns)
        if r.series == "ETH-2100-C"
    )  # fmt: skip
    assert order["is_buy"] and not order["reduce_only"]
    assert order["size"] == hl.floor_size(D(repr(4 * delta)), 4)  # the quoter's own delta
    assert order["limit_px"] == D("2121")  # mid + 100 bps
    assert order["expires_after_ms"] == rig.chain.now_ns // 10**6 + 8_000
    row = rig.row()
    assert row["state"] == "trade" and D(row["position"]) == order["size"]
    assert row["target"] == pytest.approx(4 * delta, abs=1e-6)
    assert abs(row["gap"]) < 1e-4

    rig.advance(5)
    rig.hedger.tick()
    assert len(rig.venue.orders) == 1  # nothing more to do
    assert rig.row()["state"] == "balanced"

    (logged,) = rig.store.hedge_orders(10)
    assert logged["status"] == "filled" and logged["side"] == "buy" and logged["coin"] == "ETH"
    assert logged["filled"] == hl.to_wire(order["size"]) and logged["cloid"] == order["cloid"]


def test_puts_hedge_the_other_way_and_calls_and_puts_net(rig: Rig) -> None:
    deltas = {r.series: r.delta for r in rig.quoter.rows(rig.hedger.cache.get(), rig.chain.now_ns)}
    assert deltas["ETH-2100-P"] < 0 < deltas["ETH-2100-C"]
    rig.traders_hold("ETH-2100-P", 4)  # the vault is short puts: long delta, so it sells
    rig.hedger.tick()
    assert rig.venue.orders[-1]["is_buy"] is False
    assert rig.venue.position == -hl.floor_size(D(repr(-4 * deltas["ETH-2100-P"])), 4)

    rig.traders_hold("ETH-2100-C", 4)  # now short a straddle: the two deltas mostly cancel
    rig.advance(5)
    rig.hedger.tick()
    want = 4 * (deltas["ETH-2100-C"] + deltas["ETH-2100-P"])
    assert float(rig.venue.position) == pytest.approx(want, abs=1e-4)
    assert abs(want) < 4 * deltas["ETH-2100-C"]


def test_when_the_book_closes_the_hedge_is_flattened_reduce_only(rig: Rig) -> None:
    rig.traders_hold("ETH-2100-C", 4)
    rig.hedger.tick()
    held = rig.venue.position
    rig.traders_hold("ETH-2100-C", 0)
    rig.advance(5)
    rig.hedger.tick()
    last = rig.venue.orders[-1]
    assert last["is_buy"] is False and last["reduce_only"] and last["size"] == held
    assert rig.venue.position == 0 and rig.row()["target"] == 0


def test_no_dust_is_left_when_the_last_option_closes_after_a_partial_unwind(rig: Rig) -> None:
    rig.traders_hold("ETH-2100-C", 4)
    rig.hedger.tick()
    # The book shrinks to a sliver: the hedge is cut to match, leaving a few dollars of perp.
    rig.traders_hold("ETH-2100-C", 0.01)
    rig.advance(5)
    rig.hedger.tick()
    left = rig.venue.position
    assert 0 < left * rig.venue.mid < 25
    # Then the sliver closes too. The remainder is inside the deadband, and is closed anyway.
    rig.traders_hold("ETH-2100-C", 0)
    rig.advance(5)
    rig.hedger.tick()
    assert rig.venue.position == 0
    assert rig.venue.orders[-1]["reduce_only"] and rig.venue.orders[-1]["size"] == left


def test_spot_noise_does_not_re_trade_the_hedge_but_a_real_move_does(rig: Rig) -> None:
    rig.traders_hold("ETH-2100-C", 4)
    rig.hedger.tick()
    assert len(rig.venue.orders) == 1
    band = rig.row()["band"]
    inv = rig.hedger.status()["underlyings"]["ETH"]
    assert band > 25 / 2100 and inv["state"] == "trade"
    # Ten passes of a few basis points of noise either way: delta moves, the hedge does not.
    for i in range(10):
        rig.advance(5, keep_spot_fresh=False)
        rig.chain.set_spot("ETH", 2_110 + (3 if i % 2 else -3))
        rig.venue.mid = D("2100") + (3 if i % 2 else -3)
        rig.hedger.tick()
        assert rig.row()["state"] == "balanced"
    assert len(rig.venue.orders) == 1
    # A 2% move is a real change in delta: one more order, towards the new target.
    rig.advance(5, keep_spot_fresh=False)
    rig.chain.set_spot("ETH", 2_152)
    rig.venue.mid = D("2142")
    rig.hedger.tick()
    assert len(rig.venue.orders) == 2 and rig.venue.orders[-1]["is_buy"]  # short calls: delta rose
    assert abs(rig.row()["gap"]) < 1e-4


def test_a_position_change_it_did_not_make_stops_the_hedger(rig: Rig) -> None:
    rig.traders_hold("ETH-2100-C", 4)
    rig.hedger.tick()
    held = rig.venue.position
    rig.advance(5)
    rig.hedger.tick()
    assert len(rig.venue.orders) == 1 and rig.row()["state"] == "balanced"

    rig.venue.position = held - D("0.5")  # someone else sold half an ETH on this account
    rig.advance(5)
    rig.hedger.tick()
    row = rig.row()
    assert len(rig.venue.orders) == 1, "it must not trade against whoever that was"
    assert row["state"] == "hold" and "no order from this hedger" in row["reason"]
    assert f"went from {hl.to_wire(held)} to {hl.to_wire(held - D('0.5'))}" in row["reason"]
    assert D(row["position"]) == held - D("0.5")  # and it still shows what the venue holds

    # It stays stopped: not when the book changes, not when the position is put back.
    rig.traders_hold("ETH-2100-C", 0)
    rig.venue.position = held
    for _ in range(5):
        rig.advance(5)
        rig.hedger.tick()
    assert len(rig.venue.orders) == 1 and rig.row()["state"] == "hold"


def test_an_agent_with_an_empty_book_leaves_another_agents_hedge_alone() -> None:
    """Seen live on Nov 14: the shared deployment's agent bought its 0.585 ETH hedge, and a test
    agent on the same exchange account, whose own book was empty, closed it as if it were a
    leftover of its own. Seven times in 70 seconds, each paying the spread and two fees."""
    a, b = Rig(), Rig()
    b.venue = a.venue
    b.hedger.venue = a.venue  # the same exchange account
    a.traders_hold("ETH-2100-C", 4)  # a's book needs a long hedge; b's book is empty
    for _ in range(20):
        for rig in (a, b):
            rig.hedger.tick()
        for rig in (a, b):
            rig.advance(5)
    assert len(a.venue.orders) == 1  # a's hedge, and nothing else: 40 orders without the rule
    assert a.row()["state"] == "balanced" and a.venue.position > 0
    assert b.row()["state"] == "hold" and "did not open" in b.row()["reason"]
    assert D(b.row()["position"]) == a.venue.position and b.row()["target"] == 0


def test_a_position_found_at_start_is_only_touched_once_the_book_needs_a_hedge(rig: Rig) -> None:
    rig.venue.position = D("0.58")  # on the account before this agent ever traded
    for _ in range(3):
        rig.hedger.tick()
        rig.advance(5)
    assert rig.venue.orders == [] and rig.row()["state"] == "hold"
    # Its own book opens: from here it hedges to its target, starting from what is there.
    rig.traders_hold("ETH-2100-C", 4)
    rig.hedger.tick()
    assert len(rig.venue.orders) == 1 and rig.venue.orders[0]["is_buy"]
    assert float(rig.venue.position) == pytest.approx(rig.row()["target"], abs=1e-4)
    # And once it has traded there, an empty book means the position is its own to close.
    rig.traders_hold("ETH-2100-C", 0)
    rig.advance(5)
    rig.hedger.tick()
    assert rig.venue.position == 0 and rig.venue.orders[-1]["reduce_only"]


def test_two_hedgers_with_books_of_their_own_stop_after_one_exchange() -> None:
    """Both think the account is theirs and want different positions. The first to see a
    position it did not leave stops, so they trade against each other once, not for ever."""
    a, b = Rig(), Rig()
    b.venue = a.venue
    b.hedger.venue = a.venue
    a.traders_hold("ETH-2100-C", 4)  # a wants to be long
    b.traders_hold("ETH-2100-P", 4)  # b wants to be short
    for _ in range(20):
        for rig in (a, b):
            rig.hedger.tick()
        for rig in (a, b):
            rig.advance(5)
    orders = a.venue.orders
    # a bought once; b sold through it (in two orders, because of the order size cap); a saw a
    # position it had not left and stopped. Nothing after that.
    assert [o["is_buy"] for o in orders] == [True, False, False]
    assert a.row()["state"] == "hold"
    assert "something else is trading this account" in a.row()["reason"]
    assert b.row()["state"] == "balanced" and a.venue.position < 0
    assert float(a.venue.position) == pytest.approx(b.row()["target"], abs=1e-4)


def test_its_own_fill_showing_up_late_is_not_mistaken_for_someone_else(rig: Rig) -> None:
    rig.traders_hold("ETH-2100-C", 4)
    rig.hedger.tick()
    filled = rig.venue.position
    # The venue is slow to show the fill: the read at the start of the next pass still says 0.
    rig.venue.lag_reads, rig.venue.lag_position = 1, D(0)
    rig.advance(5)
    rig.hedger.tick()
    assert rig.hedger._foreign == {} and len(rig.venue.orders) == 1
    assert D(rig.row()["position"]) == filled and rig.row()["state"] == "balanced"


def test_after_a_timeout_either_outcome_of_its_own_order_is_accepted() -> None:
    for lands in (False, True):
        r = Rig()
        r.traders_hold("ETH-2100-C", 4)
        r.venue.ioc_error = hl.TransportError("/exchange: timed out")
        r.venue.lands_despite_error = lands
        with pytest.raises(hl.TransportError):
            r.hedger.tick()
        r.venue.ioc_error = None
        for _ in range(4):
            r.advance(5)
            r.hedger.tick()
        assert r.hedger._foreign == {}, lands
        assert float(r.venue.position) == pytest.approx(r.row()["target"], abs=1e-4)


def test_a_stale_contract_spot_sends_nothing(rig: Rig) -> None:
    rig.traders_hold("ETH-2100-C", 4)
    rig.advance(45, keep_spot_fresh=False)  # the contract refuses a spot older than 30 s
    rig.hedger.tick()
    assert rig.venue.orders == []
    row = rig.row()
    assert row["state"] == "hold" and "stale" in row["reason"] and row["target"] is None


def test_an_unreadable_venue_sends_nothing_and_is_reported(rig: Rig) -> None:
    rig.traders_hold("ETH-2100-C", 4)
    rig.venue.fail_reads = True
    with pytest.raises(hl.TransportError):
        rig.hedger.tick()
    assert rig.venue.orders == []

    stop = threading.Event()
    rig.hedger.cfg = HedgeConfig(interval_s=0.01)
    t = threading.Thread(target=rig.hedger.run, args=(stop,))
    t.start()
    try:
        for _ in range(200):
            if rig.hedger.status()["error"]:
                break
            stop.wait(0.01)
    finally:
        stop.set()
        t.join(2)
    assert "TransportError" in rig.hedger.status()["error"]
    assert rig.venue.orders == []


def test_a_venue_price_far_from_the_contracts_spot_sends_nothing(rig: Rig) -> None:
    rig.traders_hold("ETH-2100-C", 4)
    rig.venue.mid = D("2400")  # +13.7% against the contract's 2,110
    rig.hedger.tick()
    assert rig.venue.orders == []
    row = rig.row()
    assert row["state"] == "hold" and row["basis_bps"] == pytest.approx(1374.4, abs=0.1)


def test_an_asset_the_venue_does_not_list_is_held(rig: Rig) -> None:
    rig.traders_hold("ETH-2100-C", 4)
    del rig.venue.listed["ETH"]
    rig.hedger.tick()
    assert rig.venue.orders == [] and "does not list ETH" in rig.row()["reason"]


@pytest.mark.parametrize("lands", [False, True])
def test_an_order_with_an_unknown_outcome_is_never_sent_twice(rig: Rig, lands: bool) -> None:
    """The request timed out. Whether or not it reached the venue, no second order may go out
    while the first could still fill; afterwards the position read decides."""
    rig.traders_hold("ETH-2100-C", 4)
    rig.venue.ioc_error = hl.TransportError("/exchange: timed out")
    rig.venue.lands_despite_error = lands
    with pytest.raises(hl.TransportError):
        rig.hedger.tick()
    assert len(rig.venue.orders) == 1
    assert rig.store.hedge_orders(1)[0]["status"] == "unknown"
    rig.venue.ioc_error = None

    rig.advance(5)  # the order has not expired yet (8 s)
    rig.hedger.tick()
    assert len(rig.venue.orders) == 1
    if not lands:
        assert rig.row()["state"] == "hold" and "unknown" in rig.row()["reason"]

    rig.advance(5)  # expired: it can no longer fill
    rig.hedger.tick()
    assert len(rig.venue.orders) == (1 if lands else 2)
    target = rig.row()["target"]
    assert float(rig.venue.position) == pytest.approx(target, abs=1e-4)  # hedged exactly once


def test_a_refused_order_backs_off_before_trying_again(rig: Rig) -> None:
    rig.traders_hold("ETH-2100-C", 4)
    rig.venue.reject = "Insufficient margin to place order."
    rig.hedger.tick()
    assert rig.store.hedge_orders(1)[0]["status"] == "rejected"
    assert "Insufficient margin" in rig.store.hedge_orders(1)[0]["detail"]
    for _ in range(5):  # 25 s of passes: still inside the 30 s back-off
        rig.advance(5)
        rig.hedger.tick()
    assert len(rig.venue.orders) == 1
    rig.venue.reject = None
    rig.advance(6)
    rig.hedger.tick()
    assert len(rig.venue.orders) == 2 and rig.venue.position > 0


def test_a_partial_fill_is_completed_on_the_next_pass(rig: Rig) -> None:
    rig.traders_hold("ETH-2100-C", 4)
    rig.venue.fill_fraction = D("0.4")
    rig.hedger.tick()
    first = rig.venue.orders[0]["size"]
    assert rig.venue.position == hl.floor_size(first * D("0.4"), 4)
    assert D(rig.row()["position"]) == rig.venue.position  # from the venue, not the order
    rig.venue.fill_fraction = D(1)
    rig.advance(5)
    rig.hedger.tick()
    assert rig.venue.orders[1]["size"] == first - hl.floor_size(first * D("0.4"), 4)
    assert rig.venue.position == first


def test_a_large_gap_is_worked_off_in_capped_orders() -> None:
    rig = Rig(HedgeConfig(max_order_usd=1_050.0, recheck_s=0.0))  # 0.5 ETH at a 2,100 mid
    rig.traders_hold("ETH-2100-C", 4)
    sizes = []
    for _ in range(8):
        rig.hedger.tick()
        rig.advance(5)
        sizes.append(rig.venue.position)
    assert rig.venue.orders[0]["size"] == D("0.5000")
    assert all(o["size"] <= D("0.5") for o in rig.venue.orders)
    assert float(rig.venue.position) == pytest.approx(rig.row()["target"], abs=0.012)
    assert rig.row()["state"] == "balanced"


def test_status_has_the_shape_the_app_parses(rig: Rig) -> None:
    rig.traders_hold("ETH-2100-C", 4)
    rig.hedger.tick()
    s = rig.hedger.status()
    assert s["enabled"] is True and s["venue"] == "hyperliquid" and s["network"] == "testnet"
    assert s["account"] == rig.venue.account and s["error"] is None
    assert s["updated_ns"] == str(rig.chain.now_ns)
    assert (s["account_value"], s["withdrawable"]) == ("1000", "1000")
    assert set(s["underlyings"]) == {"ETH"}
    assert set(s["underlyings"]["ETH"]) == {
        "target", "position", "gap", "band", "state", "reason", "venue_mid", "basis_bps",
        "entry_px", "unrealized_pnl",
    }  # fmt: skip
    assert s["limits"]["deadband_usd"] == 25.0 and len(s["orders"]) == 1
    assert isinstance(s["orders"][0]["ts_ns"], str)


def test_hedge_orders_survive_a_restart(tmp_path: Any) -> None:
    a = Store(tmp_path)
    for i in range(3):
        a.add_hedge_order({"ts_ns": str(i), "status": "filled"})
    b = Store(tmp_path)
    assert [e["ts_ns"] for e in b.hedge_orders(2)] == ["2", "1"]  # newest first
    assert b.hedge_orders(0) == []


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_random_markets_and_failures_never_break_the_hedgers_rules(seed: int) -> None:
    """600 passes of a random book, a random walk in spot, a venue price that sometimes runs
    away from it, stale spots, an unreadable venue, timed-out and refused orders and partial
    fills. Whatever happens, the rules in hedger.py hold on every pass; the fake venue also
    refuses any order the real one would (lot, tick, minimum, expiry, reduce-only)."""
    rng = random.Random(seed)
    cfg = HedgeConfig(max_order_usd=3_000.0, max_position_usd=20_000.0, recheck_s=0.0)
    rig = Rig(cfg)
    spot = 2_110.0
    quiet_until_ms = 0  # no order may be sent before this (after a timeout or a refusal)
    seen = {
        "orders": 0,
        "stale": 0,
        "unreadable": 0,
        "far": 0,
        "timeouts": 0,
        "refused": 0,
        "capped": 0,
    }

    for _ in range(600):
        # -- the world moves
        if rng.random() < 0.10:
            sid = rng.choice(["ETH-2100-C", "ETH-2100-P", "ETH-2300-C"])
            rig.traders_hold(sid, rng.choice([0, 0, 1, 3, 8, 40, -2, -15]))
        spot *= 1 + rng.gauss(0, 0.002)
        stale = rng.random() < 0.05
        rig.chain.now_ns += 5 * SEC
        if stale:
            rig.chain.now_ns += 40 * SEC  # the keeper fell behind: the last spot is now too old
        else:
            rig.chain.set_spot("ETH", spot)
        far = rng.random() < 0.03
        rig.venue.mid = D(str(round(spot * (1.08 if far else 1 + rng.gauss(0, 0.001)), 1)))
        rig.venue.fail_reads = rng.random() < 0.03
        timeout = rng.random() < 0.04
        rig.venue.ioc_error = hl.TransportError("/exchange: timed out") if timeout else None
        rig.venue.lands_despite_error = rng.random() < 0.5
        rig.venue.reject = "Insufficient margin to place order." if rng.random() < 0.03 else None
        rig.venue.fill_fraction = D(str(rng.choice([1, 1, 1, 1, 0.4, 0.8])))

        # -- one pass
        now_ms = rig.chain.now_ns // 10**6
        n_before, pos_before = len(rig.venue.orders), rig.venue.position
        try:
            rig.hedger.tick()
            raised = False
        except hl.TransportError:
            raised = True
        sent = rig.venue.orders[n_before:]

        # -- the rules
        assert len(sent) <= 1
        if stale or rig.venue.fail_reads or far or now_ms < quiet_until_ms:
            assert sent == [], (stale, rig.venue.fail_reads, far, now_ms < quiet_until_ms)
        seen["stale"] += stale
        seen["unreadable"] += rig.venue.fail_reads
        seen["far"] += far
        if not sent:
            assert rig.venue.position == pos_before  # nothing moves without an order
            continue
        (o,) = sent
        seen["orders"] += 1
        mid = rig.venue.mid
        assert o["size"] * mid <= D(str(cfg.max_order_usd)) + mid * D("0.0001")
        seen["capped"] += o["size"] * mid > D(str(cfg.max_order_usd)) * D("0.99")
        signed = o["size"] if o["is_buy"] else -o["size"]
        if abs(pos_before + signed) > abs(pos_before):  # it adds exposure: the cap applies
            assert abs(pos_before + signed) * mid <= D(str(cfg.max_position_usd)) + mid * D(
                "0.0001"
            )
        assert o["expires_after_ms"] == now_ms + 8_000
        if timeout:
            assert raised
            quiet_until_ms = o["expires_after_ms"] + 1_000
            seen["timeouts"] += 1
        elif rig.venue.reject:
            assert rig.venue.position == pos_before
            quiet_until_ms = now_ms + 30_000
            seen["refused"] += 1
        else:
            # The status the app shows is the venue's position after the order, never a guess.
            assert D(rig.row()["position"]) == rig.venue.position

    # None of its own fills, timeouts, refusals or partial fills looked like someone else's.
    assert rig.hedger._foreign == {}
    # The run must have exercised every path, not just the easy one.
    assert seen["orders"] > 40 and seen["capped"] > 0, seen
    assert (
        min(seen["stale"], seen["unreadable"], seen["far"], seen["timeouts"], seen["refused"]) > 0
    ), seen

    # -- and when the trouble stops, it settles on the target and stays there
    for flag in ("fail_reads",):
        setattr(rig.venue, flag, False)
    rig.venue.ioc_error, rig.venue.reject, rig.venue.fill_fraction = None, None, D(1)
    for _ in range(40):
        rig.advance(5)
        rig.venue.mid = D(str(round(spot, 1)))
        rig.hedger.tick()
    row = rig.row()
    assert row["state"] == "balanced" and abs(row["gap"]) <= row["band"] + 1e-4, row
    settled = len(rig.venue.orders)
    for _ in range(10):
        rig.advance(5)
        rig.hedger.tick()
    assert len(rig.venue.orders) == settled


FIXTURE = Path(__file__).parent / "fixtures" / "hedge_status.json"


def test_the_status_the_app_is_tested_against_is_what_the_hedger_reports() -> None:
    """`app/src/backend/agent.test.ts` parses tests/fixtures/hedge_status.json. This keeps that
    file equal to what `Hedger.status()` and `/hedge` really produce. After changing the status
    shape, regenerate it and fix the app's parser:

        TWOOPTIONS_WRITE_FIXTURES=1 uv run pytest tests/test_hedger.py -k fixture -q
    """
    from twooptions_agent.server import App

    rig = Rig()
    rig.traders_hold("ETH-2100-C", 4)
    off = App(CONTRACT, rig.hedger.cache, rig.quoter, Store(None))
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr("time.time_ns", lambda: rig.chain.now_ns)
        disabled = off.handle("/hedge", {})[1]
    rig.venue.fill_fraction = D("0.4")
    rig.hedger.tick()  # a partial fill: position, gap and one order
    rig.venue.reject = "Insufficient margin to place order. asset=4"
    rig.advance(5)
    rig.hedger.tick()  # then a refusal
    enabled = rig.hedger.status()
    for o in enabled["orders"]:
        o["cloid"] = "0x" + "00" * 16  # random per order
    got = {"disabled": disabled, "enabled": enabled}
    text = json.dumps(got, indent=1, sort_keys=True) + "\n"
    if os.environ.get("TWOOPTIONS_WRITE_FIXTURES"):
        FIXTURE.write_text(text)
    assert FIXTURE.read_text() == text
    assert [o["status"] for o in enabled["orders"]] == ["rejected", "filled"]
