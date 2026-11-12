# Demo video storyboard (#8)

Three minutes, recorded Nov 13 after the freeze, submitted Nov 14 with the X post. It follows the plan's demo script (NEAR_HACKATHON_PLAN.md §11), adjusted to what is actually built. Every beat says what it proves, what it depends on, and what to show if the dependency isn't ready. **Never record demo mode and present it as testnet**: the header shows a `DEMO` badge, and it has to stay visible in any demo-mode footage.

## Before recording

- [ ] 2Options deployed to testnet; USDC registered; series listed **around live spot** (ETH is about $2,110, not $3,500)
- [ ] Keeper posting `post_spot` every ≤10 s and `settle_funding` hourly; LP vault seeded
- [ ] Agent live at `VITE_AGENT_URL` with `/attestation`; the header badge shows `AGENT ✓`
- [ ] Two funded testnet accounts: one trader with test USDC, one LP
- [ ] The trader holds one position opened at least an hour earlier, so there is funding to show
- [ ] Explorer tabs open (testnet.nearblocks.io) for the contract and the keeper account
- [ ] Decisions made: funding period (HANDOFF_GAURAV.md §2), where #33 is shown (§5), which stretch goal survives (#37)
- [ ] Screen at 1440 px wide, dark theme, browser zoom 110%, notifications off

## Shot list

| Time | Beat | Screen and action | Says | Proves | Depends on | If not ready |
|---|---|---|---|---|---|---|
| 0:00–0:15 | Hook | Positions panel with an open ETH call that has no expiry | "This option never expires. I pay a little funding each hour instead of rolling it." | The product in one line | — | — |
| 0:15–0:25 | Connect | Connect Wallet → Meteor (or HOT) | "Any NEAR wallet. Signing in adds a key that can only trade on 2Options, so trades don't need a popup." | NEAR Wallet Selector, limited access keys | Testnet deploy | — |
| 0:25–0:55 | Deposit from Solana | Deposit from another chain → SOL → live quote → send from Phantom → status turns to SUCCESS → Deposit into 2Options | "I'm paying in SOL. NEAR Intents swaps it to USDC on NEAR in about 30 seconds, then it's my collateral." | **NEAR Intents (1Click)** | Decision §5: mainnet, or a split shot | Show the live quote, then a pre-recorded mainnet swap landing in a wallet, labelled as such; do the testnet deposit with test USDC |
| 0:55–1:25 | Trade with a signed quote | Click an ATM ask → ticket shows margin after and funding per hour → Get firm quote → countdown → Buy → open the tx on the explorer | "The agent signs every price; the contract checks the signature, the price band and my margin before it fills. Here's the transaction." | Signature-verified RFQ, on-chain margin | Agent live | None: this beat is the minimum viable demo |
| 1:25–1:45 | Spread in one transaction | Strategy → Bull call spread → note package margin → Execute 2 legs → explorer shows one tx with two `trade` actions | "Both legs fill in one transaction or neither does, so I'm margined as a spread, not as a naked short." | Atomic multi-leg on NEAR | Quote TTL raised to ~30 s (§4) | Skip; mention it in the close |
| 1:45–2:00 | Who signs the prices | Click the `AGENT ✓` badge → key registered on the contract, last quote verified, TEE code hash | "You don't have to trust our server: the agent runs in a TEE and the contract only accepts its key." | **Shade Agent** attestation | #5, #34 | Show the key registered and the signature verified; say the TEE deploy is in progress (be exact) |
| 2:00–2:15 | Funding settles on chain | Funding tab → countdown, rates → explorer: keeper's `settle_funding` tx → position shows accrued funding | "Every hour the keeper settles funding on chain. That's what replaces expiry." | Funding mechanism | Keeper running; `entry_index` in the view (§3) | Show the settlement tx and the index change; skip accrued funding per position |
| 2:15–2:40 | The vault | Vault tab → equity, share price, vault health, net delta → (stretch) hedge order on Hyperliquid via Chain Signatures | "LPs are the counterparty. The agent hedges the vault's delta on Hyperliquid, signed through NEAR Chain Signatures." | LP design; **Chain Signatures** (if #38 ships) | #38 (stretch) | Show net delta and the hedge target from `agent/twooptions_agent/inventory.py`; say hedging is next |
| 2:40–3:00 | Close | Architecture diagram from the README | "Everlasting options on NEAR: Intents for deposits, a TEE agent for prices, and a contract that holds the money and checks everything. Built at NEAR Hackathon." | — | README diagram (#41) | Stay on the app |

**Cut from the plan:** "transfer the position token (NEP-245)". The contract keeps positions in the account record and does not mint tokens (contracts/README.md, limitation 7). Mention it as future work in the close; don't show it.

## What each judge should see

| Judge | Beats |
|---|---|
| Illia Polosukhin (NEAR tech) | Deposit (Intents), Who signs the prices (Shade Agent), Vault (Chain Signatures, if built), Connect (limited keys) |
| Kain Warwick (perps and funding design) | Hook, Funding settles on chain, Vault (LP risk, delta hedge), Spread (portfolio margin) |
| Technical implementation | Trade (signature, band and margin checks on chain), Spread (atomic batch) |
| AI judges | The video isn't for them; they read the repo. Keep the README, CI and setup accurate |

## If something breaks while recording

Order of what to cut, least important first: the Spread beat, the hedge part of the Vault beat, accrued funding, the live 1Click swap (switch to the split shot). The Trade beat on testnet is the one thing the video can't do without; if the agent or contract is down, fix that rather than record around it.

## Recording notes

- Record each beat as its own take and cut them together. The quote countdown is 10 s, so fumbling a click means a fresh quote, not a reshoot.
- Keep talking during waits: the 1Click swap takes 20–35 s, so cover it by explaining that the contract credits whoever sends the USDC, which is why it lands in your wallet first.
- Zoom in (in the edit) on the explorer's action list for the two-leg transaction and on the badge dialog; at full width they're unreadable.
- The lines above are about 170 words, roughly 70 s at a calm pace; the rest of the 3 minutes is clicking and waiting. Expand during waits, but stay under about 400 words in total. Trim words, not beats.
