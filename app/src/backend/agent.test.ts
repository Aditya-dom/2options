import { expect, test } from 'bun:test';
import { parseFundingHistory, parseHealth, parseHedge } from './agent';
import { rowSummary } from '../components/HedgePanel';
import hedgeFixture from '../../../agent/tests/fixtures/hedge_status.json';
import type { HealthJson, HedgeJson } from './types';
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

// agent/tests/fixtures/hedge_status.json is what Hedger.status() and GET /hedge really return;
// agent/tests/test_hedger.py fails if the two drift apart.
test('a running hedger parses into what the Vault page shows', () => {
  const h = parseHedge(hedgeFixture.enabled as HedgeJson);
  expect([h.enabled, h.venue, h.network, h.error]).toEqual([true, 'hyperliquid', 'testnet', null]);
  expect(h.account).toBe('0x1111111111111111111111111111111111111111');
  expect([h.accountValue, h.deadbandUsd, h.rehedgeMoveBps, h.updatedMs]).toEqual([1000, 25, 50, 1_794_268_865_000]);
  expect(h.rows).toEqual([{
    underlying: 'ETH', target: 2.379593, position: 0.9518, gap: 1.427793, band: 0.356531, state: 'trade', reason: 'rebalancing',
    venueMid: 2100, basisBps: -47.4, unrealizedPnl: 0,
  }]);
  // Newest first: the refusal, then the partial fill before it.
  expect(h.orders.map(o => [o.status, o.side, o.size, o.filled, o.avgPx, o.atMs])).toEqual([
    ['rejected', 'buy', 1.4277, 0, null, 1_794_268_865_000],
    ['filled', 'buy', 2.3795, 0.9518, 2100, 1_794_268_860_000],
  ]);
  expect(h.orders[0].detail).toContain('Insufficient margin');
});

test('an agent without a hedger still reports the target, and the panel says it is not hedged', () => {
  const h = parseHedge(hedgeFixture.disabled as HedgeJson);
  expect([h.enabled, h.venue, h.account, h.updatedMs, h.accountValue]).toEqual([false, null, null, null, null]);
  expect(h.rows).toEqual([{
    underlying: 'ETH', target: 2.379593, position: null, gap: null, band: null, state: null, reason: '', venueMid: null,
    basisBps: null, unrealizedPnl: null,
  }]);
  expect(h.orders).toEqual([]);
  expect(rowSummary(h.rows[0])).toEqual({ text: 'Not hedged', tone: 'warn' });
});

test('a hedge on hold is shown as a warning with its reason', () => {
  const row = { ...parseHedge(hedgeFixture.enabled as HedgeJson).rows[0], state: 'hold' as const, reason: "the contract's spot is stale or missing" };
  expect(rowSummary(row)).toEqual({ text: "On hold: the contract's spot is stale or missing", tone: 'warn' });
});

test('the keeper\'s liquidation scan is read from /health when it is complete, and ignored otherwise', () => {
  const keeper = { last_spot_post_ns: {}, last_spot_hold: {}, last_funding_epoch: {}, liquidations: 0, errors: {} };
  const health = (watch?: object) => parseHealth({ ok: true, paused: false, series: 10, spot_age_s: {}, keeper: { ...keeper, watch } as HealthJson['keeper'] });
  expect(health({ source: 'watch list', accounts: 12, with_positions: 7, due: 1, behind_s: 2.5 }).keeper?.watch).toEqual({ accounts: 12, withPositions: 7, behindS: 2.5, fromContract: false });
  expect(health({ source: 'contract', accounts: 4, page: 100, round_s: 3.1, behind_s: 0 }).keeper?.watch).toEqual({ accounts: 4, withPositions: null, behindS: 0, fromContract: true });
  expect(health().keeper?.watch).toBeNull();   // an agent from before the scan reported itself
  expect(health({}).keeper?.watch).toBeNull(); // one that has not filled it in
});
