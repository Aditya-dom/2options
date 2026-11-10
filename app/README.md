# Perennia app (NEAR)

React + Vite frontend for the perennia contract (`contracts/perennia`). It replaces the Solana/Privy frontend in `frontend/`, which is kept for reference only.

```bash
cd app
bun install
bun run dev      # http://localhost:3001
bun test         # units, margin parity with the contract, pricing, trade preview
bun run build    # tsc + vite build
```

## Modes

With no configuration the app runs a **demo**: the contract, agent and market are simulated in the browser, so every screen works before anything is deployed. Set env vars in `app/.env` (see `.env.example`) to point it at testnet.

| `VITE_CONTRACT_ID` | `VITE_AGENT_URL` | Contract | Prices and quotes |
|---|---|---|---|
| unset | (ignored) | in-browser demo (`src/backend/demo.ts`) | local pricing; trades accepted |
| set | set | testnet via RPC + Wallet Selector | Gaurav's agent |
| set | unset | testnet | local pricing for display; **trading disabled** (only the agent can sign quotes) |

`VITE_USDC_ID` is required whenever `VITE_CONTRACT_ID` is set. The app refuses to start half-configured.

The demo mirrors `lib.rs` step by step: same checks, same rounding, same panic strings. It skips only signature verification. Two deliberate differences: funding settles every **2 minutes** instead of hourly, and the LP cooldown is 5 minutes, so both are visible in a demo. State persists in `localStorage`; **RESET DEMO** clears it.

## What works

| Screen | Issue | Notes |
|---|---|---|
| Wallet login | #26 | Meteor, HOT, MyNearWallet. Sign-in adds a function-call key for `trade`, `withdraw`, `lp_request_redeem`, `lp_claim`, so trades sign without a popup inside the 10 s quote window. |
| Deposit / withdraw | #26, #27 | `ft_transfer_call` with 1 yocto and 100 TGas. Withdraw checks USDC storage registration first and offers `storage_deposit`. The max withdrawable amount is computed at the 1.5× initial ratio. |
| Option chain | #28 | Bid, ask, delta, funding per hour. A zero bid is not sellable. |
| Trade ticket | #28 | Indicative price → firm quote with a countdown → `trade(quote, signature)` passed through untouched. A margin preview replays `trade()`'s checks and blocks quotes the contract would reject. Shows instant P&L vs spot. |
| Positions + margin health | #29 | Close value at the bid or ask, the contract's margin value, funding per hour, and health against the 1.15 / 1.30 / 1.50 tiers read from `get_params`. One click closes a position. |
| Funding | #29 | Countdown, per-series rate and index, and settlements observed this session. |
| LP vault | #30 | Equity, share price, vault health, net delta from the agent's deltas, vault book, deposit, redeem, and claim with a cooldown countdown. States that hedge P&L is not in the share price. |
| Strategy builder | #31 | Presets (straddle, strangle, spreads, risk reversal, short strangle) and editable legs. Shows net debit or credit, funding per hour, net delta and gamma, package margin, and P&L vs spot now and after a day of funding. All legs execute in **one transaction** (a `trade` action per leg, buys first), so every leg fills or none does. A batch needs one wallet confirmation, because limited access keys sign single-action transactions only. |
| Deposit from another chain | #33 | SOL, ETH, USDC (Solana, Ethereum, Base, Arbitrum) and BTC through NEAR Intents 1Click. Swaps to native USDC in the user's NEAR wallet, then offers a one-click deposit. Live quotes in every mode. A real deposit address is only issued on a mainnet deployment using native USDC, because 1Click is mainnet only. Pending swaps survive reloads. |
| Agent badge | #35 | Every quote is verified in the browser (same digest as the contract) against the agent key, and the key against `is_agent_key`. Quotes from any other key are refused. The TEE code hash and quote show once `/attestation` provides them (#34). |

Contract errors are mapped to plain messages in `src/lib/errors.ts`. Every receipt is checked, not just the transaction status, because a refused `ft_on_transfer` does not fail the outer `ft_transfer_call`.

## Layout

```
src/
  lib/units.ts        fixed-point parse/format (bigint end to end; floats only for charts)
  lib/margin.ts       TypeScript port of math.rs + margin.rs; parity-tested against the Rust code
  lib/preview.ts      pre-trade margin replay of trade()
  lib/pricing.ts      everlasting series (50 terms, half weights), greeks
  lib/contract.ts     view types and parsing (mirrors types.rs)
  lib/wire.ts         borsh + digest + ed25519 check of agent quotes; parity-tested against the contract
  lib/strategies.ts   strategy presets relative to the ATM strike
  lib/oneclick.ts     NEAR Intents 1Click client
  backend/chain.ts    RPC views + wallet transactions
  backend/demo.ts     in-browser contract + simulated market
  backend/agent.ts    HTTP agent client + local pricing agent
  hooks/useProtocol   one polling loop all screens read from; send() for transactions
```

### Margin parity

`src/lib/fixtures/margin_vectors.json` is generated from the contract's own code:

```bash
cd contracts/perennia
cargo run --example margin_vectors > ../../app/src/lib/fixtures/margin_vectors.json
```

`margin.test.ts` checks 160 random portfolios (up to 6 legs over 4 underlyings, two parameter sets) plus 120 rounding cases. Regenerate the fixture whenever `margin.rs` or `math.rs` changes.

## Agent API the app codes against

This is HANDOFF §5, with the units pinned down. Gaurav, please confirm or change these.

```
GET /chain
[{ "series": "ETH-3500-C", "bid": "11930000", "ask": "12170000", "mark": "12050000",
   "delta": 0.502, "gamma": 0.0139, "funding_rate_hourly": "40000000" }]
   bid/ask/mark: USDC micros per contract. funding_rate_hourly: 1e9-scaled fraction of mark
   (same scale as FundingUpdate.rate).

GET /quote?series=ETH-3500-C&side=Buy&size=1000000&taker=alice.testnet
{ "quote": { "series", "taker", "side", "size", "price", "nonce", "expiry_ns" }, "signature": "<base64>" }

GET /spot
{ "ETH": { "price": "350012345678", "ts_ns": "1794268800000000000" } }

GET /attestation
{ "agent_public_key": "ed25519:...", "code_hash": "...", "tee_quote_url": "..." }
```

CORS must allow the app's origin. `VITE_AGENT_PUBLIC_KEY` can pin the key instead of trusting `/attestation`.

## Open asks for the contract and agent

1. **`entry_index` in `get_account` positions.** This would let the app show accrued funding per position. The demo already exposes it, and the app shows "n/a" without it.
2. **Funding history.** RPC cannot list past `FundingSettled` events cheaply. Either `GET /funding/history` on the agent, or an indexer.
3. **Strike grid.** With hourly funding, strikes more than about 3% from spot price at about $0 (the effective life is about 2 hours). The demo uses ±3% in $50 steps.
4. **The funding formula and the price assume different funding periods.** The price uses f = 1 h ($12.06 ATM), but `(mark − intrinsic)/24` per hour is the daily-funding rate. A delta-hedged long earns ½ΓσS² ≈ $3.6/h at 60% realized vol and pays $0.50/h, so the vault breaks even only below about 22% realized vol. The 4%/h cap also binds on every out-of-the-money series, since 1/24 > 4%. Fixing this means choosing f and then resizing the contract's `max_funding_rate` and `max_time_value_bps` (an f = 1 day ATM price of $59 is above the current $52 band).

5. **Quote TTL for multi-leg trades.** All legs must be quoted, then confirmed in the wallet, inside the 10 s `max_quote_ttl`. Raising it to about 30 s (`validate_params` allows up to 60 s) or adding a batch quote endpoint would make strategies practical.

## Not done yet

- TEE attestation in the badge waits on the Shade Agent (#5, #34).
- NEP-245 position transfer. The contract does not mint position tokens yet.
- Nothing has been run against a deployed contract or a live agent yet.
