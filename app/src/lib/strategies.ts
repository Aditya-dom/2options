/**
 * Strategy presets for the builder, defined relative to the at-the-money strike of one
 * underlying. Everlasting longs pay funding and shorts receive it, so the presets are grouped
 * by what they do: buy convexity, express direction, or collect funding.
 */

import type { Kind, Series, Side, Underlying } from './contract';

export interface StrategyLeg { series: string; side: Side; size: string }

interface LegTemplate { kind: Kind; offset: number; side: Side }

export interface Preset {
  id: string;
  name: string;
  blurb: string;
  legs: LegTemplate[];
}

export const PRESETS: Preset[] = [
  { id: 'long-call', name: 'Long call', blurb: 'Upside, pays funding.', legs: [{ kind: 'Call', offset: 0, side: 'Buy' }] },
  { id: 'long-put', name: 'Long put', blurb: 'Downside, pays funding.', legs: [{ kind: 'Put', offset: 0, side: 'Buy' }] },
  { id: 'straddle', name: 'Long straddle', blurb: 'Long gamma either way; pays funding on both legs.', legs: [{ kind: 'Call', offset: 0, side: 'Buy' }, { kind: 'Put', offset: 0, side: 'Buy' }] },
  { id: 'strangle', name: 'Long strangle', blurb: 'Cheaper convexity one strike out.', legs: [{ kind: 'Call', offset: 1, side: 'Buy' }, { kind: 'Put', offset: -1, side: 'Buy' }] },
  { id: 'bull-call', name: 'Bull call spread', blurb: 'Capped upside; the short leg offsets funding.', legs: [{ kind: 'Call', offset: 0, side: 'Buy' }, { kind: 'Call', offset: 1, side: 'Sell' }] },
  { id: 'bear-put', name: 'Bear put spread', blurb: 'Capped downside; the short leg offsets funding.', legs: [{ kind: 'Put', offset: 0, side: 'Buy' }, { kind: 'Put', offset: -1, side: 'Sell' }] },
  { id: 'risk-reversal', name: 'Risk reversal', blurb: 'Long upside financed by a short put.', legs: [{ kind: 'Call', offset: 1, side: 'Buy' }, { kind: 'Put', offset: -1, side: 'Sell' }] },
  { id: 'short-strangle', name: 'Short strangle', blurb: 'Collects funding on both legs; short gamma.', legs: [{ kind: 'Call', offset: 1, side: 'Sell' }, { kind: 'Put', offset: -1, side: 'Sell' }] },
];

/** Active strikes for an underlying, ascending, and the index nearest to spot. */
export function strikeGrid(series: Series[], u: Underlying, spot: bigint): { strikes: bigint[]; atm: number } {
  const strikes = [...new Set(series.filter(s => s.underlying === u && s.active).map(s => s.strike))].sort((a, b) => (a < b ? -1 : 1));
  let atm = 0;
  strikes.forEach((k, i) => {
    const d = k > spot ? k - spot : spot - k;
    const best = strikes[atm] > spot ? strikes[atm] - spot : spot - strikes[atm];
    if (d < best) atm = i;
  });
  return { strikes, atm };
}

/** Concrete legs for a preset, or null if the grid lacks a needed strike. */
/** Default leg size: small, so it fits deployments that cap trade size (the agent's /limits). */
export const DEFAULT_SIZE = '0.1';

export function buildPreset(preset: Preset, series: Series[], u: Underlying, spot: bigint, size = DEFAULT_SIZE): StrategyLeg[] | null {
  const { strikes, atm } = strikeGrid(series, u, spot);
  const legs: StrategyLeg[] = [];
  for (const t of preset.legs) {
    const k = strikes[atm + t.offset];
    const s = k != null ? series.find(x => x.underlying === u && x.strike === k && x.kind === t.kind && x.active) : undefined;
    if (!s) return null;
    legs.push({ series: s.id, side: t.side, size });
  }
  return legs;
}
