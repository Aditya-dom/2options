# Handoff for Gaurav

From Aditya, Nov 10, 2026. This replies to `HANDOFF_ADITYA.md`. The frontend is on branch `aditya/near-frontend`, in `app/` (see `app/README.md`).

## Where the frontend is

Issues #26–#30 are built and running against an in-browser copy of the contract. Run `cd app && bun install && bun run dev`, then open http://localhost:3001 with no `.env`. That gives you a demo: deposit, trade, positions and margin health, funding, and the LP vault.

The demo copies `trade`, `withdraw`, `lp_*` and `apply_funding` from `lib.rs` step by step: same checks, same rounding, same panic strings. It skips only the signature check. The margin code is a TypeScript port that matches `margin.rs`/`math.rs` exactly on 2,697 cases generated from your code (`contracts/perennia/examples/margin_vectors.rs`, a new example file; the wasm build is untouched). The trade ticket uses it to show margin before signing and to block trades the contract would reject.

Nothing has been tested on testnet, because nothing is deployed. Pointing the app at testnet takes three env vars. Everything below is what I need for that.

---

## 1. Blocking: needed before deposit → trade → funding → withdraw works on testnet

| # | What | Why the app needs it |
|---|---|---|
| 1 | **Deploy `perennia` to testnet** and send me the account id. | `VITE_CONTRACT_ID` |
| 2 | **Which USDC token** (account id), and **how I get test USDC** for my account (mint method, faucet, or send me some). | `VITE_USDC_ID`. The app reads `ft_balance_of`, `storage_balance_of` and `storage_balance_bounds` on it. |
| 3 | **Register the perennia contract with the USDC token** (`storage_deposit` for the contract account). | Otherwise `ft_transfer_call` fails inside the token and no deposit reaches `ft_on_transfer`. |
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

I lean towards **B**: it needs no code change four days before the freeze. Confidence is high that the mismatch is real, since it's the agent's own Γ and funding, and medium on the exact parameter values, so please check them with your model. The frontend reads band, cap and rates from the chain and the agent, so either choice needs no app change.

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

The attestation badge will check `agent_public_key` against your existing `is_agent_key` view, so it proves the key that signs quotes is the registered one.

## 5. Answers to your §9 questions

1. **Shade Agent quickstart:** I haven't run it yet (#5). It's my next task, and I'll report the account, keys and cost.
2. **1Click on testnet:** not tried yet (#6). Also next.
3. **Agent API:** keep your §5, with the units and two additions in §4 above.
4. **Wallets:** Meteor, HOT and MyNearWallet are wired in. Sign-in also adds a limited key for `trade`, `withdraw`, `lp_request_redeem` and `lp_claim`, so trades sign without a popup inside the 10 s quote window. Deposits still ask the wallet, because they attach 1 yocto.

## 6. Eligibility, before we submit

- **#2 is still open on the board**: did the organizers say the pricing math can be reused? The app's `app/src/lib/pricing.ts` is a TypeScript port of `core/everlasting.py`, so it needs the same disclosure.
- **This repo's history starts Oct 23 with the whole Solana project** (201 files). The plan says to submit from a fresh public repo created on Nov 1, without the old history, because judges read the git log. When do we move, and what goes in? `contracts/`, `app/`, the plan and spec docs, and the agent once it exists.
- **#4 (fixed-point scheme) can be marked Done.** The contract settled it: USDC 1e6, prices 1e8, funding 1e9.

## 7. What I'm doing next

1. Spikes #3, #5, #6: testnet account, Shade Agent on Phala, 1Click quote. I'll send you my testnet account id for test USDC.
2. Testnet end to end as soon as §1 is done.
3. #33 (1Click deposit), #35 (attestation badge), #31 (strategy builder), in that order.
