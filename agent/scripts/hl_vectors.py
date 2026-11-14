"""Regenerate tests/fixtures/hyperliquid_vectors.json from the official Hyperliquid SDK.

    cd agent && uv run --no-project --with hyperliquid-python-sdk python scripts/hl_vectors.py \
        > tests/fixtures/hyperliquid_vectors.json

The agent does not depend on the SDK; `twooptions_agent/hyperliquid.py` re-implements the parts it
needs. This script is the reference those parts are tested against: msgpack bytes, keccak, the
action hash, the EIP-712 digest and the signature, all from the SDK and the libraries it uses.
The key below is the public test key from the SDK's own test suite. Never put a real key here.
"""

from __future__ import annotations

import json
import random
import sys

import eth_account
import msgpack
from eth_account.messages import encode_typed_data
from eth_utils import keccak
from hyperliquid.utils.signing import (
    action_hash,
    construct_phantom_agent,
    float_to_wire,
    l1_payload,
    order_request_to_order_wire,
    order_wires_to_order_action,
    sign_l1_action,
)
from hyperliquid.utils.types import Cloid

TEST_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123"
VAULT = "0x1719884eb866cb12b2287399b15f7db5e7d775ea"


def msgpack_cases() -> list[dict[str, object]]:
    ints = [0, 1, 127, 128, 255, 256, 65_535, 65_536, 2**32 - 1, 2**32, 2**64 - 1]
    ints += [-1, -32, -33, -128, -129, -32_768, -32_769, -(2**31), -(2**31) - 1, -(2**63)]
    objs: list[object] = [None, True, False, *ints]
    objs += ["", "a", "x" * 31, "y" * 32, "z" * 255, "w" * 256, "é€"]
    objs += [[], [1] * 15, [2] * 16, list(range(300)), {}, {"k": [None, {"n": -5}]}]
    objs += [{f"k{i}": i for i in range(15)}, {f"k{i}": str(i) for i in range(16)}]
    objs.append({"type": "order", "orders": [{"a": 4, "b": True, "p": "1670.1", "s": "0.0147"}]})
    return [{"obj": o, "hex": msgpack.packb(o).hex()} for o in objs]


def order(sz: float, px: float, is_buy: bool, reduce_only: bool, cloid: str | None) -> dict:
    return {
        "coin": "ETH",
        "is_buy": is_buy,
        "sz": sz,
        "limit_px": px,
        "reduce_only": reduce_only,
        "order_type": {"limit": {"tif": "Ioc"}},
        "cloid": Cloid.from_str(cloid) if cloid else None,
    }


def l1_cases() -> list[dict[str, object]]:
    wallet = eth_account.Account.from_key(TEST_KEY)
    actions = [
        {"type": "dummy", "num": 100_000_000_000},
        order_wires_to_order_action([order_request_to_order_wire(order(0.0147, 1670.1, True, False, None), 4)]),
        order_wires_to_order_action(
            [order_request_to_order_wire(order(0.5, 2006.2, False, True, "0x" + "ab" * 16), 4)]
        ),
        order_wires_to_order_action([order_request_to_order_wire(order(12.0, 3.4527, True, False, None), 54)]),
    ]  # fmt: skip
    out = []
    for action in actions:
        for vault in (None, VAULT):
            for nonce, expires in ((0, None), (1_794_519_063_150, None), (1_794_519_063_150, 1_794_519_071_150)):  # fmt: skip
                for is_mainnet in (True, False):
                    h = action_hash(action, vault, nonce, expires)
                    typed = encode_typed_data(full_message=l1_payload(construct_phantom_agent(h, is_mainnet)))  # fmt: skip
                    digest = keccak(b"\x19" + typed.version + typed.header + typed.body)
                    out.append(
                        {
                            "action": action,
                            "vault": vault,
                            "nonce": nonce,
                            "expires_after": expires,
                            "is_mainnet": is_mainnet,
                            "connection_id": h.hex(),
                            "digest": digest.hex(),
                            "signature": sign_l1_action(
                                wallet, action, vault, nonce, expires, is_mainnet
                            ),  # fmt: skip
                        }
                    )
    return out


def price_cases() -> list[dict[str, object]]:
    rng = random.Random(7)
    out = []
    for sz_decimals in (0, 1, 2, 4, 5):
        for _ in range(40):
            px = 10 ** rng.uniform(-2, 5.2)
            px = float(f"{px:.9g}")
            # The expression in the SDK's Exchange._slippage_price, after slippage is applied.
            rounded = round(float(f"{px:.5g}"), 6 - sz_decimals)
            if rounded > 0:
                out.append({"px": repr(px), "sz_decimals": sz_decimals, "wire": float_to_wire(rounded)})  # fmt: skip
    return out


def main() -> int:
    rng = random.Random(11)
    blobs = [b"", b"abc", bytes(135), bytes(136), bytes(137), *(rng.randbytes(n) for n in (1, 55, 200, 1000))]  # fmt: skip
    wire_floats = [0.0, 1.0, 0.5, 100.0, 1670.1, 0.0147, 12.0, 0.00001, 2006.2, 73317.0, 1e-8]
    json.dump(
        {
            "generator": "agent/scripts/hl_vectors.py",
            "key": TEST_KEY,
            "address": eth_account.Account.from_key(TEST_KEY).address.lower(),
            "keccak": [{"in": b.hex(), "out": keccak(b).hex()} for b in blobs],
            "msgpack": msgpack_cases(),
            "wire": [{"value": repr(x), "wire": float_to_wire(x)} for x in wire_floats],
            "prices": price_cases(),
            "l1": l1_cases(),
        },
        sys.stdout,
        separators=(",", ":"),
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
