import { expect, test } from 'bun:test';
import { clamp } from './usePanelSize';

test('clamp keeps a size inside its limits', () => {
  expect(clamp(100, 280, 420)).toBe(280);
  expect(clamp(500, 280, 420)).toBe(420);
  expect(clamp(300, 280, 420)).toBe(300);
});
