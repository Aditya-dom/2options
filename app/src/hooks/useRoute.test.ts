import { expect, test } from 'bun:test';
import { href, parseRoute, TABS } from './useRoute';

test('every screen round-trips through its address', () => {
  for (const t of TABS) expect(parseRoute(href(t.id))).toBe(t.id);
  expect(parseRoute(href('landing'))).toBe('landing');
});

test('an empty or unknown address is the landing page', () => {
  for (const hash of ['', '#', '#/', '#/nope']) expect(parseRoute(hash)).toBe('landing');
});
