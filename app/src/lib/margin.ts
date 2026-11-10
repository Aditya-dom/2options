/**
 * Port of contracts/perennia/src/{math,margin}.rs for pre-trade previews. Same integers, same
 * rounding, so a preview that passes here passes on chain for the same spot and marks.
 * Parity is checked against the Rust code in margin.test.ts (vectors from scripts/margin_vectors).
 */

import { BPS, SIZE_SCALE } from './units';

export type Kind = 'Call' | 'Put';
export type Underlying = 'BTC' | 'ETH' | 'SOL' | 'NEAR';

/** The subset of the contract's `Params` the margin code reads (bps and micros as bigint). */
export interface MarginParams {
  min_time_value_bps: bigint;
  max_time_value_bps: bigint;
  tv_reserve_bps: bigint;
  min_margin_per_contract: bigint;
}

export interface Leg {
  underlying: Underlying;
  kind: Kind;
  /** 1e8-scaled USD. */
  strike: bigint;
  /** Signed size units, 1e6 per contract. */
  size: bigint;
}

/** Spot shocks in bps, applied per underlying independently. */
export const SHOCKS_BPS = [-2_000n, -1_000n, 1_000n, 2_000n] as const;
const SPOT_TO_USDC = 100n;

/** Rust `i128::div_euclid` for a positive divisor: floor division. */
function floorDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  return n % d !== 0n && n < 0n ? q - 1n : q;
}

export function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error('division by zero');
  return floorDiv(a * b, d);
}

export function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error('division by zero');
  return -floorDiv(-(a * b), d);
}

/** Intrinsic value of one contract in USDC micros. Truncates like the Rust `/`. */
export function intrinsic(kind: Kind, spot: bigint, strike: bigint): bigint {
  const diff = kind === 'Call' ? spot - strike : strike - spot;
  return diff <= 0n ? 0n : diff / SPOT_TO_USDC;
}

export const spotUsdc = (spot: bigint): bigint => spot / SPOT_TO_USDC;

export function shock(price: bigint, bps: bigint): bigint {
  const s = mulDivFloor(price, BPS + bps, BPS);
  return s < 0n ? 0n : s;
}

/** [lo, hi] band a quote or mark must sit in, USDC micros per contract. */
export function priceBand(kind: Kind, spot: bigint, strike: bigint, p: MarginParams): [bigint, bigint] {
  const intr = intrinsic(kind, spot, strike);
  const s = spotUsdc(spot);
  const lo = intr - mulDivFloor(s, p.min_time_value_bps, BPS);
  const hi = intr + mulDivFloor(s, p.max_time_value_bps, BPS);
  return [lo < 0n ? 0n : lo, hi];
}

export function liabilityMark(kind: Kind, spot: bigint, strike: bigint, lastMark: bigint, p: MarginParams): bigint {
  const [, hi] = priceBand(kind, spot, strike, p);
  const lo = intrinsic(kind, spot, strike);
  return lastMark < lo ? lo : lastMark > hi ? hi : lastMark;
}

export const assetMark = (kind: Kind, spot: bigint, strike: bigint): bigint => intrinsic(kind, spot, strike);

export const positionValue = (size: bigint, mark: bigint): bigint => mulDivFloor(size, mark, SIZE_SCALE);

/** Longs at intrinsic, shorts at the clamped liability mark. */
export function legValue(kind: Kind, spot: bigint, strike: bigint, lastMark: bigint, size: bigint, p: MarginParams): bigint {
  const mark = size >= 0n ? assetMark(kind, spot, strike) : liabilityMark(kind, spot, strike, lastMark, p);
  return positionValue(size, mark);
}

/** Worst-case loss requirement for a set of legs in USDC micros, rounded up. */
export function requirement(legs: Leg[], spotOf: (u: Underlying) => bigint, p: MarginParams): bigint {
  const seen: Underlying[] = [];
  let scenarioTotal = 0n;
  let reserve = 0n;
  let floorTotal = 0n;

  for (const leg of legs) {
    if (!seen.includes(leg.underlying)) seen.push(leg.underlying);
    if (leg.size < 0n) {
      const abs = -leg.size;
      const s = spotUsdc(spotOf(leg.underlying));
      reserve += mulDivCeil(abs * s, p.tv_reserve_bps, SIZE_SCALE * BPS);
      floorTotal += mulDivCeil(abs, p.min_margin_per_contract, SIZE_SCALE);
    }
  }

  for (const u of seen) {
    if (!legs.some(l => l.underlying === u && l.size < 0n)) continue;
    const spot = spotOf(u);
    let worst = 0n;
    for (const bps of SHOCKS_BPS) {
      const shocked = shock(spot, bps);
      let change = 0n;
      for (const l of legs) {
        if (l.underlying !== u) continue;
        change += l.size * (intrinsic(l.kind, shocked, l.strike) - intrinsic(l.kind, spot, l.strike));
      }
      if (change < 0n) {
        const loss = mulDivCeil(-change, 1n, SIZE_SCALE);
        if (loss > worst) worst = loss;
      }
    }
    scenarioTotal += worst;
  }

  const total = scenarioTotal + reserve;
  return total > floorTotal ? total : floorTotal;
}

/** Cash leg of a fill, as the contract books it: buys round up, sells round down. */
export function tradeCash(side: 'Buy' | 'Sell', price: bigint, size: bigint): bigint {
  return side === 'Buy' ? mulDivCeil(price, size, SIZE_SCALE) : mulDivFloor(price, size, SIZE_SCALE);
}

/** Funding owed since `entryIndex` (positive = trader pays), rounded like `apply_funding`. */
export function accruedFunding(size: bigint, fundingIndex: bigint, entryIndex: bigint): bigint {
  const diff = fundingIndex - entryIndex;
  return diff === 0n ? 0n : mulDivCeil(size, diff, SIZE_SCALE);
}
