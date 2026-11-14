import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import hedgeFixture from '../../../agent/tests/fixtures/hedge_status.json';
import { parseHedge } from '../backend/agent';
import type { HedgeJson, HedgeStatus } from '../backend/types';
import { HedgeView, signedUsd } from './HedgePanel';

// The fixture is what the agent's hedger really reports (agent/tests/test_hedger.py keeps it so).
const live = parseHedge(hedgeFixture.enabled as HedgeJson);
const off = parseHedge(hedgeFixture.disabled as HedgeJson);
const text = (hedge: HedgeStatus | null, now = live.updatedMs! + 2_000) =>
  renderToStaticMarkup(<HedgeView hedge={hedge} now={now} />).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

test('nothing is rendered when the agent reports no hedger (demo mode)', () => {
  expect(renderToStaticMarkup(<HedgeView hedge={null} now={0} />)).toBe('');
});

test('a running hedge shows target, position, what is unhedged, and where the money sits', () => {
  const out = text(live);
  expect(out).toContain('LIVE · HYPERLIQUID TESTNET');
  expect(out).toContain('+2.3796'); // target
  expect(out).toContain('+0.9518'); // position on the venue
  expect(out).toContain('+1.4278'); // still unhedged
  expect(out).toContain('Rebalancing');
  expect(out).toContain('±0.3565 ETH (≈ $749)'); // the gamma-scaled no-trade band
  expect(out).toContain('a 0.5% move in spot');
  expect(out).toContain('0x111111…111111');
  expect(out).toContain('REJECTED');
  expect(out).toContain('FILLED');
  // The disclosure is always there: this money is not in the contract or the share price.
  expect(out).toContain('not in the contract');
  expect(out).toContain('not part of the vault equity or share price');
  expect(renderToStaticMarkup(<HedgeView hedge={live} now={live.updatedMs!} />)).toContain(
    'https://app.hyperliquid-testnet.xyz/explorer/address/0x1111111111111111111111111111111111111111',
  );
});

test('a hedger that is switched off says LPs carry the delta and shows the whole target as unhedged', () => {
  const out = text(off, 0);
  expect(out).toContain('OFF');
  expect(out).toContain('no hedger running');
  expect(out).toContain('Hedging is switched off');
  expect(out).not.toContain('LIVE');
  expect(out.match(/\+2\.3796/g)?.length).toBe(2); // the target, and all of it unhedged
});

test('a failed pass or a silent hedger is called out instead of showing stale numbers as live', () => {
  const failed = text({ ...live, error: 'TransportError: /info: timed out' });
  expect(failed).toContain('NOT UPDATING');
  expect(failed).toContain("The hedger's last pass failed, so it sent no order: TransportError: /info: timed out");
  expect(failed).not.toContain('LIVE ·');

  const silent = text(live, live.updatedMs! + 61_000);
  expect(silent).toContain('NOT UPDATING');
  expect(silent).toContain('has not reported for over a minute');
  expect(text(live, live.updatedMs! + 59_000)).toContain('LIVE ·');
});

test('profit and loss is signed, and a loss under half a cent is not shown as minus zero', () => {
  expect([signedUsd(-3.966), signedUsd(2.5), signedUsd(-0.004), signedUsd(0), signedUsd(-0.006)]).toEqual(['−$3.97', '$2.50', '$0.00', '$0.00', '−$0.01']);
});

test('a hedge on hold shows why', () => {
  const held: HedgeStatus = { ...live, rows: [{ ...live.rows[0], state: 'hold', reason: "the contract's spot is stale or missing" }] };
  expect(text(held)).toContain("On hold: the contract's spot is stale or missing");
});
