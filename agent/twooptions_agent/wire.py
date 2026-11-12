"""Wire format for agent-signed messages, matching contracts/twooptions (README "Wire format").

    digest    = sha256(domain || u32_le(len(contract_id)) || contract_id || borsh(message))
    signature = ed25519_sign(agent_secret_key, digest), sent base64

Borsh: enums are one u8 in declaration order; strings are u32-LE length + UTF-8; u64/u128/i128
are little-endian. JSON carries every 64/128-bit integer as a decimal string.

Checked byte for byte, signature included, against contracts/twooptions/examples/wire_vectors.rs,
which also runs the signatures through post_spot and settle_funding on a real contract.
"""

from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass
from enum import IntEnum

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

QUOTE_DOMAIN = b"twooptions:quote:v1"
SPOT_DOMAIN = b"twooptions:spot:v1"
FUNDING_DOMAIN = b"twooptions:funding:v1"

U64_MAX = 2**64 - 1
U128_MAX = 2**128 - 1
I128_MIN, I128_MAX = -(2**127), 2**127 - 1


class Underlying(IntEnum):
    BTC = 0
    ETH = 1
    SOL = 2
    NEAR = 3


class Side(IntEnum):
    Buy = 0
    Sell = 1


def _check(name: str, v: int, lo: int, hi: int) -> int:
    if not lo <= v <= hi:
        raise ValueError(f"{name}={v} out of range [{lo}, {hi}]")
    return v


def _u64(v: int) -> bytes:
    return _check("u64", v, 0, U64_MAX).to_bytes(8, "little")


def _u128(v: int) -> bytes:
    return _check("u128", v, 0, U128_MAX).to_bytes(16, "little")


def _i128(v: int) -> bytes:
    return _check("i128", v, I128_MIN, I128_MAX).to_bytes(16, "little", signed=True)


def _string(s: str) -> bytes:
    b = s.encode()
    return len(b).to_bytes(4, "little") + b


@dataclass(frozen=True)
class SpotUpdate:
    underlying: Underlying
    price: int  # USD x 1e8
    ts_ns: int
    seq: int  # strictly increasing per underlying

    def borsh(self) -> bytes:
        return bytes([self.underlying]) + _u128(self.price) + _u64(self.ts_ns) + _u64(self.seq)

    def to_json(self) -> dict[str, str]:
        return {
            "underlying": self.underlying.name,
            "price": str(self.price),
            "ts_ns": str(self.ts_ns),
            "seq": str(self.seq),
        }

    @classmethod
    def from_json(cls, d: dict[str, str]) -> SpotUpdate:
        return cls(Underlying[d["underlying"]], int(d["price"]), int(d["ts_ns"]), int(d["seq"]))


@dataclass(frozen=True)
class FundingUpdate:
    series: str
    epoch: int  # floor(ts / funding_interval)
    rate: int  # 1e9 fraction of mark per hour, signed; positive = longs pay
    mark: int  # USDC micros per contract

    def borsh(self) -> bytes:
        return _string(self.series) + _u64(self.epoch) + _i128(self.rate) + _u128(self.mark)

    def to_json(self) -> dict[str, str]:
        return {
            "series": self.series,
            "epoch": str(self.epoch),
            "rate": str(self.rate),
            "mark": str(self.mark),
        }

    @classmethod
    def from_json(cls, d: dict[str, str]) -> FundingUpdate:
        return cls(d["series"], int(d["epoch"]), int(d["rate"]), int(d["mark"]))


@dataclass(frozen=True)
class Quote:
    series: str
    taker: str
    side: Side
    size: int  # 1e6 per contract
    price: int  # USDC micros per contract
    nonce: int  # must exceed the taker's last_nonce
    expiry_ns: int  # at most max_quote_ttl past block time when the trade lands

    def borsh(self) -> bytes:
        return (
            _string(self.series)
            + _string(self.taker)
            + bytes([self.side])
            + _u128(self.size)
            + _u128(self.price)
            + _u64(self.nonce)
            + _u64(self.expiry_ns)
        )

    def to_json(self) -> dict[str, str]:
        return {
            "series": self.series,
            "taker": self.taker,
            "side": self.side.name,
            "size": str(self.size),
            "price": str(self.price),
            "nonce": str(self.nonce),
            "expiry_ns": str(self.expiry_ns),
        }

    @classmethod
    def from_json(cls, d: dict[str, str]) -> Quote:
        return cls(
            d["series"],
            d["taker"],
            Side[d["side"]],
            int(d["size"]),
            int(d["price"]),
            int(d["nonce"]),
            int(d["expiry_ns"]),
        )


Message = SpotUpdate | FundingUpdate | Quote

DOMAIN: dict[type, bytes] = {
    SpotUpdate: SPOT_DOMAIN,
    FundingUpdate: FUNDING_DOMAIN,
    Quote: QUOTE_DOMAIN,
}


def digest(contract_id: str, msg: Message) -> bytes:
    cid = contract_id.encode()
    return hashlib.sha256(
        DOMAIN[type(msg)] + len(cid).to_bytes(4, "little") + cid + msg.borsh()
    ).digest()


def sign(key: Ed25519PrivateKey, contract_id: str, msg: Message) -> str:
    """Base64 signature, as the contract's `signature: Base64VecU8` argument expects."""
    return base64.b64encode(key.sign(digest(contract_id, msg))).decode()
