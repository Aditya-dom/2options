"""Hyperliquid perps for the hedger: signing and the handful of REST calls it needs.

Kept to the standard library plus `cryptography`, like the rest of the agent, so there is no
exchange SDK to audit or to ship inside a TEE image. Three pieces are written out here that an
SDK would otherwise bring: the msgpack subset an order uses, the EIP-712 digest of
Hyperliquid's "agent" message, and the recovery id of a secp256k1 signature. Each is checked
against the official `hyperliquid-python-sdk` (tests/fixtures/hyperliquid_vectors.json, generated
by `scripts/hl_vectors.py`, and the vectors in the SDK's own test suite).

Signing an order (an "L1 action"):

    connection_id = keccak256( msgpack(action) || u64_be(nonce) || vault flag || expiry flag )
    digest        = EIP-712( domain {Exchange, 1, chainId 1337, 0x0}, Agent {source, connection_id} )
    signature     = secp256k1( digest ), sent as { r, s, v }

`source` is "a" on mainnet and "b" on testnet, so a signature for one cannot be used on the other.

The private key only ever goes through OpenSSL (`cryptography`). The Python elliptic-curve
arithmetic below works on public values alone: it finds which of the two candidate public keys a
signature recovers to, which is what `v` encodes.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from decimal import ROUND_DOWN, Decimal
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, utils

from .keccak import keccak256

API_URL = {
    "mainnet": "https://api.hyperliquid.xyz",
    "testnet": "https://api.hyperliquid-testnet.xyz",
}

#: Perp prices carry at most this many decimals minus the asset's size decimals...
MAX_PRICE_DECIMALS = 6
#: ...and at most this many significant figures.
PRICE_SIG_FIGS = 5


class HyperliquidError(RuntimeError):
    """The venue refused a request or answered with something this client cannot read."""


class TransportError(HyperliquidError):
    """No usable answer (timeout, connection error, HTTP 5xx/429). A sent order may still have
    reached the venue."""


# ---------------------------------------------------------------------------------------------
# msgpack: the subset an action uses (maps with string keys, lists, strings, ints, bools, None)
# ---------------------------------------------------------------------------------------------


def _sized(n: int, fix: int, fix_max: int, tags: tuple[tuple[int, int], ...]) -> bytes:
    if n <= fix_max:
        return bytes([fix | n])
    for tag, width in tags:
        if n < 1 << (8 * width):
            return bytes([tag]) + n.to_bytes(width, "big")
    raise ValueError("value too long for msgpack")


def msgpack(obj: object) -> bytes:
    """Encode as `msgpack.packb` does. Floats are refused: Hyperliquid sends numbers as strings,
    and a float would silently change the bytes that get signed."""
    if obj is None:
        return b"\xc0"
    if obj is True:
        return b"\xc3"
    if obj is False:
        return b"\xc2"
    if isinstance(obj, int):
        if 0 <= obj < 0x80:
            return bytes([obj])
        if -0x20 <= obj < 0:
            return bytes([obj & 0xFF])
        if obj > 0:
            for tag, width in ((0xCC, 1), (0xCD, 2), (0xCE, 4), (0xCF, 8)):
                if obj < 1 << (8 * width):
                    return bytes([tag]) + obj.to_bytes(width, "big")
        else:
            for tag, width in ((0xD0, 1), (0xD1, 2), (0xD2, 4), (0xD3, 8)):
                if obj >= -(1 << (8 * width - 1)):
                    return bytes([tag]) + obj.to_bytes(width, "big", signed=True)
        raise ValueError("integer out of range for msgpack")
    if isinstance(obj, str):
        raw = obj.encode()
        return _sized(len(raw), 0xA0, 31, ((0xD9, 1), (0xDA, 2), (0xDB, 4))) + raw
    if isinstance(obj, list | tuple):
        head = _sized(len(obj), 0x90, 15, ((0xDC, 2), (0xDD, 4)))
        return head + b"".join(msgpack(x) for x in obj)
    if isinstance(obj, dict):
        out = _sized(len(obj), 0x80, 15, ((0xDE, 2), (0xDF, 4)))
        for k, v in obj.items():
            if not isinstance(k, str):
                raise TypeError("msgpack map keys must be strings")
            out += msgpack(k) + msgpack(v)
        return out
    raise TypeError(f"cannot msgpack {type(obj).__name__}")


# ---------------------------------------------------------------------------------------------
# The digest an L1 action is signed over
# ---------------------------------------------------------------------------------------------


def _address_bytes(address: str) -> bytes:
    raw = bytes.fromhex(address.removeprefix("0x"))
    if len(raw) != 20:
        raise ValueError("address must be 20 bytes of hex")
    return raw


def action_hash(
    action: dict[str, Any], vault_address: str | None, nonce: int, expires_after: int | None
) -> bytes:
    data = msgpack(action) + nonce.to_bytes(8, "big")
    data += b"\x00" if vault_address is None else b"\x01" + _address_bytes(vault_address)
    if expires_after is not None:
        data += b"\x00" + expires_after.to_bytes(8, "big")
    return keccak256(data)


_DOMAIN_SEPARATOR = keccak256(
    keccak256(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
    + keccak256(b"Exchange")
    + keccak256(b"1")
    + (1337).to_bytes(32, "big")
    + bytes(32)
)
_AGENT_TYPEHASH = keccak256(b"Agent(string source,bytes32 connectionId)")


def agent_digest(connection_id: bytes, is_mainnet: bool) -> bytes:
    """EIP-712 digest of `Agent { source, connectionId }` in Hyperliquid's Exchange domain."""
    if len(connection_id) != 32:
        raise ValueError("connection id must be 32 bytes")
    source = keccak256(b"a" if is_mainnet else b"b")
    struct = keccak256(_AGENT_TYPEHASH + source + connection_id)
    return keccak256(b"\x19\x01" + _DOMAIN_SEPARATOR + struct)


# ---------------------------------------------------------------------------------------------
# secp256k1: signing through OpenSSL, recovery id from public values
# ---------------------------------------------------------------------------------------------

_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
_G = (
    0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
    0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8,
)
_Point = tuple[int, int] | None  # None is the point at infinity


def _add(a: _Point, b: _Point) -> _Point:
    if a is None:
        return b
    if b is None:
        return a
    if a[0] == b[0]:
        if (a[1] + b[1]) % _P == 0:
            return None
        slope = 3 * a[0] * a[0] * pow(2 * a[1], -1, _P) % _P
    else:
        slope = (b[1] - a[1]) * pow(b[0] - a[0], -1, _P) % _P
    x = (slope * slope - a[0] - b[0]) % _P
    return x, (slope * (a[0] - x) - a[1]) % _P


def _mul(k: int, point: _Point) -> _Point:
    out: _Point = None
    while k:
        if k & 1:
            out = _add(out, point)
        point = _add(point, point)
        k >>= 1
    return out


def recover(digest: bytes, r: int, s: int, recovery_id: int) -> tuple[int, int] | None:
    """The public key that `(r, s)` over `digest` recovers to for this recovery id."""
    if not (0 < r < _N and 0 < s < _N):
        return None
    y = pow(r**3 + 7, (_P + 1) // 4, _P)
    if (y * y - r**3 - 7) % _P:
        return None
    if y & 1 != recovery_id:
        y = _P - y
    r_inv = pow(r, -1, _N)
    z = int.from_bytes(digest, "big")
    return _add(_mul(-z * r_inv % _N, _G), _mul(s * r_inv % _N, (r, y)))


def address_of(public: tuple[int, int]) -> str:
    raw = public[0].to_bytes(32, "big") + public[1].to_bytes(32, "big")
    return "0x" + keccak256(raw)[12:].hex()


class Signer:
    """One secp256k1 key. Signatures are deterministic (RFC 6979) and low-s, as Ethereum
    libraries produce them, so they can be compared byte for byte with the SDK's."""

    def __init__(self, secret_hex: str):
        try:
            raw = bytes.fromhex(secret_hex.strip().removeprefix("0x"))
        except ValueError as e:
            raise ValueError("Hyperliquid key must be 32 bytes of hex") from e
        if len(raw) != 32 or not 0 < int.from_bytes(raw, "big") < _N:
            raise ValueError("Hyperliquid key must be 32 bytes of hex")
        self._key = ec.derive_private_key(int.from_bytes(raw, "big"), ec.SECP256K1())
        nums = self._key.public_key().public_numbers()
        self.public = (nums.x, nums.y)
        self.address = address_of(self.public)

    def sign_digest(self, digest: bytes) -> tuple[int, int, int]:
        """`(r, s, v)` with `v` 27 or 28."""
        if len(digest) != 32:
            raise ValueError("digest must be 32 bytes")
        der = self._key.sign(
            digest, ec.ECDSA(utils.Prehashed(hashes.SHA256()), deterministic_signing=True)
        )
        r, s = utils.decode_dss_signature(der)
        if s > _N // 2:
            s = _N - s
        for rec in (0, 1):
            if recover(digest, r, s, rec) == self.public:
                return r, s, 27 + rec
        raise HyperliquidError("signature does not recover to the signing key")


def sign_l1_action(
    signer: Signer,
    action: dict[str, Any],
    vault_address: str | None,
    nonce: int,
    expires_after: int | None,
    is_mainnet: bool,
) -> dict[str, Any]:
    digest = agent_digest(action_hash(action, vault_address, nonce, expires_after), is_mainnet)
    r, s, v = signer.sign_digest(digest)
    return {"r": hex(r), "s": hex(s), "v": v}


# ---------------------------------------------------------------------------------------------
# Numbers on the wire
# ---------------------------------------------------------------------------------------------


def to_wire(x: Decimal) -> str:
    """A decimal string without trailing zeros, at most 8 decimals (the SDK's `float_to_wire`)."""
    if x != x.quantize(Decimal("1e-8")):
        raise ValueError(f"{x} has more than 8 decimals")
    out = format(x.normalize(), "f")
    return "0" if out == "-0" else out


def round_price(px: Decimal, sz_decimals: int) -> Decimal:
    """The nearest price the venue accepts: 5 significant figures and at most
    `6 - sz_decimals` decimals. Exact decimal arithmetic, so a tie rounds to even; the SDK goes
    through binary floats and can land one tick lower on a tie. Both are valid prices."""
    if px <= 0:
        raise ValueError("price must be positive")
    sig = Decimal(format(px, f".{PRICE_SIG_FIGS}g"))
    out = sig.quantize(Decimal(1).scaleb(-(MAX_PRICE_DECIMALS - sz_decimals)))
    if out <= 0:
        raise ValueError(f"{px} is below the smallest price for this asset")
    return out


def floor_size(size: Decimal, sz_decimals: int) -> Decimal:
    return size.quantize(Decimal(1).scaleb(-sz_decimals), rounding=ROUND_DOWN)


def order_action(
    asset: int, is_buy: bool, limit_px: Decimal, size: Decimal, reduce_only: bool, cloid: str | None
) -> dict[str, Any]:
    """An immediate-or-cancel limit order. Key order matters: msgpack encodes it as written."""
    wire: dict[str, Any] = {
        "a": asset,
        "b": is_buy,
        "p": to_wire(limit_px),
        "s": to_wire(size),
        "r": reduce_only,
        "t": {"limit": {"tif": "Ioc"}},
    }
    if cloid is not None:
        wire["c"] = cloid
    return {"type": "order", "orders": [wire], "grouping": "na"}


# ---------------------------------------------------------------------------------------------
# REST
# ---------------------------------------------------------------------------------------------

#: `post(path, body)` returning the decoded JSON answer.
Http = Callable[[str, dict[str, Any]], Any]


def http_client(base_url: str, timeout: float = 8.0) -> Http:
    def post(path: str, body: dict[str, Any]) -> Any:
        req = urllib.request.Request(
            base_url.rstrip("/") + path,
            data=json.dumps(body, separators=(",", ":")).encode(),
            headers={"Content-Type": "application/json", "User-Agent": "twooptions-agent"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - operator-configured URL
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            text = e.read().decode(errors="replace")[:300]
            if e.code == 429 or e.code >= 500:
                raise TransportError(f"{path}: HTTP {e.code} {text}") from e
            raise HyperliquidError(f"{path}: HTTP {e.code} {text}") from e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            raise TransportError(f"{path}: {e}") from e
        except ValueError as e:
            raise HyperliquidError(f"{path}: answer is not JSON") from e

    return post


@dataclass(frozen=True)
class Asset:
    name: str
    index: int
    sz_decimals: int


@dataclass(frozen=True)
class Position:
    coin: str
    size: Decimal  # signed: positive is long
    entry_px: Decimal | None
    unrealized_pnl: Decimal


@dataclass(frozen=True)
class AccountState:
    account_value: Decimal
    margin_used: Decimal
    withdrawable: Decimal
    positions: dict[str, Position]


@dataclass(frozen=True)
class OrderResult:
    #: "filled" (fully or in part), or "rejected" (nothing traded).
    status: str
    filled: Decimal
    avg_px: Decimal | None
    oid: int | None
    detail: str = ""


class Hyperliquid:
    """The venue as the hedger sees it. `account` is whose positions are read: the signer's own
    address, or the master account when the key is an API wallet approved to trade for it."""

    name = "hyperliquid"

    def __init__(
        self,
        signer: Signer,
        network: str = "testnet",
        account: str | None = None,
        http: Http | None = None,
        base_url: str | None = None,
    ):
        if network not in API_URL:
            raise ValueError(f"network must be one of {sorted(API_URL)}")
        self.signer = signer
        self.network = network
        self.account = (account or signer.address).lower()
        _address_bytes(self.account)
        self._post = http or http_client(base_url or API_URL[network])
        self._assets: dict[str, Asset] | None = None
        self._assets_at = 0.0
        self._mode: str | None = None
        self._mode_at = 0.0
        self._nonce = 0

    # -- reads --------------------------------------------------------------------------------

    def assets(self, max_age_s: float = 600.0) -> dict[str, Asset]:
        if self._assets is None or time.monotonic() - self._assets_at > max_age_s:
            meta = self._post("/info", {"type": "meta"})
            self._assets = {
                a["name"]: Asset(a["name"], i, int(a["szDecimals"]))
                for i, a in enumerate(meta["universe"])
            }
            self._assets_at = time.monotonic()
        return self._assets

    def mids(self) -> dict[str, Decimal]:
        return {k: Decimal(v) for k, v in self._post("/info", {"type": "allMids"}).items()}

    def _spot_backed(self, max_age_s: float = 600.0) -> bool:
        """Whether this account's spot USDC is its perp collateral (Hyperliquid's unified
        account and portfolio margin modes). In those modes the perp balance reads zero while
        the account can still trade against what it holds on the spot side."""
        if self._mode is None or time.monotonic() - self._mode_at > max_age_s:
            try:
                self._mode = str(self._post("/info", {"type": "userAbstraction", "user": self.account}))  # fmt: skip
            except TransportError:
                raise
            except HyperliquidError:
                self._mode = "default"  # an API without account modes
            self._mode_at = time.monotonic()
        return self._mode in ("unifiedAccount", "portfolioMargin")

    def state(self) -> AccountState:
        j = self._post("/info", {"type": "clearinghouseState", "user": self.account})
        positions: dict[str, Position] = {}
        for row in j["assetPositions"]:
            p = row["position"]
            size = Decimal(p["szi"])
            if size:
                entry = p.get("entryPx")
                positions[p["coin"]] = Position(
                    p["coin"],
                    size,
                    Decimal(entry) if entry is not None else None,
                    Decimal(p.get("unrealizedPnl", "0")),
                )
        m = j["marginSummary"]
        value, free = Decimal(m["accountValue"]), Decimal(str(j["withdrawable"]))
        if self._spot_backed():
            spot = self._post("/info", {"type": "spotClearinghouseState", "user": self.account})
            for b in spot.get("balances", []):
                if b["coin"] == "USDC":
                    # `hold` is the margin already moved behind open perp positions; the perp
                    # balance counts it too, so it is taken out here rather than counted twice.
                    unheld = Decimal(b["total"]) - Decimal(b.get("hold", "0"))
                    value += unheld
                    free += unheld
        return AccountState(value, Decimal(m["totalMarginUsed"]), free, positions)

    # -- orders -------------------------------------------------------------------------------

    def _next_nonce(self) -> int:
        self._nonce = max(time.time_ns() // 1_000_000, self._nonce + 1)
        return self._nonce

    def ioc(
        self,
        coin: str,
        is_buy: bool,
        size: Decimal,
        limit_px: Decimal,
        reduce_only: bool,
        expires_after_ms: int,
        cloid: str | None = None,
    ) -> OrderResult:
        """Send an immediate-or-cancel order: it fills against the book up to `limit_px` at
        once and the rest is cancelled, so nothing is ever left resting. The venue rejects it
        outright after `expires_after_ms`, which bounds how late a delayed request can land."""
        asset = self.assets()[coin]
        action = order_action(asset.index, is_buy, limit_px, size, reduce_only, cloid)
        nonce = self._next_nonce()
        signature = sign_l1_action(
            self.signer, action, None, nonce, expires_after_ms, self.network == "mainnet"
        )
        body = {
            "action": action,
            "nonce": nonce,
            "signature": signature,
            "vaultAddress": None,
            "expiresAfter": expires_after_ms,
        }
        return parse_order_response(self._post("/exchange", body))


def parse_order_response(j: Any) -> OrderResult:
    if not isinstance(j, dict) or j.get("status") != "ok":
        detail = j.get("response") if isinstance(j, dict) else j
        return OrderResult("rejected", Decimal(0), None, None, str(detail)[:300])
    try:
        st = j["response"]["data"]["statuses"][0]
    except (KeyError, IndexError, TypeError) as e:
        raise HyperliquidError(f"unexpected order answer: {str(j)[:300]}") from e
    if isinstance(st, dict) and "filled" in st:
        f = st["filled"]
        return OrderResult("filled", Decimal(f["totalSz"]), Decimal(f["avgPx"]), int(f["oid"]))
    if isinstance(st, dict) and "error" in st:
        return OrderResult("rejected", Decimal(0), None, None, str(st["error"])[:300])
    # An IOC order cannot rest; anything else is an answer this client does not know.
    raise HyperliquidError(f"unexpected order status: {str(st)[:300]}")
