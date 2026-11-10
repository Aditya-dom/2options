# perennia-agent

Off-chain pieces for the perennia contract that don't need the quote server: the wire format for signed messages, the spot feed (#22), and vault inventory and net delta (#24). Gaurav's quoter, keeper and hedger can import them.

```bash
cd agent
uv sync --python 3.11
uv run pytest                                   # 23 tests
uv run ruff check . && uv run mypy perennia_agent
uv run python -m perennia_agent.spot --once     # live prices, one round
uv run python -m perennia_agent.inventory --contract perennia.testnet
```

## `wire.py`: what the agent signs

`SpotUpdate`, `FundingUpdate` and `Quote`, each with `borsh()`, `to_json()` and `from_json()`, plus `digest(contract_id, msg)` and `sign(key, contract_id, msg)` (base64, ready for the contract's `signature` argument).

`tests/fixtures/wire_vectors.json` comes from `contracts/perennia/examples/wire_vectors.rs`. That example uses the contract's own types and runs the signatures through `post_spot` and `settle_funding` on a real `Perennia` instance. The tests check borsh bytes, digests and signatures byte for byte, so anything this module signs is what the contract verifies. Regenerate the fixture if the message structs change:

```bash
cd contracts/perennia && cargo run --example wire_vectors > ../../agent/tests/fixtures/wire_vectors.json
```

## `spot.py`: spot feed for `post_spot` (#22)

Pyth Hermes answers 401 without an API key (checked Nov 10, 2026), so the feed takes the median of four public venues: Coinbase, Kraken, Binance (USDT book) and Hyperliquid (the hedge venue).

It fails closed. It holds instead of posting when fewer than 2 venues are fresh (10 s), when the venues disagree by more than 50 bps, or when the move since the last post exceeds the contract's 10% jump limit inside its 300 s window. `ts_ns` and `seq` (milliseconds) never go backwards, even across restarts. Seed `SpotFeed.last` from `get_spot` on start so the jump guard compares against the chain.

Signing and posting belong to the keeper:

```python
from perennia_agent.spot import SpotFeed
from perennia_agent.wire import Underlying, sign

for d in SpotFeed([Underlying.ETH]).poll():
    if d.update:
        args = {"update": d.update.to_json(), "signature": sign(agent_key, CONTRACT_ID, d.update)}
        # function call post_spot(args) from the keeper account
```

## `inventory.py`: vault inventory and net delta (#24)

This reads `list_series` and `get_spot`, not events. The contract keeps `net_trader_size` per series exactly, and the vault holds the opposite side, so state is authoritative and needs no indexer. It returns, per series and per underlying:
- the vault position;
- delta, from the everlasting series in `greeks.py` until #20's pricing lands;
- net delta and the perp `hedge_target` that flattens it;
- underlyings that have open interest but no spot (it won't hedge those blind).

`rebalance(target, current, deadband)` gives the order size with a no-trade band.
