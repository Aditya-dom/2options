"""Minimal NEAR JSON-RPC client for free view calls."""

from __future__ import annotations

import base64
import json
import urllib.request
from typing import Any

DEFAULT_RPC = {
    "testnet": "https://test.rpc.fastnear.com",
    "mainnet": "https://free.rpc.fastnear.com",
}


class RpcError(RuntimeError):
    pass


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
        "id": "perennia-agent",
        "method": "query",
        "params": {
            "request_type": "call_function",
            "finality": finality,
            "account_id": account_id,
            "method_name": method,
            "args_base64": base64.b64encode(json.dumps(args or {}).encode()).decode(),
        },
    }
    req = urllib.request.Request(
        rpc_url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - operator-configured RPC
        body = json.loads(r.read())
    if "error" in body:
        raise RpcError(f"{method}: {body['error']}")
    result = body["result"]
    if "error" in result:  # contract panic inside a view
        raise RpcError(f"{method}: {result['error']}")
    return json.loads(bytes(result["result"]).decode())
