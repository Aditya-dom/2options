"""Minimal NEAR JSON-RPC client for free view calls."""

from __future__ import annotations

import base64
import json
import time
import urllib.error
import urllib.request
from typing import Any

DEFAULT_RPC = {
    "testnet": "https://test.rpc.fastnear.com",
    "mainnet": "https://free.rpc.fastnear.com",
}


class RpcError(RuntimeError):
    pass


def post(rpc_url: str, payload: dict[str, Any], timeout: float, retries: int = 3) -> Any:
    """POST a JSON-RPC request. Public endpoints rate-limit (HTTP 429): back off and retry."""
    req = urllib.request.Request(
        rpc_url,
        data=json.dumps(payload).encode(),
        # Some providers refuse the default Python user agent.
        headers={"Content-Type": "application/json", "User-Agent": "twooptions-agent"},
    )
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - operator-configured RPC
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == retries:
                raise RpcError(f"{payload.get('method')}: HTTP {e.code}") from e
            time.sleep(0.5 * 2**attempt)
    raise AssertionError("unreachable")


def view(
    rpc_url: str,
    account_id: str,
    method: str,
    args: dict[str, Any] | None = None,
    timeout: float = 10.0,
    finality: str = "final",
) -> Any:
    payload = {
        "jsonrpc": "2.0",
        "id": "twooptions-agent",
        "method": "query",
        "params": {
            "request_type": "call_function",
            "finality": finality,
            "account_id": account_id,
            "method_name": method,
            "args_base64": base64.b64encode(json.dumps(args or {}).encode()).decode(),
        },
    }
    body = post(rpc_url, payload, timeout)
    if "error" in body:
        raise RpcError(f"{method}: {body['error']}")
    result = body["result"]
    if "error" in result:  # contract panic inside a view
        raise RpcError(f"{method}: {result['error']}")
    return json.loads(bytes(result["result"]).decode())
