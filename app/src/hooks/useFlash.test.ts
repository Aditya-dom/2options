import { expect, test } from 'bun:test';
import { flashClass, flashDecision } from './useFlash';

const cell = (value: number | null, text: string) => ({ value, text });

test('a visible rise flashes up and a visible fall flashes down', () => {
  expect(flashDecision(cell(1_280_000, '$1.28'), cell(1_290_000, '$1.29'))).toBe('up');
  expect(flashDecision(cell(1_290_000, '$1.29'), cell(1_280_000, '$1.28'))).toBe('down');
});

test('a change nobody can see does not flash', () => {
  // The raw value moved, the screen reads the same.
  expect(flashDecision(cell(1_280_001, '$1.28'), cell(1_280_400, '$1.28'))).toBeNull();
  expect(flashDecision(cell(0.5912, '59.1%'), cell(0.5914, '59.1%'))).toBeNull();
});

test('nothing flashes when a value appears, disappears or is unchanged', () => {
  expect(flashDecision(cell(null, '—'), cell(1, '$1.00'))).toBeNull();
  expect(flashDecision(cell(1, '$1.00'), cell(null, '—'))).toBeNull();
  expect(flashDecision(cell(1, '$1.00'), cell(1, '$1.00'))).toBeNull();
});

test('flash class follows the direction', () => {
  expect(flashClass('up')).toBe('flash-up');
  expect(flashClass('down')).toBe('flash-down');
  expect(flashClass(null)).toBe('');
});
