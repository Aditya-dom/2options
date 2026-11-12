# 2Options app (NEAR)

React + Vite frontend for the 2Options contract (`contracts/twooptions`). It replaces our earlier Solana/Privy frontend (see the README's prior-work section).

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
| Funding | #29 | Countdown, per-series rate and index, and recent settlements: from the agent's `/funding/history` when there is one, otherwise those observed this session. |
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
cd contracts/twooptions
cargo run --example margin_vectors > ../../app/src/lib/fixtures/margin_vectors.json
```

`margin.test.ts` checks 160 random portfolios (up to 6 legs over 4 underlyings, two parameter sets) plus 120 rounding cases. Regenerate the fixture whenever `margin.rs` or `math.rs` changes.

## Agent API

The quote server is `agent/twooptions_agent/server.py`; `agent/README.md` documents every endpoint. The app uses `/chain`, `/quote`, `/spot`, `/attestation` and `/funding/history` (loaded once, so the Funding page shows past settlements). Run it with `make near-agent` and set `VITE_AGENT_URL=http://localhost:8787`. The agent allows the origins in its `TWOOPTIONS_CORS_ORIGINS`. `VITE_AGENT_PUBLIC_KEY` can pin the key instead of trusting `/attestation`.

## Open items between the app and the agent

1. **Local pricing still uses the old model.** `src/lib/pricing.ts` (demo mode, payoff charts, and the chain fallback when no agent is configured) prices with half weights at an hourly period, about $12 at the money on ETH 3,500. The agent prices with weights `c(1-c)^(n-1)`, `c = 1/24`, hourly, about $39, because that is what `(mark - intrinsic) / 24` per hour is worth (`agent/README.md`, "Pricing"). In chain mode with an agent every price on screen is the agent's, so the two only disagree in demo mode and in the charts. Porting it is a change to the weights in `everlasting()` plus the demo's strike grid and copy ("lives about 2 hours" becomes about a day).
2. **Demo parameters.** `demoParams()` mirrors the contract defaults (4% cap, 150 bps band, 10 s TTL). Testnet runs the preset in `contracts/README.md` ("Deploying"). The app reads all of them from `get_params`, so only the demo differs.
3. **Strike grid.** With an average life of a day, strikes out to about ±5% carry a visible premium. Bootstrap lists the at-the-money strike and two either side in steps of about 2.5% of spot.

## Not done yet

- TEE attestation in the badge waits on the Shade Agent (#5, #34).
- NEP-245 position transfer. The contract does not mint position tokens yet.
- Nothing has been run against a deployed contract or a live agent yet. The agent, the keeper and the deploy tooling now exist (`agent/`); testnet needs someone with a funded account to run `make near-bootstrap`.
