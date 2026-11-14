import json
import socket
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from twooptions_agent import config, near
from twooptions_agent import server as server_module
from twooptions_agent import store as store_module
from twooptions_agent.chain import ChainCache
from twooptions_agent.quoter import Quoter, QuoterConfig
from twooptions_agent.server import App, RateLimiter, Server, client_ip, make_handler
from twooptions_agent.store import Store

from .fakes import CONTRACT, FakeChain

KEY = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
QUOTE = {"series": "ETH-2100-C", "side": "Buy", "size": "1000000", "taker": "alice.testnet"}


@pytest.fixture
def chain(monkeypatch: pytest.MonkeyPatch) -> FakeChain:
    c = FakeChain(KEY)
    c.add_series("ETH-2100-C", "ETH-2100-P")
    c.set_spot("ETH", 2_110)
    c.accounts["alice.testnet"] = {"collateral": "1000000", "positions": []}
    # The app reads the wall clock; pin it to the fake chain's time.
    monkeypatch.setattr("time.time_ns", lambda: c.now_ns)
    return c


@pytest.fixture
def app(chain: FakeChain) -> App:
    return App(
        contract_id=CONTRACT,
        cache=ChainCache(chain.view, max_age_s=0),
        quoter=Quoter(KEY, CONTRACT),
        store=Store(None),
        cors=["http://localhost:3001"],
    )


def test_chain_rows_have_the_shape_the_app_parses(app: App) -> None:
    status, rows = app.handle("/chain", {})
    assert status == 200 and len(rows) == 2
    for r in rows:
        assert {"series", "bid", "ask", "mark", "delta", "gamma", "funding_rate_hourly"} <= set(r)
        for k in ("bid", "ask", "mark", "funding_rate_hourly"):
            assert isinstance(r[k], str) and int(r[k]) >= 0
        assert isinstance(r["delta"], float) and isinstance(r["gamma"], float)


def test_spot_and_attestation(app: App) -> None:
    assert app.handle("/spot", {}) == (
        200, {"ETH": {"price": "211000000000", "ts_ns": str(app.cache.get().spots[next(iter(app.cache.get().spots))].ts_ns)}},
    )  # fmt: skip
    assert app.handle("/attestation", {}) == (200, {"agent_public_key": near.public_key_str(KEY)})
    app.code_hash, app.tee_quote_url = "sha256:abc", "https://example.invalid/quote"
    assert app.handle("/attestation", {})[1]["code_hash"] == "sha256:abc"


def test_quote_round_trip_and_watch_list(app: App) -> None:
    status, body = app.handle("/quote", QUOTE)
    assert status == 200
    assert body["quote"]["taker"] == "alice.testnet" and body["quote"]["side"] == "Buy"
    assert len(body["signature"]) == 88  # base64 of 64 bytes
    assert app.store.takers() == ["alice.testnet"]


def test_quote_for_an_account_that_never_deposited_is_refused(app: App) -> None:
    status, body = app.handle("/quote", {**QUOTE, "taker": "nobody.testnet"})
    assert (status, body) == (409, {"error": "deposit first"})
    assert app.store.takers() == []


@pytest.mark.parametrize(
    ("change", "status"),
    [
        ({"side": "Hold"}, 400),
        ({"size": "-5"}, 400),
        ({"size": "1e6"}, 400),
        ({"size": ""}, 400),
        ({"series": "ETH-1-C"}, 404),
        ({"taker": "not valid"}, 400),
    ],
)
def test_bad_quote_requests_get_an_error_body(app: App, change: dict, status: int) -> None:
    got, body = app.handle("/quote", {**QUOTE, **change})
    assert got == status and isinstance(body["error"], str)


def test_missing_parameters_and_unknown_paths(app: App) -> None:
    assert app.handle("/quote", {"series": "ETH-2100-C"})[0] == 400
    assert app.handle("/nope", {}) == (404, {"error": "not found"})


def test_funding_history_filters_and_limits(app: App) -> None:
    for i in range(5):
        app.store.add_funding({"series": "ETH-2100-C" if i % 2 else "ETH-2100-P", "epoch": str(i)})
    assert [e["epoch"] for e in app.handle("/funding/history", {})[1]] == ["4", "3", "2", "1", "0"]
    got = app.handle("/funding/history", {"series": "ETH-2100-C", "limit": "1"})[1]
    assert got == [{"series": "ETH-2100-C", "epoch": "3"}]
    assert app.handle("/funding/history", {"limit": "0"})[0] == 400


def test_inventory_reports_the_hedge_for_the_vault_short(app: App, chain: FakeChain) -> None:
    chain.series["ETH-2100-C"]["net_trader_size"] = str(4_000_000)  # traders long 4 calls
    inv = app.handle("/inventory", {})[1]
    assert inv["net_delta"]["ETH"] < 0  # the vault is short calls
    assert inv["hedge_target"]["ETH"] == pytest.approx(-inv["net_delta"]["ETH"])
    assert 1.5 < inv["hedge_target"]["ETH"] < 3.0  # about 4 x 0.55 ETH long


def test_the_hedge_delta_is_the_quoted_delta_for_every_strike(app: App, chain: FakeChain) -> None:
    chain.add_series("ETH-2300-C", "ETH-1900-P")  # away from the money, where the smile matters
    for sid in chain.series:
        chain.series[sid]["net_trader_size"] = str(1_000_000)
    quoted = {r["series"]: r["delta"] for r in app.handle("/chain", {})[1]}
    inv = app.handle("/inventory", {})[1]
    assert len(inv["exposures"]) == 4
    for e in inv["exposures"]:
        assert e["delta_per_contract"] == pytest.approx(quoted[e["series"]], abs=1e-6)


def test_hedge_without_a_hedger_says_so_and_shows_the_target(app: App, chain: FakeChain) -> None:
    chain.series["ETH-2100-C"]["net_trader_size"] = str(4_000_000)
    status, body = app.handle("/hedge", {})
    inv = app.handle("/inventory", {})[1]
    assert status == 200 and body["enabled"] is False and body["orders"] == []
    assert body["underlyings"] == {"ETH": {"target": round(inv["hedge_target"]["ETH"], 6)}}
    assert app.handle("/health", {})[1]["hedger"] is False


def test_hedge_reports_the_running_hedger(app: App, chain: FakeChain) -> None:
    from twooptions_agent.hedger import Hedger

    from .test_hedger import FakeVenue

    chain.series["ETH-2100-C"]["net_trader_size"] = str(4_000_000)
    venue = FakeVenue(lambda: chain.now_ns)
    app.hedger = Hedger(venue, app.cache, app.quoter, app.store, clock=lambda: chain.now_ns)
    app.hedger.tick()
    status, body = app.handle("/hedge", {})
    assert status == 200 and body["enabled"] is True and body["venue"] == "hyperliquid"
    row = body["underlyings"]["ETH"]
    assert row["position"] == str(venue.position) and abs(row["gap"]) < 1e-4
    assert len(body["orders"]) == 1 and body["orders"][0]["status"] == "filled"
    assert app.handle("/health", {})[1]["hedger"] is True
    json.dumps(body)  # everything in it is JSON


def test_rpc_failure_is_a_502_not_a_crash(app: App, chain: FakeChain) -> None:
    def boom(method, args=None):  # type: ignore[no-untyped-def]
        raise OSError("rpc down")

    app.cache.view = boom
    status, body = app.handle("/chain", {})
    assert status == 502 and "OSError" in body["error"]


def test_rate_limiter_refills() -> None:
    lim = RateLimiter(per_second=1, burst=2)
    assert [lim.allow("a", 0.0), lim.allow("a", 0.0), lim.allow("a", 0.0)] == [True, True, False]
    assert lim.allow("b", 0.0)
    assert lim.allow("a", 1.0)


def test_quotes_are_rate_limited_per_client(app: App) -> None:
    app.limiter = RateLimiter(per_second=0.001, burst=1)
    assert app.handle("/quote", QUOTE, "1.2.3.4")[0] == 200
    assert app.handle("/quote", QUOTE, "1.2.3.4")[0] == 429
    assert app.handle("/quote", QUOTE, "5.6.7.8")[0] == 200


def test_http_layer_json_and_cors(app: App) -> None:
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    try:

        def get(path: str, origin: str | None, method: str = "GET"):  # type: ignore[no-untyped-def]
            req = urllib.request.Request(
                base + path, method=method, headers={"Origin": origin} if origin else {}
            )
            try:
                with urllib.request.urlopen(req, timeout=5) as r:
                    return r.status, r.headers, r.read()
            except urllib.error.HTTPError as e:
                return e.code, e.headers, e.read()

        status, headers, body = get("/chain", "http://localhost:3001")
        assert status == 200 and len(json.loads(body)) == 2
        assert headers["Access-Control-Allow-Origin"] == "http://localhost:3001"
        assert headers["Content-Type"] == "application/json"

        status, headers, _ = get("/chain", "https://evil.example")
        assert status == 200 and headers["Access-Control-Allow-Origin"] is None

        status, headers, body = get(
            "/quote?series=ETH-2100-C&side=Buy&size=1000000&taker=alice.testnet", None
        )
        assert status == 200 and json.loads(body)["quote"]["series"] == "ETH-2100-C"

        status, headers, body = get("/quote?series=nope", "http://localhost:3001")
        assert status == 400 and "error" in json.loads(body)
        assert headers["Access-Control-Allow-Origin"] == "http://localhost:3001"

        status, headers, _ = get("/quote", "http://localhost:3001", "OPTIONS")
        assert status == 204 and "GET" in headers["Access-Control-Allow-Methods"]
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_store_survives_a_restart_and_a_torn_line(tmp_path: Path) -> None:
    s = Store(tmp_path)
    s.add_funding({"series": "ETH-2100-C", "epoch": "1"})
    s.add_taker("alice.testnet")
    s.add_taker("bob.testnet")
    s.remove_taker("alice.testnet")
    with (tmp_path / "funding.jsonl").open("a") as f:
        f.write('{"series": "ETH-21')  # crash mid-write
    again = Store(tmp_path)
    assert again.funding_history(None, 10) == [{"series": "ETH-2100-C", "epoch": "1"}]
    assert again.takers() == ["bob.testnet"]


def test_config_reads_env_and_rejects_bad_values(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    for k in (
        "TWOOPTIONS_CONTRACT_ID",
        "NEAR_NETWORK",
        "NEAR_RPC_URL",
        "AGENT_PRIVATE_KEY",
        "TWOOPTIONS_VOL_ETH",
    ):
        monkeypatch.delenv(k, raising=False)
    with pytest.raises(config.ConfigError, match="TWOOPTIONS_CONTRACT_ID"):
        config.network()
    env = tmp_path / ".env"
    env.write_text(
        f'# comment\nTWOOPTIONS_CONTRACT_ID="twooptions.testnet"\nAGENT_PRIVATE_KEY={near.secret_key_str(KEY)}\nTWOOPTIONS_VOL_ETH=0.75\n'
    )
    config.load_dotenv(env)
    net = config.network()
    assert (net.network, net.contract_id) == ("testnet", "twooptions.testnet")
    assert net.rpc_url.startswith("https://")
    assert near.public_key_str(config.agent_key()) == near.public_key_str(KEY)
    assert config.quoter_config().atm_vol[near_underlying("ETH")] == 0.75
    assert config.keeper_account(net) is None

    monkeypatch.setenv("TWOOPTIONS_VOL_ETH", "9")
    with pytest.raises(config.ConfigError, match="TWOOPTIONS_VOL_ETH"):
        config.quoter_config()
    monkeypatch.setenv("AGENT_PRIVATE_KEY", "ed25519:nonsense")
    with pytest.raises(config.ConfigError, match="AGENT_PRIVATE_KEY"):
        config.agent_key()
    for k in ("TWOOPTIONS_CONTRACT_ID", "AGENT_PRIVATE_KEY", "TWOOPTIONS_VOL_ETH"):
        monkeypatch.delenv(k, raising=False)


def near_underlying(name: str):  # type: ignore[no-untyped-def]
    from twooptions_agent.wire import Underlying

    return Underlying[name]


HL_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123"  # the SDK's test key


def test_hedge_config_is_off_without_a_key_and_strict_with_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for k in (
        "HYPERLIQUID_PRIVATE_KEY",
        "HYPERLIQUID_ACCOUNT_ADDRESS",
        "HYPERLIQUID_NETWORK",
        "HYPERLIQUID_API_URL",
        "HEDGE_DEADBAND_USD",
        "HEDGE_MAX_ORDER_USD",
        "HEDGE_SLIPPAGE_BPS",
    ):
        monkeypatch.delenv(k, raising=False)
    testnet = config.Network("testnet", "https://rpc.example", "twooptions.testnet")
    assert config.hedge_venue(testnet) is None  # no key: no hedging, and no error

    monkeypatch.setenv("HYPERLIQUID_PRIVATE_KEY", HL_KEY)
    venue = config.hedge_venue(testnet)
    assert venue is not None and venue.network == "testnet"
    assert venue.account == "0x14791697260e4c9a71f18484c9f997b308e59325"  # the key's own address

    monkeypatch.setenv("HYPERLIQUID_ACCOUNT_ADDRESS", "0x" + "AB" * 20)  # an API wallet's master
    assert config.hedge_venue(testnet).account == "0x" + "ab" * 20  # type: ignore[union-attr]
    monkeypatch.setenv("HYPERLIQUID_ACCOUNT_ADDRESS", "0x1234")
    with pytest.raises(config.ConfigError, match="HYPERLIQUID_ACCOUNT_ADDRESS"):
        config.hedge_venue(testnet)
    monkeypatch.delenv("HYPERLIQUID_ACCOUNT_ADDRESS")

    # Real money against a test book, or the reverse, is refused at start-up.
    monkeypatch.setenv("HYPERLIQUID_NETWORK", "mainnet")
    with pytest.raises(config.ConfigError, match="does not match"):
        config.hedge_venue(testnet)
    mainnet = config.Network("mainnet", "https://rpc.example", "twooptions.near")
    assert config.hedge_venue(mainnet).network == "mainnet"  # type: ignore[union-attr]
    monkeypatch.setenv("HYPERLIQUID_NETWORK", "testnet")
    with pytest.raises(config.ConfigError, match="does not match"):
        config.hedge_venue(mainnet)
    monkeypatch.setenv("HYPERLIQUID_NETWORK", "devnet")
    with pytest.raises(config.ConfigError, match="HYPERLIQUID_NETWORK"):
        config.hedge_venue(testnet)
    monkeypatch.setenv("HYPERLIQUID_NETWORK", "testnet")

    monkeypatch.setenv("HYPERLIQUID_PRIVATE_KEY", "not-a-key")
    with pytest.raises(config.ConfigError, match="HYPERLIQUID_PRIVATE_KEY"):
        config.hedge_venue(testnet)

    assert config.hedge_config().deadband_usd == 25.0
    monkeypatch.setenv("HEDGE_DEADBAND_USD", "40")
    assert config.hedge_config().deadband_usd == 40.0
    for name, bad in (
        ("HEDGE_DEADBAND_USD", "-1"),
        ("HEDGE_MAX_ORDER_USD", "5"),
        ("HEDGE_SLIPPAGE_BPS", "0"),
        ("HEDGE_SLIPPAGE_BPS", "abc"),
    ):
        monkeypatch.setenv(name, bad)
        with pytest.raises(config.ConfigError, match=name):
            config.hedge_config()
        monkeypatch.delenv(name)


def test_one_container_serves_the_app_and_the_api(app: App, tmp_path: Path) -> None:
    site = tmp_path / "site"
    (site / "assets").mkdir(parents=True)
    (site / "index.html").write_text("<!doctype html><title>2Options</title>")
    (site / "assets" / "app-1a2b.js").write_text("console.log(1)")
    (tmp_path / "secret.txt").write_text("not served")
    app.static_dir = site
    app.tee = {"platform": "intel-tdx (dstack)", "quote": "04ab"}
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"

    def get(path: str):  # type: ignore[no-untyped-def]
        try:
            with urllib.request.urlopen(base + path, timeout=5) as r:
                return r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    try:
        status, headers, body = get("/")
        assert status == 200 and b"2Options" in body and headers["Content-Type"] == "text/html"
        assert headers["Cache-Control"] == "no-cache"
        status, headers, _ = get("/assets/app-1a2b.js")
        assert status == 200 and "immutable" in headers["Cache-Control"]
        status, _, body = get("/health")  # API paths still answer with JSON
        assert status == 200 and json.loads(body)["ok"] is True
        status, _, body = get("/attestation")
        assert json.loads(body)["tee"]["quote"] == "04ab"
        status, _, body = get("/hedge")
        assert status == 200 and "enabled" in json.loads(body)
        for bad in ("/../secret.txt", "/%2e%2e/secret.txt", "/nope.js"):
            status, _, body = get(bad)
            assert status == 404 and b"not served" not in body
    finally:
        httpd.shutdown()


def test_limits_are_published_and_enforced_on_quotes(app: App, chain: FakeChain) -> None:
    assert app.handle("/limits", {}) == (
        200, {"max_trade_size": None, "max_position": None, "max_open_interest": None},
    )  # fmt: skip
    app.quoter = Quoter(KEY, CONTRACT, QuoterConfig(max_trade_size=100_000, max_position=100_000))
    assert app.handle("/limits", {})[1]["max_trade_size"] == "100000"
    big = {"series": "ETH-2100-C", "side": "Buy", "size": "1000000", "taker": "alice.testnet"}
    status, body = app.handle("/quote", big, "1.1.1.1")
    assert status == 409 and "per trade" in body["error"]
    assert app.handle("/quote", {**big, "size": "100000"}, "1.1.1.1")[0] == 200
    # Closing a position bigger than the limits still gets a quote.
    chain.accounts["alice.testnet"]["positions"] = [{"series": "ETH-2100-C", "size": "5000000"}]
    assert app.handle("/quote", {**big, "side": "Sell", "size": "5000000"}, "1.1.1.1")[0] == 200
    status, body = app.handle("/quote", {**big, "taker": "nobody.testnet"}, "1.1.1.1")
    assert status == 409 and body["error"] == "deposit first"


# -- limits on a public server -----------------------------------------------------------------


def test_a_quote_puts_the_account_on_the_keepers_close_watch(app: App) -> None:
    touched: list[str] = []

    class Watching:
        def touch(self, account_id: str) -> None:
            touched.append(account_id)

    app.keeper = Watching()  # type: ignore[assignment]
    status, _ = app.handle("/quote", {**QUOTE, "taker": "alice.testnet"})
    assert status == 200 and touched == ["alice.testnet"]
    status, _ = app.handle("/quote", {**QUOTE, "taker": "nobody.testnet"})  # refused: no deposit
    assert status == 409 and touched == ["alice.testnet"]


def test_the_limiter_forgets_idle_clients_first_and_never_everyone_at_once() -> None:
    lim = RateLimiter(per_second=1, burst=2, max_clients=4)
    assert lim.allow("busy", now=0) and lim.allow("busy", now=0) and not lim.allow("busy", now=0)
    for i in range(3):
        lim.allow(f"idle{i}", now=0)
    # Five seconds on, the idle ones have full buckets again; one more client forces a clean-up.
    assert lim.allow("busy", now=5.0) and lim.allow("busy", now=5.0)
    lim.allow("new", now=5.0)
    assert not lim.allow("busy", now=5.0)  # still out of tokens: it was not handed a new burst
    assert set(lim._state) == {"busy", "new"}

    # When every client is active there is nothing idle to forget: the most recent half stay.
    crowd = RateLimiter(per_second=0.001, burst=1, max_clients=4)
    for i in range(5):
        crowd.allow(f"c{i}", now=float(i))
    assert set(crowd._state) == {"c3", "c4"}
    assert not crowd.allow("c4", now=5.0)


@pytest.mark.parametrize(
    ("peer", "header", "expect"),
    [
        ("203.0.113.9", None, "203.0.113.9"),
        # A client that connects directly cannot pick whom it is counted as.
        ("203.0.113.9", "1.1.1.1", "203.0.113.9"),
        ("10.0.0.1", None, "10.0.0.1"),
        ("10.0.0.1", "198.51.100.7", "198.51.100.7"),
        # The client wrote the first entry; the proxy appended the address it really saw.
        ("10.0.0.1", "1.1.1.1, 198.51.100.7", "198.51.100.7"),
        ("10.0.0.1", "198.51.100.7, 10.0.0.2", "198.51.100.7"),  # two proxies in a row
        ("10.0.0.1", "10.0.0.2", "10.0.0.1"),
        ("10.0.0.1", " , ", "10.0.0.1"),
    ],
)
def test_the_client_is_taken_from_the_header_only_behind_a_named_proxy(
    peer: str, header: str | None, expect: str
) -> None:
    assert client_ip(peer, header, frozenset({"10.0.0.1", "10.0.0.2"})) == expect


def test_quotes_behind_a_proxy_are_limited_per_client_not_per_proxy(app: App) -> None:
    app.limiter = RateLimiter(per_second=0.001, burst=1)
    app.proxies = frozenset({"127.0.0.1"})
    httpd = Server(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    query = "&".join(f"{k}={v}" for k, v in QUOTE.items())
    url = f"http://127.0.0.1:{httpd.server_address[1]}/quote?{query}"

    def quote(client: str) -> int:
        req = urllib.request.Request(url, headers={"X-Forwarded-For": client})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return int(r.status)
        except urllib.error.HTTPError as e:
            return e.code

    try:
        assert [quote("198.51.100.1"), quote("198.51.100.1"), quote("198.51.100.2")] == [
            200,
            429,
            200,
        ]
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_open_connections_are_capped_and_idle_ones_are_dropped(
    app: App, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(server_module, "IDLE_TIMEOUT_S", 0.3)
    httpd = Server(("127.0.0.1", 0), make_handler(app), max_connections=2)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    address = ("127.0.0.1", httpd.server_address[1])

    def closed_by_server(sock: socket.socket, within: float) -> bool:
        sock.settimeout(within)
        try:
            return sock.recv(1) == b""
        except TimeoutError:
            return False
        except ConnectionError:
            return True

    try:
        idle = [socket.create_connection(address) for _ in range(2)]  # connect, say nothing
        extra = socket.create_connection(address)
        assert closed_by_server(extra, 0.2)  # over the cap: refused at once, no thread spent
        assert all(closed_by_server(s, 1.0) for s in idle)  # the silent ones time out
        with urllib.request.urlopen(f"http://{address[0]}:{address[1]}/health", timeout=5) as r:
            assert r.status == 200  # and their slots are free again
    finally:
        for s in (*idle, extra):
            s.close()
        httpd.shutdown()
        httpd.server_close()


def test_the_log_files_stay_bounded_and_keep_the_newest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(store_module, "MAX_FUNDING_IN_MEMORY", 10)
    monkeypatch.setattr(store_module, "MAX_HEDGE_IN_MEMORY", 5)
    store = Store(tmp_path)
    lines = lambda name: (tmp_path / name).read_text().splitlines()  # noqa: E731
    sizes = []
    for i in range(100):
        store.add_funding({"series": "ETH-2100-C", "epoch": str(i)})
        store.add_hedge_order({"n": i})
        sizes.append((len(lines("funding.jsonl")), len(lines("hedge.jsonl"))))
    assert max(f for f, _ in sizes) <= 20 and max(h for _, h in sizes) <= 10
    assert [e["epoch"] for e in store.funding_history(None, 3)] == ["99", "98", "97"]
    assert json.loads(lines("funding.jsonl")[-1])["epoch"] == "99"
    assert not list(tmp_path.glob("*.tmp"))

    # A file left oversized by an older version is cut down when it is next opened.
    with (tmp_path / "funding.jsonl").open("a") as f:
        f.writelines(
            json.dumps({"series": "ETH-2100-C", "epoch": str(i)}) + "\n" for i in range(100, 200)
        )
        f.write('{"torn')
    again = Store(tmp_path)
    assert len(lines("funding.jsonl")) == 10
    assert [e["epoch"] for e in again.funding_history(None, 2)] == ["199", "198"]
    assert len(again.funding_history(None, 500)) == 10
