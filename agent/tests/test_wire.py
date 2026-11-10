"""Byte-for-byte parity with the contract's own encoding (fixture from wire_vectors.rs)."""

import base64
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from perennia_agent.wire import FundingUpdate, Quote, SpotUpdate, Underlying, digest, sign

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "wire_vectors.json").read_text())
PARSERS = {
    "spot": SpotUpdate.from_json,
    "funding": FundingUpdate.from_json,
    "quote": Quote.from_json,
}
KEY = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(FIXTURE["agent_secret_key_hex"]))
CONTRACT = FIXTURE["contract_id"]


def b58encode(b: bytes) -> str:
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    n, out = int.from_bytes(b, "big"), ""
    while n:
        n, r = divmod(n, 58)
        out = alphabet[r] + out
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + out


def test_fixture_covers_every_message_type() -> None:
    assert {v["kind"] for v in FIXTURE["vectors"]} == {"spot", "funding", "quote"}
    assert set(FIXTURE["accepted_by_contract"]) == {"spot", "funding"}


def test_public_key_matches_contract_format() -> None:
    raw = KEY.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    assert "ed25519:" + b58encode(raw) == FIXTURE["agent_public_key"]


@pytest.mark.parametrize(
    "v", FIXTURE["vectors"], ids=lambda v: f"{v['kind']}-{v['digest_hex'][:8]}"
)
def test_encoding_digest_and_signature_match_rust(v: dict[str, object]) -> None:
    msg = PARSERS[str(v["kind"])](v["message"])  # type: ignore[arg-type]
    assert msg.to_json() == v["message"]
    assert msg.borsh().hex() == v["borsh_hex"]
    assert digest(CONTRACT, msg).hex() == v["digest_hex"]
    # ed25519 is deterministic, so the same key and digest give the same signature.
    assert sign(KEY, CONTRACT, msg) == v["signature_b64"]
    assert len(base64.b64decode(sign(KEY, CONTRACT, msg))) == 64


def test_domain_separation_changes_the_digest() -> None:
    s = SpotUpdate(Underlying.ETH, 1, 2, 3)
    assert digest(CONTRACT, s) != digest("perennia.near", s)


def test_out_of_range_values_are_rejected() -> None:
    with pytest.raises(ValueError):
        SpotUpdate(Underlying.ETH, -1, 0, 0).borsh()
    with pytest.raises(ValueError):
        FundingUpdate("ETH-2100-C", 2**64, 0, 0).borsh()
