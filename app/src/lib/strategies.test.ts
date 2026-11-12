import { expect, test } from 'bun:test';
import type { Series } from './contract';
import { buildPreset, PRESETS, strikeGrid } from './strategies';
import { SPOT_SCALE } from './units';

const mk = (k: number, kind: 'Call' | 'Put'): Series => ({
  id: `ETH-${k}-${kind[0]}`, underlying: 'ETH', strike: BigInt(k) * SPOT_SCALE, kind,
  fundingIndex: 0n, lastMark: 0n, lastEpoch: 0n, netTraderSize: 0n, active: true, refMark: null, refSpot: null,
});
const grid = [3_450, 3_500, 3_550].flatMap(k => [mk(k, 'Call'), mk(k, 'Put')]);
const spot = 3_512n * SPOT_SCALE;
const preset = (id: string) => PRESETS.find(p => p.id === id)!;

test('ATM is the strike nearest to spot', () => {
  expect(strikeGrid(grid, 'ETH', spot)).toEqual({ strikes: [3_450n, 3_500n, 3_550n].map(k => k * SPOT_SCALE), atm: 1 });
});

test('presets resolve relative strikes', () => {
  expect(buildPreset(preset('bull-call'), grid, 'ETH', spot)).toEqual([
    { series: 'ETH-3500-C', side: 'Buy', size: '1' },
    { series: 'ETH-3550-C', side: 'Sell', size: '1' },
  ]);
  expect(buildPreset(preset('short-strangle'), grid, 'ETH', spot, '2')).toEqual([
    { series: 'ETH-3550-C', side: 'Sell', size: '2' },
    { series: 'ETH-3450-P', side: 'Sell', size: '2' },
  ]);
});

test('a preset needing a strike off the grid is unavailable', () => {
  expect(buildPreset(preset('strangle'), grid, 'ETH', 3_548n * SPOT_SCALE)).toBeNull();
});
