"""Transaction encoding parity with @near-js/transactions (fixture from app/scripts)."""

import json
from pathlib import Path

import pytest

from twooptions_agent import near

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "near_tx_vectors.json").read_text())
KEY = near.parse_secret_key(FIXTURE["secret_seed_hex"])


def action(a: dict) -> near.Action:
    t = a["type"]
    if t == "FunctionCall":
        return near.FunctionCall(a["method"], a["args"], int(a["gas"]), int(a["deposit"]))
    if t == "CreateAccount":
        return near.CreateAccount()
    if t == "Transfer":
        return near.Transfer(int(a["deposit"]))
    if t == "AddFullAccessKey":
        return near.AddFullAccessKey(near.parse_public_key(a["public_key"]))
    if t == "DeployContract":
        return near.DeployContract(bytes.fromhex(a["code_hex"]))
    raise AssertionError(t)


def test_fixture_covers_every_action_type() -> None:
    kinds = {a["type"] for c in FIXTURE["cases"] for a in c["actions"]}
    assert kinds == {
        "FunctionCall",
        "CreateAccount",
        "Transfer",
        "AddFullAccessKey",
        "DeployContract",
    }


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: c["name"])
def test_transaction_bytes_hash_and_signature(case: dict) -> None:
    tx = near.encode_transaction(
        case["signer_id"],
        near.public_key_bytes(KEY),
        int(case["nonce"]),
        case["receiver_id"],
        bytes.fromhex(FIXTURE["block_hash_hex"]),
        [action(a) for a in case["actions"]],
    )
    assert tx.hex() == case["transaction_hex"]
    signed, tx_hash = near.sign_transaction(KEY, tx)
    assert tx_hash == case["hash_b58"]
    assert signed.hex() == case["signed_hex"]


def test_key_formats_round_trip() -> None:
    assert near.public_key_str(KEY) == FIXTURE["public_key"]
    again = near.parse_secret_key(near.secret_key_str(KEY))
    assert near.public_key_bytes(again) == near.public_key_bytes(KEY)
    assert near.parse_public_key(FIXTURE["public_key"]) == near.public_key_bytes(KEY)


def test_base58_keeps_leading_zero_bytes() -> None:
    for raw in (b"", b"\0", b"\0\0\x01", bytes(range(40))):
        assert near.b58decode(near.b58encode(raw)) == raw


def test_bad_keys_are_rejected() -> None:
    with pytest.raises(ValueError):
        near.parse_secret_key("ed25519:abc")
    with pytest.raises(ValueError):
        near.parse_secret_key("not a key")
    with pytest.raises(ValueError):
        near.parse_public_key("secp256k1:abc")
    # A 64-byte key whose public half was swapped for another key's.
    other = near.parse_secret_key("07" * 32)
    forged = "ed25519:" + near.b58encode(KEY.private_bytes_raw() + near.public_key_bytes(other))
    with pytest.raises(ValueError):
        near.parse_secret_key(forged)


def test_contract_panic_message_is_extracted() -> None:
    failure = {
        "ActionError": {
            "index": 0,
            "kind": {
                "FunctionCallError": {
                    "ExecutionError": "Smart contract panicked: spot price is stale"
                }
            },
        }
    }
    assert near._failure_text(failure) == "spot price is stale"
