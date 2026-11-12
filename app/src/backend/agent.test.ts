import { expect, test } from 'bun:test';
import { parseFundingHistory } from './agent';
import { mergeFundingEvents, type FundingEvent } from '../hooks/useProtocol';

test('funding history rows from the agent parse into the units the panel shows', () => {
  const row = parseFundingHistory({
    series: 'ETH-2100-C', epoch: '498409', rate: '41666667', mark: '27130000',
    per_contract: '1130416', index: '1130416', ts_ns: '1794272430000000000', tx_hash: 'abc',
  });
  expect(row).toEqual({
    series: 'ETH-2100-C', epoch: 498409n, mark: 27_130_000n, perContract: 1_130_416n, atMs: 1_794_272_430_000,
  });
});

test('merging keeps one row per series and epoch, newest first', () => {
  const ev = (series: string, epoch: bigint, atMs: number, mark = 1n): FundingEvent => ({ series, epoch, atMs, mark, perContract: 0n });
  const merged = mergeFundingEvents([
    ev('A', 2n, 2_000, 7n),      // seen live this session
    ev('A', 1n, 1_000),
    ev('A', 2n, 1_999, 9n),      // the same settlement from the agent's history
    ev('B', 2n, 2_500),
  ]);
  expect(merged.map(e => `${e.series}-${e.epoch}`)).toEqual(['B-2', 'A-2', 'A-1']);
  expect(merged[1].mark).toBe(7n);
});
