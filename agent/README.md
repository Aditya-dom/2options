# twooptions-agent

The off-chain half of 2Options on NEAR: it prices the option chain, signs quotes, posts spot, settles hourly funding, liquidates accounts that can no longer carry their positions, and hedges the vault's delta on Hyperliquid. The contract in `contracts/twooptions` verifies every signature and bounds every number, so this process can propose prices but cannot move funds.

Standard library plus `cryptography`. No web framework and no NEAR SDK, so the image that runs inside a TEE stays small.

```bash
cd agent
uv sync --python 3.11
uv run pytest                                    # 205 tests
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
4. `make near-wasm`, then `make near-bootstrap`. It deploys the test USDC and 2Options, applies the parameter preset, registers the contract with the token, lists a strike grid around the live spot, seeds LP liquidity and gives the keeper a contract balance. Rerunning it skips what is already done.
5. `make near-agent`. `GET /health` shows the spot age and the keeper's last actions.
6. Point the app at it: `VITE_CONTRACT_ID`, `VITE_USDC_ID`, `VITE_AGENT_URL=http://localhost:8787`. Traders get test USDC from the app's faucet button (the token's `faucet()`: 2,000 per account per 24 hours); the owner can still `admin mint --to <account> --amount 10000`.

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
| `GET /inventory` | Vault position and delta per series, net delta and perp hedge target per underlying. The delta is the quoted one for each strike (same surface, funding fraction and interval as `/chain`) |
| `GET /hedge` | The hedger: `enabled`, venue, network, exchange account, and per underlying the `target`, `position` on the venue, `gap`, `state` (`balanced`, `trade`, `hold`) with its `reason`, venue price and basis to the contract's spot; the account's collateral; the last 20 orders with status (`filled`, `rejected`, `unknown`); the last error. With no hedger configured: `enabled: false` and the targets |
| `GET /health` | Spot age per underlying, series count, pause flag, keeper status and last errors |

A quote is refused, with the contract's own wording where one exists, when: the taker has never deposited (`deposit first`), the spot on chain is stale, trading is paused, the series is inactive, the size is out of range, the vault could not pay for it (`vault cannot fund this trade`) or it would push the vault past its risk limit (`vault risk limit reached`). The agent also refuses to sell when the fair price is above the contract's band, instead of selling at the band edge below fair value. It also refuses a price further than the contract allows from the series' last funding mark (`price is too far from the last funding mark`), and a quote that would push the vault's payouts this hour past its cap (`vault outflow limit reached for this hour`).

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
| `keeper.py` | `post_spot` every 5 s, `settle_funding` once per epoch per series at the current mark, liquidation scan |
| `store.py` | Funding history, the liquidation watch list and the hedger's orders, on disk |
| `inventory.py` | Vault inventory, net delta and hedge target |
| `hedger.py` | Keeps a perp position equal to the hedge target: a pure decision function and its own thread |
| `hyperliquid.py` | Hyperliquid perps: order signing (msgpack, EIP-712, secp256k1) and the few REST calls the hedger needs; parity-tested against the official SDK |
| `keccak.py` | Keccak-256, which the standard library does not have (its SHA3-256 pads differently) |
| `near.py` | Keys, transaction encoding, signing and RPC; parity-tested against `@near-js/transactions` |
| `server.py` | HTTP API and the process entry point |
| `admin.py` | Owner-side deploy and setup |
| `config.py` | Environment and `.env` loading |

## Keeper behaviour worth knowing

- **Spot.** It seeds the feed from the contract's spot on start and after any failed post, so the feed's jump guard compares against what the contract holds. It posts every underlying that has a series. If fewer than two venues agree it holds, the spot on chain goes stale and trading pauses. That is the intended failure mode.
- **Funding.** It waits 15 s into a new epoch, then settles each series whose `last_epoch` is behind, two per pass so spot posts are never starved. The mark is the agent's current mark, not an average over the hour: the contract records it with the spot of that moment and anchors the next hour's trade prices to the pair, so the two must belong together. One series failing does not block the others; it is retried on the next pass.
- **Liquidations.** The contract cannot list its accounts, so the keeper watches every account the agent has quoted for. An account that deposits and never asks this agent for a quote has no positions to liquidate. The keeper account needs a deposit in the contract to receive rewards (`admin fund-keeper`). The scan applies the contract's own test: equity below zero, or equity under 1.15 times the requirement. `get_account` reports equity before funding the account owes but has not been charged, so the keeper subtracts that first (`pending_funding`). That is what catches a long: it has no requirement, and nothing else ever touches its account to charge the funding. `/health` lists the last liquidations with their transaction hashes.
- **One transaction at a time.** All keeper transactions go through one account and wait for execution, about 2 s each. With many underlyings the spot round gets slower; keep `max_spot_age` (30 s) in mind before listing more than a few.

## Hedging (`hedger.py`, `hyperliquid.py`)

Off unless `HYPERLIQUID_PRIVATE_KEY` is set. With it, a third thread keeps a perp position on Hyperliquid equal to the vault's hedge target and `/hedge` reports it.

```bash
# agent/.env
HYPERLIQUID_PRIVATE_KEY=0x...        # an API wallet key: it can trade, it cannot withdraw
HYPERLIQUID_ACCOUNT_ADDRESS=0x...    # the account that API wallet trades for; empty if the key is the account's own
HYPERLIQUID_NETWORK=testnet          # must match NEAR_NETWORK

uv run python scripts/hedge_smoke.py           # read only: is the account there, what does it hold
uv run python scripts/hedge_smoke.py --trade   # buy and sell back about 12 USD of ETH (testnet only)
```

**What it is not.** The hedge sits in an exchange account the operator holds, not in the contract. Its profit and loss does not flow into vault equity or the LP share price. It lowers the price risk LPs carry and it is a trusted, off-chain piece; the app's Vault page says so next to the numbers.

**The loop**, every 5 s, per underlying:

    target = -(sum over series of vault position x quoted delta)
    gap    = target - position on the venue

- It trades when the gap is outside a no-trade band, up to 5,000 USD per order and 50,000 USD of position. Sizes are floored to the venue's lot. The band is the larger of 25 USD (never under the venue's 10 USD minimum) and the delta drift that a 50 bps move in spot causes, `|gamma| x spot x 0.5%`. `/hedge` reports it per underlying as `band`.
- Every order is immediate-or-cancel with a price limit (100 bps through the mid) and an 8 s expiry, so nothing rests on the book and a request delayed in transit is refused instead of filling late. An order that only shrinks the position is sent reduce-only.
- The venue is the source of truth: the position is read every pass and again after every order. Nothing is remembered locally and an order's own answer is not trusted for it.
- When the book is empty the hedge this agent opened is closed completely with a reduce-only order, whatever its size. Hyperliquid accepts a reduce-only order that closes a whole position even under its 10 USD minimum (checked with an 8.52 USD close), so no remainder is left inside the deadband.
- **It sends nothing when in doubt:** the contract's spot is stale, the venue cannot be read, the venue does not list the asset, or the venue's price is more than 500 bps from the contract's spot. With a stale spot the contract refuses trades, so the book the hedge covers cannot change either.
- After a request times out, no new order goes out for that asset until the first one has expired on the venue, so a retry can never double the hedge. After a refusal it waits 30 s.
- **One hedger per exchange account.** Two rules protect an account that is shared by mistake. With an empty book, the hedger leaves alone any position it has not traded in this process: it belongs to another agent or was opened by hand. And if the position on the venue changes with no order from this hedger, it stops hedging that asset and says why in `/hedge` until the agent is restarted, instead of trading against whatever it is. On Nov 14 a test agent with an empty book shared the account that hedges the shared deployment: that deployment's agent bought its 0.585 ETH hedge and the test agent closed it, seven times in 70 seconds at about 3.70 USD a round.
- `HYPERLIQUID_NETWORK` must match `NEAR_NETWORK`: a testnet book hedged with real money, or the reverse, is refused at start-up.

**Cost, and why the band follows gamma.** Each rebalance crosses half the venue's spread and pays its taker fee. When traders are net long options the vault is short gamma, so re-hedging buys after rises and sells after falls; the funding the vault collects is what pays for that. These options live about a day, so their delta moves quickly, and a band fixed in dollars re-trades on a few basis points of spot. Measured on Nov 14 with a 25 USD band alone: 41 fills and about 5,000 USD traded in 21 minutes to hedge three calls worth 11 USD, at a cost of about 17 USD. With the gamma term the same test made one order while the position was open and one to close it. (That test book settles funding every 3 minutes, so its options live about 72 minutes and its gamma is several times the shared deployment's; there the band comes to about 15% of the hedge for an at-the-money book.) Between re-hedges the vault carries the drift inside the band: `HEDGE_REHEDGE_MOVE_BPS` and `HEDGE_DEADBAND_USD` trade tracking against cost.

**On Hyperliquid testnet, keep it small.** The testnet book is thin: an order of 1 ETH or more walks it and a round trip costs about 0.4%. The day's testing took a 999 USDC test account to about 915. For a demo set `HEDGE_MAX_ORDER_USD=25` and `HEDGE_MAX_POSITION_USD=50`; the mechanism shows just as well and a round trip costs cents.

**The quoter does not yet charge for the hedge.** Its floor on the half-spread is 0.5 bp of delta-weighted spot (`spread_delta_bps`), while hedging that delta as a taker costs several bps even on a liquid book. A 2-contract trade opened and closed within a minute earned 0.37 USD of option spread and cost about 5 USD to hedge on testnet's wide book. Raise that floor towards the venue's taker fee plus half its spread before reading anything into hedged P&L.

**Signing without an SDK.** Hyperliquid orders are signed with secp256k1 over an EIP-712 digest of a Keccak-256 hash of the msgpack-encoded order. The standard library has none of these, so `keccak.py` and `hyperliquid.py` implement the subset an order needs and `cryptography` (OpenSSL) does the signing; the private key never passes through the Python curve code, which only finds the signature's recovery id from public values. `tests/test_hyperliquid.py` checks msgpack bytes, hashes, digests and signatures against vectors generated from the official SDK (`scripts/hl_vectors.py`) and against the vectors in the SDK's own test suite. Accounts in Hyperliquid's unified mode hold their collateral as spot USDC; the client counts it.

## Fixtures

```bash
make near-fixtures    # regenerates all three after changing contract types, margin or the encoders
```

- `tests/fixtures/wire_vectors.json` from `contracts/twooptions/examples/wire_vectors.rs`, which also runs the signatures through `post_spot` and `settle_funding` on a real `2Options` instance.
- `app/src/lib/fixtures/margin_vectors.json` from `contracts/twooptions/examples/margin_vectors.rs`; `tests/test_margin.py` reads the same file as the app.
- `tests/fixtures/near_tx_vectors.json` from `app/scripts/near_tx_vectors.ts`, which encodes and signs the same transactions with `@near-js/transactions`.
- `tests/fixtures/hyperliquid_vectors.json` from `scripts/hl_vectors.py`, which needs the official SDK only while generating: `uv run --no-project --with hyperliquid-python-sdk python scripts/hl_vectors.py > tests/fixtures/hyperliquid_vectors.json`.
- `tests/fixtures/hedge_status.json` is what `GET /hedge` returns; the app's parser is tested on it and `tests/test_hedger.py` fails if the hedger's output drifts from it (`TWOOPTIONS_WRITE_FIXTURES=1 uv run pytest tests/test_hedger.py -k fixture` rewrites it).

## Not verified

- **A market-driven liquidation of a short has not happened on testnet.** `liquidate` for a short has run with real transactions, but only with a price we set: on our test deployment the keeper's price source was replaced and raised 9% in two steps, and the keeper liquidated the short it made unhealthy. Everything else has run live, the LP claim included (a claim requested an hour earlier paid out in full). `scripts/e2e_testnet.py <account.testnet>` runs 34 checks with real transactions (faucet and its daily limit, owner-only mint, deposit, a buy on credit refused, trades, rejected replays and forgeries, a validly signed price far from the funding mark, a two-leg batch, withdraw, LP deposit and redeem, close-out, solvency). `scripts/liquidation_demo.py <account.testnet>` opens a long with no cash to spare, waits for the next funding settlement and checks that the keeper closes it and that the balance matches the transaction's events to the micro. Both passed on Nov 14 against a second deployment running the current contract; the shared deployment has not been upgraded to it yet. Rerun `e2e_testnet.py` with the same account an hour or more later and it also collects the LP claim the first run left.
- **Public RPCs throttle and stall.** `NEAR_RPC_URL` takes several endpoints, comma separated (testnet: `https://near-testnet.drpc.org,https://test.rpc.fastnear.com,https://rpc.testnet.near.org`). A timeout, HTTP 408/429/5xx or a connection error moves the request to the next one, and the one that answered is used first from then on. HTTP 429 is retried with backoff first; parameters are read every 30 s rather than every pass.
- **The spot must stay under 30 s old** or the contract refuses trades. The keeper posts it every 5 s and returns as soon as the transaction is in a block, without waiting for it to run, so a slow endpoint delays one post rather than the feed. If the chain's spot falls more than four intervals behind the posts sent, the feed resyncs from the chain. Other transactions wait for their outcome; after a provider timeout the keeper asks for it for at most 6 s. Funding settles one series per pass, and a series that keeps failing goes to the back of the queue. The quoter stops signing once the spot is past half its allowed age, since the trade would likely land stale.
- **Do not transact from the keeper's account while it runs.** Access-key nonces collide and one of the two transactions is dropped; the keeper retries, a script may not.
- **A quote is a short free option.** A taker can hold a signed quote for its whole lifetime (28 s with the preset) and execute only if spot moved their way. The spread is the only compensation. A shorter TTL or a wider spread for larger sizes are the levers.
- **The hedge follows with a delay.** About 15 to 25 s passed between a trade on NEAR and the hedge order on the Nov 14 run: the snapshot is refreshed every few seconds from public RPC endpoints that can lag a block or two, and the hedger runs every 5 s. During that window the vault carries the trade's delta.
- **`HOST` and `PORT` in `.env`** were ignored before Nov 14 (the defaults were read before the file); they now take effect.
- **Transactions are anchored to a final block.** They used the block from the access-key query, which is optimistic (not final yet). A node that does not have that block, such as another provider after a failover, refuses the transaction as `Expired`; the keeper's log showed it twice in a day once one provider began rate-limiting. The anchor is now a final block's hash, refreshed once a minute.
- **Order the RPC list by health.** A rate-limited endpoint (HTTP 429) is retried with backoff before the next one is tried, which delays price posts enough for quotes to be refused as stale. On Nov 14 `https://near-testnet.drpc.org,https://test.rpc.fastnear.com` worked; `rpc.testnet.near.org` answered 429 throughout.
- **No TEE.** `/attestation` returns the key; `code_hash` and `tee_quote_url` are passed through from the environment once the agent runs as a Shade Agent (#34).
- **Flat vols.** The ATM vols are configured constants with a realized-vol floor, not a market-implied surface.
