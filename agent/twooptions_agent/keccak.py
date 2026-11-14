"""Keccak-256, the hash Ethereum-style signatures use (Hyperliquid's included).

`hashlib.sha3_256` is the same sponge with a different padding byte (0x06, where Keccak uses
0x01), so it cannot stand in. The tests exploit that: this sponge with 0x06 must reproduce
`hashlib.sha3_256` on every input, which checks the permutation and the round constants against
the standard library.

Pure Python: about 0.3 ms per 136-byte block, and the hedger hashes a few hundred bytes per
order. Only public data is hashed here, so timing does not matter.
"""

from __future__ import annotations

_MASK = (1 << 64) - 1
_RATE = 136  # bytes per block for a 256-bit digest (1600 - 2 * 256 bits)

_ROUND_CONSTANTS = (
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
)  # fmt: skip


def _rol(v: int, n: int) -> int:
    return ((v << n) | (v >> (64 - n))) & _MASK


def _permute(s: list[int]) -> None:
    """Keccak-f[1600] in place. `s` holds 25 lanes of 64 bits, lane (x, y) at index x + 5y."""
    for rc in _ROUND_CONSTANTS:
        # theta
        c = [s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        for i in range(25):
            s[i] ^= d[i % 5]
        # rho and pi
        x, y = 1, 0
        lane = s[1]
        for t in range(24):
            x, y = y, (2 * x + 3 * y) % 5
            i = x + 5 * y
            lane, s[i] = s[i], _rol(lane, ((t + 1) * (t + 2) // 2) % 64)
        # chi
        for row in range(0, 25, 5):
            a = s[row : row + 5]
            for x in range(5):
                s[row + x] = a[x] ^ (~a[(x + 1) % 5] & _MASK & a[(x + 2) % 5])
        # iota
        s[0] ^= rc


def sponge256(data: bytes, suffix: int) -> bytes:
    """A 256-bit digest from the Keccak sponge. `suffix` is the padding's first byte: 0x01 for
    Keccak-256, 0x06 for SHA3-256."""
    padded = bytearray(data)
    padded.append(suffix)
    padded.extend(b"\0" * (-len(padded) % _RATE))
    padded[-1] |= 0x80
    state = [0] * 25
    for off in range(0, len(padded), _RATE):
        for i in range(_RATE // 8):
            state[i] ^= int.from_bytes(padded[off + 8 * i : off + 8 * i + 8], "little")
        _permute(state)
    return b"".join(v.to_bytes(8, "little") for v in state[:4])


def keccak256(data: bytes) -> bytes:
    return sponge256(data, 0x01)
