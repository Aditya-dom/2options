# Handoff for Gaurav

## Update, Nov 14: hedging, a fix to the long side of the contract, and a status page

From Aditya. This section is current; the Nov 10 note below it is history. Everything is on branch `aditya/hedge-liquidation`.

### What I need from you, in order

1. **Review and merge the branch.** The contract change is small (three edits in `lib.rs`, below) but it is yours to approve.
2. **Upgrade `contract.twooptions.testnet`.** Code only: no storage, parameter or `margin.rs` change, so no migration, and the parity fixtures are untouched.
   ```bash
   git pull && make near-wasm
   cd agent && uv run python -m twooptions_agent.admin upgrade      # no --migrate
   ```
3. **Restart the agent** (`make near-agent`). The keeper's liquidation scan changed and must match the contract.
4. **Optional, for the demo: turn on hedging.** Put a Hyperliquid testnet key in `agent/.env` (`HYPERLIQUID_PRIVATE_KEY`, see `agent/.env.example`) and restart. Check it first with `uv run python scripts/hedge_smoke.py --trade`.
5. **Decide two things** marked "Your call" below: the liquidation fee base and the quoter's spread floor.

Until step 2 is done the shared deployment still has the hole described next. The README says so.

### Why the contract changed

A long could be opened on credit and could never be liquidated. A long has a margin requirement of zero; `trade` only checked margin when the requirement rose; `liquidate` required a requirement above zero. So nothing ever checked that a buyer could pay the premium, and nothing ever collected funding from a long whose cash had run out. Gains on such a position are paid in real USDC.

Shown on chain against the Nov 13 code, on a second deployment so yours was not touched: an account holding 1 USDC bought 100 USDC of calls ([tx](https://testnet.nearblocks.io/txns/GgeZAz52cC5sMMi6WLFwWQ5dZvbqyFysEcJQavp3fNA9)), ending with a collateral of -99 and a requirement of 0. The ledger invariant still balanced, because the negative collateral offsets the premium credited to the vault, so `get_solvency` did not show it.

### What changed in `lib.rs`

| Where | Change |
|---|---|
| `trade` | A buy must leave the taker's cash at or above zero: `not enough cash to pay the premium`. Checked after funding is settled, so funding owed counts. |
| `liquidate` | An account is liquidatable when its equity is under 1.15 times its requirement **or its equity is negative** after the funding it owes. The second test is what reaches a long. |
| `liquidate` | Fees are charged on the spot notional of each short leg and on the **mark value of each long leg**. |

**Your call: the fee base.** With fees on spot notional, the 1% (reward plus insurance) is more than an out-of-the-money option is worth, so a long one cent short on funding would lose its entire position to the keeper, which is our own account. On mark value, the trader keeps about 99% of what the position is worth less the funding owed. This also lowers the fee on the long leg of a liquidated spread. Say if you want it otherwise; it is one line.

**Known gap, documented in both READMEs.** A long has no funding buffer: it becomes liquidatable only at negative equity, when the remaining time value (about a day of funding) is the cushion. A keeper that is away longer leaves a shortfall for insurance and then the vault. Closing it means a funding reserve in the long's requirement, which changes `margin.rs`, both ports and the fixtures. Not done.

The upgrade was rehearsed on the second deployment with the same two wasm builds: state was identical before and after (params, series, vault, accounts), the deployed code is byte-identical to a fresh build of this branch, and 33 seconds after the upgrade the keeper closed the credit-bought position ([tx](https://testnet.nearblocks.io/txns/BsWib2NATibbzgd1pipuB8CyuaWdWCFK18pD9ayxRhTk)).

### Liquidation on testnet, not staged

`agent/scripts/liquidation_demo.py <account.testnet>` deposits a few USDC, is refused a buy it cannot pay for, spends its cash on an out-of-the-money call and waits. At the next funding settlement the keeper closes the position, and the script checks the account's balance against the transaction's own events to the micro: cash - funding + value at the mark - fees ([tx](https://testnet.nearblocks.io/txns/DiCnvhsvznKcmtQvDyfWEXFfmjZJcZiqpMTjJjYDs9Eq), 10 of 10 checks). No parameter is touched and no price has to move. On your deployment the wait is up to an hour, so start it a few minutes before the top of the hour when recording.

I did not build the "owner tightens the liquidation ratio" demo. `validate_params` has no upper bound on `liquidation_ratio_bps`, so it would show the owner force-closing a healthy account, which the README says the owner cannot do. Worth adding an upper bound some time.

Keeper change (`keeper.py`): `get_account` reports equity before funding that is owed but not yet charged, so the scan now subtracts it (`pending_funding`) and applies the contract's test. `/health` lists recent liquidations with their transaction hashes.

### Hedging on Hyperliquid (#38)

New: `agent/twooptions_agent/hedger.py`, `hyperliquid.py`, `keccak.py`; `GET /hedge`; a DELTA HEDGE panel on the Vault page. Off until a key is configured. `agent/README.md`, "Hedging", is the reference.

- **It ran live.** Two calls bought on NEAR testnet; 0.8286 ETH of perp bought on Hyperliquid testnet about 15 seconds later; flattened with a reduce-only order when the calls were sold back.
- **No new dependency.** Hyperliquid signs orders with secp256k1 over an EIP-712 digest of a Keccak-256 hash of msgpack. None of that is in the standard library, so the subset an order needs is written out and checked byte for byte against the official SDK on 48 signing vectors. The SDK is only used to generate those vectors.
- **It is trusted and off chain.** The hedge sits in an exchange account we hold. Its P&L is not in vault equity or the share price. The app and the README say this wherever the hedge is shown. It uses ordinary Hyperliquid API signing, not NEAR Chain Signatures, and the storyboard is corrected to match.
- **It fails closed.** No order when the contract's spot is stale, the venue cannot be read, the venue's price is more than 500 bps from the contract's spot, or an earlier order's fate is unknown. Orders are immediate-or-cancel with an 8 second expiry, so nothing rests and a delayed request cannot fill late. The position is always read back from the venue.
- **One hedger per exchange account. My test agent broke that, and it cost the hedge account about 25 USDC.** When you turned hedging on for the shared deployment at 16:01 IST, your agent bought its 0.585 ETH hedge (the vault is short one ETH-1900 call). My local test agent was still running against the same Hyperliquid account with an empty book of its own, took that position for a leftover, and closed it. Yours bought it back; mine closed it again: seven times in 70 seconds. Mine is off, and the key is disabled in my local config. Your hedge has been in place undisturbed since 16:08.
- **Two rules now stop that from happening again.** With an empty book, the hedger leaves alone any position it did not open in this process, and says so in `/hedge`. And when the venue's position changes with no order from it, it stops hedging that asset until the agent is restarted, so two agents that both have books trade against each other once, not indefinitely.
- **Keep testnet orders small.** Hyperliquid's testnet book is thin; a round trip of 1.5 ETH cost about 13 USDC. `HEDGE_MAX_ORDER_USD=25` and `HEDGE_MAX_POSITION_USD=50` are enough to show it working.
- **It closes completely.** When the book is empty the hedge is closed with a reduce-only order whatever its size (Hyperliquid accepts that even under its 10 USD minimum), so no remainder is left on the venue.
- **The no-trade band follows gamma.** With a fixed 25 USD band it made 41 fills in 21 minutes hedging three calls worth 11 USD. The band is now the larger of 25 USD and the delta drift of a 0.5% move in spot (`HEDGE_REHEDGE_MOVE_BPS`); the same test then made one order.
- `/inventory` now uses each strike's quoted delta and reports `net_gamma`. It used the at-the-money vol for every strike, so the hedge target disagreed with `/chain`.

**Your call: the spread floor.** The quoter's minimum half-spread is 0.5 bp of delta-weighted spot (`spread_delta_bps`). Hedging that delta as a taker costs several bps. A two-contract trade opened and closed within a minute earned 0.37 USD of option spread and cost about 5 USD to hedge on testnet's wide book. The floor should move towards the hedge venue's taker fee plus half its spread. I did not change pricing.

### Status page

`#/status` in the app (STATUS tab): one line per component with OPERATIONAL, DEGRADED, DOWN or OFF, and an overall verdict. It reads the contract and the agent's `/health` every few seconds.

| Component | Down or degraded when |
|---|---|
| Contract, price feed, ledger, quote server, agent key | These are needed to trade; any one down is an outage. Price older than the contract's limit; `get_solvency` not balancing; agent not answering; agent key not registered |
| Keeper | A job is failing, or it is holding a price back |
| Funding settlement | A series is late in the interval, or has missed one |
| LP vault | At its risk limit, near its hourly payout cap, or withdrawals halted |
| Delta hedge | Last pass failed, silent for a minute, or on hold. OFF when not configured |

The rules are one pure function (`app/src/lib/status.ts`) with a test per rule. `cd app && bun scripts/live_status.ts` prints the same verdict in a terminal and exits 1 on an outage. I checked it by stopping the agent: it reported "Outage: quote server" at once and added "price feed" when the on-chain price passed 30 seconds, then went back to operational after a restart.

### What was tested

| | |
|---|---|
| Contract | 84 unit tests. The 2,000-step random run now also asserts that no completed buy leaves negative cash and that only an account with open positions can have a negative balance |
| Agent | 205 tests, `ruff`, `mypy --strict`. Includes a randomized run of the hedger (random book, price walk, stale spots, venue failures, timeouts, refusals, partial fills) that checks its rules on every pass |
| App | 79 tests, type-check, build |
| Guards | Each new check was removed in turn to confirm a test fails: 5 in the contract, about 35 in the agent, 16 in the status rules |
| Live, second deployment | `e2e_testnet.py` 34 of 34; `liquidation_demo.py` 10 of 10; the hedge loop (open, hold through noise, flatten); `hedge_smoke.py --trade` 8 of 8; the status page in a browser, operational and in an outage |

Two paths that were unverified until today, both on the second deployment:

- **LP claim.** A claim of 499.999152 USDC requested an hour earlier paid out in full and was cleared. `e2e_testnet.py` now collects a matured claim when rerun with the same account an hour or more later.
- **Liquidating a short**, with a price we set. A short needs the price to rise, so I ran the real `Keeper` class with its price source replaced, raised the price 9% in two steps (inside the contract's jump limit), and it liquidated the short once its health reached 0.999 ([tx](https://testnet.nearblocks.io/txns/93SGMKhbZqDMqCMC5236Kxxxp7XNYtPqZSSKTLSbedbC)): fee on spot notional, short closed at intrinsic, balance exact to the micro. The market price was restored afterwards. This tests the code path with real transactions; it is not a market-driven liquidation, and I would not run it on a deployment other people use.

**Not verified:** a market-driven liquidation of a short, the app's trading screens driven by a real wallet in a browser (trades ran through scripts; the Status and Vault pages were checked in a browser), and anything at all on `contract.twooptions.testnet` since Nov 13.

### Two changes in files that are yours

- **`near.py`: transactions are anchored to a final block.** `send` took the block hash from the access-key query, which answers with an optimistic block. A node without that block refuses the transaction as `Expired`. It happened twice in the keeper's log today and once in a test, after FastNEAR began rate-limiting my machine and requests started failing over to another provider. The nonce still comes from the optimistic query; the anchor is a final block's hash, cached for a minute and dropped after an `Expired`.
- **`e2e_testnet.py` reads the strike grid** instead of rounding spot to 50, and its delta bound for the nearest strike is 0.1 to 0.9, because on a deployment with a short funding interval the options are short-dated and delta is steep.

### Smaller things

- `HOST` and `PORT` in `agent/.env` were ignored, because the defaults were read before the file was loaded. Fixed.
- `e2e_testnet.py` has one more check (a buy on credit is refused), retries when the agent stalls on a slow RPC, and borrows a quote for the keeper account instead of the owner, which only worked when the two were the same account.
- Public RPC endpoints rate-limit. Put a healthy one first in `NEAR_RPC_URL`: a rate-limited endpoint is retried with backoff before the next is tried, which delays price posts enough for quotes to be refused as stale. Today `near-testnet.drpc.org` then `test.rpc.fastnear.com` worked, and `rpc.testnet.near.org` answered 429 all day.
- If the agent runs on a laptop, keep it awake: `caffeinate -i make near-agent`. Mine slept for seven minutes mid-test. The spot went stale, trading stopped and the hedger held its position, which is the intended behaviour, but nothing runs while the machine sleeps.
- The second deployment is `contract.e2e-owner-459fc447.testnet` with `usdc.e2e-owner-459fc447.testnet`, funding every 3 minutes so settlements and liquidations can be watched. It only works while my agent is running. Its keys are not in the repo; ask me if you want them.

---

From Aditya, Nov 10, 2026 (final update for today). This replies to `HANDOFF_ADITYA.md`. Everything is on branch `aditya/near-frontend`, in **PR #46**. The new `near` CI workflow passes there: contract, app and agent.

> **Nov 13:** this note predates the testnet deployment. Everything in §1 is done and running; see "Update, Nov 13" in `HANDOFF_ADITYA.md` and the README's **Status** table.

## Where my issues stand

| Issue | Board | State |
|---|---|---|
| #26–#30 Frontend | In Progress | Built and tested against the in-browser contract; waits on §1 for testnet. |
| #31 Strategy builder | In Progress | Presets and editable legs; all legs fill in one transaction or none do. |
| #33 Deposit from another chain | In Progress | Works end to end in the demo against live 1Click quotes; waits on the mainnet decision in §5. |
| #35 Agent badge | In Progress | Verifies every quote's signature and the key's registration; the TEE half waits on #5 and #34. |
| #6 1Click spike | Done | Answers in §5. |
| #22 Spot feed | Done | `agent/twooptions_agent/spot.py`; your keeper signs and posts. |
| #24 Inventory / net delta | In Progress | `agent/twooptions_agent/inventory.py`; waits on a deployed contract to run against. |
| #42 CI + one-command setup | Done | `make near-setup`, `make near-test`, `make near-dev`; `near` workflow green. |
| #8 Demo storyboard (shared) | In Progress | Draft in `DEMO_STORYBOARD.md`: a shot list with dependencies and fallbacks. Please review; three beats hinge on the decisions in §2, §4 and §5 and on which stretch goal (#37) survives. |
| #3 Testnet account, #5 Shade Agent | Todo | Mine, next (§7). |

Run `make near-setup && make near-dev`, then open http://localhost:3001 with no `.env`, to get the full demo.

The demo copies `trade`, `withdraw`, `lp_*` and `apply_funding` from `lib.rs` step by step: same checks, same rounding, same panic strings. It skips only the signature check. The margin code is a TypeScript port that matches `margin.rs`/`math.rs` exactly on 2,697 cases generated from your code (`contracts/twooptions/examples/margin_vectors.rs`, a new example file; the wasm build is untouched). The trade ticket uses it to show margin before signing and to block trades the contract would reject.

Nothing has been tested against a deployed contract, because nothing is deployed. I did run the app in chain mode against real testnet RPC with a mock agent. That run found a crash that stopped the wallet selector from starting (a wallet SDK reads Node's `process`), which is now fixed: the modal lists Meteor, HOT and MyNearWallet. Pointing the app at testnet takes three env vars. Everything below is what I need for that.

---

## 1. Blocking: needed before deposit → trade → funding → withdraw works on testnet

| # | What | Why the app needs it |
|---|---|---|
| 1 | **Deploy `twooptions` to testnet** and send me the account id. | `VITE_CONTRACT_ID` |
| 2 | **Which USDC token** (account id), and **how I get test USDC** for my account (mint method, faucet, or send me some). | `VITE_USDC_ID`. The app reads `ft_balance_of`, `storage_balance_of` and `storage_balance_bounds` on it. |
| 3 | **Register the 2Options contract with the USDC token** (`storage_deposit` for the contract account). | Otherwise `ft_transfer_call` fails inside the token and no deposit reaches `ft_on_transfer`. |
| 4 | **`add_series` for the strike grid.** See the decision in §2 before choosing strikes. | The chain renders whatever `list_series` returns. |
| 5 | **Keeper posting `post_spot`** every ≤10 s for every underlying with a series (`max_spot_age` is 30 s). | Without a fresh spot, `get_account` and `get_vault` return null equity and every trade or LP action reverts with `spot price is stale`. |
| 6 | **Keeper running `settle_funding`** hourly per series. | Funding page and index. |
| 7 | **Seed LP liquidity** (first deposit must be above the 1 USDC locked shares). | With an empty vault, the first trade fails with `vault cannot fund this trade`. |
| 8 | **Agent URL** serving the API in §4, with **CORS** allowing `http://localhost:3001` and the deployed origin. | `VITE_AGENT_URL`. Without it the app shows prices but disables trading, because only your key can sign quotes. |

## 2. Decision needed: the funding formula and the price assume different funding periods

The agent prices with f = 1 hour but charges funding at the daily rate. Using the agent's own model at ETH 3,500 and 60% vol:

| | f = 1 hour (agent today) | f = 1 day |
|---|---|---|
| ATM call price | **$12.06** (0.34% of spot) | $59.07 (1.69% of spot) |
| Funding per hour, `(mark − intrinsic)/24` | **$0.50** | $2.46 |
| Delta-hedged long's gamma P&L, ½ΓσS² per hour | **$3.61** | $0.74 |

Today a hedged long pays $0.50/h and earns about $3.61/h. The vault is the short side and hedges its delta, so it **loses about $3.1/h per ATM contract** at 60% realized vol. It breaks even only below **about 22% realized vol**, against the 60% the price assumes. The 4%/h cap also binds on every OTM series, because `(mark − intrinsic)/mark/24 = 1/24 ≈ 4.17%` there.

The `/24` comes from `FUNDING_PERIODS_PER_DAY = 24` in `core/everlasting.py`, carried over from the Pacifica code.

**Options:**

- **A. Keep f = 1 h.** Funding becomes roughly the full time value per hour, close to 100% of mark for OTM series. `max_funding_rate` is capped at 10% by `validate_params`, so this needs a contract code change.
- **B. Price with f = 1 day and keep `/24` hourly settlement.** Only `set_params` and the agent change:
  - `max_time_value_bps`: 150 is too low, since the band top is $52.50 against a $59 ATM price. Use about 400–500 to leave room for high vol.
  - `max_funding_rate`: 4% is below 4.17%, so use about 5%.
  - Check whether `tv_reserve_bps` (1% of spot) is still enough for the larger time value.
  - Strikes up to about ±10% become meaningful (σ√2d ≈ 4.4%). Under f = 1 h, anything beyond about ±3% prices at roughly $0.

I lean towards **B**: it needs no code change three days before the Nov 13 freeze. Confidence is high that the mismatch is real, since it's the agent's own Γ and funding, and medium on the exact parameter values, so please check them with your model. The frontend reads band, cap and rates from the chain and the agent, so either choice needs no app change.

## 3. Small contract changes

1. **Add `entry_index` to `PositionView`** in `get_account`. It's one field (`entry_index: I128(p.entry_index)`). Without it the app can't show accrued funding per position, and it shows "n/a" today. The handoff (§6) already flagged this.
2. **Funding history.** RPC can't list past `FundingSettled` events cheaply. Either the agent serves `GET /funding/history` (shape in §4), or we use an indexer. For now the app only shows settlements seen while the page is open.

## 4. Agent HTTP API the app codes against

This is your §5 with the units pinned down. All 64/128-bit numbers are decimal strings; errors are non-200 with `{"error": "..."}`.

```
GET /chain
[{ "series": "ETH-3500-C",
   "bid": "11930000", "ask": "12170000", "mark": "12050000",   // USDC micros per contract
   "delta": 0.502, "gamma": 0.0139,                             // plain numbers
   "funding_rate_hourly": "40000000" }]                         // 1e9 fraction of mark, = FundingUpdate.rate

GET /quote?series=ETH-3500-C&side=Buy&size=1000000&taker=aditya.testnet
{ "quote": { "series": "ETH-3500-C", "taker": "aditya.testnet", "side": "Buy",
             "size": "1000000", "price": "12170000", "nonce": "1794268800123456",
             "expiry_ns": "1794268810000000000" },
  "signature": "<base64 of 64-byte ed25519 over sha256(domain ‖ u32le(len(contract)) ‖ contract ‖ borsh(Quote))>" }

GET /spot
{ "ETH": { "price": "350012345678", "ts_ns": "1794268800000000000" } }

GET /funding/history?series=ETH-3500-C&limit=48          (new, for the funding page)
[{ "series": "ETH-3500-C", "epoch": "498408", "rate": "40000000", "mark": "12050000",
   "per_contract": "482000", "index": "...", "ts_ns": "...", "tx_hash": "..." }]

GET /attestation                                          (new, for the badge in #35)
{ "agent_public_key": "ed25519:...", "code_hash": "...", "tee_quote_url": "..." }
```

Quote rules the contract enforces, so the agent needs to follow them:

- `nonce` must exceed the taker's `last_nonce`. A microsecond clock works.
- `expiry_ns` can be at most 10 s past block time when the trade lands. The app stops submitting with less than 0.5 s left.
- `price` must sit in the band computed from the **contract's cached spot**, not the agent's live spot. Quoting near a band edge from a fresher spot can fail with `price is outside the allowed band`.
- It would help to check the vault risk limit before quoting, or to return a `max_size` per series in `/chain`. Otherwise users can get a valid quote that reverts with `vault risk limit reached`.

- **Multi-leg strategies** request one quote per leg, in execution order (buys first), then submit them as one transaction. That needs one wallet confirmation, because limited access keys can only sign single-action transactions. All of it has to fit inside `max_quote_ttl` (10 s), which is tight with a wallet popup. Please raise it to about 30 s (`validate_params` allows up to 60), or add a batch quote endpoint.

The badge checks `agent_public_key` against your `is_agent_key` view and verifies every quote's signature in the browser. That proves each quote comes from the registered key. Publishing `/attestation` (or giving me the key for `VITE_AGENT_PUBLIC_KEY`) turns it on.

### Signing helpers you can use

`agent/twooptions_agent/wire.py` encodes `Quote`, `SpotUpdate` and `FundingUpdate` and signs them. Its tests compare bytes, digests and signatures against `contracts/twooptions/examples/wire_vectors.rs`, which uses your types and runs the signatures through `post_spot` and `settle_funding` on a real `2Options` instance. If your quoter is in Python, import it; if not, the fixture (`agent/tests/fixtures/wire_vectors.json`) is a ready-made test for any language. The app's TypeScript check uses the same fixture.

### Spot feed (#22) and inventory (#24)

- **Spot feed:** `twooptions_agent.spot`. Pyth Hermes now returns 401 without an API key, so the feed takes the median of Coinbase, Kraken, Binance and Hyperliquid. It holds instead of posting when fewer than 2 venues are fresh, when they disagree by more than 50 bps, or on a move your jump limit would refuse; `ts_ns`/`seq` never go backwards. Your keeper only needs to sign and post: `{"update": d.update.to_json(), "signature": sign(key, contract, d.update)}`. If we get a Pyth key, Pyth can be added as a fifth venue.
- **Inventory:** `twooptions_agent.inventory` reads `list_series` + `get_spot`, not events, because `net_trader_size` is already exact on chain. It returns the vault position and delta per series, net delta per underlying, and the perp `hedge_target`, plus `rebalance()` with a deadband. Swap `greeks.everlasting_delta` for #20's pricing when it lands.

Live ETH is about $2,110 (Nov 10), not the $3,500 in the handoff. Strikes should be listed around the real spot.

## 5. Answers to your §9 questions

1. **Shade Agent quickstart:** not run yet (#5). It needs a Phala account and possibly a paid deployment, which I'll set up myself. I'll report the account, keys and cost.
2. **1Click on testnet (#6, done):** 1Click is **mainnet only** (39 chains, no testnet).
   - Quotes, deposit addresses and status work **without an API key**; 1Click then adds its own fee (20 bps on SOL→USDC, 1 bp on Base USDC→USDC).
   - CORS allows any origin, so the app calls it directly. Delivery takes about 22–35 s after the deposit confirms.
   - I deliver USDC to the **user's own NEAR wallet** and then run the normal deposit. 1Click's `customRecipientMsg` could `ft_transfer_call` straight into twooptions, but `ft_on_transfer` credits `sender_id`, which would be the intents contract, not the user.
   - **Decision needed:** where do we demo #33?
     - (a) 2Options on mainnet with small caps;
     - (b) show the swap landing in a mainnet wallet, with the deposit on testnet shown separately;
     - (c) add `msg = "deposit:<account_id>"` to `ft_on_transfer` to credit a named account, which is safe because the sender pays.
3. **Agent API:** keep your §5, with the units and two additions in §4 above.
4. **Wallets:** Meteor, HOT and MyNearWallet are wired in, and the modal loads against testnet RPC. Sign-in also adds a limited key for `trade`, `withdraw`, `lp_request_redeem` and `lp_claim`, so trades sign without a popup inside the 10 s quote window. Deposits still ask the wallet, because they attach 1 yocto.

## 6. Eligibility, before we submit

- **#2 (can we reuse the pricing math?):** you closed the issue on Oct 24 with no comment. My board-setup script reset its status to Todo two minutes later; I've set it back to Done to match. Did the organizers answer? Please put their answer in the issue. Either way we need disclosure wording: `app/src/lib/pricing.ts` and `agent/twooptions_agent/greeks.py` are ports of `core/everlasting.py`.
- **This repo's history starts Oct 23 with the whole Solana project** (201 files). The plan says to submit from a fresh public repo created on Nov 1, without the old history, because judges read the git log. When do we move, and what goes in? `contracts/`, `app/`, `agent/`, the plan and spec docs, and your quoter and keeper.
- **#4 (fixed-point scheme) can be marked Done.** The contract settled it: USDC 1e6, prices 1e8, funding 1e9.
- **The old `ci` workflow's macOS jobs were failing (fixed in ac00e81).** GitHub retired the macOS 14 runner image on Nov 2, 2026, after brownouts that cancelled the Nov 1 runs on `main`. `macos-14` jobs are now refused before they start. The matrix now uses `macos-15`, which is still arm64, and all 7 checks on PR #46 pass. `main` stays red until #46 merges. This workflow only builds the Solana-era the earlier Rust math kernel wheel, so dropping it is still an option.

## 7. What I'm doing next

1. Spikes #3 and #5: testnet account and Shade Agent on Phala. I'll send you my testnet account id for test USDC.
2. Testnet end to end as soon as §1 is done. Nothing in `app/` or `agent/` has run against a deployed contract yet.
3. The TEE half of the badge, once the agent runs as a Shade Agent (#34).
