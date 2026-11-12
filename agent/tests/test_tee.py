"""tee.py against a fake dstack guest agent on a Unix socket, and /attestation with a quote."""

from __future__ import annotations

import hashlib
import json
import socketserver
import tempfile
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from twooptions_agent import near, tee

KEY = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))


class FakeGuestAgent:
    def __init__(self, path: str, status: int = 200, body: dict[str, Any] | None = None):
        self.requests: list[str] = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                outer.requests.append(self.path)
                rd = parse_qs(urlsplit(self.path).query).get("report_data", [""])[0]
                data = json.dumps(
                    body if body is not None else {"quote": "0400" + rd, "event_log": "[]"}
                ).encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def address_string(self) -> str:
                return "unix"

            def log_message(self, *a: Any) -> None:
                pass

        self.server = socketserver.ThreadingUnixStreamServer(path, H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def sock() -> Iterator[str]:
    # AF_UNIX paths are short (about 100 bytes); pytest's tmp_path can be longer on macOS.
    with tempfile.TemporaryDirectory(dir="/tmp") as d:
        yield str(Path(d) / "dstack.sock")


def test_report_data_binds_the_agent_key() -> None:
    pub = near.public_key_bytes(KEY)
    assert tee.report_data(pub) == hashlib.sha256(b"twooptions:agent-key:v1" + pub).digest()
    assert len(tee.report_data(pub)) == 32


def test_no_socket_means_no_tee_block(sock: str) -> None:
    assert tee.attest(near.public_key_bytes(KEY), sock) is None


def test_quote_is_requested_over_the_key_binding(sock: str) -> None:
    agent = FakeGuestAgent(sock)
    try:
        out = tee.attest(near.public_key_bytes(KEY), sock)
    finally:
        agent.close()
    rd = tee.report_data(near.public_key_bytes(KEY)).hex()
    assert agent.requests == [f"/GetQuote?report_data={rd}"]
    assert out is not None and out["report_data"] == rd and out["quote"] == "0400" + rd
    assert out["event_log"] == "[]" and "error" not in out


def test_a_failing_guest_agent_is_reported_not_fatal(sock: str) -> None:
    agent = FakeGuestAgent(sock, status=500, body={"error": "boom"})
    try:
        out = tee.attest(near.public_key_bytes(KEY), sock)
    finally:
        agent.close()
    assert out is not None and "quote" not in out and "HTTP 500" in out["error"]


def test_report_data_longer_than_tdx_allows_is_refused(sock: str) -> None:
    with pytest.raises(ValueError):
        tee.get_quote(bytes(65), sock)
