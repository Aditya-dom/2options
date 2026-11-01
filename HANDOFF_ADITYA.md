# Handoff for Aditya

Status as of Nov 2, 2026. The hackathon build window runs Nov 1 to Nov 14 (submission closes Nov 14, 23:59 UTC).

You own the **frontend and the integrations** (cross-chain deposit, verification badge). Gaurav owns the contract, the pricing agent and the hedge. This file tells you what exists, what you can build against today, and what is not ready yet.

Open `near-board.html` in a browser for the full issue board. Your issues are the ones assigned to Aditya.

---

## 1. What we are building

An options venue on NEAR where the **contract holds the money** and an **agent signs the prices**.

```
Trader ──ask for price──▶ Agent (signs quote) ──signed quote──▶ Trader
Trader ──submit signed quote──▶ perennia contract (verifies, settles, tracks margin)
Agent ──every ~10s──▶ post_spot        Agent ──hourly──▶ settle_funding
Agent ──reads vault delta──▶ hedges on Hyperliquid testnet
```

The options are **everlasting**: no expiry. The buyer pays a small funding amount every hour instead. On ETH at 3,500 with 60% volatility, an at-the-money call costs about **$12**, has delta 0.5, and pays about $0.50 per hour in funding. Prices are small compared with spot, which matters for how the UI formats numbers.

Why the vault hedges: when a trader buys a call, the vault is short it. Hedging with a perp removes the vault's bet on price direction, so LPs earn the spread and funding instead. Background in `NEAR_HACKATHON_PLAN.md`.

---

## 2. What is done

| Item | Where | State |
|---|---|---|
| Plan, architecture diagrams, scope tiers | `NEAR_HACKATHON_PLAN.md` | Written |
| Contract interface spec (v0) | `NEAR_CONTRACT_SPEC.md` | Written. Where the code differs, `contracts/README.md` wins |
| **The contract** | `contracts/perennia/` | Written. 70 unit tests pass, clippy clean, builds to a ~530 KB wasm |
| Hyperliquid hedging check | scratch script, results below | Signing scheme verified. No real order yet |
| Issue board | `near-board.html` | Done. Saves in your browser only |
| GitHub issues script | `scripts/create_github_board.mjs` | Written, not run (`gh` was not installed) |

**What the contract does:** holds USDC; trader collateral and an LP vault with shares; trades settled against agent-signed quotes; margin for traders and for the vault; hourly funding; liquidation; owner controls and pause.

**Not done yet (do not build assuming these exist):**
- No agent service, so there is **no price server yet**. Nothing signs quotes.
- Nothing is deployed. No testnet contract address exists yet.
- No sandbox integration tests and no gas numbers.
- No hedge loop. No NEAR Intents deposit. No TEE (Shade Agent).
- Positions are not NEP-245 tokens and cannot be transferred.

---

## 3. Your tasks, in order

### Now: setup and spikes (issues #3, #5, #6)
1. Create a NEAR **testnet** account and fund it from the faucet. Send Gaurav the account id.
2. Run the Shade Agent quickstart on Phala and note what you needed (account, keys, cost). Tell us early if it is a blocker.
3. Get one test quote from the NEAR Intents **1Click API** sandbox. Write down which chains and tokens worked on testnet, if any.

### Then: the frontend (issues #26 to #31)
Make a new Vite + React app. Reuse from the old frontend (`frontend/src`), replace the wallet layer.

**Keep and adapt:** `OptionChainPanel`, `OrderPanel`, `StrategyBuilder`, `PayoffDiagram`, `FundingPanel`, `ChartPanel`, `CollateralPanel`, `Select`, `ConfirmDialog`, plus the hooks `useOptions`, `usePositions`, `useFunding`, `useMarket`.

**Replace:** `lib/privy.tsx`, `hooks/useAuth.ts`, `useWalletSetup.ts`, `useSolanaDeposit.ts`, `useWalletBalance.ts`, `useSolBalance.ts`, `components/DepositWithdrawDialog.tsx`, and the Solana wording in `TradeHeader.tsx` and `LandingPage.tsx`. Use **NEAR Wallet Selector**. Dependencies on `@solana/*` and `@privy-io/*` go away.

Screens to deliver: wallet login; deposit and withdraw; option chain with price, delta and funding; trade ticket with quote countdown; positions with margin health; funding history; LP vault page (deposit, share price, redeem, claim).

### Later: integrations (issues #33, #35)
- Deposit from another chain using 1Click, arriving as USDC in the contract.
- A verification badge showing the agent's code hash and TEE attestation, once the Shade Agent is deployed.

**Checkpoint:** by **Nov 8**, deposit, trade, funding and withdraw should work end to end on testnet. If that slips, we drop the later items first.

---

## 4. Contract cheat sheet for the frontend

Source of truth: `contracts/perennia/src/lib.rs` and `types.rs`. Full detail in `contracts/README.md`.

**JSON rules:** every 64-bit and 128-bit number is a **string** (`"12000000"`). Enums are plain strings (`"Buy"`, `"Call"`, `"ETH"`).

### Units
| What | Scale |
|---|---|
| USDC balance, premium, option price, mark | 6 decimals. `"12000000"` = 12 USDC. Prices are per contract |
| Spot and strike | 8 decimals. `"350000000000"` = $3,500 |
| Position size | 6 decimals per contract, signed. `"1000000"` = 1 contract, negative = short |
| Funding index | USDC micros per contract, cumulative |
| Time | nanoseconds |

### Series ids
`ETH-3500-C`, `ETH-3500-P`, `ETH-4000-C`. Format `UNDERLYING-STRIKE_USD-C|P`. Get them from `list_series()`.

### Calls
| Action | How |
|---|---|
| Deposit collateral | On the **USDC token**: `ft_transfer_call({receiver_id: <contract>, amount, msg: "deposit"})`, attach **1 yoctoNEAR**, give plenty of gas (start at 100 TGas) |
| Become an LP | Same call with `msg: "lp"` |
| Trade | On the contract: `trade({quote, signature})` |
| Withdraw | `withdraw({amount})`. Pays the caller only |
| Redeem LP shares | `lp_request_redeem({shares})`, then `lp_claim()` after the cooldown |

`quote` is `{series, taker, side, size, price, nonce, expiry_ns}`. `signature` is a base64 string. **You never build these yourself.** The agent returns both, and you pass them straight through. The quote expires within about **10 seconds**, so show a countdown and submit fast.

### Views (free to call)
| View | Returns |
|---|---|
| `get_account({account_id})` | `collateral`, `positions[]`, `equity`, `requirement` (equity and requirement can be `null` when spot is stale) |
| `list_series()` / `get_series({series})` | id, strike, kind, `funding_index`, `last_mark`, `net_trader_size`, `active` |
| `get_vault()` | `cash`, `total_shares`, `pending_claims`, `insurance`, `equity`, `requirement` |
| `get_lp_shares({account_id})`, `get_lp_claim({account_id})` | LP balance and pending claim with unlock time |
| `get_spot({underlying})` | latest spot and its timestamp |
| `get_params()` | all limits (ratios, band, fees) |
| `get_solvency()` | sanity check for the demo |

**Margin health for the UI:** ratio = `equity / requirement`. Show healthy above 1.5, close-only 1.3 to 1.5, liquidatable below 1.15. These come from `get_params()` (`initial_ratio_bps`, `close_only_ratio_bps`, `liquidation_ratio_bps`).

### Errors to show nicely
The contract panics with readable text. Map these to friendly messages:

| Contract message | Meaning for the user |
|---|---|
| `quote expired` / `nonce already used` | Get a fresh quote |
| `insufficient margin for this trade` | Deposit more or reduce size |
| `vault risk limit reached` | The vault cannot take more risk right now |
| `spot price is stale` | Prices are paused, try again shortly |
| `price is outside the allowed band` | Should not happen with a real agent. Report it |
| `withdrawal would leave the account under-margined` | Close or reduce positions first |
| `trading is paused` / `deposits are paused` | Show a banner |

### Events
The contract logs `EVENT_JSON:{"standard":"perennia",...}`. Events: `Deposit`, `Withdraw`, `Trade`, `FundingSettled`, `FundingApplied`, `SpotUpdated`, `Liquidation`, `LpMint`, `LpRedeemRequest`, `LpClaim`.

---

## 5. The agent HTTP API (proposed, not built yet)

Gaurav builds the agent next. This is the shape the frontend can code against now. Tell Gaurav if you want something different.

| Request | Response |
|---|---|
| `GET /chain` | Per series: `series`, `bid`, `ask`, `mark`, `delta`, `gamma`, `funding_rate_hourly`, all in the units above |
| `GET /quote?series=ETH-3500-C&side=Buy&size=1000000&taker=aditya.testnet` | `{ quote: {...}, signature: "<base64>" }` |
| `GET /spot` | Latest spot per underlying |

Until the real agent exists, mock these responses so you can build the screens. A mocked quote will **not** pass the contract's signature check, so a real trade needs Gaurav's agent.

---

## 6. Facts that affect your UI

- **Prices are small.** An ATM call is about 0.35% of spot. Far out-of-the-money strikes price at about $0.00 because everlasting options effectively live about 2 hours. Format with enough decimals and do not treat `$0.00` as an error.
- **Funding accrues continuously but is only applied when an account is touched.** The `positions` view shows the current mark value, not accrued funding. If you want to show accrued funding, compute `size × (series.funding_index − entry_index)`, which needs `entry_index` added to the view. Ask Gaurav.
- **A short needs margin.** Selling an ATM call needs roughly $1,100 of collateral per contract at ETH 3,500.
- **Hedge profit and loss is not in the LP share price.** State that plainly in the UI copy and README.

---

## 7. Hedging check (for context)

- Hyperliquid testnet has BTC, ETH, SOL and NEAR perps.
- NEAR's testnet signer contract is live and derives secp256k1 keys.
- A raw ECDSA signature over the 32-byte digest (the kind NEAR's MPC signer produces) was matched byte for byte against Hyperliquid's own SDK signature, and Hyperliquid's testnet recovered the right signer address from it. It then rejected the order only because that throwaway address has no account.
- Not yet checked: a real MPC signature, funding a Hyperliquid testnet account, and a real order. That is Gaurav's spike.

---

## 8. Working agreements

- Everything counts only if it is in the repo and was written Nov 1 to Nov 14. Commit in small pieces.
- Never commit private keys, seed phrases or `.env` files.
- The contract builds with `cd contracts/perennia && cargo test --lib`. If linking fails with `libSystem.tbd`, export `SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk` first.
- Ask early if anything in the contract's API makes the UI painful. Changing the contract is cheap now and expensive after Nov 8.

## 9. Questions we need your answer on

1. Is the Shade Agent quickstart workable for you on your machine and budget?
2. Which 1Click flows work on testnet, and which only on mainnet?
3. Do you want the agent API changed from section 5?
4. Which wallets do you want to support first (Meteor, HOT, MyNearWallet)?
