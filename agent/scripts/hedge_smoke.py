"""Live check of the hedger's venue client against Hyperliquid.

    cd agent && uv run python scripts/hedge_smoke.py            # read only: account, price, book
    cd agent && uv run python scripts/hedge_smoke.py --trade    # also a round trip of the minimum size

Reads HYPERLIQUID_PRIVATE_KEY (and HYPERLIQUID_ACCOUNT_ADDRESS, HYPERLIQUID_NETWORK) from the
environment or agent/.env. `--trade` buys about 12 USD of ETH with an immediate-or-cancel order,
checks the position the venue reports, sells it back reduce-only and checks the position is back
where it started. Testnet only: a mainnet key is refused. Stop the agent first, or its hedger
will see the test position as a gap and trade against it.

Without funds the order path can still be checked: an order from an unfunded account is refused
with "Insufficient margin", which already means the venue recovered the right address from the
signature. A wrong signature is refused with "User or API Wallet 0x... does not exist".
"""

from __future__ import annotations

import argparse
import sys
import time
from decimal import ROUND_UP, Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from twooptions_agent import config, hyperliquid  # noqa: E402

results: list[bool] = []


def check(ok: bool, name: str, detail: object = "") -> bool:
    results.append(bool(ok))
    print(("PASS  " if ok else "FAIL  ") + name + (f"  [{detail}]" if detail != "" else ""), flush=True)  # fmt: skip
    return bool(ok)


def main() -> int:
    p = argparse.ArgumentParser(description="Hyperliquid client smoke test")
    p.add_argument("--trade", action="store_true", help="round trip of the minimum order size")
    p.add_argument("--coin", default="ETH")
    p.add_argument("--usd", type=float, default=12.0, help="--trade: order size in USD")
    p.add_argument("--slippage-bps", type=float, default=100.0)
    a = p.parse_args()

    config.load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    try:
        venue = config.hedge_venue(config.Network("testnet", "", "unused"))
    except config.ConfigError as e:
        print(f"config: {e}", file=sys.stderr)
        return 2
    if venue is None:
        print("HYPERLIQUID_PRIVATE_KEY is not set (agent/.env)", file=sys.stderr)
        return 2
    print(f"{venue.name} {venue.network}: signer {venue.signer.address}, account {venue.account}")

    asset = venue.assets().get(a.coin)
    if not check(asset is not None, f"{a.coin} is listed", asset):
        return 1
    assert asset is not None
    mid = venue.mids().get(a.coin)
    if not check(mid is not None and mid > 0, f"{a.coin} has a mid price", mid):
        return 1
    assert mid is not None
    state = venue.state()
    held = state.positions.get(a.coin)
    start = held.size if held else Decimal(0)
    check(True, "account state reads", f"value {state.account_value}, withdrawable {state.withdrawable}, {a.coin} position {start}")  # fmt: skip

    if not a.trade:
        print("\nread-only run; pass --trade for an order round trip")
        return 0 if all(results) else 1
    if not check(state.account_value > 0, "the account has collateral", state.account_value):
        print(f"fund {venue.account} on the Hyperliquid testnet first", file=sys.stderr)
        return 1

    lot = Decimal(1).scaleb(-asset.sz_decimals)
    size = (Decimal(repr(a.usd)) / mid).quantize(lot, rounding=ROUND_UP)
    slip = Decimal(repr(a.slippage_bps)) / 10_000

    def order(is_buy: bool, reduce_only: bool) -> hyperliquid.OrderResult:
        px = hyperliquid.round_price(mid * (1 + slip if is_buy else 1 - slip), asset.sz_decimals)
        expires = time.time_ns() // 1_000_000 + 8_000
        return venue.ioc(a.coin, is_buy, size, px, reduce_only, expires)

    def position() -> Decimal:
        for _ in range(5):  # the fill shows up in the account state a moment later
            time.sleep(1.0)
            h = venue.state().positions.get(a.coin)
            now = h.size if h else Decimal(0)
            if now != position.last:  # type: ignore[attr-defined]
                break
        position.last = now  # type: ignore[attr-defined]
        return now

    position.last = start  # type: ignore[attr-defined]

    buy = order(True, False)
    if not check(buy.status == "filled" and buy.filled > 0, f"buy {size} {a.coin} is accepted and fills", f"{buy.filled} @ {buy.avg_px}, oid {buy.oid} {buy.detail}"):  # fmt: skip
        return 1
    after_buy = position()
    check(after_buy == start + buy.filled, "the venue's position moved by the fill", f"{start} -> {after_buy}")  # fmt: skip

    size = buy.filled
    sell = order(False, start >= 0)
    check(sell.status == "filled" and sell.filled == size, f"sell {size} {a.coin} back fills", f"{sell.filled} @ {sell.avg_px}, oid {sell.oid} {sell.detail}")  # fmt: skip
    after_sell = position()
    check(after_sell == start, "the position is back where it started", f"{after_sell}")
    if buy.avg_px and sell.avg_px:
        cost = (buy.avg_px - sell.avg_px) * size
        print(f"      round trip cost before fees: {cost:.4f} USD ({(buy.avg_px / sell.avg_px - 1) * 10_000:.1f} bps of spread crossed)")  # fmt: skip

    failed = results.count(False)
    print(f"\n{len(results) - failed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
