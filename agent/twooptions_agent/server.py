"""The agent's HTTP API and process entry point.

    GET /chain                          bid, ask, mark, greeks and funding rate per series
    GET /quote?series=&side=&size=&taker=   one signed quote
    GET /spot                           the contract's cached spot per underlying
    GET /funding/history?series=&limit= settlements this agent has posted, newest first
    GET /attestation                    the agent's public key, and a TDX quote bound to it
                                        when running in a dstack TEE (tee.py)
    GET /inventory                      vault position, net delta and hedge target
    GET /limits                         size limits per trade, per account and series, per underlying
    GET /hedge                          the hedger: target, venue position, gap, recent orders
    GET /health                         liveness and keeper status

Numbers follow the contract's JSON rules: every 64/128-bit integer is a decimal string.
Errors are non-200 with `{"error": "..."}`.

    uv run python -m twooptions_agent.server            # quote server + keeper (+ hedger)
    uv run python -m twooptions_agent.server --no-keeper
    uv run python -m twooptions_agent.server --no-hedger

The hedger runs when HYPERLIQUID_PRIVATE_KEY is set (see hedger.py).

With TWOOPTIONS_STATIC_DIR set, any other path is served from that directory: the built app,
so one container (Dockerfile at the repo root) serves the trade desk, the API and the keeper.

Standard library only: one thread per request, which is plenty for an RFQ desk and keeps the
image that runs inside the TEE small. The server is public, so it is bounded: a limit on open
connections, a timeout on idle ones, and rate limits on signing: per account, which holds
whatever is in front of the server, and per source address.
"""

from __future__ import annotations

import argparse
import json
import logging
import mimetypes
import os
import sys
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from . import config, inventory, near, tee
from .chain import NS, ChainCache, rpc_viewer
from .hedger import Hedger
from .keeper import Keeper
from .quoter import QuoteError, Quoter
from .spot import SpotFeed
from .store import Store
from .wire import Side

log = logging.getLogger("twooptions_agent")

MAX_HISTORY = 500
API_PATHS = frozenset(
    {
        "/health",
        "/attestation",
        "/funding/history",
        "/chain",
        "/spot",
        "/inventory",
        "/hedge",
        "/limits",
        "/quote",
    }
)
#: Connections served at once; one more is closed at once instead of costing a thread.
MAX_CONNECTIONS = 256
#: Seconds a connection may sit without sending its request or taking its answer.
IDLE_TIMEOUT_S = 15.0
#: How long "this account has not deposited" is remembered, so that asking again and again for
#: an account that does not exist costs no chain reads.
NO_ACCOUNT_TTL_S = 30.0
MAX_NO_ACCOUNT = 10_000


class RateLimiter:
    """Token bucket per client. Signing is cheap; this only stops one client hogging threads."""

    def __init__(self, per_second: float = 5.0, burst: float = 20.0, max_clients: int = 10_000):
        self.rate, self.burst, self.max_clients = per_second, burst, max_clients
        self._state: dict[str, tuple[float, float]] = {}
        self._lock = threading.Lock()

    def allow(self, client: str, now: float | None = None) -> bool:
        t = now if now is not None else time.monotonic()
        with self._lock:
            tokens, last = self._state.get(client, (self.burst, t))
            tokens = min(self.burst, tokens + (t - last) * self.rate)
            ok = tokens >= 1.0
            self._state[client] = (tokens - 1.0 if ok else tokens, t)
            if len(self._state) > self.max_clients:
                self._forget(t)
            return ok

    def _forget(self, t: float) -> None:
        """Make room. A client idle long enough to have a full bucket again loses nothing by
        being forgotten; only if that is not enough do the least recent of the rest go, and
        never the busy ones wholesale, which would hand every client a fresh burst."""
        full_after = self.burst / self.rate
        self._state = {c: v for c, v in self._state.items() if t - v[1] < full_after}
        if len(self._state) > self.max_clients:
            newest = sorted(self._state.items(), key=lambda kv: kv[1][1])[-self.max_clients // 2 :]
            self._state = dict(newest)


def client_ip(peer: str, forwarded_for: str | None, proxies: frozenset[str]) -> str:
    """Whom to count a request against. Behind a reverse proxy every connection comes from the
    proxy, so all clients would share one allowance. X-Forwarded-For is believed only when the
    connection comes from a proxy the operator named, and then only its last entry that is not
    such a proxy: earlier entries are whatever the client chose to send."""
    if peer not in proxies or not forwarded_for:
        return peer
    for hop in reversed(forwarded_for.split(",")):
        hop = hop.strip()[:64]
        if hop and hop not in proxies:
            return hop
    return peer


class Server(ThreadingHTTPServer):
    """One thread per connection, up to `max_connections`. Past that a new connection is closed
    at once: an open port must not be a way to make the process start threads without limit."""

    daemon_threads = True
    request_queue_size = 128

    def __init__(
        self,
        address: tuple[str, int],
        handler: type[BaseHTTPRequestHandler],
        max_connections: int = MAX_CONNECTIONS,
    ):
        super().__init__(address, handler)
        self._slots = threading.BoundedSemaphore(max_connections)

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


@dataclass
class App:
    contract_id: str
    cache: ChainCache
    quoter: Quoter
    store: Store
    keeper: Keeper | None = None
    hedger: Hedger | None = None
    cors: list[str] = field(default_factory=list)
    #: Quotes per source address. Behind a gateway that hides the client every user shares
    #: this one, so it is a ceiling on the whole site there and set well above one user's need.
    limiter: RateLimiter = field(default_factory=lambda: RateLimiter(per_second=20.0, burst=60.0))
    #: Quotes per account: what one trader may ask for, wherever the request comes from.
    taker_limiter: RateLimiter = field(default_factory=RateLimiter)
    #: Chain reads for accounts not seen before, across all clients.
    lookup_limiter: RateLimiter = field(
        default_factory=lambda: RateLimiter(per_second=10.0, burst=40.0)
    )
    proxies: frozenset[str] = frozenset()
    _no_account: dict[str, float] = field(default_factory=dict)
    _no_account_lock: threading.Lock = field(default_factory=threading.Lock)
    code_hash: str = ""
    tee_quote_url: str = ""
    #: TDX quote bound to the agent key (tee.attest), when running in a dstack VM.
    tee: dict[str, Any] | None = None
    #: The built app, served for every non-API path.
    static_dir: Path | None = None

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
            out: dict[str, Any] = {"agent_public_key": near.public_key_str(self.quoter.key)}
            if self.code_hash:
                out["code_hash"] = self.code_hash
            if self.tee_quote_url:
                out["tee_quote_url"] = self.tee_quote_url
            if self.tee is not None:
                out["tee"] = self.tee
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
            return 200, self._inventory().to_json()
        if path == "/hedge":
            return 200, self._hedge()
        if path == "/limits":
            return 200, self.quoter.limits_json()
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
        side = Side[q["side"]]
        if len(taker) > 64:
            raise QuoteError(400, "taker is not an account id")
        if not self.taker_limiter.allow(taker):
            raise QuoteError(429, "too many quote requests for this account")
        known = taker in self.store.takers()
        snap = self.cache.get()
        checked = False
        if self.quoter.cfg.has_limits:
            acct = self._account(taker, known)
            checked = True
            held = sum(int(p["size"]) for p in acct["positions"] if p["series"] == q["series"])
            self.quoter.check_limits(snap, q["series"], side, size, held)
        signed = self.quoter.quote(snap, q["series"], side, size, taker)
        # The contract only trades for accounts that have deposited, and only those go on the
        # liquidation watch list.
        if not known:
            if not checked:
                self._account(taker, known)
            self.store.add_taker(taker)
        if self.keeper is not None:
            self.keeper.touch(taker)  # a trade may follow: watch it closely for a while
        return signed.to_json()

    def _account(self, taker: str, known: bool) -> Any:
        """The taker's account on chain, or a refusal. An account this agent has not seen
        costs a chain read, and made-up ids must not become a stream of reads: a miss is
        remembered for a while, and lookups of new accounts are rationed across all clients."""
        if not known:
            if self._known_missing(taker):
                raise QuoteError(409, "deposit first")
            if not self.lookup_limiter.allow("lookups"):
                raise QuoteError(429, "too many new accounts at once; try again in a moment")
        acct = self.cache.view("get_account", {"account_id": taker})
        if acct is None:
            self._remember_missing(taker)
            raise QuoteError(409, "deposit first")
        return acct

    def _known_missing(self, taker: str) -> bool:
        with self._no_account_lock:
            seen = self._no_account.get(taker)
            return seen is not None and time.monotonic() - seen < NO_ACCOUNT_TTL_S

    def _remember_missing(self, taker: str) -> None:
        now = time.monotonic()
        with self._no_account_lock:
            if len(self._no_account) >= MAX_NO_ACCOUNT:
                self._no_account = {
                    t: at for t, at in self._no_account.items() if now - at < NO_ACCOUNT_TTL_S
                }
                if len(self._no_account) >= MAX_NO_ACCOUNT:
                    self._no_account.clear()
            self._no_account[taker] = now

    def _inventory(self) -> inventory.Inventory:
        return inventory.from_snapshot(self.cache.get(), self.quoter, time.time_ns())

    def _hedge(self) -> Any:
        if self.hedger is not None:
            return self.hedger.status()
        # No hedger configured: say so, and show what it would hold.
        inv = self._inventory()
        return {
            "enabled": False,
            "underlyings": {u: {"target": round(t, 6)} for u, t in inv.hedge_target.items()},
            "orders": [],
        }

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
            "hedger": self.hedger is not None,
        }

    def static_file(self, path: str) -> Path | None:
        """The file under `static_dir` for a request path, or None. Never escapes the directory."""
        if self.static_dir is None:
            return None
        root = self.static_dir.resolve()
        f = (root / path.lstrip("/")).resolve()
        if f == root:
            f = root / "index.html"
        if root not in f.parents or not f.is_file():
            return None
        return f

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
        server_version = "twooptions-agent"
        timeout = IDLE_TIMEOUT_S  # a client that connects and says nothing is dropped

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

        def _send_file(self, f: Path) -> None:
            data = f.read_bytes()
            self.send_response(200)
            ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            # Vite fingerprints everything under assets/; index.html must be re-read on deploy.
            hashed = "assets" in f.parts
            self.send_header(
                "Cache-Control", "public, max-age=31536000, immutable" if hashed else "no-cache"
            )
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:  # noqa: N802 - http.server API
            url = urlsplit(self.path)
            path = url.path.rstrip("/") or "/"
            if path not in API_PATHS and app.static_dir is not None:
                f = app.static_file(url.path)
                if f is not None:
                    self._send_file(f)
                    return
            query = {k: v[0] for k, v in parse_qs(url.query).items()}
            client = client_ip(
                self.client_address[0], self.headers.get("X-Forwarded-For"), app.proxies
            )
            status, body = app.handle(path, query, client)
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


def build_app(with_keeper: bool, with_hedger: bool = True) -> App:
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
    venue = config.hedge_venue(net) if with_hedger else None
    hedger = Hedger(venue, cache, quoter, store, config.hedge_config()) if venue else None
    return App(
        contract_id=net.contract_id,
        cache=cache,
        quoter=quoter,
        store=store,
        keeper=keeper,
        hedger=hedger,
        cors=config.cors_origins(),
        proxies=config.trusted_proxies(),
        code_hash=os.environ.get("TWOOPTIONS_CODE_HASH", "").strip(),
        tee_quote_url=os.environ.get("TWOOPTIONS_TEE_QUOTE_URL", "").strip(),
        tee=tee.attest(near.public_key_bytes(key)),
        static_dir=_static_dir(),
    )


def _static_dir() -> Path | None:
    raw = os.environ.get("TWOOPTIONS_STATIC_DIR", "").strip()
    if not raw:
        return None
    d = Path(raw)
    if not (d / "index.html").is_file():
        raise config.ConfigError(f"TWOOPTIONS_STATIC_DIR={raw} has no index.html")
    return d


def _warm(cache: ChainCache, stop: threading.Event) -> None:
    """Keep the snapshot fresh so a quote request never waits on five RPC calls."""
    while not stop.is_set():
        try:
            cache.refresh()
        except Exception as e:
            log.warning("snapshot refresh failed: %s", e)
        stop.wait(3.0)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="2Options agent: quote server and keeper")
    p.add_argument("--host", help="default: HOST from the environment or .env, else 127.0.0.1")
    p.add_argument("--port", type=int, help="default: PORT from the environment or .env, else 8787")
    p.add_argument("--no-keeper", action="store_true", help="serve quotes only")
    p.add_argument("--no-hedger", action="store_true", help="never place hedge orders")
    p.add_argument("--env-file", default=".env")
    p.add_argument("-v", "--verbose", action="store_true")
    a = p.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if a.verbose else logging.INFO,
        stream=sys.stderr,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    config.load_dotenv(Path(a.env_file))
    # Resolved after the .env file is read, so HOST and PORT set there take effect.
    a.host = a.host or os.environ.get("HOST", "").strip() or "127.0.0.1"
    try:
        a.port = a.port or int(os.environ.get("PORT", "").strip() or "8787")
    except ValueError:
        log.error("PORT must be a number")
        return 2
    try:
        app = build_app(with_keeper=not a.no_keeper, with_hedger=not a.no_hedger)
        registered = app.cache.view("is_agent_key", {"key": near.public_key_str(app.quoter.key)})
    except config.ConfigError as e:
        log.error("%s", e)
        return 2
    if not registered:
        log.error(
            "agent key %s is not registered on %s; the contract will reject every signature. "
            "Run `python -m twooptions_agent.admin set-agent-keys`.",
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
    if app.hedger:
        threads.append(
            threading.Thread(target=app.hedger.run, args=(stop,), daemon=True, name="hedger")
        )
    for t in threads:
        t.start()
    httpd = Server((a.host, a.port), make_handler(app))
    hedging = (
        f"on {app.hedger.venue.name} {app.hedger.venue.network} as {app.hedger.venue.account}"
        if app.hedger
        else "off"
    )
    log.info(
        "agent %s for %s on http://%s:%d (keeper %s, hedger %s)",
        near.public_key_str(app.quoter.key),
        app.contract_id,
        a.host,
        a.port,
        "on" if app.keeper else "off",
        hedging,
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
