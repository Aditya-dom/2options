import { expect, test } from 'bun:test';
import type { AccountState, Params, Series } from './contract';
import { executionOrder, previewBatch, previewTrade } from './preview';
import { SIZE_SCALE, SPOT_SCALE, USDC_UNIT } from './units';

const params: Params = {
  max_quote_ttl_ns: 10_000_000_000n, max_spot_age_ns: 30_000_000_000n, max_positions: 16,
  max_funding_rate: 40_000_000n, funding_interval_ns: 3_600_000_000_000n, lp_cooldown_ns: 3_600_000_000_000n,
  min_deposit: 1_000_000n, initial_ratio_bps: 15_000n, close_only_ratio_bps: 13_000n, liquidation_ratio_bps: 11_500n,
  vault_ratio_bps: 12_000n, min_time_value_bps: 20n, max_time_value_bps: 150n, tv_reserve_bps: 100n,
  min_margin_per_contract: 5_000_000n, mark_band_bps: 100n, max_epoch_outflow_bps: 1_000n,
};

const call3500: Series = {
  id: 'ETH-3500-C', underlying: 'ETH', strike: 3_500n * SPOT_SCALE, kind: 'Call',
  fundingIndex: 0n, lastMark: 12n * USDC_UNIT, lastEpoch: 0n, netTraderSize: 0n, active: true, refMark: null, refSpot: null,
};
const series = new Map([[call3500.id, call3500]]);
const spots = { ETH: { price: 3_500n * SPOT_SCALE, tsNs: 0n } };
const account = (collateral: bigint): AccountState => ({
  collateral: collateral * USDC_UNIT, positions: [], lastNonce: 0n, equity: null, requirement: null,
});

test('buying a call needs only the premium and has no requirement', () => {
  const p = previewTrade({ account: account(100n), series, spots, params, trade: { series: call3500.id, side: 'Buy', size: SIZE_SCALE, price: 12n * USDC_UNIT } })!;
  expect(p.cash).toBe(12n * USDC_UNIT);
  expect(p.reqAfter).toBe(0n);
  expect(p.failure).toBeNull();
});

test('a short ATM call needs about $1,100 at 3,500 (handoff §6)', () => {
  const trade = { series: call3500.id, side: 'Sell' as const, size: SIZE_SCALE, price: 12n * USDC_UNIT };
  // +20% shock = $700 intrinsic, plus 1% of spot reserve = $735 requirement. Equity after the
  // fill is collateral + $12 premium − $12 short mark, so it must reach 1.5 × 735 = $1,102.50.
  const thin = previewTrade({ account: account(1_102n), series, spots, params, trade })!;
  expect(thin.reqAfter).toBe(735n * USDC_UNIT);
  expect(thin.failure).toBe('insufficient margin for this trade');
  const ok = previewTrade({ account: account(1_103n), series, spots, params, trade })!;
  expect(ok.failure).toBeNull();
  expect(ok.ratioAfterBps! >= 15_000n).toBe(true);
});

test('no account means the contract will say deposit first', () => {
  const p = previewTrade({ account: null, series, spots, params, trade: { series: call3500.id, side: 'Buy', size: SIZE_SCALE, price: 12n * USDC_UNIT } })!;
  expect(p.failure).toBe('deposit first');
});

test('a call spread fits where a naked short does not, but only with the buy first', () => {
  const call3550: Series = { ...call3500, id: 'ETH-3550-C', strike: 3_550n * SPOT_SCALE, lastMark: 1n * USDC_UNIT };
  const both = new Map([[call3500.id, call3500], [call3550.id, call3550]]);
  const ctx = { account: account(300n), series: both, spots, params };
  const sell = { series: call3500.id, side: 'Sell' as const, size: SIZE_SCALE, price: 12n * USDC_UNIT };
  const buy = { series: call3550.id, side: 'Buy' as const, size: SIZE_SCALE, price: 1n * USDC_UNIT };

  expect(previewBatch(ctx, [sell])!.failure).toBe('insufficient margin for this trade');
  const ordered = previewBatch(ctx, executionOrder([sell, buy]))!;
  expect(ordered.failure).toBeNull();
  // Max loss of the spread at +20% is the $50 strike width, plus the 1% reserve on the short.
  expect(ordered.reqAfter).toBe(85n * USDC_UNIT);
  expect(ordered.cash).toBe(11n * USDC_UNIT); // net credit
  const reversed = previewBatch(ctx, [sell, buy])!;
  expect(reversed.failedLeg).toBe(0);
});

test('pending funding is settled before the margin check', () => {
  const acct: AccountState = {
    collateral: 1_000n * USDC_UNIT, lastNonce: 0n, equity: null, requirement: null,
    positions: [{ series: call3500.id, size: 2n * SIZE_SCALE, mark: 0n, value: 0n, entryIndex: 0n }],
  };
  const funded = new Map([[call3500.id, { ...call3500, fundingIndex: 500_000n }]]);
  const p = previewTrade({ account: acct, series: funded, spots, params, trade: { series: call3500.id, side: 'Buy', size: SIZE_SCALE, price: 12n * USDC_UNIT } })!;
  expect(p.pendingFunding).toBe(1_000_000n);
});

test('a buy must be paid in full from cash, after the funding the contract settles first', () => {
  const buy = (contracts: bigint) => ({ series: call3500.id, side: 'Buy' as const, size: contracts * SIZE_SCALE, price: 12n * USDC_UNIT });
  // 1 USDC cannot pay 1,200 of premium, although a long has no margin requirement.
  const credit = previewTrade({ account: account(1n), series, spots, params, trade: buy(100n) })!;
  expect(credit.reqAfter).toBe(0n);
  expect(credit.failure).toBe('not enough cash to pay the premium');
  expect(previewTrade({ account: account(12n), series, spots, params, trade: buy(1n) })!.failure).toBeNull();

  // Holding one call entered at index 0 with the index now at 0.50: 0.50 USDC is settled first,
  // so 12.25 in cash is no longer enough for a 12.00 premium.
  const settled = new Map([[call3500.id, { ...call3500, fundingIndex: 500_000n }]]);
  const holder: AccountState = {
    collateral: 12_250_000n, lastNonce: 0n, equity: null, requirement: null,
    positions: [{ series: call3500.id, size: SIZE_SCALE, mark: 12n * USDC_UNIT, value: 0n, entryIndex: 0n }],
  };
  const p = previewTrade({ account: holder, series: settled, spots, params, trade: buy(1n) })!;
  expect(p.pendingFunding).toBe(500_000n);
  expect(p.failure).toBe('not enough cash to pay the premium');
});

test('a batch stops at the first buy the account cannot pay for', () => {
  const call3550: Series = { ...call3500, id: 'ETH-3550-C', strike: 3_550n * SPOT_SCALE, lastMark: 1n * USDC_UNIT };
  const both = new Map([[call3500.id, call3500], [call3550.id, call3550]]);
  const legs = [
    { series: call3550.id, side: 'Buy' as const, size: SIZE_SCALE, price: 1n * USDC_UNIT },
    { series: call3500.id, side: 'Buy' as const, size: SIZE_SCALE, price: 12n * USDC_UNIT },
  ];
  const p = previewBatch({ account: account(12n), series: both, spots, params }, legs)!;
  expect([p.failure, p.failedLeg]).toEqual(['not enough cash to pay the premium', 1]);
});
