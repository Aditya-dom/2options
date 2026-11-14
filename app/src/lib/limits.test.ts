import { expect, test } from 'bun:test';
import { limitError, type TradeLimits } from './limits';

const C = 1_000_000n;
const L: TradeLimits = { maxTradeSize: C / 10n, maxPosition: C / 10n, maxOpenInterest: C / 4n };

test('mirrors the agent: trade size, position, and closing always allowed', () => {
  expect(limitError(null, 'Buy', 50n * C, 0n)).toBeNull();
  expect(limitError(L, 'Buy', C / 10n, 0n)).toBeNull();
  expect(limitError(L, 'Buy', C, 0n)).toMatch(/0.1 contracts per trade/);
  expect(limitError(L, 'Buy', C / 20n, C / 10n)).toMatch(/held per series/);
  expect(limitError(L, 'Sell', 12n * C, 12n * C)).toBeNull(); // closing an old, larger position
  expect(limitError(L, 'Sell', C / 5n, C / 20n)).toMatch(/per trade/); // flips through zero
});
