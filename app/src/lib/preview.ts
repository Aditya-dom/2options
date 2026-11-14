/**
 * Pre-trade preview: replays the margin part of `trade()` (lib.rs) on the current view data so
 * the ticket can say "this will fail" before the user signs. It is exact for the same spot and
 * marks; between preview and execution spot can move, so it is a preview, not a guarantee.
 *
 * A batch (one transaction, one `trade` action per leg) is replayed leg by leg: the contract
 * checks margin after every action, so every intermediate state has to pass, not just the end.
 */

import type { AccountState, Params, Series, Side, SpotPoint, Underlying } from './contract';
import { accruedFunding, legValue, requirement, tradeCash, type Leg } from './margin';
import { BPS } from './units';

export interface TradeLeg { series: string; side: Side; size: bigint; price: bigint }

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

export interface BatchPreview extends TradePreview {
  /** Index of the first leg that would revert the whole transaction. */
  failedLeg: number | null;
}

interface PreviewCtx {
  account: AccountState | null;
  series: Map<string, Series>;
  spots: Partial<Record<Underlying, SpotPoint>>;
  params: Params;
  maxPositions?: number;
}

interface PosLike { series: string; size: bigint }

export function previewBatch(ctx: PreviewCtx, legs: TradeLeg[]): BatchPreview | null {
  const { account, series, spots, params } = ctx;
  if (legs.length === 0 || legs.some(l => !series.has(l.series))) return null;

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
    const ls: Leg[] = [];
    for (const p of positions) {
      const s = series.get(p.series);
      const spot = s && spots[s.underlying]?.price;
      if (!s || spot == null) return null;
      equity += legValue(s.kind, spot, s.strike, marks.get(p.series) ?? s.lastMark, p.size, params);
      ls.push({ underlying: s.underlying, kind: s.kind, strike: s.strike, size: p.size });
    }
    return [equity, requirement(ls, u => spots[u]?.price ?? 0n, params)];
  };

  let positions: PosLike[] = (account?.positions ?? []).map(p => ({ series: p.series, size: p.size }));
  const r0 = risk(collateral, positions);
  if (!r0) return null;

  let cashTotal = 0n;
  let reqPrev = r0[1];
  let last: [bigint, bigint] = r0;
  let failure: string | null = account ? null : 'deposit first';
  let failedLeg: number | null = account ? null : 0;

  legs.forEach((leg, i) => {
    if (failure) return;
    const cash = tradeCash(leg.side, leg.price, leg.size);
    cashTotal += leg.side === 'Buy' ? cash : -cash;
    collateral += leg.side === 'Buy' ? -cash : cash;
    // A buy is paid in full from cash (after the funding the contract settles first).
    if (leg.side === 'Buy' && collateral < 0n) { failure = 'not enough cash to pay the premium'; failedLeg = i; return; }
    const next = positions.map(p => ({ ...p }));
    const j = next.findIndex(p => p.series === leg.series);
    const delta = leg.side === 'Buy' ? leg.size : -leg.size;
    if (j >= 0) {
      next[j].size += delta;
      if (next[j].size === 0n) next.splice(j, 1);
    } else {
      if (next.length >= (ctx.maxPositions ?? params.max_positions)) { failure = 'too many open series'; failedLeg = i; return; }
      next.push({ series: leg.series, size: delta });
    }
    positions = next;
    if (leg.side === 'Buy' && leg.price > (marks.get(leg.series) ?? 0n)) marks.set(leg.series, leg.price);
    const r = risk(collateral, positions);
    if (!r) { failure = 'spot price is stale'; failedLeg = i; return; }
    if (r[1] > reqPrev && r[0] * BPS < r[1] * params.initial_ratio_bps) { failure = 'insufficient margin for this trade'; failedLeg = i; }
    else if (positions.length === 0 && collateral < 0n) { failure = 'trade would leave a negative balance'; failedLeg = i; }
    reqPrev = r[1];
    last = r;
  });

  return {
    cash: cashTotal < 0n ? -cashTotal : cashTotal,
    pendingFunding,
    equityBefore: r0[0],
    reqBefore: r0[1],
    equityAfter: last[0],
    reqAfter: last[1],
    ratioAfterBps: last[1] > 0n ? (last[0] * BPS) / last[1] : null,
    failure,
    failedLeg,
  };
}

/** Single-leg preview used by the trade ticket. */
export function previewTrade(args: PreviewCtx & { trade: TradeLeg }): TradePreview | null {
  return previewBatch(args, [args.trade]);
}

/**
 * Execution order for a batch: buys first, so long legs are in place before the shorts they
 * cover are checked. The agent must issue quotes in this order (nonces strictly increase).
 */
export const executionOrder = <T extends { side: Side }>(legs: T[]): T[] =>
  [...legs.filter(l => l.side === 'Buy'), ...legs.filter(l => l.side === 'Sell')];
