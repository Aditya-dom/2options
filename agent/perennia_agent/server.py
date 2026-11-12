"""The agent's HTTP API (#21) and process entry point.

    GET /chain                          bid, ask, mark, greeks and funding rate per series
    GET /quote?series=&side=&size=&taker=   one signed quote
    GET /spot                           the contract's cached spot per underlying
    GET /funding/history?series=&limit= settlements this agent has posted, newest first
    GET /attestation                    the agent's public key (and TEE fields when set)
    GET /inventory                      vault position, net delta and hedge target
    GET /health                         liveness and keeper status

Numbers follow the contract's JSON rules: every 64/128-bit integer is a decimal string.
Errors are non-200 with `{"error": "..."}`.

    uv run python -m perennia_agent.server            # quote server + keeper
    uv run python -m perennia_agent.server --no-keeper

Standard library only: one thread per request, which is plenty for an RFQ desk and keeps the
image that runs inside the TEE small.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from . import config, inventory, near, pricing
from .chain import HOUR_NS, NS, ChainCache, rpc_viewer
from .keeper import Keeper
from .quoter import QuoteError, Quoter
from .spot import SpotFeed
from .store import Store
from .wire import Side

log = logging.getLogger("perennia_agent")

MAX_HISTORY = 500


class RateLimiter:
    """Token bucket per client. Signing is cheap; this only stops one client hogging threads."""

    def __init__(self, per_second: float = 5.0, burst: float = 20.0):
        self.rate, self.burst = per_second, burst
        self._state: dict[str, tuple[float, float]] = {}
        self._lock = threading.Lock()

    def allow(self, client: str, now: float | None = None) -> bool:
        t = now if now is not None else time.monotonic()
        with self._lock:
            tokens, last = self._state.get(client, (self.burst, t))
            tokens = min(self.burst, tokens + (t - last) * self.rate)
            ok = tokens >= 1.0
            self._state[client] = (tokens - 1.0 if ok else tokens, t)
            if len(self._state) > 10_000:
                self._state.clear()
            return ok


@dataclass
class App:
    contract_id: str
    cache: ChainCache
    quoter: Quoter
    store: Store
    keeper: Keeper | None = None
    cors: list[str] = field(default_factory=list)
    limiter: RateLimiter = field(default_factory=RateLimiter)
    code_hash: str = ""
    tee_quote_url: str = ""

    def handle(self, path: str, query: dict[str, str], client: str = "") -> tuple[int, Any]:
        try:
            return self._route(path, query, client)
        except QuoteError as e:
            return e.status, {"error": str(e)}
        except Exception as e:  # RPC down, bad contract id, ...
            log.exception("request %s failed", path)
            return 502, {"error": f"upstream failure: {type(e).__name__}"}

    def _route(self, path: str, q: dict[str, str], client: str) -> tuple[int, Any]:
        if path == "/health":
            return 200, self._health()
        if path == "/attestation":
            out = {"agent_public_key": near.public_key_str(self.quoter.key)}
            if self.code_hash:
                out["code_hash"] = self.code_hash
            if self.tee_quote_url:
                out["tee_quote_url"] = self.tee_quote_url
            return 200, out
        if path == "/funding/history":
            limit = _int_param(q, "limit", 48, 1, MAX_HISTORY)
            return 200, self.store.funding_history(q.get("series") or None, limit)
        if path == "/chain":
            return 200, [r.to_json() for r in self.quoter.rows(self.cache.get())]
        if path == "/spot":
            snap = self.cache.get()
            return 200, {
                u.name: {"price": str(sp.price), "ts_ns": str(sp.ts_ns)}
                for u, sp in snap.spots.items()
            }
        if path == "/inventory":
            return 200, self._inventory()
        if path == "/quote":
            if not self.limiter.allow(client):
                raise QuoteError(429, "too many quote requests")
            return 200, self._quote(q)
        return 404, {"error": "not found"}

    def _quote(self, q: dict[str, str]) -> Any:
        for name in ("series", "side", "size", "taker"):
            if not q.get(name):
                raise QuoteError(400, f"missing query parameter: {name}")
        if q["side"] not in Side.__members__:
            raise QuoteError(400, "side must be Buy or Sell")
        size = _int_param(q, "size", 0, 1, 10**30)
        taker = q["taker"]
        signed = self.quoter.quote(self.cache.get(), q["series"], Side[q["side"]], size, taker)
        # The contract only trades for accounts that have deposited. Checking here keeps
        # made-up account ids out of the liquidation watch list.
        if taker not in self.store.takers():
            if self.cache.view("get_account", {"account_id": taker}) is None:
                raise QuoteError(409, "deposit first")
            self.store.add_taker(taker)
        return signed.to_json()

    def _inventory(self) -> Any:
        snap = self.cache.get()
        now = time.time_ns()
        interval_h = snap.params.funding_interval_ns / HOUR_NS
        fraction = self.quoter.cfg.funding_fraction

        def delta(spot: float, strike: float, vol: float, is_call: bool) -> float:
            return pricing.everlasting(spot, strike, vol, is_call, fraction, interval_h).delta

        series = [
            inventory.SeriesState(s.id, s.underlying, s.strike, s.is_call, s.net_trader_size)
            for s in snap.series.values()
        ]
        spots = {u: p for u in snap.spots if (p := snap.fresh_spot(u, now)) is not None}
        vols = {u: self.quoter.atm_vol(u) for u in snap.spots}
        return inventory.compute(series, spots, vols, delta).to_json()

    def _health(self) -> Any:
        snap = self.cache.get()
        now = time.time_ns()
        return {
            "ok": True,
            "contract_id": self.contract_id,
            "paused": snap.paused,
            "series": len(snap.series),
            "spot_age_s": {u.name: round((now - sp.ts_ns) / NS, 1) for u, sp in snap.spots.items()},
            "keeper": self.keeper.status.to_json() if self.keeper else None,
        }

    def cors_origin(self, origin: str | None) -> str | None:
        if "*" in self.cors:
            return "*"
        if origin and origin.rstrip("/") in self.cors:
            return origin
        return None


def _int_param(q: dict[str, str], name: str, default: int, lo: int, hi: int) -> int:
    raw = q.get(name)
    if raw is None or raw == "":
        return default
    if not raw.isdigit() or not lo <= int(raw) <= hi:
        raise QuoteError(400, f"{name} must be an integer between {lo} and {hi}")
    return int(raw)


def make_handler(app: App) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "perennia-agent"

        def _send(self, status: int, body: Any) -> None:
            data = json.dumps(body, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self._cors()
            self.end_headers()
            self.wfile.write(data)

        def _cors(self) -> None:
            allowed = app.cors_origin(self.headers.get("Origin"))
            if allowed:
                self.send_header("Access-Control-Allow-Origin", allowed)
                self.send_header("Vary", "Origin")

        def do_GET(self) -> None:  # noqa: N802 - http.server API
            url = urlsplit(self.path)
            query = {k: v[0] for k, v in parse_qs(url.query).items()}
            status, body = app.handle(url.path.rstrip("/") or "/", query, self.client_address[0])
            self._send(status, body)

        def do_OPTIONS(self) -> None:  # noqa: N802 - http.server API
            self.send_response(204)
            self._cors()
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Accept, Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()

        def log_message(self, fmt: str, *args: Any) -> None:
            log.debug("%s %s", self.address_string(), fmt % args)

    return Handler


def build_app(with_keeper: bool) -> App:
    net = config.network()
    key = config.agent_key()
    cache = ChainCache(rpc_viewer(net.rpc_url, net.contract_id))
    quoter = Quoter(key, net.contract_id, config.quoter_config())
    store = Store(config.data_dir())
    keeper = None
    if with_keeper:
        sender = config.keeper_account(net)
        if sender is None:
            raise config.ConfigError("KEEPER_ACCOUNT_ID is not set; set it or run with --no-keeper")
        keeper = Keeper(net.contract_id, sender, key, cache, quoter, SpotFeed([]), store)
    return App(
        contract_id=net.contract_id,
        cache=cache,
        quoter=quoter,
        store=store,
        keeper=keeper,
        cors=config.cors_origins(),
        code_hash=os.environ.get("PERENNIA_CODE_HASH", "").strip(),
        tee_quote_url=os.environ.get("PERENNIA_TEE_QUOTE_URL", "").strip(),
    )


def _warm(cache: ChainCache, stop: threading.Event) -> None:
    """Keep the snapshot fresh so a quote request never waits on five RPC calls."""
    while not stop.is_set():
        try:
            cache.refresh()
        except Exception as e:
            log.warning("snapshot refresh failed: %s", e)
        stop.wait(3.0)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Perennia agent: quote server and keeper")
    p.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8787")))
    p.add_argument("--no-keeper", action="store_true", help="serve quotes only")
    p.add_argument("--env-file", default=".env")
    p.add_argument("-v", "--verbose", action="store_true")
    a = p.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if a.verbose else logging.INFO,
        stream=sys.stderr,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    config.load_dotenv(Path(a.env_file))
    try:
        app = build_app(with_keeper=not a.no_keeper)
        registered = app.cache.view("is_agent_key", {"key": near.public_key_str(app.quoter.key)})
    except config.ConfigError as e:
        log.error("%s", e)
        return 2
    if not registered:
        log.error(
            "agent key %s is not registered on %s; the contract will reject every signature. "
            "Run `python -m perennia_agent.admin set-agent-keys`.",
            near.public_key_str(app.quoter.key),
            app.contract_id,
        )
        return 2

    stop = threading.Event()
    threads = [threading.Thread(target=_warm, args=(app.cache, stop), daemon=True, name="warm")]
    if app.keeper:
        threads.append(
            threading.Thread(target=app.keeper.run, args=(stop,), daemon=True, name="keeper")
        )
    for t in threads:
        t.start()
    httpd = ThreadingHTTPServer((a.host, a.port), make_handler(app))
    log.info(
        "agent %s for %s on http://%s:%d (keeper %s)",
        near.public_key_str(app.quoter.key),
        app.contract_id,
        a.host,
        a.port,
        "on" if app.keeper else "off",
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
