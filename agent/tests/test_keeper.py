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
    for h in rig.store.funding_history(None, 10):
        is_call = h["series"].endswith("C")
        intr = margin.intrinsic(is_call, 2_110 * 10**8, 2_100 * 10**8)
        assert int(h["per_contract"]) == pytest.approx((int(h["mark"]) - intr) / 24, abs=2)


def test_funding_uses_the_average_mark_of_the_epoch_that_ended(rig: Rig) -> None:
    rig.chain.now_ns = T0 + 10 * SEC
    rig.chain.set_spot("ETH", 2_110, age_s=5)
    low, high = Decimal("2100"), Decimal("2120")
    marks = []
    for i in range(6):  # samples during epoch N
        rig.price = low if i % 2 == 0 else high
        rig.post()
        marks.append(
            rig.quoter.rows(fetch_snapshot(rig.chain.view, rig.chain.now_ns), rig.chain.now_ns)
        )
        rig.advance(5)
    expected = sum(r.mark for rows in marks for r in rows if r.series == "ETH-2100-C") // 6

    rig.chain.now_ns = T0 + HOUR + 20 * SEC  # epoch N + 1
    rig.price = high
    rig.post()
    rig.keeper.tick_funding(rig.chain.now_ns)
    h = rig.store.funding_history("ETH-2100-C", 1)[0]
    assert int(h["mark"]) == expected


def test_one_series_failing_does_not_block_the_others(rig: Rig) -> None:
    rig.chain.now_ns = T0 + HOUR + 30 * SEC
    rig.chain.set_spot("ETH", 2_110)
    rig.chain.fail_next = "epoch is not current"
    with pytest.raises(TxError):
        rig.keeper.tick_funding(rig.chain.now_ns)
    assert [m for m, _ in rig.chain.calls] == ["settle_funding"]  # the second series still settled
    rig.keeper.tick_funding(rig.chain.now_ns)  # and the first one is retried next turn
    assert len(rig.chain.calls) == 2


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


def test_a_funding_backlog_is_settled_a_few_at_a_time_so_spot_is_never_starved(rig: Rig) -> None:
    rig.chain.add_series("ETH-2000-C", "ETH-2000-P", "ETH-2200-C")  # five series in all
    rig.chain.now_ns = T0 + HOUR + 30 * SEC
    rig.chain.set_spot("ETH", 2_110)
    per_pass = []
    for _ in range(4):
        before = len(rig.chain.calls)
        rig.keeper.tick_funding(rig.chain.now_ns)
        per_pass.append(len(rig.chain.calls) - before)
    assert per_pass == [2, 2, 1, 0]
    assert {s["last_epoch"] for s in rig.chain.series.values()} == {str(rig.chain.now_ns // HOUR)}
