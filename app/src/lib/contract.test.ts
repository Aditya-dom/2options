import { expect, test } from 'bun:test';
import { orderPositions, type Position, type Series } from './contract';
import { SPOT_SCALE } from './units';

const series = (id: string, underlying: Series['underlying'] = 'ETH'): Series => {
  const [, strike, kind] = id.split('-');
  return {
    id, underlying, strike: BigInt(strike) * SPOT_SCALE, kind: kind === 'C' ? 'Call' : 'Put',
    fundingIndex: 0n, lastMark: 0n, lastEpoch: 0n, netTraderSize: 0n, active: true, refMark: null, refSpot: null,
  };
};
const position = (id: string): Position => ({ series: id, size: 1_000_000n, mark: 0n, value: 0n, entryIndex: null });
const ids = ['ETH-1900-C', 'ETH-1900-P', 'ETH-2000-C', 'ETH-950-P', 'ETH-2100-P'];
const book = new Map(ids.map(id => [id, series(id)]));
const shown = (stored: string[]) => orderPositions(stored.map(position), book).map(p => p.series);

test('positions are shown by strike, calls before puts, whatever order the contract holds them in', () => {
  // 950 sorts before 1,900 as a number, though "ETH-950" sorts after "ETH-1900" as text.
  const want = ['ETH-950-P', 'ETH-1900-C', 'ETH-1900-P', 'ETH-2000-C', 'ETH-2100-P'];
  expect(shown(ids)).toEqual(want);
  expect(shown([...ids].reverse())).toEqual(want);
});

test('closing one position leaves the others where they were', () => {
  // The contract fills the closed slot with its last entry: [a, b, c, d] without b is [a, d, c].
  const before = ['ETH-2100-P', 'ETH-1900-C', 'ETH-2000-C', 'ETH-950-P'];
  const afterClose = ['ETH-2100-P', 'ETH-950-P', 'ETH-2000-C'];
  expect(shown(afterClose)).toEqual(shown(before).filter(id => id !== 'ETH-1900-C'));
});

test('a position in a series the app has not loaded yet still has a place, and the input is not reordered', () => {
  const stored = ['ETH-2000-C', 'ETH-9999-C', 'ETH-1900-C'].map(position);
  expect(orderPositions(stored, book).map(p => p.series)).toEqual(['ETH-1900-C', 'ETH-2000-C', 'ETH-9999-C']);
  expect(stored.map(p => p.series)).toEqual(['ETH-2000-C', 'ETH-9999-C', 'ETH-1900-C']);
});
