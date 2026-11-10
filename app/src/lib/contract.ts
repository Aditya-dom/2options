/**
 * Contract-facing types, mirroring contracts/perennia/src/types.rs. `*Json` types are the raw
 * view results (64/128-bit numbers as strings); the parsed types hold bigints.
 */

import type { Kind, MarginParams, Underlying } from './margin';
import { big } from './units';

export type { Kind, Underlying };
export type Side = 'Buy' | 'Sell';

export const UNDERLYINGS: Underlying[] = ['BTC', 'ETH', 'SOL', 'NEAR'];

// ---------------------------------------------------------------------------------------------
// Raw JSON
// ---------------------------------------------------------------------------------------------

/** `Params` uses plain integers, so serde emits JSON numbers (all below 2^53). */
export interface ParamsJson {
  max_quote_ttl_ns: number;
  max_spot_age_ns: number;
  max_positions: number;
  max_funding_rate: number;
  funding_interval_ns: number;
  liquidation_reward_bps: number;
  insurance_bps: number;
  lp_cooldown_ns: number;
  min_lp_liquidity: number;
  min_deposit: number;
  initial_ratio_bps: number;
  close_only_ratio_bps: number;
  liquidation_ratio_bps: number;
  vault_ratio_bps: number;
  max_time_value_bps: number;
  min_time_value_bps: number;
  tv_reserve_bps: number;
  min_margin_per_contract: number;
  max_spot_jump_bps: number;
}

export interface PositionViewJson {
  series: string;
  size: string;
  mark: string;
  value: string;
  /** Not in the v1 view. Requested so the UI can show accrued funding (handoff §6). */
  entry_index?: string;
}

export interface AccountViewJson {
  collateral: string;
  positions: PositionViewJson[];
  last_nonce: string;
  equity: string | null;
  requirement: string | null;
}

export interface SeriesViewJson {
  id: string;
  underlying: Underlying;
  strike: string;
  kind: Kind;
  funding_index: string;
  last_mark: string;
  last_epoch: string;
  net_trader_size: string;
  active: boolean;
}

export interface VaultViewJson {
  cash: string;
  total_shares: string;
  pending_claims: string;
  insurance: string;
  equity: string | null;
  requirement: string | null;
}

/** The agent-signed quote, passed to `trade` exactly as received. Never built client-side. */
export interface QuoteJson {
  series: string;
  taker: string;
  side: Side;
  size: string;
  price: string;
  nonce: string;
  expiry_ns: string;
}

// ---------------------------------------------------------------------------------------------
// Parsed
// ---------------------------------------------------------------------------------------------

export interface Params extends MarginParams {
  max_quote_ttl_ns: bigint;
  max_spot_age_ns: bigint;
  max_positions: number;
  max_funding_rate: bigint;
  funding_interval_ns: bigint;
  lp_cooldown_ns: bigint;
  min_deposit: bigint;
  initial_ratio_bps: bigint;
  close_only_ratio_bps: bigint;
  liquidation_ratio_bps: bigint;
  vault_ratio_bps: bigint;
}

export interface Position {
  series: string;
  size: bigint;
  mark: bigint;
  value: bigint;
  entryIndex: bigint | null;
}

export interface AccountState {
  collateral: bigint;
  positions: Position[];
  lastNonce: bigint;
  equity: bigint | null;
  requirement: bigint | null;
}

export interface Series {
  id: string;
  underlying: Underlying;
  strike: bigint;
  kind: Kind;
  fundingIndex: bigint;
  lastMark: bigint;
  lastEpoch: bigint;
  netTraderSize: bigint;
  active: boolean;
}

export interface Vault {
  cash: bigint;
  totalShares: bigint;
  pendingClaims: bigint;
  insurance: bigint;
  equity: bigint | null;
  requirement: bigint | null;
}

export interface SpotPoint {
  price: bigint;
  tsNs: bigint;
}

export interface LpClaim {
  amount: bigint;
  unlockNs: bigint;
}

const opt = (v: string | null) => (v == null ? null : big(v));

export function parseParams(j: ParamsJson): Params {
  return {
    max_quote_ttl_ns: big(j.max_quote_ttl_ns),
    max_spot_age_ns: big(j.max_spot_age_ns),
    max_positions: j.max_positions,
    max_funding_rate: big(j.max_funding_rate),
    funding_interval_ns: big(j.funding_interval_ns),
    lp_cooldown_ns: big(j.lp_cooldown_ns),
    min_deposit: big(j.min_deposit),
    initial_ratio_bps: big(j.initial_ratio_bps),
    close_only_ratio_bps: big(j.close_only_ratio_bps),
    liquidation_ratio_bps: big(j.liquidation_ratio_bps),
    vault_ratio_bps: big(j.vault_ratio_bps),
    min_time_value_bps: big(j.min_time_value_bps),
    max_time_value_bps: big(j.max_time_value_bps),
    tv_reserve_bps: big(j.tv_reserve_bps),
    min_margin_per_contract: big(j.min_margin_per_contract),
  };
}

export const parseAccount = (j: AccountViewJson): AccountState => ({
  collateral: big(j.collateral),
  positions: j.positions.map(p => ({
    series: p.series,
    size: big(p.size),
    mark: big(p.mark),
    value: big(p.value),
    entryIndex: p.entry_index == null ? null : big(p.entry_index),
  })),
  lastNonce: big(j.last_nonce),
  equity: opt(j.equity),
  requirement: opt(j.requirement),
});

export const parseSeries = (j: SeriesViewJson): Series => ({
  id: j.id,
  underlying: j.underlying,
  strike: big(j.strike),
  kind: j.kind,
  fundingIndex: big(j.funding_index),
  lastMark: big(j.last_mark),
  lastEpoch: big(j.last_epoch),
  netTraderSize: big(j.net_trader_size),
  active: j.active,
});

export const parseVault = (j: VaultViewJson): Vault => ({
  cash: big(j.cash),
  totalShares: big(j.total_shares),
  pendingClaims: big(j.pending_claims),
  insurance: big(j.insurance),
  equity: opt(j.equity),
  requirement: opt(j.requirement),
});

/** `Option<(U128, U64)>` serializes as `[price, ts]` or null. */
export const parseSpot = (j: [string, string] | null): SpotPoint | null =>
  j == null ? null : { price: big(j[0]), tsNs: big(j[1]) };

export const parseLpClaim = (j: [string, string] | null): LpClaim | null =>
  j == null ? null : { amount: big(j[0]), unlockNs: big(j[1]) };

/** Margin health = equity / requirement in bps. Null when there is nothing to measure. */
export function healthBps(equity: bigint | null, requirement: bigint | null): bigint | null {
  if (equity == null || requirement == null || requirement <= 0n) return null;
  return (equity * 10_000n) / requirement;
}

export type HealthTier = 'healthy' | 'warning' | 'close-only' | 'liquidatable';

/** Tiers from the contract's params: ≥ initial is healthy, below liquidation anyone can close you. */
export function healthTier(bps: bigint, p: Params): HealthTier {
  if (bps < p.liquidation_ratio_bps) return 'liquidatable';
  if (bps < p.close_only_ratio_bps) return 'close-only';
  if (bps < p.initial_ratio_bps) return 'warning';
  return 'healthy';
}

/** `ETH-3500-C` → `ETH 3,500 C`. */
export function seriesLabel(s: Pick<Series, 'underlying' | 'strike' | 'kind'>): string {
  return `${s.underlying} ${(s.strike / 100_000_000n).toLocaleString('en-US')} ${s.kind === 'Call' ? 'C' : 'P'}`;
}
