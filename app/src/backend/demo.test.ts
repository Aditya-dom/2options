import { expect, test } from 'bun:test';
import { SIZE_SCALE, USDC_UNIT } from '../lib/units';
import { DEMO_ACCOUNT, DemoWorld, demoAgent } from './demo';

const world = () => new DemoWorld(); // no localStorage under bun: always a fresh genesis

async function quote(w: DemoWorld, series: string, side: 'Buy' | 'Sell', size = SIZE_SCALE) {
  return demoAgent(w).quote({ series, side, size, taker: DEMO_ACCOUNT });
}

test('a batch is atomic: a failing second leg rolls back the first', async () => {
  const w = world();
  w.apply(DEMO_ACCOUNT, { kind: 'deposit', amount: 1_000n * USDC_UNIT });
  const before = w.accountView(DEMO_ACCOUNT)!;
  const buy = await quote(w, 'ETH-3550-C', 'Buy');
  // Re-using the same nonce makes leg 2 panic with "nonce already used" after leg 1 succeeded.
  const replay = { ...buy, quote: { ...buy.quote, series: 'ETH-3500-C' } };
  expect(() => w.apply(DEMO_ACCOUNT, { kind: 'trade_batch', legs: [buy, replay] })).toThrow('nonce already used');
  const after = w.accountView(DEMO_ACCOUNT)!;
  expect(after.positions).toEqual(before.positions);
  expect(after.collateral).toBe(before.collateral);
  expect(after.lastNonce).toBe(before.lastNonce);
});

test('a spread fills as one batch where its naked short leg alone is refused', async () => {
  const w = world();
  w.apply(DEMO_ACCOUNT, { kind: 'deposit', amount: 300n * USDC_UNIT });
  const naked = await quote(w, 'ETH-3500-C', 'Sell');
  expect(() => w.apply(DEMO_ACCOUNT, { kind: 'trade', ...naked })).toThrow('insufficient margin for this trade');
  // Buys first, quotes requested in execution order so nonces increase.
  const buy = await quote(w, 'ETH-3550-C', 'Buy');
  const sell = await quote(w, 'ETH-3500-C', 'Sell');
  expect(w.apply(DEMO_ACCOUNT, { kind: 'trade_batch', legs: [buy, sell] })).toEqual(['Trade', 'Trade']);
  expect(w.accountView(DEMO_ACCOUNT)!.positions.map(p => [p.series, p.size])).toEqual([
    ['ETH-3550-C', SIZE_SCALE],
    ['ETH-3500-C', -SIZE_SCALE],
  ]);
});

test('faucet pays 2,000 USDC once per day, like the test token', () => {
  const w = world();
  const before = w.wallet('newcomer.testnet');
  expect(w.faucetNextClaim('newcomer.testnet')).toBeNull();
  w.apply('newcomer.testnet', { kind: 'faucet' });
  expect(w.wallet('newcomer.testnet') - before).toBe(2_000n * USDC_UNIT);
  expect(w.faucetNextClaim('newcomer.testnet')).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  expect(() => w.apply('newcomer.testnet', { kind: 'faucet' })).toThrow(/faucet already claimed; try again in 2[34]h \d+m/);
  expect(w.wallet('newcomer.testnet') - before).toBe(2_000n * USDC_UNIT);
});

test('the demo contract refuses a buy on credit, like the real one', async () => {
  const w = world();
  w.apply(DEMO_ACCOUNT, { kind: 'deposit', amount: 1n * USDC_UNIT });
  const big = await quote(w, 'ETH-3500-C', 'Buy', 100n * SIZE_SCALE);
  expect(() => w.apply(DEMO_ACCOUNT, { kind: 'trade', ...big })).toThrow('not enough cash to pay the premium');
  const after = w.accountView(DEMO_ACCOUNT)!;
  expect([after.collateral, after.positions.length]).toEqual([1n * USDC_UNIT, 0]);
});
