/**
 * In-browser stand-in for the twooptions contract plus a simulated market, so every screen can be
 * built and demoed before the contract and agent are deployed.
 *
 * The state transitions mirror contracts/twooptions/src/lib.rs step by step (same checks, same
 * rounding via lib/margin.ts, same panic strings) except signature verification. Each call runs
 * on a copy of the state and commits only if it does not throw, like a NEAR transaction.
 * Funding settles every 2 minutes instead of hourly so it is visible in a demo.
 */

import {
  accruedFunding, legValue, mulDivFloor, priceBand, requirement, tradeCash, type Leg,
} from '../lib/margin';
import type {
  AccountState, LpClaim, Params, QuoteJson, Series, SpotPoint, Underlying, Vault,
} from '../lib/contract';
import { DEFAULT_VOL } from '../lib/pricing';
import { big, BPS, FUNDING_SCALE, NS_PER_MS, nowNs, SIZE_SCALE, SPOT_SCALE, USDC_UNIT } from '../lib/units';
import type { Fill } from '../lib/history';
import { priceRow, PricingAgent } from './agent';
import type { Backend, Call, CallResult } from './types';

export const DEMO_ACCOUNT = 'you.demo';
const SEED_LP = 'seed-lp.demo';
const WHALE = 'whale.demo';
let fillSeq = 0;
const STORAGE_KEY = 'twooptions-demo-v2';
const SEC = 1_000_000_000n;

const MIN_TRADE_SIZE = 1_000n;
const MAX_POSITION_SIZE = 1_000_000_000_000n;
const MAX_PRICE_MICROS = 1_000_000_000_000n;

const VOL: Record<Underlying, number> = DEFAULT_VOL;
/**
 * With hourly funding an everlasting option lives ~2 hours (σ√2h ≈ 0.9% of spot at 60% vol),
 * so strikes more than a few percent away price at ~$0. Keep the grid within ±3% of spot.
 */
const STRIKES_USD = [3_350n, 3_400n, 3_450n, 3_500n, 3_550n, 3_600n, 3_650n];

interface DemoPosition { series: string; size: bigint; entryIndex: bigint }
interface DemoAccount { collateral: bigint; positions: DemoPosition[]; lastNonce: bigint }

export interface FundingLogEntry { tsNs: bigint; series: string; rate: bigint; mark: bigint; perContract: bigint; index: bigint }

interface DemoState {
  version: 1;
  params: Params;
  maxPositions: number;
  series: Record<string, Series>;
  spots: Partial<Record<Underlying, SpotPoint>>;
  accounts: Record<string, DemoAccount>;
  wallets: Record<string, bigint>;
  lpShares: Record<string, bigint>;
  lpClaims: Record<string, LpClaim>;
  totalShares: bigint;
  lockedShares: bigint;
  vaultCash: bigint;
  insurance: bigint;
  lpPending: bigint;
  lastFundingEpoch: bigint;
  fundingLog: FundingLogEntry[];
  /** Every fill, newest first (the chain backend reads these from an indexer instead). */
  fills?: Fill[];
  /** The vault's net payout to traders this funding interval (the contract's outflow cap). */
  outEpoch?: bigint;
  epochNetOut?: bigint;
  epochStartCash?: bigint;
  /** Last faucet claim per account (ms), as the test token keeps it. */
  faucetClaims?: Record<string, number>;
}

/** The test token's faucet terms (contracts/test-usdc): 2,000 USDC per account per 24 hours. */
export const FAUCET_AMOUNT = 2_000n * USDC_UNIT;
export const FAUCET_COOLDOWN_MS = 24 * 3_600_000;

class Panic extends Error {}
const require_ = (cond: boolean, msg: string): void => { if (!cond) throw new Panic(msg); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function demoParams(): Params {
  return {
    max_quote_ttl_ns: 10n * SEC,
    max_spot_age_ns: 30n * SEC,
    max_positions: 16,
    max_funding_rate: 40_000_000n,
    funding_interval_ns: 120n * SEC,
    lp_cooldown_ns: 300n * SEC,
    min_deposit: 1_000_000n,
    initial_ratio_bps: 15_000n,
    close_only_ratio_bps: 13_000n,
    liquidation_ratio_bps: 11_500n,
    vault_ratio_bps: 12_000n,
    min_time_value_bps: 20n,
    max_time_value_bps: 150n,
    tv_reserve_bps: 100n,
    min_margin_per_contract: 5_000_000n,
    mark_band_bps: 100n,
    max_epoch_outflow_bps: 1_000n,
  };
}

// bigint-safe persistence
const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? { $b: v.toString() } : v);
const reviver = (_k: string, v: unknown) =>
  v && typeof v === 'object' && '$b' in (v as object) ? BigInt((v as { $b: string }).$b) : v;

export class DemoWorld {
  private s: DemoState;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.s = this.load() ?? this.genesis();
  }

  // ------------------------------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------------------------------

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(1), 1_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  reset() {
    this.s = this.genesis();
    this.save();
    this.emit();
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit() { for (const fn of this.listeners) fn(); }

  private load(): DemoState | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const st = JSON.parse(raw, reviver) as DemoState;
      if (st.version !== 1) return null;
      // Spot is a live feed, not state: refresh its timestamp so a reload is not "stale".
      for (const sp of Object.values(st.spots)) if (sp) sp.tsNs = nowNs();
      return st;
    } catch {
      return null;
    }
  }

  private save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.s, replacer)); } catch { /* private mode */ }
  }

  private genesis(): DemoState {
    const s: DemoState = {
      version: 1,
      params: demoParams(),
      maxPositions: 16,
      series: {},
      spots: { ETH: { price: 3_500n * SPOT_SCALE, tsNs: nowNs() } },
      accounts: {},
      wallets: { [DEMO_ACCOUNT]: 25_000n * USDC_UNIT, [SEED_LP]: 500_000n * USDC_UNIT, [WHALE]: 200_000n * USDC_UNIT },
      lpShares: {},
      lpClaims: {},
      totalShares: 0n,
      lockedShares: 0n,
      vaultCash: 0n,
      insurance: 0n,
      lpPending: 0n,
      lastFundingEpoch: nowNs() / (120n * SEC),
      fundingLog: [],
    };
    for (const k of STRIKES_USD) {
      for (const kind of ['Call', 'Put'] as const) {
        const id = `ETH-${k}-${kind === 'Call' ? 'C' : 'P'}`;
        s.series[id] = {
          id, underlying: 'ETH', strike: k * SPOT_SCALE, kind,
          fundingIndex: 0n, lastMark: 0n, lastEpoch: 0n, netTraderSize: 0n, active: true, refMark: null, refSpot: null,
        };
      }
    }
    this.s = s;
    for (const ser of Object.values(s.series)) {
      ser.lastMark = priceRow(ser, s.spots.ETH!.price, VOL.ETH, s.params).mark;
    }
    // Seed: LP capital, and a whale with open interest so the vault has a book to show.
    this.lpDeposit(SEED_LP, 250_000n * USDC_UNIT);
    this.deposit(WHALE, 100_000n * USDC_UNIT);
    this.execTrade(WHALE, this.markQuote(WHALE, 'ETH-3500-C', 'Buy', 20n * SIZE_SCALE));
    this.execTrade(WHALE, this.markQuote(WHALE, 'ETH-3450-P', 'Sell', 10n * SIZE_SCALE));
    this.execTrade(WHALE, this.markQuote(WHALE, 'ETH-3550-C', 'Buy', 15n * SIZE_SCALE));
    return s;
  }

  private markQuote(taker: string, series: string, side: 'Buy' | 'Sell', size: bigint): QuoteJson {
    const ser = this.s.series[series];
    const row = priceRow(ser, this.s.spots[ser.underlying]!.price, VOL[ser.underlying], this.s.params);
    const acct = this.s.accounts[taker];
    return {
      series, taker, side, size: size.toString(),
      price: (side === 'Buy' ? row.ask : row.bid).toString(),
      nonce: ((acct?.lastNonce ?? 0n) + 1n).toString(),
      expiry_ns: (nowNs() + 5n * SEC).toString(),
    };
  }

  // ------------------------------------------------------------------------------------------
  // Market simulation: GBM spot, funding at each epoch (what the agent and keeper would do)
  // ------------------------------------------------------------------------------------------

  private tick(seconds: number) {
    const now = nowNs();
    for (const [u, sp] of Object.entries(this.s.spots) as [Underlying, SpotPoint][]) {
      const dt = seconds / 31_536_000;
      const z = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
      const factor = Math.exp(-0.5 * VOL[u] ** 2 * dt + VOL[u] * Math.sqrt(dt) * z);
      sp.price = BigInt(Math.round(Number(sp.price) * factor));
      sp.tsNs = now;
    }
    const epoch = now / this.s.params.funding_interval_ns;
    if (epoch > this.s.lastFundingEpoch) {
      this.settleFunding(epoch, now);
      this.s.lastFundingEpoch = epoch;
      this.save();
    }
    this.emit();
  }

  private settleFunding(epoch: bigint, now: bigint) {
    for (const ser of Object.values(this.s.series)) {
      const spot = this.s.spots[ser.underlying]?.price;
      if (spot == null) continue;
      const row = priceRow(ser, spot, VOL[ser.underlying], this.s.params);
      const perContract = mulDivFloor(row.fundingRateHourly, row.mark, FUNDING_SCALE);
      ser.fundingIndex += perContract;
      ser.lastMark = row.mark;
      ser.lastEpoch = epoch;
      ser.refMark = row.mark;
      ser.refSpot = spot;
      this.s.fundingLog.unshift({
        tsNs: now, series: ser.id, rate: row.fundingRateHourly, mark: row.mark, perContract, index: ser.fundingIndex,
      });
    }
    this.s.fundingLog.length = Math.min(this.s.fundingLog.length, 300);
  }

  // ------------------------------------------------------------------------------------------
  // Contract logic (mirror of lib.rs)
  // ------------------------------------------------------------------------------------------

  private spotOrPanic(u: Underlying): bigint {
    const sp = this.s.spots[u];
    require_(sp != null && nowNs() - sp.tsNs <= this.s.params.max_spot_age_ns, 'spot price is stale');
    return sp!.price;
  }

  private accountRisk(acct: DemoAccount): [bigint, bigint] | null {
    let equity = acct.collateral;
    const legs: Leg[] = [];
    for (const pos of acct.positions) {
      const ser = this.s.series[pos.series];
      const spot = this.s.spots[ser.underlying]?.price;
      if (spot == null) return null;
      equity += legValue(ser.kind, spot, ser.strike, ser.lastMark, pos.size, this.s.params);
      legs.push({ underlying: ser.underlying, kind: ser.kind, strike: ser.strike, size: pos.size });
    }
    return [equity, requirement(legs, u => this.s.spots[u]?.price ?? 0n, this.s.params)];
  }

  private vaultRisk(): [bigint, bigint] | null {
    let equity = this.s.vaultCash;
    const legs: Leg[] = [];
    for (const ser of Object.values(this.s.series)) {
      if (ser.netTraderSize === 0n) continue;
      const spot = this.s.spots[ser.underlying]?.price;
      if (spot == null) return null;
      const size = -ser.netTraderSize;
      equity += legValue(ser.kind, spot, ser.strike, ser.lastMark, size, this.s.params);
      legs.push({ underlying: ser.underlying, kind: ser.kind, strike: ser.strike, size });
    }
    return [equity, requirement(legs, u => this.s.spots[u]?.price ?? 0n, this.s.params)];
  }

  private applyFunding(acct: DemoAccount): bigint {
    let payment = 0n;
    for (const pos of acct.positions) {
      const idx = this.s.series[pos.series].fundingIndex;
      if (idx !== pos.entryIndex) {
        payment += accruedFunding(pos.size, idx, pos.entryIndex);
        pos.entryIndex = idx;
      }
    }
    acct.collateral -= payment;
    this.s.vaultCash += payment;
    return payment;
  }

  private account(id: string): DemoAccount {
    return this.s.accounts[id] ?? { collateral: 0n, positions: [], lastNonce: 0n };
  }

  private saveAccount(id: string, acct: DemoAccount) {
    if (acct.collateral === 0n && acct.positions.length === 0) delete this.s.accounts[id];
    else this.s.accounts[id] = acct;
  }

  private debitWallet(id: string, amount: bigint) {
    // ft_transfer_call fails in the token before reaching the contract.
    require_((this.s.wallets[id] ?? 0n) >= amount, 'The account doesn\'t have enough balance');
    this.s.wallets[id] = (this.s.wallets[id] ?? 0n) - amount;
  }

  private deposit(sender: string, amount: bigint) {
    require_(amount >= this.s.params.min_deposit, 'deposit below minimum');
    this.debitWallet(sender, amount);
    const acct = this.account(sender);
    acct.collateral += amount;
    this.s.accounts[sender] = acct;
  }

  private lpDeposit(sender: string, amount: bigint) {
    require_(amount >= this.s.params.min_deposit, 'deposit below minimum');
    this.debitWallet(sender, amount);
    let shares: bigint;
    if (this.s.totalShares === 0n) {
      const locked = 1_000_000n;
      require_(amount > locked, 'first deposit must exceed the locked liquidity');
      this.s.lockedShares = locked;
      this.s.totalShares = locked;
      shares = amount - locked;
    } else {
      const risk = this.vaultRisk();
      require_(risk != null, 'spot price is stale');
      require_(risk![0] > 0n, 'vault has no equity, deposits are closed');
      shares = mulDivFloor(amount, this.s.totalShares, risk![0]);
      require_(shares > 0n, 'deposit rounds to zero shares');
    }
    this.s.vaultCash += amount;
    this.s.totalShares += shares;
    this.s.lpShares[sender] = (this.s.lpShares[sender] ?? 0n) + shares;
  }

  private withdraw(id: string, amount: bigint) {
    require_(amount > 0n, 'amount must be positive');
    require_(this.s.vaultCash + this.s.insurance >= 0n, 'system is under-collateralized, withdrawals are halted');
    require_(this.s.accounts[id] != null, 'no account');
    const acct = this.account(id);
    this.applyFunding(acct);
    require_(acct.collateral >= amount, 'insufficient collateral');
    acct.collateral -= amount;
    if (acct.positions.length > 0) {
      const risk = this.accountRisk(acct);
      require_(risk != null, 'spot price is stale');
      require_(risk![0] * BPS >= risk![1] * this.s.params.initial_ratio_bps, 'withdrawal would leave the account under-margined');
    } else {
      require_(acct.collateral >= 0n, 'account owes funding, cannot withdraw');
    }
    this.saveAccount(id, acct);
    this.s.wallets[id] = (this.s.wallets[id] ?? 0n) + amount;
  }

  private execTrade(taker: string, q: QuoteJson) {
    this.execTradeChecked(taker, q);
    const fills = (this.s.fills ??= []);
    fills.unshift({ txHash: `demo-${Date.now().toString(36)}-${(fillSeq++).toString(36)}`, leg: 0, atMs: Date.now(), series: q.series, side: q.side, size: big(q.size), price: big(q.price), taker } as Fill & { taker: string });
    fills.length = Math.min(fills.length, 500);
  }

  fillsOf(account: string): Fill[] {
    return (this.s.fills ?? []).filter(f => (f as Fill & { taker?: string }).taker === account).map(f => ({ ...f }));
  }

  private execTradeChecked(taker: string, q: QuoteJson) {
    const p = this.s.params;
    require_(taker === q.taker, 'quote is for a different taker');
    const now = nowNs();
    const expiry = big(q.expiry_ns);
    require_(now <= expiry, 'quote expired');
    require_(expiry - now <= p.max_quote_ttl_ns, 'quote expiry is too far in the future');
    const size = big(q.size);
    const price = big(q.price);
    require_(size >= MIN_TRADE_SIZE && size <= MAX_POSITION_SIZE, 'size out of range');
    require_(price <= MAX_PRICE_MICROS, 'price out of range');

    const ser = this.s.series[q.series];
    require_(ser != null, 'unknown series');
    require_(ser.active, 'series is not active');
    const spot = this.spotOrPanic(ser.underlying);
    const [lo, hi] = priceBand(ser.kind, spot, ser.strike, p);
    require_(price >= lo && price <= hi, 'price is outside the allowed band');
    if (ser.refMark != null && ser.refSpot != null) {
      const moved = (spot > ser.refSpot ? spot - ser.refSpot : ser.refSpot - spot) / 100n;
      const allowance = mulDivFloor(spot / 100n, p.mark_band_bps, BPS);
      const off = price > ser.refMark ? price - ser.refMark : ser.refMark - price;
      require_(off <= moved + allowance, 'price is too far from the last funding mark');
    }

    require_(this.s.accounts[taker] != null, 'deposit first');
    const acct = this.account(taker);
    const nonce = big(q.nonce);
    require_(nonce > acct.lastNonce, 'nonce already used');
    acct.lastNonce = nonce;

    const vaultBefore = this.vaultRisk();
    require_(vaultBefore != null, 'spot price is stale');
    this.applyFunding(acct);
    const before = this.accountRisk(acct);
    require_(before != null, 'spot price is stale');

    const delta = q.side === 'Buy' ? size : -size;
    const cash = tradeCash(q.side, price, size);
    const traderCash = q.side === 'Buy' ? -cash : cash;
    const epochNow = now / p.funding_interval_ns;
    if (this.s.outEpoch !== epochNow) {
      this.s.outEpoch = epochNow;
      this.s.epochNetOut = 0n;
      this.s.epochStartCash = this.s.vaultCash;
    }
    acct.collateral += traderCash;
    if (q.side === 'Buy') require_(acct.collateral >= 0n, 'not enough cash to pay the premium');
    this.s.vaultCash -= traderCash;
    require_(this.s.vaultCash >= 0n, 'vault cannot fund this trade');
    this.s.epochNetOut = (this.s.epochNetOut ?? 0n) + traderCash;
    if (traderCash > 0n) {
      require_(this.s.epochNetOut * BPS <= (this.s.epochStartCash ?? 0n) * p.max_epoch_outflow_bps, 'vault outflow limit reached for this hour');
    }

    const i = acct.positions.findIndex(x => x.series === q.series);
    const newSize = (i >= 0 ? acct.positions[i].size : 0n) + delta;
    require_((newSize < 0n ? -newSize : newSize) <= MAX_POSITION_SIZE, 'position too large');
    if (i >= 0 && newSize === 0n) acct.positions.splice(i, 1);
    else if (i >= 0) acct.positions[i].size = newSize;
    else {
      require_(acct.positions.length < this.s.maxPositions, 'too many open series');
      acct.positions.push({ series: q.series, size: newSize, entryIndex: ser.fundingIndex });
    }
    ser.netTraderSize += delta;
    if (q.side === 'Buy' && price > ser.lastMark) ser.lastMark = price;

    const after = this.accountRisk(acct)!;
    if (after[1] > before![1]) {
      require_(after[0] * BPS >= after[1] * p.initial_ratio_bps, 'insufficient margin for this trade');
    }
    if (acct.positions.length === 0) require_(acct.collateral >= 0n, 'trade would leave a negative balance');
    const vaultAfter = this.vaultRisk()!;
    if (vaultAfter[1] > vaultBefore![1]) {
      require_(vaultAfter[0] * BPS >= vaultAfter[1] * p.vault_ratio_bps, 'vault risk limit reached');
    }
    this.saveAccount(taker, acct);
  }

  private lpRequestRedeem(holder: string, shares: bigint) {
    const held = this.s.lpShares[holder] ?? 0n;
    require_(shares > 0n && shares <= held, 'invalid share amount');
    require_(this.s.totalShares - shares >= this.s.lockedShares, 'cannot redeem the locked liquidity');
    const risk = this.vaultRisk();
    require_(risk != null, 'spot price is stale');
    const [equity, req] = risk!;
    require_(equity > 0n, 'vault has no equity');
    const amount = mulDivFloor(shares, equity, this.s.totalShares);
    require_(amount > 0n, 'redeem amount rounds to zero');
    require_(amount <= this.s.vaultCash, 'vault has insufficient free cash');
    require_((equity - amount) * BPS >= req * this.s.params.vault_ratio_bps, 'redeeming would leave the vault under-margined');
    if (held === shares) delete this.s.lpShares[holder];
    else this.s.lpShares[holder] = held - shares;
    this.s.totalShares -= shares;
    this.s.vaultCash -= amount;
    this.s.lpPending += amount;
    const prior = this.s.lpClaims[holder]?.amount ?? 0n;
    this.s.lpClaims[holder] = { amount: prior + amount, unlockNs: nowNs() + this.s.params.lp_cooldown_ns };
  }

  private claimLp(holder: string) {
    const claim = this.s.lpClaims[holder];
    require_(claim != null, 'no claim');
    require_(nowNs() >= claim.unlockNs, 'claim is still in cooldown');
    require_(this.s.vaultCash + this.s.insurance >= 0n, 'system is under-collateralized, withdrawals are halted');
    delete this.s.lpClaims[holder];
    this.s.lpPending -= claim.amount;
    this.s.wallets[holder] = (this.s.wallets[holder] ?? 0n) + claim.amount;
  }

  /** Run a call against a copy of the state; commit only if it does not panic. */
  apply(accountId: string, call: Call): string[] {
    const snapshot = structuredClone(this.s);
    try {
      const events = this.dispatch(accountId, call);
      this.save();
      this.emit();
      return events;
    } catch (e) {
      this.s = snapshot;
      if (e instanceof Panic) throw new Error(`Smart contract panicked: ${e.message}`);
      throw e;
    }
  }

  private dispatch(id: string, call: Call): string[] {
    switch (call.kind) {
      case 'deposit': this.deposit(id, call.amount); return ['Deposit'];
      case 'lp_deposit': this.lpDeposit(id, call.amount); return ['LpMint'];
      case 'withdraw': this.withdraw(id, call.amount); return ['Withdraw'];
      case 'trade': this.execTrade(id, call.quote); return ['Trade'];
      case 'trade_batch': for (const leg of call.legs) this.execTrade(id, leg.quote); return call.legs.map(() => 'Trade');
      case 'lp_request_redeem': this.lpRequestRedeem(id, call.shares); return ['LpRedeemRequest'];
      case 'lp_claim': this.claimLp(id); return ['LpClaim'];
      case 'register_usdc': return [];
      case 'faucet': this.faucet(id); return ['ft_mint'];
    }
  }

  private faucet(id: string) {
    const next = this.faucetNextClaim(id);
    if (next != null) {
      const mins = Math.ceil((next - Date.now()) / 60_000);
      throw new Panic(`faucet already claimed; try again in ${Math.floor(mins / 60)}h ${mins % 60}m`);
    }
    (this.s.faucetClaims ??= {})[id] = Date.now();
    this.s.wallets[id] = (this.s.wallets[id] ?? 0n) + FAUCET_AMOUNT;
  }

  faucetNextClaim(id: string): number | null {
    const last = this.s.faucetClaims?.[id];
    return last != null && Date.now() < last + FAUCET_COOLDOWN_MS ? last + FAUCET_COOLDOWN_MS : null;
  }

  // ------------------------------------------------------------------------------------------
  // Views (shapes match the contract's views after parsing)
  // ------------------------------------------------------------------------------------------

  params(): Params { return { ...this.s.params }; }
  series(): Series[] { return Object.values(this.s.series).map(x => ({ ...x })); }
  spot(u: Underlying): SpotPoint | null { const sp = this.s.spots[u]; return sp ? { ...sp } : null; }
  spots(): Partial<Record<Underlying, SpotPoint>> { return structuredClone(this.s.spots); }
  fundingLog(): FundingLogEntry[] { return this.s.fundingLog.slice(); }
  vol(u: Underlying) { return VOL[u]; }

  vault(): Vault {
    const risk = this.vaultRisk();
    return {
      cash: this.s.vaultCash, totalShares: this.s.totalShares, pendingClaims: this.s.lpPending,
      insurance: this.s.insurance, equity: risk?.[0] ?? null, requirement: risk?.[1] ?? null,
      epochNetOutflow: this.s.outEpoch === nowNs() / this.s.params.funding_interval_ns ? this.s.epochNetOut ?? 0n : 0n,
      epochStartCash: this.s.outEpoch === nowNs() / this.s.params.funding_interval_ns ? this.s.epochStartCash ?? this.s.vaultCash : this.s.vaultCash,
    };
  }

  accountView(id: string): AccountState | null {
    const acct = this.s.accounts[id];
    if (!acct) return null;
    const risk = this.accountRisk(acct);
    return {
      collateral: acct.collateral,
      lastNonce: acct.lastNonce,
      equity: risk?.[0] ?? null,
      requirement: risk?.[1] ?? null,
      positions: acct.positions.map(pos => {
        const ser = this.s.series[pos.series];
        const spot = this.s.spots[ser.underlying]?.price;
        return {
          series: pos.series,
          size: pos.size,
          mark: ser.lastMark,
          value: spot == null ? 0n : legValue(ser.kind, spot, ser.strike, ser.lastMark, pos.size, this.s.params),
          // The real v1 view omits this (requested from Gaurav); the demo shows what it enables.
          entryIndex: pos.entryIndex,
        };
      }),
    };
  }

  lpShares(id: string) { return this.s.lpShares[id] ?? 0n; }
  lpClaim(id: string): LpClaim | null { const c = this.s.lpClaims[id]; return c ? { ...c } : null; }
  wallet(id: string) { return this.s.wallets[id] ?? 0n; }

  /** Simulated 1Click delivery: USDC arrives in the user's wallet, outside the contract. */
  creditWallet(id: string, amount: bigint) {
    this.s.wallets[id] = (this.s.wallets[id] ?? 0n) + amount;
    this.save();
    this.emit();
  }
}

export class DemoBackend implements Backend {
  readonly mode = 'demo' as const;
  readonly contractId = 'twooptions.demo';
  readonly usdcId = 'usdc.demo';

  constructor(readonly world: DemoWorld) {}

  async getParams() { return this.world.params(); }
  async listSeries() { return this.world.series(); }
  async getSpot(u: Underlying) { return this.world.spot(u); }
  async getVault() { return this.world.vault(); }
  async isPaused() { return false; }
  async getAccount(id: string) { return this.world.accountView(id); }
  async getLpShares(id: string) { return this.world.lpShares(id); }
  async getLpClaim(id: string) { return this.world.lpClaim(id); }
  async usdcBalance(id: string) { return this.world.wallet(id); }
  async usdcRegistered() { return true; }
  async faucetStatus(id: string) { return { amount: FAUCET_AMOUNT, nextClaimMs: this.world.faucetNextClaim(id) }; }
  async isAgentKey() { return null; }
  async tradeHistory(id: string) { return this.world.fillsOf(id); }

  async submit(accountId: string, call: Call): Promise<CallResult> {
    await sleep(500 + Math.random() * 500); // block time, so the UI's pending states get exercised
    return { txHash: null, events: this.world.apply(accountId, call) };
  }
}

export function demoAgent(world: DemoWorld) {
  return new PricingAgent({
    spots: async () => world.spots(),
    series: async () => world.series(),
    params: async () => world.params(),
    vol: u => world.vol(u),
  }, true);
}

/** ns → ms for Date math in the UI. */
export const nsToMs = (ns: bigint) => Number(ns / NS_PER_MS);
