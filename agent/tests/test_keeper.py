from decimal import Decimal

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from twooptions_agent import margin
from twooptions_agent.chain import ChainCache, fetch_snapshot
from twooptions_agent.keeper import Keeper
from twooptions_agent.near import TxError
from twooptions_agent.quoter import Quoter
from twooptions_agent.spot import SpotFeed, VenueQuote
from twooptions_agent.store import Store
from twooptions_agent.wire import Underlying

from .fakes import CONTRACT, HOUR, SEC, T0, FakeChain

KEY = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))


class Rig:
    def __init__(self) -> None:
        self.chain = FakeChain(KEY)
        self.chain.add_series("ETH-2100-C", "ETH-2100-P")
        self.chain.set_spot("ETH", 2_110, age_s=5)
        self.price = Decimal("2112.5")
        self.store = Store(None)
        self.cache = ChainCache(self.chain.view, max_age_s=0)  # always re-read the fake
        self.feed = SpotFeed([], venues={"a": self._venue("a"), "b": self._venue("b")})
        self.quoter = Quoter(KEY, CONTRACT)
        self.keeper = Keeper(
            CONTRACT, self.chain, KEY, self.cache, self.quoter, self.feed, self.store
        )

    def _venue(self, name: str):  # type: ignore[no-untyped-def]
        def fetch(us: list[Underlying], now_ns: int) -> list[VenueQuote]:
            return [VenueQuote(name, u, self.price, now_ns) for u in us]

        return fetch

    def advance(self, secs: float) -> None:
        self.chain.now_ns += int(secs * SEC)

    def post(self) -> None:
        self.keeper.tick_spot(self.chain.now_ns)


def test_spot_is_signed_posted_and_sequenced_after_the_chain(rig: Rig) -> None:
    rig.post()
    assert [m for m, _ in rig.chain.calls] == ["post_spot"]
    price, ts, seq = rig.chain.spots["ETH"]
    assert price == 211_250_000_000 and ts == rig.chain.now_ns
    assert rig.keeper.status.last_spot_post_ns == {"ETH": ts}
    rig.advance(5)
    rig.post()
    assert rig.chain.spots["ETH"][2] > seq


def test_feed_is_seeded_from_chain_so_a_big_jump_is_held_not_posted(rig: Rig) -> None:
    rig.price = Decimal("2500")  # +18% against the contract's 2,110: it would refuse this
    rig.post()
    assert rig.chain.calls == []
    assert "move" in rig.keeper.status.last_spot_hold["ETH"]


def test_a_failed_post_resyncs_with_the_chain_and_recovers(rig: Rig) -> None:
    rig.chain.fail_next = "sequence must increase"
    with pytest.raises(TxError):
        rig.post()
    assert rig.chain.spots["ETH"][0] == 2_110 * 10**8  # nothing landed
    rig.advance(5)
    rig.post()
    assert rig.chain.spots["ETH"][0] == 211_250_000_000


def test_no_series_means_nothing_to_post() -> None:
    rig = Rig()
    rig.chain.series.clear()
    rig.post()
    assert rig.chain.calls == []


def test_funding_waits_for_the_settle_delay_then_settles_each_series_once(rig: Rig) -> None:
    rig.chain.now_ns = T0 + HOUR + 5 * SEC  # 5 s into a new epoch
    rig.chain.set_spot("ETH", 2_110)
    rig.keeper.tick_funding(rig.chain.now_ns)
    assert rig.chain.calls == []

    rig.advance(20)
    rig.chain.set_spot("ETH", 2_110)
    rig.keeper.tick_funding(rig.chain.now_ns)  # one settlement per pass
    rig.keeper.tick_funding(rig.chain.now_ns)
    epoch = rig.chain.now_ns // HOUR
    assert [m for m, _ in rig.chain.calls] == ["settle_funding", "settle_funding"]
    assert {s["last_epoch"] for s in rig.chain.series.values()} == {str(epoch)}

    rig.keeper.tick_funding(rig.chain.now_ns)  # already settled: no second charge
    assert len(rig.chain.calls) == 2

    history = rig.store.funding_history("ETH-2100-C", 10)
    assert len(history) == 1
    h = history[0]
    snap = fetch_snapshot(rig.chain.view, rig.chain.now_ns)
    assert h["index"] == str(snap.series["ETH-2100-C"].funding_index)
    assert int(h["per_contract"]) == int(h["rate"]) * int(h["mark"]) // 10**9 > 0
    assert h["epoch"] == str(epoch) and h["tx_hash"]
    assert all(isinstance(v, str) for v in h.values())


def test_funding_charges_one_twenty_fourth_of_time_value(rig: Rig) -> None:
    rig.chain.now_ns = T0 + HOUR + 30 * SEC
    rig.chain.set_spot("ETH", 2_110)
    rig.keeper.tick_funding(rig.chain.now_ns)
    rig.keeper.tick_funding(rig.chain.now_ns)
    assert len(rig.store.funding_history(None, 10)) == 2
    for h in rig.store.funding_history(None, 10):
        is_call = h["series"].endswith("C")
        intr = margin.intrinsic(is_call, 2_110 * 10**8, 2_100 * 10**8)
        assert int(h["per_contract"]) == pytest.approx((int(h["mark"]) - intr) / 24, abs=2)


def test_funding_settles_at_the_current_mark_and_spot(rig: Rig) -> None:
    # The contract anchors the next hour's trade prices to this mark and the spot it records,
    # so the mark must be the price at that spot (not an average over the hour).
    rig.chain.now_ns = T0 + HOUR + 20 * SEC
    rig.chain.set_spot("ETH", 2_110)
    rig.keeper.tick_funding(rig.chain.now_ns)
    snap = fetch_snapshot(rig.chain.view, rig.chain.now_ns)
    row = {r.series: r for r in rig.quoter.rows(snap, rig.chain.now_ns)}["ETH-2100-C"]
    s = snap.series["ETH-2100-C"]
    assert s.ref_mark == row.mark
    assert s.ref_spot == 2_110 * 10**8


def test_one_series_failing_does_not_block_the_others(rig: Rig) -> None:
    rig.chain.now_ns = T0 + HOUR + 30 * SEC
    rig.chain.set_spot("ETH", 2_110)
    rig.chain.fail_next = "epoch is not current"
    with pytest.raises(TxError):
        rig.keeper.tick_funding(rig.chain.now_ns)
    assert rig.chain.calls == []
    rig.keeper.tick_funding(rig.chain.now_ns)  # the other series goes first next turn
    assert [m for m, _ in rig.chain.calls] == ["settle_funding"]
    rig.keeper.tick_funding(rig.chain.now_ns)  # then the failed one is retried
    assert len(rig.chain.calls) == 2
    assert {s["last_epoch"] for s in rig.chain.series.values()} == {str(rig.chain.now_ns // HOUR)}


def test_a_series_that_keeps_failing_does_not_starve_the_rest(rig: Rig) -> None:
    rig.chain.add_series("ETH-2000-C", "ETH-2000-P")
    rig.chain.now_ns = T0 + HOUR + 30 * SEC
    rig.chain.set_spot("ETH", 2_110)
    rig.chain.fail_series = {"ETH-2100-C"}
    for _ in range(6):
        try:
            rig.keeper.tick_funding(rig.chain.now_ns)
        except TxError:
            pass
    # ETH-2100-C failed every time it was tried; the other three still settled.
    settled = {k for k, s in rig.chain.series.items() if s["last_epoch"] != "0"}
    assert settled == {"ETH-2100-P", "ETH-2000-C", "ETH-2000-P"}


def test_funding_waits_while_spot_is_stale(rig: Rig) -> None:
    rig.chain.now_ns = T0 + HOUR + 30 * SEC
    rig.chain.set_spot("ETH", 2_110, age_s=45)
    rig.keeper.tick_funding(rig.chain.now_ns)
    assert rig.chain.calls == []


def account(equity: int, requirement: int, positions: int = 1) -> dict:
    return {
        "collateral": "0",
        "positions": [{"series": "ETH-2100-C", "size": "-1000000"}] * positions,
        "equity": str(equity),
        "requirement": str(requirement),
    }


def test_only_accounts_below_the_liquidation_ratio_are_liquidated(rig: Rig) -> None:
    rig.chain.accounts = {
        "keeper.testnet": account(10**6, 0, positions=0),
        "healthy.testnet": account(1_200, 1_000),
        "edge.testnet": account(1_150, 1_000),  # exactly 1.15: not liquidatable
        "sick.testnet": account(1_149, 1_000),
        "stale.testnet": {
            "collateral": "0",
            "positions": [{}],
            "equity": None,
            "requirement": None,
        },
    }
    for a in (*rig.chain.accounts, "gone.testnet"):
        rig.store.add_taker(a)
    rig.keeper.tick_liquidations()
    assert rig.chain.calls == [("liquidate", {"account_id": "sick.testnet"})]
    assert rig.keeper.status.liquidations == 1
    assert "gone.testnet" not in rig.store.takers()  # removed on chain, dropped from the list


def position(size: int, entry_index: int = 0, series: str = "ETH-2100-C") -> dict:
    return {"series": series, "size": str(size), "entry_index": str(entry_index)}


def holder(equity: int, requirement: int, *positions: dict) -> dict:
    return {
        "collateral": "0",
        "positions": list(positions),
        "equity": str(equity),
        "requirement": str(requirement),
    }


def test_a_long_whose_cash_cannot_cover_its_funding_is_liquidated(rig: Rig) -> None:
    """A long has no requirement, so the ratio test never fires. What it owes is funding, and
    the view shows equity before funding is charged."""
    rig.chain.series["ETH-2100-C"]["funding_index"] = "480001"  # 0.48 USDC per contract so far
    rig.chain.accounts = {
        "keeper.testnet": account(10**6, 0, positions=0),
        # One contract each, entered at index 0, so each owes 480,001 micros.
        "broke.testnet": holder(0, 0, position(1_000_000)),
        "exact.testnet": holder(480_001, 0, position(1_000_000)),  # pays it with nothing left
        "short_by_a_micro.testnet": holder(480_000, 0, position(1_000_000)),
        "funded.testnet": holder(5_000_000, 0, position(1_000_000)),
        # Entered at the current index: nothing owed yet.
        "new.testnet": holder(0, 0, position(1_000_000, entry_index=480_001)),
        # Rounding is the contract's: 0.001 contract owes ceil(480.001) = 481 micros, not 480.
        "dust.testnet": holder(480, 0, position(1_000)),
    }
    for a in rig.chain.accounts:
        rig.store.add_taker(a)
    rig.keeper.tick_liquidations()
    assert sorted(a["account_id"] for m, a in rig.chain.calls if m == "liquidate") == [
        "broke.testnet",
        "dust.testnet",
        "short_by_a_micro.testnet",
    ]
    assert rig.keeper.status.liquidations == 3
    # Each one is reported with its transaction, newest first, for /health and the demo script.
    reported = rig.keeper.status.to_json()["liquidated"]
    assert [x["account"] for x in reported] == [
        "dust.testnet",
        "short_by_a_micro.testnet",
        "broke.testnet",
    ]
    assert all(x["tx_hash"].startswith("tx") and x["ts_ns"].isdigit() for x in reported)


def test_unpaid_funding_counts_for_shorts_too(rig: Rig) -> None:
    rig.chain.series["ETH-2100-C"]["funding_index"] = "10"
    rig.chain.series["ETH-2100-P"]["funding_index"] = "-10"
    rig.chain.accounts = {
        "keeper.testnet": account(10**6, 0, positions=0),
        # A short call is owed 10 (longs pay): 1,149 + 10 = 1,159, back above 1.15.
        "saved.testnet": holder(1_149, 1_000, position(-1_000_000)),
        # A short put owes 10 when the index fell: 1,155 - 10 = 1,145, now under 1.15.
        "tipped.testnet": holder(1_155, 1_000, position(-1_000_000, series="ETH-2100-P")),
    }
    for a in rig.chain.accounts:
        rig.store.add_taker(a)
    rig.keeper.tick_liquidations()
    assert rig.chain.calls == [("liquidate", {"account_id": "tipped.testnet"})]


def test_keeper_without_a_contract_account_reports_why_it_cannot_liquidate(
    rig: Rig, caplog
) -> None:  # type: ignore[no-untyped-def]
    rig.chain.accounts = {"sick.testnet": account(1, 1_000)}
    rig.store.add_taker("sick.testnet")
    with pytest.raises(TxError):
        rig.keeper.tick_liquidations()
    assert "needs a deposit" in caplog.text


@pytest.fixture
def rig() -> Rig:
    return Rig()


def test_a_funding_backlog_is_settled_one_at_a_time_so_spot_is_never_starved(rig: Rig) -> None:
    rig.chain.add_series("ETH-2000-C", "ETH-2000-P", "ETH-2200-C")  # five series in all
    rig.chain.now_ns = T0 + HOUR + 30 * SEC
    rig.chain.set_spot("ETH", 2_110)
    per_pass = []
    for _ in range(6):
        before = len(rig.chain.calls)
        rig.keeper.tick_funding(rig.chain.now_ns)
        per_pass.append(len(rig.chain.calls) - before)
    assert per_pass == [1, 1, 1, 1, 1, 0]
    assert {s["last_epoch"] for s in rig.chain.series.values()} == {str(rig.chain.now_ns // HOUR)}


def test_spot_posts_do_not_wait_for_execution_but_settlements_do(rig: Rig) -> None:
    rig.post()
    rig.chain.now_ns = T0 + HOUR + 30 * SEC
    rig.chain.set_spot("ETH", 2_110)
    rig.keeper.tick_funding(rig.chain.now_ns)
    assert ("post_spot", "INCLUDED") in rig.chain.waits
    assert ("settle_funding", "EXECUTED_OPTIMISTIC") in rig.chain.waits


def test_posts_refused_on_chain_are_noticed_and_the_feed_resyncs(rig: Rig, caplog) -> None:  # type: ignore[no-untyped-def]
    rig.post()
    landed = rig.chain.spots["ETH"][1]
    rig.chain.drop_spot_posts = 5
    for _ in range(5):
        rig.advance(5)
        rig.post()
    assert rig.chain.spots["ETH"][1] == landed  # nothing landed, and no error was raised
    rig.advance(5)
    rig.post()
    assert "resyncing" in caplog.text
    assert rig.chain.spots["ETH"][1] == rig.chain.now_ns  # posting again, in step with the chain


# -- the liquidation scan's budget and order ---------------------------------------------------


class Clock:
    """A clock the test moves. Each account read costs `per_read` seconds."""

    def __init__(self) -> None:
        self.t = 1_000.0

    def __call__(self) -> float:
        return self.t


def scanning_rig(per_read: float = 0.5) -> tuple[Rig, Clock, list[str]]:
    """A rig whose account reads take time and are recorded."""
    rig, clock, reads = Rig(), Clock(), []
    rig.keeper = Keeper(
        CONTRACT, rig.chain, KEY, rig.cache, rig.quoter, rig.feed, rig.store, clock=clock
    )
    view = rig.cache.view

    def timed(method: str, args: dict | None = None):  # type: ignore[no-untyped-def]
        if method == "get_account":
            clock.t += per_read
            reads.append(args["account_id"])  # type: ignore[index]
        return view(method, args)

    rig.cache.view = timed
    return rig, clock, reads


def watch(rig: Rig, accounts: dict[str, dict]) -> None:
    rig.chain.accounts = {"keeper.testnet": account(10**6, 0, positions=0), **accounts}
    for a in accounts:
        rig.store.add_taker(a)


def test_a_long_watch_list_is_read_over_several_turns_so_spot_is_never_starved() -> None:
    rig, clock, reads = scanning_rig(per_read=0.5)
    watch(rig, {f"a{i:02}.testnet": account(2_000, 1_000) for i in range(20)})
    turns = []
    for _ in range(5):
        before = len(reads)
        started = clock.t
        rig.keeper.tick_liquidations()
        turns.append(len(reads) - before)
        assert clock.t - started <= rig.keeper.cfg.liquidation_budget_s + 0.5  # one read over
        clock.t += 1.0  # the spot and funding jobs take their turn
    assert turns == [4, 4, 4, 4, 4]
    assert sorted(reads) == sorted(rig.chain.accounts.keys() - {"keeper.testnet"})  # each once
    assert rig.keeper.status.watch["accounts"] == 20


def test_an_account_close_to_liquidation_is_read_every_turn_and_before_the_others() -> None:
    rig, clock, reads = scanning_rig(per_read=0.5)
    watch(
        rig,
        {
            **{f"safe{i}.testnet": account(3_000, 1_000) for i in range(6)},
            "close.testnet": account(1_200, 1_000),  # 1.20 against a ratio of 1.15
        },
    )
    rig.keeper.tick_liquidations()  # nothing is known yet: watch-list order, four of seven
    assert "close.testnet" not in reads
    clock.t += 1.0
    rig.keeper.tick_liquidations()
    assert "close.testnet" in reads
    for _ in range(3):  # from now on it leads every turn, though the others are overdue too
        clock.t += 20.0
        del reads[:]
        rig.keeper.tick_liquidations()
        assert reads[0] == "close.testnet"


def test_an_account_with_nothing_open_is_read_rarely_until_it_is_quoted() -> None:
    rig, clock, reads = scanning_rig(per_read=0.1)
    watch(rig, {"idle.testnet": account(5_000, 0, positions=0)})
    rig.keeper.tick_liquidations()
    assert reads == ["idle.testnet"]
    clock.t += 60.0
    rig.keeper.tick_liquidations()
    assert reads == ["idle.testnet"]  # not again yet
    clock.t += 61.0
    rig.keeper.tick_liquidations()
    assert len(reads) == 2

    # A quote means a trade may follow: it is read on the open-position rhythm for a while,
    # even though each read still finds nothing open.
    rig.keeper.touch("idle.testnet")
    clock.t += 16.0
    rig.keeper.tick_liquidations()
    clock.t += 16.0
    rig.keeper.tick_liquidations()
    assert len(reads) == 4
    clock.t += 200.0  # the quote is long past
    rig.keeper.tick_liquidations()
    clock.t += 16.0
    rig.keeper.tick_liquidations()
    assert len(reads) == 5


def test_one_account_that_cannot_be_read_does_not_stop_the_others() -> None:
    rig, clock, reads = scanning_rig(per_read=0.1)
    watch(
        rig,
        {
            "broken.testnet": account(2_000, 1_000),
            "sick.testnet": account(1_000, 1_000),
        },
    )
    inner = rig.cache.view

    def flaky(method: str, args: dict | None = None):  # type: ignore[no-untyped-def]
        if method == "get_account" and args == {"account_id": "broken.testnet"}:
            raise RuntimeError("rpc: bad response")
        return inner(method, args)

    rig.cache.view = flaky
    with pytest.raises(RuntimeError):
        rig.keeper.tick_liquidations()
    assert ("liquidate", {"account_id": "sick.testnet"}) in rig.chain.calls
    # The broken one is tried again on its next turn, not in a tight loop.
    rig.chain.calls.clear()
    clock.t += 1.0
    rig.keeper.tick_liquidations()
    assert rig.keeper.status.watch["accounts"] == 2


def test_the_scan_reports_how_far_behind_it_is() -> None:
    rig, clock, _ = scanning_rig(per_read=1.0)  # two reads a turn
    # Every field is there from the start, before the scan has had a turn.
    assert rig.keeper.status.to_json()["watch"] == {
        "accounts": 0,
        "with_positions": 0,
        "due": 0,
        "behind_s": 0.0,
    }
    watch(rig, {f"a{i:02}.testnet": account(2_000, 1_000) for i in range(40)})
    for _ in range(30):
        rig.keeper.tick_liquidations()
        clock.t += 1.0
    w = rig.keeper.status.to_json()["watch"]
    assert w["accounts"] == 40 and w["with_positions"] == 40
    # 40 accounts at two reads every three seconds is a 60 s round against a 15 s target.
    assert 30 < w["behind_s"] < 60


def test_a_liquidated_account_is_read_again_at_once_and_dropped_when_it_is_gone() -> None:
    rig, clock, reads = scanning_rig(per_read=0.1)
    watch(rig, {"sick.testnet": account(1_000, 1_000)})
    rig.keeper.tick_liquidations()
    assert rig.keeper.status.liquidations == 1
    del rig.chain.accounts["sick.testnet"]  # closed out and removed on chain
    clock.t += 1.0
    rig.keeper.tick_liquidations()
    assert reads == ["sick.testnet", "sick.testnet"]
    assert rig.store.takers() == [] and rig.keeper.status.watch["accounts"] == 0
