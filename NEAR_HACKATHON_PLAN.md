# Perennia on NEAR — Hackathon Plan

> **Everlasting options, deposited from any chain, priced and hedged by a verifiable AI agent running in secure hardware (TEE), with settlement on a NEAR smart contract.**

| | |
|---|---|
| **Hackathon** | [NEAR Hackathon](https://nearhackathon.com/), "Build what's next" |
| **Build window** | Nov 1, 2026 00:00 UTC to **Nov 14, 2026 23:59 UTC** |
| **Judging** | Nov 16–18 (human jury, plus Claude Code & Codex as AI judges) |
| **Primary track** | Unstoppable DeFi |
| **Secondary tracks** | AI Security & Defense, Agent Economy |
| **Prize target** | Track 1st place ($10K) and the Grand Prize ($55K) |

---

## Table of contents

1. [Eligibility: resolve this first](#1-eligibility-resolve-this-first)
2. [Where we are today](#2-where-we-are-today)
3. [Why the NEAR version is different](#3-why-the-near-version-is-different)
4. [System architecture](#4-system-architecture)
5. [Core flows](#5-core-flows)
6. [Smart contract design](#6-smart-contract-design)
7. [Off-chain agent design](#7-off-chain-agent-design)
8. [Frontend changes](#8-frontend-changes)
9. [Scope tiers](#9-scope-tiers)
10. [Timeline](#10-timeline)
11. [Judging strategy](#11-judging-strategy)
12. [Risks and mitigations](#12-risks-and-mitigations)
13. [Submission checklist](#13-submission-checklist)

---

## 1. Eligibility: resolve this first

The hackathon rules say: **"Projects must be built during the hackathon period."**

Perennia already exists as a Solana/Pacifica project (it was a Pacifica hackathon entry). Submitting a port of it risks disqualification, and the AI judges will read the git history.

**Plan:**

- [ ] Ask the organizers before Oct 31 whether you can extend an existing project.
- [ ] Create a **fresh public repo on Nov 1**. Don't import the old git history.
- [ ] Treat the pricing math (`core/`, `perennia_math/`) as **disclosed prior work** in the README, or rewrite it in the new repo.
- [ ] Before Nov 1, do only research, accounts and design. No repo code.

---

## 2. Where we are today

```mermaid
flowchart LR
    subgraph Today["Perennia today (Solana / Pacifica)"]
        U[User<br/>Phantom / Privy] -->|USDP SPL transfer| CW[Per-user Privy<br/>custodial wallet]
        CW -.->|backend credits| PG[(Postgres<br/>ENTIRE options book,<br/>balances, funding)]
        API[FastAPI + engines] --> PG
        API -->|single hot key| PAC[Pacifica perps<br/>hedging]
    end
    style PG fill:#ffd6d6,stroke:#c00
    style CW fill:#ffd6d6,stroke:#c00
```

| Layer | Size | Status | Reuse on NEAR |
|---|---|---|---|
| `core/` + `perennia_math/` (Rust) | ~1.8k Python, ~2.1k Rust | Real, pure math: BS, 50-term everlasting series, vol surface, 12-scenario margin model | **High.** The Rust kernel compiles to wasm once pyo3 and rayon are behind a feature flag |
| `engine/` | ~5.6k | Real loops for quotes, risk, orders, funding, hedging | **High.** The hedge engine is tied to Pacifica through only 3 calls |
| `api/` + `db/` | ~5.6k | Real, but **all settlement is off-chain** | Partial. The read APIs stay; custody moves on-chain |
| `exchange/` | ~2.9k | Pacifica + Solana + Privy specific | **Replace** |
| Frontend | ~8k TS | Real chain, order, strategy and payoff UI | Components stay; the wallet layer is replaced |
| Smart contracts | none | — | **Build new** |

**The weakness to fix:** today Perennia is a centralized exchange with a crypto deposit address. The NEAR version moves trust from the server to **the chain and verifiable hardware**.

---

## 3. Why the NEAR version is different

My searches found no options protocol on NEAR, and certainly no everlasting options. Each NEAR feature below maps to a judging point:

| # | Feature | NEAR technology | Why judges care |
|---|---|---|---|
| 1 | On-chain vault and settlement, off-chain pricing (RFQ) | Rust contract, `env::ed25519_verify` | Funds are never custodial |
| 2 | Options as tokens | **NEP-245** multi-token (one token id per series) | Positions are composable: transfer them, use them as collateral, build vaults on top |
| 3 | Verifiable market maker | **Shade Agent** + **TEE attestation** | Anyone can verify that the market maker runs the published code |
| 4 | Hedging with no hot key | **Chain Signatures** (MPC) to Hyperliquid | The vault hedges its own delta on another chain |
| 5 | Deposits from any chain | **NEAR Intents / 1Click API** | Deposit BTC, ETH or SOL; it arrives as USDC in the vault |
| 6 | Permissionless funding and liquidation | Keeper-callable contract methods | Removes the "server must stay up" assumption |
| 7 | Bounded agent permissions | **Function Call Keys** with allowances | An AI vault agent can only call `trade`, with a spending cap |
| 8 | AI strategy copilot (stretch) | **NEAR AI Cloud** private inference | Turns plain language into an options strategy |

---

## 4. System architecture

### 4.1 High-level view

```mermaid
flowchart TB
    subgraph Chains["Any chain"]
        BTC[BTC]:::ext
        ETH[ETH / Arbitrum]:::ext
        SOL[Solana]:::ext
    end

    subgraph Intents["NEAR Intents"]
        OC[1Click API<br/>solver network]
    end

    subgraph NEAR["NEAR Protocol"]
        direction TB
        PC["<b>perennia.near</b><br/>Vault (USDC NEP-141)<br/>LP shares (pUSDC)<br/>Options (NEP-245)<br/>Margin + Funding + Liquidation"]
        AC["<b>agent.perennia.near</b><br/>Shade Agent contract<br/>approved TEE code hashes<br/>signing guardrails"]
        MPC["<b>v1.signer</b><br/>Chain Signatures (MPC)"]
        ORA["Price oracle<br/>(Pyth on NEAR)"]
    end

    subgraph TEE["TEE (Phala / dstack)"]
        AG["<b>Perennia Agent</b><br/>quote engine · risk engine<br/>funding keeper · hedge engine"]
    end

    subgraph Hedge["Hedge venue"]
        HL[Hyperliquid perps]:::ext
    end

    FE["Frontend<br/>React + NEAR Wallet Selector"]
    USER((Trader / LP))

    USER --> FE
    BTC & ETH & SOL -->|deposit| OC -->|USDC| PC
    FE -->|1. request quote| AG
    AG -->|2. signed quote| FE
    FE -->|3. trade tx + quote| PC
    PC -->|verify agent key| AC
    AG -->|settle_funding / liquidate| PC
    AG -->|register + attestation| AC
    AC -->|sign request| MPC
    MPC -->|signed order| HL
    ORA --> PC
    ORA --> AG

    classDef ext fill:#eef,stroke:#669
    style PC fill:#d8f5d8,stroke:#2a2
    style AG fill:#fff3c4,stroke:#b90
    style AC fill:#d8f5d8,stroke:#2a2
```

### 4.2 Trust boundaries

```mermaid
flowchart LR
    subgraph Trustless["Trustless (enforced on-chain)"]
        A[Custody of all funds]
        B[Margin checks]
        C[Funding settlement]
        D[Liquidations]
        E[Position ownership NEP-245]
    end
    subgraph Verifiable["Verifiable (TEE + attestation)"]
        F[Option pricing]
        G[Vol surface]
        H[Delta hedging]
    end
    subgraph Bounded["Bounded by contract rules"]
        I["Quote price ≤ oracle-derived band"]
        J[Quote expiry ≤ 10s]
        K[Agent key revocable by DAO / owner]
    end
    Verifiable -->|signed outputs only| Trustless
    Bounded -.->|guards| Trustless
```

### 4.3 Repository layout (new repo)

```
perennia-near/
├── contracts/
│   ├── perennia/          # main vault + options + margin contract (Rust, near-sdk)
│   ├── agent/             # Shade Agent contract (attestation + chain-sig gate)
│   └── math/              # no_std fixed-point port of perennia_math
├── agent/                 # off-chain engine (Python or TS) running inside the TEE
│   ├── pricing/           # everlasting pricing, vol surface
│   ├── quoter/            # RFQ server: signs quotes
│   ├── keeper/            # funding + liquidation caller
│   └── hedger/            # chain-signature → Hyperliquid
├── frontend/              # React + Vite + NEAR Wallet Selector
├── tests/                 # near-workspaces integration tests
└── README.md              # architecture, threat model, run instructions
```

---

## 5. Core flows

### 5.1 Deposit from any chain (NEAR Intents)

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant FE as Frontend
    participant OC as 1Click API
    participant SRC as Source chain (e.g. Solana)
    participant USDC as usdc.near (NEP-141)
    participant P as perennia.near

    U->>FE: "Deposit 2 SOL"
    FE->>OC: POST /v0/quote (SOL → USDC on NEAR, recipient = P, msg = user)
    OC-->>FE: deposit address + quote
    FE->>U: sign SOL transfer
    U->>SRC: send 2 SOL to deposit address
    OC->>USDC: solver delivers USDC
    USDC->>P: ft_transfer_call(amount, msg="deposit:user.near")
    P->>P: credit user margin balance
    P-->>FE: event: Deposit{user, amount}
```

### 5.2 Trade (RFQ with signed quote)

```mermaid
sequenceDiagram
    autonumber
    actor U as Trader
    participant FE as Frontend
    participant AG as Agent (TEE)
    participant P as perennia.near
    participant AC as agent.perennia.near

    U->>FE: Buy 1 ETH-3500-C everlasting
    FE->>AG: GET /quote?series=ETH-3500-C&side=buy&size=1
    AG->>AG: price = everlasting(spot, vol, K)<br/>+ inventory skew
    AG-->>FE: {price, size, expiry, nonce, sig_ed25519}
    FE->>U: confirm (max slippage)
    U->>P: trade(quote, sig, max_price)
    P->>AC: is_valid_agent(pubkey)?
    AC-->>P: true (attested code hash)
    P->>P: ed25519_verify(sig)<br/>check expiry, nonce, price band
    P->>P: pre-trade margin check
    P->>P: mint NEP-245 position token<br/>debit premium → vault
    P-->>FE: event: Trade{...}
    AG->>AG: update inventory → hedge if |Δ| > threshold
```

### 5.3 Hourly funding (permissionless keeper)

```mermaid
sequenceDiagram
    autonumber
    participant K as Keeper (Agent or anyone)
    participant AG as Agent (TEE)
    participant P as perennia.near

    loop every hour
        AG->>AG: compute mark TWAP per series
        AG-->>K: signed FundingUpdate{series, rate, epoch}
        K->>P: settle_funding(update, sig)
        P->>P: verify sig, cap rate ±4%/hr
        P->>P: store cumulative funding index per series
        P->>K: keeper reward
    end
    Note over P: Positions settle lazily:<br/>pnl = size × (index_now − index_entry)<br/>applied on next touch (trade / withdraw / liquidate)
```

### 5.4 Delta hedging through Chain Signatures

```mermaid
sequenceDiagram
    autonumber
    participant AG as Agent (TEE)
    participant AC as agent.perennia.near
    participant MPC as v1.signer (MPC)
    participant HL as Hyperliquid

    AG->>AG: net vault delta = Σ position deltas
    alt |delta deficit| > dynamic threshold
        AG->>AG: build Hyperliquid order (EIP-712 payload)
        AG->>AC: request_signature(payload_hash, path="hedge")
        AC->>AC: guardrails: max notional, allowed markets
        AC->>MPC: sign(secp256k1)
        MPC-->>AG: signature
        AG->>HL: submit signed order
        HL-->>AG: fill
    end
```

### 5.5 Liquidation

```mermaid
flowchart LR
    A[Keeper scans accounts] --> B{"equity / maintenance<br/>margin ratio"}
    B -->|> 50%| C[Healthy]
    B -->|30–50%| D[Warn: UI alert]
    B -->|15–30%| E["Close-only<br/>(contract blocks new risk)"]
    B -->|< 15%| F["liquidate(account)<br/>anyone can call"]
    F --> G[Positions closed at oracle mark]
    G --> H[Liquidator reward]
    G --> I{Shortfall?}
    I -->|yes| J[Insurance fund]
    J -->|insufficient| K[Socialize to LP vault]
```

---

## 6. Smart contract design

### 6.1 `perennia.near` storage

```mermaid
classDiagram
    class Perennia {
        owner: AccountId
        usdc: AccountId
        agent_contract: AccountId
        accounts: LookupMap~AccountId, Account~
        series: UnorderedMap~SeriesId, Series~
        mt_balances: LookupMap~(TokenId, AccountId), i128~
        vault: Vault
        insurance: u128
        used_nonces: LookupSet~u64~
    }
    class Account {
        collateral: u128
        positions: Vec~TokenId~  (max 16)
        funding_index_snapshot: Map~TokenId, i128~
        status: Healthy | CloseOnly
    }
    class Series {
        id: TokenId
        underlying: BTC | ETH | SOL | NEAR
        strike: u128
        kind: Call | Put
        cum_funding_index: i128
        open_interest: i128
    }
    class Vault {
        total_assets: u128
        total_shares: u128  (pUSDC)
        net_delta: i128
    }
    Perennia --> Account
    Perennia --> Series
    Perennia --> Vault
```

### 6.2 Public methods

| Method | Caller | Purpose |
|---|---|---|
| `ft_on_transfer(sender, amount, msg)` | `usdc.near` | `deposit:<acct>` (trader margin) or `lp` (mint pUSDC) |
| `withdraw(amount)` | trader | Withdraw free collateral (margin check) |
| `lp_redeem(shares)` | LP | Burn pUSDC for USDC (cooldown) |
| `trade(quote, sig, max_price)` | trader / FC-key agent | Execute a signed RFQ quote |
| `settle_funding(update, sig)` | anyone | Post the hourly funding index; earns a reward |
| `liquidate(account)` | anyone | Liquidate an unhealthy account; earns a reward |
| `add_series(...)` | owner / DAO | List a new strike |
| `mt_transfer`, `mt_balance_of`, ... | anyone | NEP-245 standard |
| `get_account`, `get_margin`, `get_series` | view | For UI and indexers |

### 6.3 Contract math rules

- **Money:** all `u128`/`i128` fixed-point (USDC 6 decimals; prices 1e8). The old code used floats for money; don't repeat that.
- **On-chain margin:** a simplified SPAN with ±15% spot × 3 vol scenarios, ported from `perennia_math`. Cap positions per account at **16** to keep gas bounded.
- **On-chain pricing:** none. The contract only checks that the quoted price is inside an **oracle-derived band** (intrinsic value ≤ price ≤ intrinsic + spot × k).

---

## 7. Off-chain agent design

```mermaid
flowchart LR
    subgraph Agent["Perennia Agent (inside TEE)"]
        F1[Spot feed<br/>Pyth / Binance WS] --> VS[Vol surface<br/>EWMA + Deribit IV]
        VS --> QE[Quote engine<br/>everlasting 50-term]
        QE --> RFQ[RFQ server<br/>ed25519 signer]
        IDX[NEAR indexer<br/>contract events] --> INV[Inventory / risk]
        INV --> QE
        INV --> HE[Hedge engine]
        INV --> KP[Keeper<br/>funding + liquidations]
        HE --> CS[Chain-sig client]
    end
    RFQ -->|HTTPS| FE[Frontend]
    KP -->|NEAR tx| P[perennia.near]
    CS -->|request_signature| AC[agent.perennia.near]
```

Porting map from the old codebase:

| Old (Perennia) | New (agent) | Effort |
|---|---|---|
| `core/everlasting.py`, `black_scholes.py`, `vol_surface.py` | `agent/pricing/` | Low (rewrite or disclose) |
| `engine/quote_engine.py` | `agent/quoter/` + signing | Medium |
| `engine/risk_engine.py`, `funding_engine.py` | `agent/keeper/` (reads chain, writes txs) | Medium |
| `engine/hedge_engine.py` (3 Pacifica calls) | `agent/hedger/` behind a `HedgeVenue` interface | Medium–High |
| `exchange/*`, `api/routes/collateral.py`, Privy auth | **Deleted.** Replaced by the contract and the wallet | — |
| Postgres options book | **Deleted.** The contract is the source of truth; an optional indexer cache | — |

---

## 8. Frontend changes

| Keep | Replace | Add |
|---|---|---|
| OptionChainPanel, OrderPanel, StrategyBuilder, PayoffDiagram, FundingPanel, ChartPanel | Privy → **NEAR Wallet Selector** (Meteor, HOT, MyNearWallet; social login) | **"Deposit from any chain"** widget (1Click) |
| useOptions, useMarket, useWebSocket | useAuth, useSolanaDeposit, useWalletBalance → NEAR RPC + contract views | **Agent attestation badge** (code hash, TEE quote) |
| Landing page layout | Solana wording | LP vault page (deposit, APY, net delta) |
| | | NEP-245 position transfer UI |

---

## 9. Scope tiers

```mermaid
flowchart TB
    subgraph T1["MUST: a demo that works end to end"]
        A1[Contract: vault, LP, NEP-245, trade w/ sig verify]
        A2[Contract: margin, funding, liquidation]
        A3[Agent: pricing + RFQ + keeper]
        A4[Frontend on NEAR Wallet Selector]
        A5[near-workspaces tests + testnet deploy]
    end
    subgraph T2["SHOULD: differentiators"]
        B1[1Click deposit from any chain]
        B2[Agent running as Shade Agent + attestation UI]
        B3[Function Call Key 'auto-roll' vault agent]
    end
    subgraph T3["STRETCH: pick at most one"]
        C1[Chain Signatures hedge on Hyperliquid testnet]
        C2[AI strategy copilot on NEAR AI Cloud]
    end
    T1 --> T2 --> T3
```

---

## 10. Timeline

```mermaid
gantt
    title Perennia on NEAR, build plan
    dateFormat  YYYY-MM-DD
    axisFormat  %b %d

    section Prep (no repo code)
    Ask organizers re: reuse            :crit, p0, 2026-10-23, 3d
    NEAR accounts, Shade Agent quickstart, 1Click sandbox :p1, 2026-10-24, 6d
    Contract interface spec + fixed-point scheme         :p2, 2026-10-27, 5d
    Demo storyboard                     :p3, 2026-10-30, 2d

    section Contract
    Skeleton: vault, LP, NEP-245, agent registry, trade sig verify :c1, 2026-11-01, 3d
    Margin, funding index, liquidation  :c2, 2026-11-04, 2d
    Testnet deploy + workspaces tests   :c3, 2026-11-06, 2d

    section Agent
    Pricing + vol surface port          :a1, 2026-11-04, 2d
    RFQ signer + keeper                 :a2, 2026-11-05, 2d
    Shade Agent deploy + attestation    :a3, 2026-11-09, 2d

    section Frontend
    Wallet Selector + contract views    :f1, 2026-11-06, 2d
    Trade, positions, funding, LP page  :f2, 2026-11-07, 2d
    1Click deposit widget               :f3, 2026-11-09, 2d

    section Milestones
    Full flow works on testnet          :milestone, m1, 2026-11-08, 0d
    Stretch (hedge OR copilot)          :s1, 2026-11-11, 2d
    Freeze, README, tests green         :crit, z1, 2026-11-13, 1d
    Demo video, X post, submit          :crit, z2, 2026-11-14, 1d
```

| Days | Goal | Exit criterion |
|---|---|---|
| Oct 23–31 | Prep | Reuse question answered; interface spec written |
| Nov 1–3 | Contract core | `trade()` passes signature and margin tests |
| Nov 4–5 | Risk logic + agent pricing | Funding and liquidation tests pass |
| Nov 6–8 | Frontend + integration | **Deposit → trade → funding → withdraw works on testnet** |
| Nov 9–10 | Differentiators | Attestation visible; 1Click deposit works |
| Nov 11–12 | One stretch goal | Demo-able or cut |
| Nov 13 | Freeze | README, diagrams, tests green, video recorded |
| Nov 14 | Submit | X post + form, well before 23:59 UTC |

---

## 11. Judging strategy

| Judge / criterion | What to show |
|---|---|
| **AI judges (Claude Code, Codex)** | A clean public repo, one-command setup, passing CI, accurate README, contract tests, no stale docs |
| **Kain Warwick (Synthetix)** | Funding design, LP risk under a crash, liquidation cascade handling, insurance fund |
| **Illia Polosukhin (NEAR)** | Real use of Intents, Chain Signatures, Shade Agents, NEP-245 |
| **Technical implementation** | Fixed-point contract math, signature-verified RFQ, attested agent |
| **Originality** | The first everlasting-options venue on NEAR; options as NEP-245 tokens |
| **Sustainability** | Revenue: spread + funding skew + LP vault fees |

**Demo script (2–3 minutes):**

1. Connect a NEAR wallet (social login).
2. Deposit SOL from Phantom; it arrives as USDC in the vault through NEAR Intents.
3. Buy an everlasting ETH call with a signed quote, and show the verification on the explorer.
4. Show the agent's TEE attestation badge.
5. Fast-forward: funding settles on-chain from a keeper tx.
6. The agent hedges its delta (Chain Signatures, if built).
7. Transfer the position token to another account (NEP-245).

---

## 12. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Reuse rule disqualifies the project | Fatal | Ask the organizers; fresh repo; disclose prior work |
| Contract gas for margin | High | Max 16 positions per account; 6 scenarios on-chain |
| Shade Agent framework is unaudited / new | Medium | It's a hackathon; say so in the README; fall back to a plain agent key |
| Hyperliquid via Chain Signatures is complex | Medium | Stretch only; hedge with a simulated venue as fallback |
| Oracle availability on testnet | Medium | Agent-signed price bounded by Pyth when available |
| Scope creep | High | Tier 1 must be frozen by Nov 8 |

---

## 13. Submission checklist

- [ ] Public GitHub repo (built Nov 1–14)
- [ ] README: pitch, architecture diagrams, threat model, setup, testnet contract addresses
- [ ] Contracts deployed on testnet (and mainnet if possible)
- [ ] Demo video, 2–3 minutes
- [ ] X post saying it was **built at NEAR HACKATHON**, with the video
- [ ] Form: name, lead, email, team size, tracks (**Unstoppable DeFi**, AI Security & Defense, Agent Economy), NEAR wallet, repo link, X link, description (20–2,000 characters)
- [ ] Submitted before **Nov 14, 23:59 UTC**

---

### References

- NEAR Hackathon: https://nearhackathon.com/
- Shade Agents: https://docs.near.org/ai/shade-agents/concepts/framework-overview
- NEAR Intents / 1Click: https://docs.near-intents.org/near-intents
- NEAR docs index: https://docs.near.org/llms.txt
