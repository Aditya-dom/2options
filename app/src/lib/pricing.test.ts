import { expect, test } from 'bun:test';
import { everlasting, hourlyFundingUsd, normCdf } from './pricing';

test('normCdf is accurate to 1e-7', () => {
  expect(normCdf(0)).toBeCloseTo(0.5, 7);
  expect(normCdf(1.959963985)).toBeCloseTo(0.975, 7);
  expect(normCdf(-3)).toBeCloseTo(0.0013498980, 7);
});

test('ATM ETH call matches the handoff numbers (~$12, delta 0.5, ~$0.50/h funding)', () => {
  const c = everlasting(3_500, 3_500, 0.6, 'Call');
  expect(c.price).toBeGreaterThan(11.5);
  expect(c.price).toBeLessThan(12.5);
  expect(c.delta).toBeCloseTo(0.5, 2);
  expect(hourlyFundingUsd(c.price, 3_500, 3_500, 'Call')).toBeCloseTo(c.price / 24, 9);
});

test('put-call parity holds term by term (r = 0)', () => {
  for (const K of [3_000, 3_400, 3_500, 3_650, 4_000]) {
    const c = everlasting(3_500, K, 0.6, 'Call');
    const p = everlasting(3_500, K, 0.6, 'Put');
    // Σ w_n = 1 − 2^-50, so C − P = (S − K)(1 − 2^-50).
    expect(c.price - p.price).toBeCloseTo((3_500 - K) * (1 - 2 ** -50), 6);
    expect(c.delta - p.delta).toBeCloseTo(1, 9);
  }
});

test('far OTM strikes price at ~0 (effective life is ~2 hours)', () => {
  expect(everlasting(3_500, 4_000, 0.6, 'Call').price).toBeLessThan(0.01);
});
