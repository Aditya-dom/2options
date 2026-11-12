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


class TransportError(RpcError):
    """The endpoint did not answer usefully (timeout, connection error, HTTP 408/429/5xx). The
    request may still have reached the chain; another endpoint is worth a try."""


def endpoints(rpc_url: str) -> list[str]:
    """`NEAR_RPC_URL` may list several endpoints, comma separated, in order of preference."""
    urls = [u.strip() for u in rpc_url.split(",") if u.strip()]
    if not urls:
        raise ValueError("no RPC endpoint configured")
    return urls


#: Index of the endpoint that last answered, per configured list. A failing endpoint is skipped
#: until the next one fails too, so one slow provider does not cost a timeout on every request.
_preferred: dict[str, int] = {}


def _post_one(url: str, payload: dict[str, Any], timeout: float, retries: int) -> Any:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        # Some providers refuse the default Python user agent.
        headers={"Content-Type": "application/json", "User-Agent": "twooptions-agent"},
    )
    method = payload.get("method")
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - operator-configured RPC
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries:
                time.sleep(0.5 * 2**attempt)  # public endpoints rate-limit: back off
                continue
            if e.code in (408, 429) or e.code >= 500:
                raise TransportError(f"{method}: HTTP {e.code} from {url}") from e
            raise RpcError(f"{method}: HTTP {e.code}") from e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            raise TransportError(f"{method}: {e} from {url}") from e
    raise AssertionError("unreachable")


def post(rpc_url: str, payload: dict[str, Any], timeout: float, retries: int = 3) -> Any:
    """POST a JSON-RPC request, trying each configured endpoint in turn while they fail to
    answer. The last transport error is raised when none does."""
    urls = endpoints(rpc_url)
    start = _preferred.get(rpc_url, 0) % len(urls)
    last: TransportError | None = None
    for i in range(len(urls)):
        k = (start + i) % len(urls)
        try:
            body = _post_one(urls[k], payload, timeout, retries)
        except TransportError as e:
            last = e
            continue
        _preferred[rpc_url] = k
        return body
    assert last is not None
    raise last


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
