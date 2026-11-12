from decimal import Decimal

from twooptions_agent.spot import FeedConfig, SpotFeed, VenueQuote, aggregate, to_spot_units
from twooptions_agent.wire import SpotUpdate, Underlying

ETH = Underlying.ETH
NOW = 1_794_268_800 * 10**9
CFG = FeedConfig()


def q(venue: str, price: str, age_s: float = 0.0, u: Underlying = ETH) -> VenueQuote:
    return VenueQuote(venue, u, Decimal(price), NOW - int(age_s * 1e9))


def test_median_of_agreeing_venues() -> None:
    d = aggregate(ETH, [q("a", "2112.10"), q("b", "2112.30"), q("c", "2114.15")], NOW, None, CFG)
    assert d.hold is None and d.update is not None
    assert d.update.price == 211_230_000_000
    assert d.update.ts_ns == NOW and d.update.seq == NOW // 1_000_000


def test_outlier_is_dropped_and_reported() -> None:
    d = aggregate(ETH, [q("a", "2112.1"), q("b", "2112.3"), q("bad", "2200")], NOW, None, CFG)
    assert d.update is not None and d.rejected == ("bad",)
    assert d.update.price == to_spot_units(Decimal("2112.2"))


def test_holds_without_quorum_of_fresh_venues() -> None:
    d = aggregate(ETH, [q("a", "2112.1"), q("stale", "2112.2", age_s=11)], NOW, None, CFG)
    assert d.update is None and d.hold is not None and "fresh" in d.hold


def test_holds_when_venues_disagree() -> None:
    d = aggregate(ETH, [q("a", "2000"), q("b", "2100")], NOW, None, CFG)
    assert d.update is None and d.hold is not None and "disagree" in d.hold


def test_jump_guard_mirrors_the_contract() -> None:
    last = SpotUpdate(ETH, 200_000_000_000, NOW - 60 * 10**9, 5)
    jump = [q("a", "2300"), q("b", "2300")]  # +15%
    assert aggregate(ETH, jump, NOW, last, CFG).update is None
    # After the contract's 300 s window any move is accepted.
    old = SpotUpdate(ETH, 200_000_000_000, NOW - 301 * 10**9, 5)
    assert aggregate(ETH, jump, NOW, old, CFG).update is not None


def test_seq_and_timestamp_never_go_backwards() -> None:
    last = SpotUpdate(ETH, 211_000_000_000, NOW + 2 * 10**9, NOW // 1_000_000 + 5_000)
    d = aggregate(ETH, [q("a", "2112"), q("b", "2112")], NOW, last, CFG)
    assert d.update is not None
    assert d.update.ts_ns >= last.ts_ns and d.update.seq == last.seq + 1


def test_rounds_half_even_to_1e8() -> None:
    assert to_spot_units(Decimal("2112.123456785")) == 211_212_345_678
    assert to_spot_units(Decimal("2112.123456775")) == 211_212_345_678


def test_feed_survives_a_failing_venue() -> None:
    def ok(us: list[Underlying], now: int) -> list[VenueQuote]:
        return [VenueQuote("ok", u, Decimal("2112"), now) for u in us]

    def ok2(us: list[Underlying], now: int) -> list[VenueQuote]:
        return [VenueQuote("ok2", u, Decimal("2112.4"), now) for u in us]

    def down(us: list[Underlying], now: int) -> list[VenueQuote]:
        raise TimeoutError("venue down")

    feed = SpotFeed([ETH], venues={"ok": ok, "ok2": ok2, "down": down})
    (d,) = feed.poll(NOW)
    assert d.update is not None and set(d.venues) == {"ok", "ok2"}
    (d2,) = feed.poll(NOW + 10**9)
    assert d2.update is not None and d2.update.seq > d.update.seq
