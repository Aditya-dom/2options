import base64

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from twooptions_agent import margin, pricing, wire
from twooptions_agent.chain import fetch_snapshot
from twooptions_agent.quoter import QuoteError, Quoter, QuoterConfig
from twooptions_agent.wire import Side, Underlying

from .fakes import CONTRACT, SEC, FakeChain

KEY = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
ONE = 1_000_000  # one contract


@pytest.fixture
def chain() -> FakeChain:
    c = FakeChain(KEY)
    c.add_series("ETH-2100-C", "ETH-2100-P", "ETH-2200-C", "ETH-1900-C")
    c.set_spot("ETH", 2_110)
    return c


def quoter(**kw: object) -> Quoter:
    return Quoter(KEY, CONTRACT, QuoterConfig(**kw))  # type: ignore[arg-type]


def test_rows_are_ordered_inside_the_band_and_use_the_consistent_funding_rate(
    chain: FakeChain,
) -> None:
    snap = fetch_snapshot(chain.view, chain.now_ns)
    rows = {r.series: r for r in quoter().rows(snap, chain.now_ns)}
    assert set(rows) == set(chain.series)
    for sid, r in rows.items():
        s = snap.series[sid]
        lo, hi = margin.price_band(s.is_call, 2_110 * 10**8, s.strike, snap.params.margin)
        assert lo <= r.bid < r.mark < r.ask <= hi
        intr = margin.intrinsic(s.is_call, 2_110 * 10**8, s.strike)
        assert r.funding_rate == pricing.funding_rate(r.mark, intr, 1 / 24, 50_000_000)
    assert 0.4 < rows["ETH-2100-C"].delta < 0.7
    assert rows["ETH-2100-P"].delta < 0
    # Out of the money pays the whole mark's worth of time value: exactly 1/24 per hour.
    assert rows["ETH-2200-C"].funding_rate == round(1e9 / 24)


def test_quote_is_signed_the_way_the_contract_verifies(chain: FakeChain) -> None:
    snap = fetch_snapshot(chain.view, chain.now_ns)
    q = quoter()
    signed = q.quote(snap, "ETH-2100-C", Side.Buy, ONE, "alice.testnet", chain.now_ns)
    row = q.row(snap.series["ETH-2100-C"], 2_110 * 10**8, snap)
    assert signed.quote.price == row.ask
    assert signed.quote.expiry_ns - chain.now_ns == 28 * SEC  # 30 s contract limit minus safety
    KEY.public_key().verify(base64.b64decode(signed.signature), wire.digest(CONTRACT, signed.quote))
    j = signed.to_json()["quote"]
    assert j == {
        "series": "ETH-2100-C", "taker": "alice.testnet", "side": "Buy", "size": str(ONE),
        "price": str(row.ask), "nonce": str(signed.quote.nonce), "expiry_ns": str(signed.quote.expiry_ns),
    }  # fmt: skip
    sell = q.quote(snap, "ETH-2100-C", Side.Sell, ONE, "alice.testnet", chain.now_ns)
    assert sell.quote.price == row.bid < signed.quote.price


def test_nonces_strictly_increase_even_within_one_microsecond(chain: FakeChain) -> None:
    snap = fetch_snapshot(chain.view, chain.now_ns)
    q = quoter()
    nonces = [
        q.quote(snap, "ETH-2100-C", Side.Buy, ONE, "alice.testnet", chain.now_ns).quote.nonce
        for _ in range(50)
    ]
    assert nonces == sorted(set(nonces))
    assert nonces[0] == chain.now_ns // 1_000


def test_ttl_never_exceeds_the_contract_limit(chain: FakeChain) -> None:
    chain.params["max_quote_ttl_ns"] = 10 * SEC
    snap = fetch_snapshot(chain.view, chain.now_ns)
    signed = quoter().quote(snap, "ETH-2100-C", Side.Buy, ONE, "alice.testnet", chain.now_ns)
    assert signed.quote.expiry_ns - chain.now_ns == 8 * SEC
    chain.params["max_quote_ttl_ns"] = 2 * SEC
    with pytest.raises(QuoteError, match="TTL"):
        quoter().quote(
            fetch_snapshot(chain.view, chain.now_ns),
            "ETH-2100-C",
            Side.Buy,
            ONE,
            "alice.testnet",
            chain.now_ns,
        )


@pytest.mark.parametrize(
    ("series", "side", "size", "taker", "status", "match"),
    [
        ("ETH-9999-C", Side.Buy, ONE, "alice.testnet", 404, "unknown series"),
        ("ETH-2100-C", Side.Buy, 999, "alice.testnet", 400, "size"),
        ("ETH-2100-C", Side.Buy, 10**12 + 1, "alice.testnet", 400, "size"),
        ("ETH-2100-C", Side.Buy, ONE, "Alice.testnet", 400, "taker"),
        ("ETH-2100-C", Side.Buy, ONE, "a", 400, "taker"),
        ("ETH-2100-C", Side.Buy, ONE, "x" * 65, 400, "taker"),
        ("ETH-2100-C", Side.Buy, ONE, "alice..testnet", 400, "taker"),
    ],
)
def test_bad_requests_are_refused(
    chain: FakeChain, series: str, side: Side, size: int, taker: str, status: int, match: str
) -> None:
    snap = fetch_snapshot(chain.view, chain.now_ns)
    with pytest.raises(QuoteError, match=match) as e:
        quoter().quote(snap, series, side, size, taker, chain.now_ns)
    assert e.value.status == status


def test_stale_spot_paused_and_inactive_series_are_refused(chain: FakeChain) -> None:
    q = quoter()
    chain.set_spot("ETH", 2_110, age_s=31)
    snap = fetch_snapshot(chain.view, chain.now_ns)
    assert q.rows(snap, chain.now_ns) == []
    with pytest.raises(QuoteError, match="stale"):
        q.quote(snap, "ETH-2100-C", Side.Buy, ONE, "alice.testnet", chain.now_ns)

    chain.set_spot("ETH", 2_110)
    chain.paused = True
    with pytest.raises(QuoteError, match="paused"):
        q.quote(
            fetch_snapshot(chain.view, chain.now_ns),
            "ETH-2100-C",
            Side.Buy,
            ONE,
            "alice.testnet",
            chain.now_ns,
        )

    chain.paused = False
    chain.series["ETH-2100-C"]["active"] = False
    with pytest.raises(QuoteError, match="not active"):
        q.quote(
            fetch_snapshot(chain.view, chain.now_ns),
            "ETH-2100-C",
            Side.Buy,
            ONE,
            "alice.testnet",
            chain.now_ns,
        )


def test_does_not_sell_below_fair_when_the_band_is_too_tight(chain: FakeChain) -> None:
    # The contract's default band (1.5% of spot) is below the fair price at 150% vol.
    chain.params["max_time_value_bps"] = 150
    snap = fetch_snapshot(chain.view, chain.now_ns)
    q = quoter(atm_vol={Underlying.ETH: 1.5})
    row = q.row(snap.series["ETH-2100-C"], 2_110 * 10**8, snap)
    assert not row.can_buy and row.can_sell
    with pytest.raises(QuoteError, match="price band") as e:
        q.quote(snap, "ETH-2100-C", Side.Buy, ONE, "alice.testnet", chain.now_ns)
    assert e.value.status == 409
    q.quote(snap, "ETH-2100-C", Side.Sell, ONE, "alice.testnet", chain.now_ns)


def test_worthless_strike_has_no_bid(chain: FakeChain) -> None:
    chain.add_series("ETH-4000-C")
    snap = fetch_snapshot(chain.view, chain.now_ns)
    q = quoter()
    assert q.row(snap.series["ETH-4000-C"], 2_110 * 10**8, snap).bid == 0
    with pytest.raises(QuoteError, match="no bid"):
        q.quote(snap, "ETH-4000-C", Side.Sell, ONE, "alice.testnet", chain.now_ns)
    q.quote(snap, "ETH-4000-C", Side.Buy, ONE, "alice.testnet", chain.now_ns)


def test_vault_limits_are_checked_before_signing(chain: FakeChain) -> None:
    q = quoter()
    # A vault with 100 USDC cannot be short 10 at-the-money calls (about 4,400 USDC of risk).
    chain.vault_cash = 100 * 10**6
    snap = fetch_snapshot(chain.view, chain.now_ns)
    with pytest.raises(QuoteError, match="vault risk limit reached"):
        q.quote(snap, "ETH-2100-C", Side.Buy, 10 * ONE, "alice.testnet", chain.now_ns)
    # It cannot pay for 100 contracts sold to it either.
    with pytest.raises(QuoteError, match="vault cannot fund this trade"):
        q.quote(snap, "ETH-2100-C", Side.Sell, 100 * ONE, "alice.testnet", chain.now_ns)
    # Buying from a trader only makes the vault long: no risk limit applies.
    q.quote(snap, "ETH-2100-C", Side.Sell, ONE, "alice.testnet", chain.now_ns)

    # A trade that reduces the vault's existing short is always allowed, however thin the vault.
    chain.vault_cash = 2_000 * 10**6
    chain.series["ETH-2100-C"]["net_trader_size"] = str(10 * ONE)
    snap = fetch_snapshot(chain.view, chain.now_ns)
    q.quote(snap, "ETH-2100-C", Side.Sell, 5 * ONE, "alice.testnet", chain.now_ns)
    with pytest.raises(QuoteError, match="vault risk limit reached"):
        q.quote(snap, "ETH-2100-C", Side.Buy, ONE, "alice.testnet", chain.now_ns)


def test_open_interest_without_a_fresh_spot_blocks_every_quote(chain: FakeChain) -> None:
    chain.add_series("BTC-100000-C")
    chain.series["BTC-100000-C"]["net_trader_size"] = str(ONE)
    snap = fetch_snapshot(chain.view, chain.now_ns)  # no BTC spot posted
    with pytest.raises(QuoteError, match="stale"):
        quoter().quote(snap, "ETH-2100-C", Side.Buy, ONE, "alice.testnet", chain.now_ns)


def test_realized_vol_lifts_the_quote_but_never_lowers_it(chain: FakeChain) -> None:
    snap = fetch_snapshot(chain.view, chain.now_ns)
    q = quoter()
    calm = q.row(snap.series["ETH-2100-C"], 2_110 * 10**8, snap).mark
    price, ts = 2_110.0, 0
    for i in range(400):  # about 2% moves every 5 s: far above 60% annualised
        price *= 1.02 if i % 2 == 0 else 1 / 1.02
        ts += 5 * SEC
        q.observe_spot(Underlying.ETH, round(price * 10**8), ts)
    assert q.atm_vol(Underlying.ETH) == 3.0  # capped
    assert q.row(snap.series["ETH-2100-C"], 2_110 * 10**8, snap).mark > calm

    quiet = quoter()
    for i in range(400):
        quiet.observe_spot(Underlying.ETH, 2_110 * 10**8, i * 5 * SEC)
    assert quiet.atm_vol(Underlying.ETH) == 0.6
