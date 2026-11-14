"""Minimal NEAR JSON-RPC client for free view calls."""

from __future__ import annotations

import base64
import json
import time
import urllib.error
import urllib.request
from typing import Any

#: Public endpoints per network, in the order they are tried. Free endpoints rate-limit and
#: stall, each on its own schedule, so the agent keeps several. dRPC leads here and FastNEAR
#: in the app, so an agent and a browser behind one address do not lean on the same provider.
DEFAULT_RPC = {
    "testnet": ",".join(
        [
            "https://near-testnet.drpc.org",
            "https://test.rpc.fastnear.com",
            "https://api.zan.top/near-testnet",
            "https://testnet-rpc.intea.rs",
            "https://rpc.testnet.near.org",
        ]
    ),
    "mainnet": ",".join(
        [
            "https://near.drpc.org",
            "https://free.rpc.fastnear.com",
            "https://api.zan.top/near-mainnet",
            "https://rpc.intea.rs",
            "https://rpc.shitzuapes.xyz",
        ]
    ),
}


def with_defaults(configured: str, network: str) -> str:
    """The endpoints to use: those configured, in their order, then the public defaults, each
    once. Configuring one endpoint puts it first without giving up the fallbacks."""
    urls: list[str] = []
    for u in [*configured.split(","), *DEFAULT_RPC[network].split(",")]:
        u = u.strip().rstrip("/")
        if u and u not in urls:
            urls.append(u)
    return ",".join(urls)


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


#: Endpoints that failed to answer, and until when (monotonic seconds) they are passed over.
#: The order of the list is the order of preference, fastest first. An endpoint that fails
#: rests for a while and the next one serves; when its rest is over it is tried first again.
#: Staying with "whichever answered last" instead leaves the agent on a slow last resort for
#: as long as that one keeps answering.
_resting: dict[str, float] = {}
REST_S = 30.0


def _in_order(urls: list[str]) -> list[str]:
    """`urls` with the resting ones moved to the back: a last resort, not an omission."""
    now = time.monotonic()
    ready = [u for u in urls if _resting.get(u, 0.0) <= now]
    return ready + [u for u in urls if u not in ready]


class Throttled(TransportError):
    """HTTP 429: the endpoint is rate-limiting this client. Waiting helps; so does going
    elsewhere."""


def _post_one(url: str, payload: dict[str, Any], timeout: float) -> Any:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        # Some providers refuse the default Python user agent.
        headers={"Content-Type": "application/json", "User-Agent": "twooptions-agent"},
    )
    method = payload.get("method")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - operator-configured RPC
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code == 429:
            raise Throttled(f"{method}: HTTP 429 from {url}") from e
        if e.code == 408 or e.code >= 500:
            raise TransportError(f"{method}: HTTP {e.code} from {url}") from e
        raise RpcError(f"{method}: HTTP {e.code}") from e
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        raise TransportError(f"{method}: {e} from {url}") from e


def post(rpc_url: str, payload: dict[str, Any], timeout: float, retries: int = 3) -> Any:
    """POST a JSON-RPC request, trying each configured endpoint in turn while they fail to
    answer, in order of preference with the ones that failed recently last. A rate-limited
    endpoint is left at once for the next: waiting on it would delay a price post that another
    provider could take now. Only when every endpoint has failed and at least one was merely
    rate-limiting does it wait and go round again, up to `retries` times. The last transport
    error is raised when none answers."""
    urls = endpoints(rpc_url)
    last: TransportError | None = None
    for attempt in range(retries + 1):
        throttled = False
        for url in _in_order(urls):
            try:
                body = _post_one(url, payload, timeout)
            except TransportError as e:
                last, throttled = e, throttled or isinstance(e, Throttled)
                _resting[url] = time.monotonic() + REST_S
                continue
            _resting.pop(url, None)
            return body
        if not throttled or attempt == retries:
            break
        time.sleep(0.5 * 2**attempt)
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
