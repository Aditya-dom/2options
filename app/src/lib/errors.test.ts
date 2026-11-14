import { expect, test } from 'bun:test';
import { friendlyError } from './errors';

test('faucet cooldown keeps the wait from the contract message', () => {
  const err = new Error('Smart contract panicked: faucet already claimed; try again in 23h 12m');
  expect(friendlyError(err)).toBe('You already claimed test USDC today. The faucet opens again in 23h 12m.');
});

test('plain mappings are unchanged', () => {
  expect(friendlyError(new Error('Smart contract panicked: insufficient margin for this trade'))).toMatch(/^Not enough margin/);
});

test('a buy the account cannot pay for says to deposit, not that collateral is short', () => {
  expect(friendlyError(new Error('Smart contract panicked: not enough cash to pay the premium'))).toBe(
    'You do not have enough USDC deposited to pay this premium. Deposit more or reduce the size.',
  );
});
