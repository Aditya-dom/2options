"""Endpoint failover (rpc.post) and the sender's timeout handling (near.Account)."""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from twooptions_agent import near, rpc
from twooptions_agent.rpc import RpcError, TransportError


def serve(
    status: int, body: dict[str, Any] | None = None, delay: float = 0.0
) -> tuple[str, list[int], HTTPServer]:
    hits: list[int] = []

    class H(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            self.rfile.read(int(self.headers["Content-Length"]))
            hits.append(1)
            time.sleep(delay)
            data = json.dumps(body or {}).encode()
            self.send_response(status)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *a: Any) -> None:
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_port}", hits, srv


@pytest.fixture
def servers() -> Iterator[list[HTTPServer]]:
    made: list[HTTPServer] = []
    yield made
    for s in made:
        s.shutdown()


PAYLOAD = {"jsonrpc": "2.0", "id": 1, "method": "block", "params": {}}
OK = {"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}


def test_a_failing_endpoint_is_skipped_and_the_working_one_is_preferred(
    servers: list[HTTPServer],
) -> None:
    bad, bad_hits, s1 = serve(408)
    good, good_hits, s2 = serve(200, OK)
    servers += [s1, s2]
    urls = f"{bad},{good}"
    assert rpc.post(urls, PAYLOAD, timeout=2) == OK
    assert rpc.post(urls, PAYLOAD, timeout=2) == OK
    assert len(bad_hits) == 1 and len(good_hits) == 2  # the second request went straight to `good`


def test_a_slow_endpoint_times_out_into_the_next(servers: list[HTTPServer]) -> None:
    slow, _, s1 = serve(200, OK, delay=1.5)
    good, good_hits, s2 = serve(200, OK)
    servers += [s1, s2]
    t = time.monotonic()
    assert rpc.post(f"{slow},{good}", PAYLOAD, timeout=0.3) == OK
    assert time.monotonic() - t < 1.4 and good_hits


def test_every_endpoint_failing_raises_a_transport_error(servers: list[HTTPServer]) -> None:
    a, _, s1 = serve(503)
    b, _, s2 = serve(408)
    servers += [s1, s2]
    with pytest.raises(TransportError):
        rpc.post(f"{a},{b}", PAYLOAD, timeout=1)


def test_a_client_error_is_not_retried_elsewhere(servers: list[HTTPServer]) -> None:
    a, _, s1 = serve(400)
    b, b_hits, s2 = serve(200, OK)
    servers += [s1, s2]
    with pytest.raises(RpcError) as e:
        rpc.post(f"{a},{b}", PAYLOAD, timeout=1)
    assert not isinstance(e.value, TransportError) and not b_hits


# -- near.Account ------------------------------------------------------------------------------

KEY = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
OUTCOME = {
    "status": {"SuccessValue": ""},
    "receipts_outcome": [{"outcome": {"logs": ["hi"], "status": {"SuccessValue": ""}}}],
}


class FakeRpc:
    def __init__(self, send: list[Any], tx: list[Any] | None = None) -> None:
        self.send, self.tx = send, tx or []
        self.methods: list[str] = []

    def __call__(self, url: str, method: str, params: Any, timeout: float) -> Any:
        if method == "block":  # the final block a transaction is anchored to (tests/test_near.py)
            return {"header": {"hash": near.b58encode(bytes(32))}}
        self.methods.append(method)
        if method == "query":
            return {"nonce": 10, "block_hash": near.b58encode(bytes(32))}
        queue = self.send if method == "send_tx" else self.tx
        step = queue.pop(0) if queue else RpcError("unknown transaction")
        if isinstance(step, Exception):
            raise step
        return step


def account(
    monkeypatch: pytest.MonkeyPatch, fake: FakeRpc, recovery_s: float = 3.0
) -> near.Account:
    monkeypatch.setattr(near, "_call", fake)
    monkeypatch.setattr(near.time, "sleep", lambda s: None)
    return near.Account("http://unused", "keeper.testnet", KEY, timeout=1, recovery_s=recovery_s)


def test_a_timed_out_send_recovers_its_outcome(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeRpc([TransportError("send_tx: HTTP 408")], [RpcError("unknown"), OUTCOME])
    r = account(monkeypatch, fake).call("c.testnet", "post_spot")
    assert r.logs == ["hi"] and fake.methods == ["query", "send_tx", "tx", "tx"]


def test_the_nodes_own_timeout_error_is_recovered_too(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeRpc(
        [RpcError('send_tx: {"name": "HANDLER_ERROR", "cause": {"name": "TIMEOUT_ERROR"}}')],
        [OUTCOME],
    )
    assert account(monkeypatch, fake).call("c.testnet", "x").logs == ["hi"]


def test_recovery_gives_up_after_its_bound(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = iter(range(1000))
    monkeypatch.setattr(near.time, "monotonic", lambda: float(next(clock)))
    fake = FakeRpc([TransportError("timeout")], [RpcError("unknown")] * 100)
    with pytest.raises(RpcError, match="no outcome after a timeout"):
        account(monkeypatch, fake, recovery_s=3.0).call("c.testnet", "x")
    assert fake.methods.count("tx") <= 3


def test_a_nonce_is_never_reused_after_a_failed_send(monkeypatch: pytest.MonkeyPatch) -> None:
    # The chain still reports nonce 10, but the first transaction (11) may land later.
    fake = FakeRpc([RpcError("send_tx: boom"), OUTCOME])
    acct = account(monkeypatch, fake)
    with pytest.raises(RpcError):
        acct.call("c.testnet", "x")
    assert acct._nonce == 11
    acct.call("c.testnet", "x")
    assert acct._nonce == 12


def test_included_returns_without_an_outcome(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeRpc([{"final_execution_status": "INCLUDED"}])
    r = account(monkeypatch, fake).call("c.testnet", "post_spot", wait="INCLUDED")
    assert r.logs == [] and r.value is None and r.tx_hash
