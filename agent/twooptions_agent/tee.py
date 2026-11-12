"""TEE attestation through dstack (Phala Cloud, NEAR AI Cloud): a TDX quote bound to the agent key.

Inside a dstack confidential VM the guest agent answers on a Unix socket. `GetQuote` returns an
Intel TDX quote whose 64-byte report data field carries what the caller asked for. Here that is
`sha256(DOMAIN || ed25519 public key)`, so a verifier who checks the quote (signed by Intel,
with the VM's measurements and the docker-compose hash in its event log) also learns which
signing key that VM reported. The contract does not verify quotes; anyone can, off chain:

    report_data[:32] == sha256(b"twooptions:agent-key:v1" + public_key_bytes)

What this does not prove: where the key came from. It is passed in as an (encrypted) secret, so
the operator who set it also knows it. Outside a dstack VM there is no socket and no quote.

Standard library only, like the rest of the agent.
"""

from __future__ import annotations

import hashlib
import http.client
import json
import logging
import os
import socket
from typing import Any
from urllib.parse import quote as urlquote

log = logging.getLogger(__name__)

DSTACK_SOCKET = "/var/run/dstack.sock"
DOMAIN = b"twooptions:agent-key:v1"


def report_data(public_key: bytes) -> bytes:
    """32 bytes; dstack pads report data to TDX's 64."""
    return hashlib.sha256(DOMAIN + public_key).digest()


class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float):
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self) -> None:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self._path)
        self.sock = s


def get_quote(
    data: bytes, socket_path: str = DSTACK_SOCKET, timeout: float = 15.0
) -> dict[str, Any]:
    """Ask the dstack guest agent for a TDX quote over `data` (at most 64 bytes)."""
    if len(data) > 64:
        raise ValueError("report data is at most 64 bytes")
    conn = _UnixHTTPConnection(socket_path, timeout)
    try:
        conn.request("GET", "/GetQuote?report_data=" + urlquote(data.hex()))
        resp = conn.getresponse()
        body = resp.read()
        if resp.status != 200:
            raise RuntimeError(f"GetQuote: HTTP {resp.status}: {body[:200]!r}")
        out = json.loads(body)
        if not isinstance(out, dict) or not out.get("quote"):
            raise RuntimeError("GetQuote: no quote in the response")
        return out
    finally:
        conn.close()


def attest(public_key: bytes, socket_path: str | None = None) -> dict[str, Any] | None:
    """The `tee` block of /attestation, or None when not running in a dstack VM."""
    path = socket_path or os.environ.get("TWOOPTIONS_DSTACK_SOCKET", "").strip() or DSTACK_SOCKET
    if not os.path.exists(path):
        return None
    data = report_data(public_key)
    out: dict[str, Any] = {
        "platform": "intel-tdx (dstack)",
        "report_data": data.hex(),
        "report_data_is": "sha256('twooptions:agent-key:v1' || agent ed25519 public key)",
    }
    try:
        q = get_quote(data, path)
    except Exception as e:  # a missing quote must not stop the agent; /attestation says why
        log.error("TEE quote failed: %s", e)
        out["error"] = str(e)[:300]
        return out
    out["quote"] = q["quote"]
    for k in ("event_log", "vm_config"):
        if k in q:
            out[k] = q[k]
    log.info("TEE quote obtained (%d bytes of quote)", len(str(q["quote"])))
    return out
