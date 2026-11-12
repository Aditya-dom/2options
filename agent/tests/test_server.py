import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from twooptions_agent import config, near
from twooptions_agent.chain import ChainCache
from twooptions_agent.quoter import Quoter
from twooptions_agent.server import App, RateLimiter, make_handler
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
