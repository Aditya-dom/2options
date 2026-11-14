# 2Options contract

Everlasting-options vault and settlement contract for NEAR. Source: [twooptions/src](twooptions/src).

## Build and test

```bash
cd contracts/twooptions
cargo test --lib                                                    # 84 unit tests
cargo clippy --lib --target wasm32-unknown-unknown -- -D warnings
cargo build --lib --target wasm32-unknown-unknown --release         # ~530 KB wasm
```

Notes:

- near-sdk only compiles for wasm or under test, so a plain `cargo check` fails by design. Use the wasm target.
- `near-sdk` is pinned to `>=5.10, <5.30` because 5.30 needs Rust 1.95 and this machine has 1.91. Cargo resolved 5.27.
- If linking fails with `libSystem.tbd: unknown architecture`, the default macOS SDK is broken. Use `export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk` for that shell.
- Not yet covered: gas measurement and sandbox integration tests (`near-workspaces`). Unit tests cannot measure gas. `agent/scripts/e2e_testnet.py` exercises the deployed contract with real transactions instead.

## Deploying

`make near-wasm` builds both contracts, and `make near-bootstrap` deploys and configures them on testnet (`agent/twooptions_agent/admin.py`; steps in `agent/README.md`).

**The wasm must be built with `--cfg near`.** `contracts/.cargo/config.toml` sets it for the wasm target, so a plain `cargo build` is correct; `cargo-near` sets it itself. Without the flag the contract still deploys and runs, but near-sdk does not route panics to the host, and every rejection reaches the caller as `WebAssembly trap: unreachable` instead of its message. This was found on testnet on Nov 12 and fixed by rebuilding and upgrading in place (`admin upgrade`, which keeps state).


Bootstrap applies these parameters on top of `Params::default()`, because the agent charges `(mark - intrinsic) / 24` per hour and prices to match (`agent/README.md`, "Pricing"):

| Parameter | Default | Preset | Why |
|---|---|---|---|
| `max_funding_rate` | 4% | 5% | 1/24 = 4.17% of mark for every out-of-the-money series; the default would clip them all |
| `max_time_value_bps` | 150 | 400 | At-the-money time value is about 1.1% of spot at 60% vol and 2.8% at 150% |
| `tv_reserve_bps` | 100 | 150 | Reserve per short contract, sized to the larger time value. Not calibrated |
| `max_quote_ttl_ns` | 10 s | 30 s | Multi-leg strategies need every leg quoted and then one wallet confirmation |

A wider band and a longer TTL also widen what a compromised agent key could do (limitation 1). They are the price of quoting at high vol and of one-confirmation strategies; the two limits below bound the damage.

### Limits on the agent key

| Parameter | Default | What it does |
|---|---|---|
| `mark_band_bps` | 100 | A trade's price must be within this share of spot, plus however far spot has moved, of the series' last funding mark. An option's price moves no more than spot does, so an honest quote fits; a skewed one does not. Series without a funding mark yet are bound only by the static band. |
| `max_epoch_outflow_bps` | 1,000 | The vault's net cash paid to traders within one funding interval may not exceed this share of its cash at the start of the interval. Trades the vault is paid for never count against it. |

Both were added by an upgrade (`admin upgrade --migrate`): the new code and a call to `migrate()` go in one transaction, which rewrites only the root state and keeps every collection. `src/migrate.rs` holds the previous layout; a unit test migrates real old-layout state and checks every balance.

## Test USDC (`test-usdc/`)

A NEP-141 token with 6 decimals built on `near-contract-standards`. `faucet()` pays the caller 2,000 USDC, at most once per 24 hours per account (the contract enforces it, and pays the caller's storage registration); `faucet_status(account_id)` says when the next claim opens. `mint(account_id, amount)` is owner only, up to 1,000,000 USDC per call, for bootstrap and LP seeding. Testnet only and worthless by design. It exists so deposits, withdrawals and LP flows can run end to end without someone else's faucet. `admin` refuses to use it outside testnet.

## Module map

| File | Purpose |
|---|---|
| `math.rs` | Checked fixed-point arithmetic, floor and ceil division, intrinsic value, shocks |
| `margin.rs` | Pure margin and valuation functions: price band, asset and liability marks, shock requirement |
| `types.rs` | State, parameters, signed message structs, view structs |
| `lib.rs` | The contract: deposits, withdrawals, LP vault, `trade`, `post_spot`, `settle_funding`, `liquidate`, admin, views |
| `tests.rs` | Unit tests plus a 2,000-step random run that checks the solvency invariant |
| `examples/` | Generators for the parity fixtures the app and agent test against |

## Wire format for the agent

Every signed message is verified as:

```
digest    = sha256( domain || u32_le(len(contract_account_id)) || contract_account_id || borsh(message) )
signature = ed25519_sign(agent_secret_key, digest)        // 64 bytes, sent base64
```

| Message | Domain bytes | Struct |
|---|---|---|
| Quote | `twooptions:quote:v1` | `Quote { series: String, taker: AccountId, side: Side, size: u128, price: u128, nonce: u64, expiry_ns: u64 }` |
| Spot update | `twooptions:spot:v1` | `SpotUpdate { underlying: Underlying, price: u128, ts_ns: u64, seq: u64 }` |
| Funding update | `twooptions:funding:v1` | `FundingUpdate { series: String, epoch: u64, rate: i128, mark: u128 }` |

Borsh details: enums are a single `u8` variant index in declaration order (`Side`: Buy=0, Sell=1; `Underlying`: BTC=0, ETH=1, SOL=2, NEAR=3). `String` and `AccountId` are a `u32` little-endian length then UTF-8 bytes. `u128`/`i128` are 16 bytes little-endian.

The JSON API takes 64 and 128-bit numbers as strings (`U128`, `U64`, `I128`).

## Units

| Quantity | Scale |
|---|---|
| USDC balances, premiums, marks, funding index | 1e6 (USDC micros, per contract for prices) |
| Spot and strike | 1e8 USD |
| Position size | 1e6 per contract, signed |
| Funding rate | 1e9 fraction per hour |
| Ratios and fees | basis points |

## How the money is kept safe

- The contract is the only custodian. No function lets the owner or the agent move user funds.
- Withdrawals go only to the caller. They debit first, then transfer, and a failed transfer is refunded in a callback.
- Every quote, spot and funding message is signature-checked with domain separation and the contract id mixed in.
- Replay is blocked by per-account increasing nonces, increasing spot sequence numbers and strictly increasing funding epochs.
- All prices must sit inside a band around intrinsic value, and spot posts are limited in how far they can jump while the previous one is fresh.
- All arithmetic is checked and rounds in the vault's favour. Size and price caps make overflow unreachable for roughly a year of maximum funding.
- The vault has its own risk limit, so LPs cannot be loaded with more short risk than their capital supports, and LPs cannot redeem capital that backs open risk.
- The ledger invariant (trader cash + vault cash + insurance + pending LP claims = net USDC received) is checked after every operation in the random test, including liquidations.
- If vault cash plus insurance goes negative, withdrawals halt until it is recapitalised. Deposits, LP deposits and liquidations stay open.
- A buy is paid in full from cash (`not enough cash to pay the premium`). A long has no margin requirement, so before this rule it could be opened on credit: the premium was never collected and any gain was paid out.
- An account can be liquidated when its equity is under 1.15 times its requirement, or when its equity is negative once the funding it owes is charged. The second test is the long side: an everlasting long owes funding every hour and is closed at the mark when its cash can no longer pay. Liquidation fees are charged on the spot notional of each short leg and on the mark value of each long leg, so closing an out-of-the-money long does not cost more than it is worth.

## Known limitations

1. **The agent key is trusted within limits.** Prices must sit in the static band (intrinsic minus 0.2% of spot up to intrinsic plus the configured share of spot) and within 1% of spot, plus spot's move, of the last funding mark; the vault pays out at most 10% of its cash per funding hour. Without those two limits a stolen key could drain the vault with round trips (buy at the band's bottom, sell back at its top), which lower the vault's risk and so never trip the vault risk limit. With them, the worst case is 10% of vault cash per hour until the owner pauses trading and rotates the key (`set_agent_keys`). The agent does not run in a TEE.
2. **Spot is agent-signed in v1.** The earlier plan had a permissionless oracle poke. A Pyth cross-check is the right upgrade; it was left out because the call shape could not be verified offline.
3. **Funding rate and mark come from the agent**, clamped to `max_funding_rate` per settlement and to the price band.
4. **Marks go stale between hourly funding updates.** Longs are valued at intrinsic only and shorts never below intrinsic, which keeps equity conservative, but LP share prices can lag fast moves in time value.
5. **Every underlying with open interest needs a fresh spot**, or trading and LP operations revert. The keeper must post all of them.
6. **Margin shocks are not calibrated** against the 12-scenario Rust model yet.
7. **No NEP-245 positions yet.** Positions live inside the account record and are not transferable. The views expose them, including each position's `entry_index` (accrued funding is `size * (series.funding_index - entry_index) / 1e6`).
8. **No gas measurement.** The worst case (32 series, 32 positions) has not been run on a sandbox.
9. **A long has no funding buffer.** It becomes liquidatable at negative equity, when the cushion left is its time value (about a day of funding). A keeper that is away for longer leaves a shortfall for insurance and then the vault (`unpaid_funding_beyond_a_longs_value_is_a_shortfall_not_a_free_ride` in `tests.rs`). A funding reserve in the long's requirement would fix it and means changing `margin.rs`, both ports and the fixtures.
10. **Accounts opened before the account index must be added to it once.** The contract lists its accounts in `account_ids` and keeps that in step on every write, but it cannot discover accounts that existed before the field did. `index_accounts` adds them ("Upgrading" below); each also adds itself the next time it deposits, trades or withdraws.
11. **Unaudited.** The Rust unit tests are not a substitute for an external review.

## Upgrading

`admin upgrade` replaces the code and keeps the state. When the state layout changed, `admin upgrade --migrate` sends the new code and a call to `migrate()` in one transaction, so the new code never runs over the old layout, and a failed migration undoes the deploy. `src/migrate.rs` holds each layout deployed before the current one and reads whichever is stored. Running it on state that is already current fails and changes nothing. Collections keep their storage prefixes: only the root struct is rewritten.

The account index (`account_ids`, with the views `get_account_count`, `list_account_ids` and `list_liquidatable`) was added this way. It starts empty, because the contract cannot list the accounts it already holds:

```bash
make near-wasm
cd agent
uv run python -m twooptions_agent.admin upgrade --migrate
uv run python -m twooptions_agent.admin index-accounts --accounts-file ids.txt   # optional file: one account id per line
uv run python -m twooptions_agent.admin status                                    # accounts_listed
```

`index-accounts` offers the agent's own watch list (`TWOOPTIONS_DATA_DIR`) plus any ids given. `index_accounts` on the contract is open to anyone and adds an id only if that account exists and is not listed yet, so offering too many is harmless and running it twice changes nothing. An account that was missed adds itself the next time it deposits, trades or withdraws; until then the keeper does not see it.

## Design decisions

| Choice | Why |
|---|---|
| Per-account strictly increasing `last_nonce` | Constant storage, same replay protection |
| Agent-signed `post_spot` with sequence, staleness and jump limits | Pyth call shape unverified offline |
| Quote has no spot; the contract uses its cached spot | One fewer thing to get wrong |
| Same numbers, but ordering is enforced and liquidation is `< 1.15` of requirement | The spec's tiers were inconsistent |
| Longs at intrinsic, shorts at the band-clamped mark, never below intrinsic | Keeps equity conservative both ways |
| Cumulative per-contract index in USDC micros | Correct across multiple epochs with changing marks |
| None | No fee source in v1 |
| Contract id is length-prefixed | Removes concatenation ambiguity |
| Also ratchets up on buys | Keeps vault liabilities from being understated between funding updates |
