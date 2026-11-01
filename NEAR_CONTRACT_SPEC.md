# Perennia on NEAR: Contract Interface Spec (draft v0)

Covers board issues #4 (fixed-point scheme) and #7 (contract interface spec).
Docs only. No contract code is written until the build window opens on Nov 1.

Companion to [NEAR_HACKATHON_PLAN.md](NEAR_HACKATHON_PLAN.md). Items marked **OPEN** need a decision before Nov 1; they are collected in section 11.

---

## 1. Fixed-point scheme

No floats anywhere in the contract. The old Postgres schema stored money as floats; do not carry that over.

| Quantity | Type | Scale | Example |
|---|---|---|---|
| USDC amount (collateral, premium, PnL) | `u128` / `i128` | 1e6 (native USDC decimals) | 1.5 USDC = `1_500_000` |
| Underlying spot / strike price | `u128` | 1e8 | ETH $3,500 = `350_000_000_000` |
| Option price per contract | `u128` | 1e6 (USDC micros per 1 contract) | $142.30 = `142_300_000` |
| Position size | `i128` | 1e6 (1 contract = `1_000_000`), long > 0, short < 0 | 0.25 contract = `250_000` |
| Funding rate per hour | `i128` | 1e9 (fraction of mark) | 1% = `10_000_000` |
| Cumulative funding index | `i128` | 1e9 | sum of hourly rates |
| Basis points (fees, margin rates) | `u32` | 1e4 | 15% = `1500` |
| Timestamps | `u64` | nanoseconds (NEAR block time) | `env::block_timestamp()` |

**Core formula.** Cost of a trade in USDC micros:

```
cost = price_per_contract * |size| / 1e6
```

Largest intermediate: `1e12 (price) * 1e12 (size at 1e6 scale, 1M contracts) = 1e24`, far below `i128::MAX` (~1.7e38). Use `checked_mul`/`checked_div` everywhere and panic on overflow.

**Rounding.** Always round in favour of the vault: premiums paid by the trader round up, premiums paid to the trader round down, margin requirements round up, withdrawals round down.

**Quote price cap.** `price_per_contract` is capped at `MAX_PRICE = 10 * spot_in_usdc_micros`, so a bad quote cannot overflow downstream math.

---

## 2. Identifiers

- **Series (token) id** is a string: `"{UNDERLYING}-{STRIKE_USD}-{C|P}"`, for example `ETH-3500-C`. There is no expiry because the options are everlasting.
- Underlyings for v1: `BTC`, `ETH`, `SOL`, `NEAR`.
- Each series id is a NEP-245 `token_id` on `perennia.near`.
- The **agent** is an ed25519 public key registered in the contract. Only quotes and funding updates signed by an active agent key are accepted.

---

## 3. Storage

```rust
pub struct Perennia {
    owner: AccountId,                       // multisig or DAO later
    usdc: AccountId,                        // NEP-141 token contract
    agent_contract: Option<AccountId>,      // Shade Agent contract (optional in v1)
    agent_keys: UnorderedSet<[u8; 32]>,     // active quote/funding signers
    params: Params,

    accounts: LookupMap<AccountId, Account>,
    series: UnorderedMap<String, Series>,
    positions: LookupMap<(AccountId, String), Position>,   // NEP-245 balance mirror
    used_nonces: LookupSet<(AccountId, u64)>,              // per taker

    vault: Vault,
    insurance: u128,
    spot: LookupMap<Underlying, SpotPoint>,                // cached oracle price
}

pub struct Account {
    collateral: u128,                       // free USDC balance, 1e6
    open_series: Vec<String>,               // max 16
    status: AccountStatus,                  // Healthy | CloseOnly
}

pub struct Position {
    size: i128,                             // 1e6, signed
    entry_funding_index: i128,              // snapshot for lazy funding settlement
    avg_price: u128,                        // 1e6, for PnL display only
}

pub struct Series {
    underlying: Underlying,
    strike: u128,                           // 1e8
    kind: Kind,                             // Call | Put
    funding_index: i128,                    // cumulative, 1e9
    last_mark: u128,                        // 1e6, from last funding update
    last_funding_ts: u64,
    open_interest_long: u128,
    open_interest_short: u128,
    active: bool,
}

pub struct Vault {
    total_assets: u128,                     // USDC the vault owns, 1e6
    total_shares: u128,                     // pUSDC, 1e6
    net_delta: i128,                        // informational, posted by agent
}

pub struct SpotPoint { price: u128 /*1e8*/, ts: u64 }

pub struct Params {
    max_quote_ttl_ns: u64,                  // 10 s
    max_spot_age_ns: u64,                   // 30 s
    max_positions: u8,                      // 16
    max_funding_rate: i128,                 // 40_000_000 = 4% per hour
    funding_interval_ns: u64,               // 1 h
    keeper_reward_bps: u32,                 // paid from fees
    liquidation_reward_bps: u32,            // 50 = 0.5% of closed notional
    lp_cooldown_ns: u64,                    // withdrawal delay
    min_lp_liquidity: u128,                 // shares locked at first deposit
}
```

The vault is the counterparty to every trade. Trader long = vault short, and the reverse.

---

## 4. Signed messages

### 4.1 Quote (RFQ)

```rust
pub struct Quote {
    series: String,
    taker: AccountId,        // must equal env::predecessor_account_id()
    side: Side,              // Buy | Sell, from the taker's view
    size: u128,              // 1e6, always positive
    price: u128,             // USDC micros per contract
    spot: u128,              // 1e8, agent's spot at signing
    nonce: u64,
    expiry_ns: u64,
}
```

**Signed bytes** (domain separation prevents replay across contracts, networks, versions):

```
msg = sha256( "perennia:quote:v1" || contract_account_id || borsh(Quote) )
```

Verification: `env::ed25519_verify(&sig, &msg, &pubkey)` where `pubkey` must be in `agent_keys`.

### 4.2 Funding update

```rust
pub struct FundingUpdate {
    series: String,
    epoch: u64,              // floor(timestamp / funding_interval), strictly increasing per series
    rate: i128,              // 1e9, signed, capped by params.max_funding_rate
    mark: u128,              // 1e6, mark price for this epoch
    spot: u128,              // 1e8
    delta: i128,             // vault net delta, informational
}
msg = sha256( "perennia:funding:v1" || contract_account_id || borsh(FundingUpdate) )
```

---

## 5. Public interface

### 5.1 Funds in and out

| Method | Caller | Behaviour |
|---|---|---|
| `ft_on_transfer(sender_id, amount, msg)` | `usdc` only | `msg = "deposit"` credits the sender's `collateral`. `msg = "lp"` mints pUSDC shares. Any other message refunds the full amount. |
| `withdraw(amount)` | trader | Requires post-withdraw margin check passes. Then `ft_transfer` out and refund collateral if the transfer fails (callback). |
| `lp_request_redeem(shares)` | LP | Burns shares into a pending claim at the current share price. |
| `lp_claim()` | LP | Pays out after `lp_cooldown_ns`, limited to free vault cash. |

**LP share price** = `total_assets * 1e6 / total_shares`. First deposit locks `min_lp_liquidity` shares permanently to block the share-inflation attack.

### 5.2 Trading

| Method | Caller | Behaviour |
|---|---|---|
| `trade(quote, signature, max_price_slippage_bps)` | taker | See 5.2.1 |
| `close_position(series, size, quote, signature)` | taker | Same as `trade` with the opposite side, size capped to the open position. |

#### 5.2.1 `trade()` checks, in order

1. `predecessor == quote.taker`.
2. `block_timestamp <= quote.expiry_ns` and `quote.expiry_ns - block_timestamp <= max_quote_ttl_ns`.
3. Nonce not used. Record it.
4. Signature valid, signer in `agent_keys`.
5. Series exists and is active. Account has fewer than 16 open series, or already holds this one.
6. Cached `spot[underlying]` is no older than `max_spot_age_ns`. Quote `spot` is within 1% of it (see section 11, open question 2).
7. Price band: `intrinsic <= price <= intrinsic + spot_in_usdc * max_time_value_bps / 1e4`, and `price <= MAX_PRICE`.
8. Taker's slippage limit holds.
9. Settle accrued funding on the position (section 6), then apply the trade: debit or credit collateral by `cost`, update `Position`, update vault assets and open interest.
10. Margin check on the taker after the trade (section 7). Fail means revert.
11. Mint or burn the NEP-245 balance, emit `Trade`.

### 5.3 Keeper methods (anyone can call)

| Method | Behaviour |
|---|---|
| `poke_oracle(underlying)` | Cross-contract call to the price oracle, stores `SpotPoint`. Reverts if the oracle price is older than the oracle's own staleness limit. |
| `settle_funding(update, signature)` | Verifies signature and `epoch > last_epoch`. Clamps `rate` to `±max_funding_rate`. Adds to `funding_index`, stores `last_mark`. Pays `keeper_reward_bps` of the epoch's funding fees to the caller. |
| `liquidate(account_id, series)` | Reverts unless the account is below the liquidation tier (section 8). Closes at `last_mark` and pays the liquidator. |

### 5.4 Admin

| Method | Caller | Behaviour |
|---|---|---|
| `add_series(underlying, strike, kind)` | owner | Registers a new series id. |
| `set_agent_key(pubkey, active)` | owner, or the Shade Agent contract | Adds or revokes a signer. |
| `set_params(params)` | owner | Bounded: rate cap never above 10%, position cap never above 32. |
| `pause(bool)` | owner | Blocks `trade`, `deposit`, `lp` and keeps `withdraw` and `liquidate` open. |

### 5.5 NEP-245 and views

Standard `mt_transfer`, `mt_batch_transfer`, `mt_balance_of`, `mt_tokens_for_owner`. **A transfer must run the margin check on both sides**: the sender after losing the position, the receiver after gaining it. Transfers of short positions are only allowed to accounts that pass margin with the extra liability.

Views: `get_account(id)`, `get_margin(id)` (equity, requirement, ratio, tier), `get_series(id)`, `get_vault()`, `get_params()`, `get_spot(underlying)`, `is_agent_key(pubkey)`.

---

## 6. Funding

Hourly, per series. The agent computes the rate off-chain with the existing everlasting funding formula and posts it. The contract caps it.

For a position `size` (signed) with entry index `i0` and current index `i1`:

```
funding_payment = size * last_mark / 1e6 * (i1 - i0) / 1e9
```

Positive result means the position pays. It is applied lazily on the next touch (trade, withdraw, transfer, liquidation), then the position's `entry_funding_index` is reset to `i1`. The vault takes the other side, so `total_assets` moves by the opposite amount.

**v1 trusts the attested agent for `rate` and `mark`**, bounded by the cap. **v2** (after the hackathon) recomputes the rate from an on-chain TWAP of marks.

---

## 7. Margin (v1, shock-based, no Black-Scholes on chain)

Pricing stays off-chain. The contract values positions with integer-only intrinsic values and a reserve:

```
for each shock s in { -20%, -10%, +10%, +20% }:
    shocked_spot  = spot * (1 + s)
    value_change  = Σ over positions of size * ( intrinsic(shocked_spot) - intrinsic(spot) ) / 1e6
    scenario_loss = max(0, -value_change)
requirement = max over scenarios of scenario_loss  +  time_value_reserve
time_value_reserve = Σ over short positions of |size| * spot_usdc * tv_reserve_bps / 1e4
```

`intrinsic` is `max(spot - strike, 0)` for calls and `max(strike - spot, 0)` for puts, converted to USDC micros per contract.

- Long options are paid for in full at trade time, so a long-only account needs no margin beyond what is paid.
- A floor of `min_margin_per_contract` applies to every short contract.
- At most 16 positions times 4 scenarios, so the cost is bounded.
- `equity = collateral + Σ size * (last_mark - avg_price) / 1e6` (mark-to-market, funding already settled).
- **Passes** when `equity >= requirement`.

Intrinsic-only shocks ignore time value, so a short option whose price is mostly time value looks cheaper to hold than it is. The reserve covers that gap. **OPEN** (question 3): calibrate the shocks and `tv_reserve_bps` against the Rust 12-scenario model in `perennia_math/` by backtesting before Nov 5.

---

## 8. Liquidation tiers

`ratio = equity / requirement` (open question 4 on definition).

| Ratio | Tier | Effect |
|---|---|---|
| above 1.50 | Healthy | normal |
| 1.30 to 1.50 | Warning | UI warning only |
| 1.15 to 1.30 | Close-only | `trade` allowed only if it reduces the requirement |
| below 1.15 | Liquidatable | anyone may call `liquidate` |

Liquidation closes all positions at `last_mark`, pays the liquidator `liquidation_reward_bps` of closed notional (capped by remaining equity), and sends any shortfall to `insurance`, then to the LP vault if `insurance` is empty. Emit `Liquidation` and `ShortfallCovered`.

---

## 9. Events (NEP-297, `standard = "perennia"`, `version = "1.0.0"`)

`Deposit{account, amount}`, `Withdraw{account, amount}`, `LpMint{account, amount, shares}`, `LpRedeemRequest{account, shares}`, `LpClaim{account, amount}`, `Trade{taker, series, side, size, price, nonce}`, `FundingSettled{series, epoch, rate, mark, index}`, `FundingApplied{account, series, amount}`, `Liquidation{account, series, closed_notional, reward, shortfall}`, `SeriesAdded{series}`, `AgentKeySet{pubkey, active}`, `OracleUpdated{underlying, price, ts}`. Plus the standard `mt_mint`, `mt_burn`, `mt_transfer` events.

---

## 10. Test plan (near-workspaces)

1. Deposit, withdraw, and a refund on a bad `ft_on_transfer` message.
2. `trade` rejects: wrong taker, expired quote, reused nonce, bad signature, unknown signer, stale spot, price outside the band, over-leveraged.
3. Buy then sell round trip returns collateral minus spread.
4. Funding: index math over several epochs, rate clamp, a missed epoch, an out-of-order epoch.
5. Lazy funding settles correctly across a transfer.
6. Liquidation at each tier boundary, shortfall to insurance, then to the vault.
7. LP: first-deposit lock, share price after a profit and a loss, cooldown, redeem larger than free cash.
8. Rounding: a million tiny trades never move `total_assets` in the trader's favour.
9. Gas: worst case account (16 positions) `trade` and `liquidate` stay under 200 TGas.

---

## 11. Open questions (decide before Nov 1)

| # | Question | Recommendation |
|---|---|---|
| 1 | Is a TEE required for v1, or may the agent key be a plain key until the Shade Agent works? | Plain key first, behind `set_agent_key`, so the contract does not depend on Shade timing. |
| 2 | Spot: trust the agent's signed `spot`, or require a cached oracle value? | Cache via permissionless `poke_oracle`, require the quote `spot` within 1% of it. Costs one extra keeper call every ~10 s. |
| 3 | Margin calibration: how closely must on-chain margin match the 12-scenario Rust model? | Backtest the 4-shock version against it. If worse than 10% off, add two vol scenarios. |
| 4 | Exact definition of the tier ratio (equity over requirement vs. equity over notional). | Equity over requirement as in section 8. Revisit after backtest. |
| 5 | Who owns `perennia.near`: your account, or a multisig? | Your account for the hackathon, noted in the README as a trust assumption. |
| 6 | Collateral token: native USDC on NEAR only, or accept any token through Intents? | USDC only in the contract. Intents swaps into USDC before it arrives. |
| 7 | Do shorts transfer? | Allow, with the receiver margin check. If it complicates tests, disable short transfers in v1. |
| 8 | Reuse of the Perennia pricing math (organizer question, issue #2). | Disclose as prior work, or rewrite. Not needed in the contract either way, since pricing is off-chain. |
