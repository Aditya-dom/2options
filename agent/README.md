# twooptions-agent

The off-chain half of 2options on NEAR: it prices the option chain, signs quotes, posts spot, settles hourly funding and scans for liquidations. The contract in `contracts/twooptions` verifies every signature and bounds every number, so this process can propose prices but cannot move funds.

Standard library plus `cryptography`. No web framework and no NEAR SDK, so the image that runs inside a TEE stays small.

```bash
cd agent
uv sync --python 3.11
uv run pytest                                    # 111 tests
uv run ruff check . && uv run mypy twooptions_agent

cp .env.example .env                             # fill in keys; .env is ignored by git
uv run python -m twooptions_agent.admin keygen     # a new ed25519 key pair
uv run python -m twooptions_agent.admin bootstrap  # testnet: deploy, configure, seed (idempotent)
uv run python -m twooptions_agent.server           # quote server + keeper on :8787
```

From the repo root the same things are `make near-bootstrap`, `make near-agent` and `make near-status`.

## Testnet from zero

1. Create a testnet account and fund it (about 11 NEAR: the two contracts need roughly 8 NEAR of storage). This is the **owner**.
2. `admin keygen` twice: one key for the agent, one for the keeper if it is a separate account. The keeper can be the owner account on testnet.
3. Fill in `agent/.env`: `OWNER_*`, `AGENT_PRIVATE_KEY`, `KEEPER_*`, and pick `TWOOPTIONS_CONTRACT_ID=contract.<owner>` and `TWOOPTIONS_USDC_ID=usdc.<owner>`.
4. `make near-wasm`, then `make near-bootstrap`. It deploys the test USDC and 2options, applies the parameter preset, registers the contract with the token, lists a strike grid around the live spot, seeds LP liquidity and gives the keeper a contract balance. Rerunning it skips what is already done.
5. `make near-agent`. `GET /health` shows the spot age and the keeper's last actions.
6. Point the app at it: `VITE_CONTRACT_ID`, `VITE_USDC_ID`, `VITE_AGENT_URL=http://localhost:8787`. Anyone can get test USDC with `admin mint --to <account> --amount 10000`.

This ran end to end on testnet on Nov 12. See "Not verified" below for what is still open.

## HTTP API

Every 64/128-bit integer is a decimal string. Errors are non-200 with `{"error": "..."}`. CORS allows the origins in `TWOOPTIONS_CORS_ORIGINS`.

| Request | Response |
|---|---|
| `GET /chain` | Per series: `series`, `bid`, `ask`, `mark` (USDC micros per contract), `delta`, `gamma`, `iv`, `funding_rate_hourly` (1e9 fraction of mark per settlement, the same scale as `FundingUpdate.rate`) |
| `GET /quote?series=&side=Buy\|Sell&size=&taker=` | `{ "quote": {series, taker, side, size, price, nonce, expiry_ns}, "signature": "<base64>" }`, passed straight to `trade` |
| `GET /spot` | `{ "ETH": { "price", "ts_ns" } }`: the contract's cached spot, which is what quotes are priced from |
| `GET /funding/history?series=&limit=` | Settlements this agent posted, newest first: `series`, `epoch`, `rate`, `mark`, `per_contract`, `index`, `ts_ns`, `tx_hash` |
| `GET /attestation` | `agent_public_key`, plus `code_hash` and `tee_quote_url` when configured |
| `GET /inventory` | Vault position and delta per series, net delta and perp hedge target per underlying |
| `GET /health` | Spot age per underlying, series count, pause flag, keeper status and last errors |

A quote is refused, with the contract's own wording where one exists, when: the taker has never deposited (`deposit first`), the spot on chain is stale, trading is paused, the series is inactive, the size is out of range, the vault could not pay for it (`vault cannot fund this trade`) or it would push the vault past its risk limit (`vault risk limit reached`). The agent also refuses to sell when the fair price is above the contract's band, instead of selling at the band edge below fair value.

## Pricing (`pricing.py`)

Every settlement a long pays the short a fraction `c` of the option's time value. That funding rule fixes the price: the option is worth a basket of ordinary options with weights `c(1-c)^(n-1)` at maturities `n` settlement intervals,

    V = sum_{n>=1} c (1-c)^(n-1) BS(S, K, sigma, T = n * interval)

With `c = 1/2` this is Paradigm's half-weight series, which is what the earlier project's `core/everlasting.py` computes. The agent uses `c = 1/24` with the contract's hourly settlement: a long pays `(mark - intrinsic) / 24` per hour and the option has an average life of one day. An at-the-money ETH call at 60% vol is about 1.1% of spot.

Price and funding share the one parameter on purpose. HANDOFF_GAURAV.md section 2 found that pricing with half weights at an hourly period while charging `/24` leaves the vault paying out about seven times more gamma than it collects in funding. Switching the price to half weights at a daily period (option B there) overshoots the other way: the quote is about 50% above what the funding stream is worth. `tests/test_pricing.py` checks the one-interval identity `V(t) = (1-c) E[V(t+dt)] + c E[intrinsic(t+dt)]` numerically and pins both mismatches.

The vol surface is a configured ATM vol per underlying with a linear skew and quadratic smile in log-moneyness, floored by the realized vol of the spot the keeper posts (30-minute half-life). Quoting below realized vol loses to anyone who delta-hedges.

This file is a port of pre-hackathon code ([`core/black_scholes.py`](https://github.com/gks2022004/nerf/blob/00fe59b/core/black_scholes.py), [`core/everlasting.py`](https://github.com/gks2022004/nerf/blob/00fe59b/core/everlasting.py), the skew and smile in [`core/vol_surface.py`](https://github.com/gks2022004/nerf/blob/00fe59b/core/vol_surface.py)) and is disclosed as prior work.

## Modules

| File | Purpose |
|---|---|
| `wire.py` | Borsh encoding, digest and signature for `Quote`, `SpotUpdate`, `FundingUpdate`; byte-for-byte parity with the contract |
| `pricing.py` | Black-Scholes, the everlasting series, funding rate, vol surface, realized vol |
| `margin.py` | Integer port of `margin.rs` and `math.rs`; parity-tested on the contract's own fixture |
| `chain.py` | Typed snapshot of contract state (params, series, spot, vault) and a shared cache |
| `quoter.py` | Chain rows and signed quotes, with the contract's checks run before signing |
| `spot.py` | Spot feed: median of Coinbase, Kraken, Binance and Hyperliquid; holds instead of posting when venues disagree |
| `keeper.py` | `post_spot` every 5 s, `settle_funding` once per epoch per series with the epoch's average mark, liquidation scan |
| `store.py` | Funding history and the liquidation watch list, on disk |
| `inventory.py` | Vault inventory, net delta and hedge target |
| `near.py` | Keys, transaction encoding, signing and RPC; parity-tested against `@near-js/transactions` |
| `server.py` | HTTP API and the process entry point |
| `admin.py` | Owner-side deploy and setup |
| `config.py` | Environment and `.env` loading |

## Keeper behaviour worth knowing

- **Spot.** It seeds the feed from the contract's spot on start and after any failed post, so the feed's jump guard compares against what the contract holds. It posts every underlying that has a series. If fewer than two venues agree it holds, the spot on chain goes stale and trading pauses. That is the intended failure mode.
- **Funding.** It waits 15 s into a new epoch, then settles each series whose `last_epoch` is behind. The mark is the average of the agent's marks sampled over the epoch that just ended (the current mark on a cold start), clamped into the band around the current spot. One series failing does not block the others; it is retried on the next pass.
- **Liquidations.** The contract cannot list its accounts, so the keeper watches every account the agent has quoted for. An account that deposits and never asks this agent for a quote has no positions to liquidate. The keeper account needs a deposit in the contract to receive rewards (`admin fund-keeper`).
- **One transaction at a time.** All keeper transactions go through one account and wait for execution, about 2 s each. With many underlyings the spot round gets slower; keep `max_spot_age` (30 s) in mind before listing more than a few.

## Fixtures

```bash
make near-fixtures    # regenerates all three after changing contract types, margin or the encoders
```

- `tests/fixtures/wire_vectors.json` from `contracts/twooptions/examples/wire_vectors.rs`, which also runs the signatures through `post_spot` and `settle_funding` on a real `2options` instance.
- `app/src/lib/fixtures/margin_vectors.json` from `contracts/twooptions/examples/margin_vectors.rs`; `tests/test_margin.py` reads the same file as the app.
- `tests/fixtures/near_tx_vectors.json` from `app/scripts/near_tx_vectors.ts`, which encodes and signs the same transactions with `@near-js/transactions`.

## Not verified

- **Liquidation and LP claim have not run live.** Everything else has: `scripts/e2e_testnet.py <account.testnet>` runs 27 checks with real transactions against the testnet deployment (deposit, trades, rejected replays and forgeries, a two-leg batch, withdraw, LP deposit and redeem, close-out, solvency). Liquidation needs a price move and the claim needs the one-hour cooldown.
- **Public RPCs throttle.** FastNEAR rate-limited the agent during testing; it now retries on HTTP 429 and reads parameters every 30 s instead of every pass. `NEAR_RPC_URL` picks the endpoint. Transactions go through `send_tx`, and a provider timeout (HTTP 408) is followed up by asking for the transaction's outcome.
- **Do not transact from the keeper's account while it runs.** Access-key nonces collide and one of the two transactions is dropped; the keeper retries, a script may not.
- **A quote is a short free option.** A taker can hold a signed quote for its whole lifetime (28 s with the preset) and execute only if spot moved their way. The spread is the only compensation. A shorter TTL or a wider spread for larger sizes are the levers.
- **No hedging.** `/inventory` reports the hedge target; nothing places orders (#38).
- **No TEE.** `/attestation` returns the key; `code_hash` and `tee_quote_url` are passed through from the environment once the agent runs as a Shade Agent (#34).
- **Flat vols.** The ATM vols are configured constants with a realized-vol floor, not a market-implied surface.
