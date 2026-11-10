/**
 * Pre-trade preview: replays the margin part of `trade()` (lib.rs) on the current view data so
 * the ticket can say "this will fail" before the user signs. It is exact for the same spot and
 * marks; between preview and execution spot can move, so it is a preview, not a guarantee.
 */

import type { AccountState, Params, Series, Side, SpotPoint, Underlying } from './contract';
import { accruedFunding, legValue, requirement, tradeCash, type Leg } from './margin';
import { BPS } from './units';

export interface TradePreview {
  /** Premium paid (buy) or received (sell), USDC micros, rounded as the contract books it. */
  cash: bigint;
  /** Funding the contract will settle first (positive = trader pays). Null if unknown. */
  pendingFunding: bigint | null;
  equityBefore: bigint;
  reqBefore: bigint;
  equityAfter: bigint;
  reqAfter: bigint;
  /** equity / requirement after, in bps; null when there is no requirement (long only). */
  ratioAfterBps: bigint | null;
  /** The contract's panic message this trade would hit, or null if it should pass. */
  failure: string | null;
}

interface PosLike { series: string; size: bigint }

export function previewTrade(args: {
  account: AccountState | null;
  series: Map<string, Series>;
  spots: Partial<Record<Underlying, SpotPoint>>;
  params: Params;
  maxPositions?: number;
  trade: { series: string; side: Side; size: bigint; price: bigint };
}): TradePreview | null {
  const { account, series, spots, params, trade } = args;
  const target = series.get(trade.series);
  if (!target) return null;

  let collateral = account?.collateral ?? 0n;
  let pendingFunding: bigint | null = 0n;
  for (const p of account?.positions ?? []) {
    const s = series.get(p.series);
    if (!s || p.entryIndex == null) { pendingFunding = null; continue; }
    if (pendingFunding != null) pendingFunding += accruedFunding(p.size, s.fundingIndex, p.entryIndex);
  }
  if (pendingFunding != null) collateral -= pendingFunding;

  const marks = new Map<string, bigint>([...series].map(([id, s]) => [id, s.lastMark]));
  const risk = (cash: bigint, positions: PosLike[]): [bigint, bigint] | null => {
    let equity = cash;
    const legs: Leg[] = [];
    for (const p of positions) {
      const s = series.get(p.series);
      const spot = s && spots[s.underlying]?.price;
      if (!s || spot == null) return null;
      equity += legValue(s.kind, spot, s.strike, marks.get(p.series) ?? s.lastMark, p.size, params);
      legs.push({ underlying: s.underlying, kind: s.kind, strike: s.strike, size: p.size });
    }
    return [equity, requirement(legs, u => spots[u]?.price ?? 0n, params)];
  };

  const before: PosLike[] = (account?.positions ?? []).map(p => ({ series: p.series, size: p.size }));
  const r0 = risk(collateral, before);
  if (!r0) return null;

  const delta = trade.side === 'Buy' ? trade.size : -trade.size;
  const cash = tradeCash(trade.side, trade.price, trade.size);
  const collateralAfter = collateral + (trade.side === 'Buy' ? -cash : cash);
  const after = before.map(p => ({ ...p }));
  const i = after.findIndex(p => p.series === trade.series);
  let failure: string | null = null;
  if (i >= 0) {
    after[i].size += delta;
    if (after[i].size === 0n) after.splice(i, 1);
  } else {
    if (after.length >= (args.maxPositions ?? params.max_positions)) failure = 'too many open series';
    after.push({ series: trade.series, size: delta });
  }
  if (trade.side === 'Buy' && trade.price > target.lastMark) marks.set(trade.series, trade.price);

  const r1 = risk(collateralAfter, after);
  if (!r1) return null;
  const [equityAfter, reqAfter] = r1;
  if (!failure && reqAfter > r0[1] && equityAfter * BPS < reqAfter * params.initial_ratio_bps) {
    failure = 'insufficient margin for this trade';
  }
  if (!failure && after.length === 0 && collateralAfter < 0n) failure = 'trade would leave a negative balance';
  if (!failure && !account) failure = 'deposit first';

  return {
    cash,
    pendingFunding,
    equityBefore: r0[0],
    reqBefore: r0[1],
    equityAfter,
    reqAfter,
    ratioAfterBps: reqAfter > 0n ? (equityAfter * BPS) / reqAfter : null,
    failure,
  };
}
