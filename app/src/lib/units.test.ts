import { expect, test } from 'bun:test';
import { big, fmtFixed, fmtPremium, fmtUsdc, formatUnits, parseUnits } from './units';

test('parseUnits accepts plain decimals and rejects over-precise or junk input', () => {
  expect(parseUnits('12', 6)).toBe(12_000_000n);
  expect(parseUnits('12.5', 6)).toBe(12_500_000n);
  expect(parseUnits('.25', 6)).toBe(250_000n);
  expect(parseUnits('0.000001', 6)).toBe(1n);
  expect(parseUnits('0.0000001', 6)).toBeNull();
  expect(parseUnits('', 6)).toBeNull();
  expect(parseUnits('.', 6)).toBeNull();
  expect(parseUnits('-1', 6)).toBeNull();
  expect(parseUnits('1e3', 6)).toBeNull();
});

test('formatUnits round-trips exactly', () => {
  for (const s of ['0', '1', '12.5', '0.000001', '3500.12345678']) {
    expect(formatUnits(parseUnits(s, 8)!, 8)).toBe(s);
  }
  expect(formatUnits(-1_500_000n, 6)).toBe('-1.5');
  expect(formatUnits(2_000_000n, 6, 2)).toBe('2.00');
});

test('fmtFixed rounds half away from zero and never shows -0', () => {
  expect(fmtFixed(12_345_678n, 6, 2)).toBe('12.35');
  expect(fmtFixed(-12_345_678n, 6, 2)).toBe('-12.35');
  expect(fmtFixed(-4_000n, 6, 2)).toBe('0.00');
  expect(fmtFixed(350_000_000_000n, 8, 0)).toBe('3,500');
  expect(fmtUsdc(1_234_567_890_000n)).toBe('$1,234,567.89');
  expect(fmtUsdc(-474_400n, 4)).toBe('-$0.4744');
  expect(fmtUsdc(-4_000n)).toBe('$0.00');
});

test('fmtPremium keeps small option prices visible', () => {
  expect(fmtPremium(0n)).toBe('$0.00');
  expect(fmtPremium(4_321n)).toBe('$0.0043');
  expect(fmtPremium(12_040_000n)).toBe('$12.04');
});

test('big rejects non-integers', () => {
  expect(big('-42')).toBe(-42n);
  expect(() => big('1.5')).toThrow();
  expect(() => big(1.5)).toThrow();
});
