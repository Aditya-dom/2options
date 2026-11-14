import { expect, test } from 'bun:test';
import { TABS } from '../hooks/useRoute';
import { TAB_ICONS } from './ascii';

test('every screen in the header has a drawing', () => {
  for (const tab of TABS) expect(TAB_ICONS[tab.id]).toBeDefined();
});

test('each drawing is a full grid of the three cell kinds, with ink and an accent', () => {
  for (const [name, rows] of Object.entries(TAB_ICONS)) {
    expect(rows.length).toBe(9);
    for (const row of rows) expect(row).toMatch(/^[#+.]{11}$/);
    const all = rows.join('');
    expect(all.includes('#') && all.includes('+')).toBe(true);
    expect(name).toMatch(/^[a-z]+$/);
  }
});
