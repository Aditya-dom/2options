import { describe, expect, test } from 'bun:test';
import {
  ACC_DIM, clear, DIM, GLYPHS, makeGrid, NONE, paintDivider, paintHero, paintLock, paintOrbit, paintPayoff,
  paintRidges, textBottom, TONES, type Grid, type Pointer, type Scene,
} from './ascii';

const SCENES: Record<string, Scene> = {
  hero: paintHero, orbit: paintOrbit, ridges: paintRidges, payoff: paintPayoff, lock: paintLock, divider: paintDivider,
};
/** Grids the page really makes (hero on a desktop and a phone, a feature drawing, a divider) and some degenerate ones. */
const SIZES: [number, number, number, number][] = [
  [176, 70, 6, 12], [81, 81, 4.5, 10], [65, 16, 5.5, 11], [176, 3, 6, 12], [1, 1, 6, 12], [3, 2, 6, 12], [40, 9, 6, 12],
];
const TIMES = [0, 0.4, 1.3, 7.5, 60.2, 1234.56];

function paint(scene: Scene, size: [number, number, number, number], t: number, dark = false, pointer: Pointer | null = null): Grid {
  const g = makeGrid(...size, dark);
  clear(g);
  scene(g, t, pointer);
  return g;
}
const rowText = (g: Grid, r: number) => Array.from({ length: g.cols }, (_, c) => (g.tones[r * g.cols + c] ? String.fromCharCode(g.chars[r * g.cols + c]) : ' ')).join('');
const painted = (g: Grid) => g.tones.reduce((n, tone) => n + (tone ? 1 : 0), 0);

describe('every scene', () => {
  for (const [name, scene] of Object.entries(SCENES)) {
    test(`${name} only writes glyphs and tones the renderer has`, () => {
      for (const size of SIZES) for (const t of TIMES) for (const dark of [false, true]) {
        const g = paint(scene, size, t, dark, { x: 5, y: 900 });
        for (let i = 0; i < g.tones.length; i++) {
          expect(g.tones[i]).toBeLessThan(TONES);
          if (g.tones[i] !== NONE) expect(GLYPHS).toContain(String.fromCharCode(g.chars[i]));
        }
      }
    });

    test(`${name} draws the same thing for the same moment`, () => {
      const a = paint(scene, SIZES[0], 7.5);
      const b = paint(scene, SIZES[0], 7.5);
      expect(Array.from(a.tones)).toEqual(Array.from(b.tones));
      expect(Array.from(a.chars)).toEqual(Array.from(b.chars));
    });

    test(`${name} draws something, and moves`, () => {
      const a = paint(scene, name === 'hero' ? SIZES[0] : SIZES[2], 3);
      const b = paint(scene, name === 'hero' ? SIZES[0] : SIZES[2], 4.1);
      expect(painted(a)).toBeGreaterThan(0);
      expect(Array.from(a.tones).join() + Array.from(a.chars).join()).not.toBe(Array.from(b.tones).join() + Array.from(b.chars).join());
    });
  }
});

describe('hero', () => {
  test('nothing stronger than the lattice lands behind the headline', () => {
    for (const size of [SIZES[0], SIZES[1]]) {
      const [cols, rows, cw, ch] = size;
      const clearRows = Math.floor(textBottom(cols * cw, rows * ch) / ch);
      for (let t = 0; t < 80; t += 0.9) {
        const g = paint(paintHero, size, t);
        for (let i = 0; i < clearRows * cols; i++) expect(g.tones[i]).toBeLessThanOrEqual(DIM);
      }
    }
  });

  test('the solid is there, with the accent light on it', () => {
    const g = paint(paintHero, SIZES[0], 7.5);
    expect(Array.from(g.tones).filter(tone => tone > DIM && tone < ACC_DIM).length).toBeGreaterThan(800);
    expect(Array.from(g.tones).filter(tone => tone >= ACC_DIM).length).toBeGreaterThan(20);
  });

  test('it leans towards the pointer', () => {
    const left = paint(paintHero, SIZES[0], 7.5, false, { x: 0, y: 420 });
    const right = paint(paintHero, SIZES[0], 7.5, false, { x: 1056, y: 420 });
    expect(Array.from(left.tones)).not.toEqual(Array.from(right.tones));
  });

  test('a hero too short for the solid still gets its lattice', () => {
    const g = paint(paintHero, [176, 30, 6, 12], 7.5);
    expect(painted(g)).toBeGreaterThan(0);
    expect(Math.max(...g.tones)).toBeLessThanOrEqual(DIM);
  });
});

describe('shading', () => {
  // Along the planet's diagonal: a point facing the light, and one facing away from it.
  const ink = (dark: boolean) => {
    const g = paint(paintOrbit, SIZES[2], 0, dark);
    const at = (c: number, r: number) => g.tones[r * g.cols + c];
    return { lit: at(28, 5), shaded: at(37, 11) };
  };
  test('on a white page the shadow carries the ink', () => {
    const { lit, shaded } = ink(false);
    expect(shaded).toBeGreaterThan(lit);
  });
  test('on a dark page the lit side does', () => {
    const { lit, shaded } = ink(true);
    expect(lit).toBeGreaterThan(shaded);
  });
});

describe('labels', () => {
  test('the greeks readout is a delta and a gamma', () => {
    for (const t of TIMES) expect(rowText(paint(paintRidges, SIZES[2], t), 15)).toMatch(/Δ [01]\.\d\d {3}Γ 0\.0\d\d/);
  });

  test('the payoff names the strategy it shows, in the order the page lists them', () => {
    const names = ['straddle', 'strangle', 'call spread', 'risk reversal'];
    names.forEach((name, i) => expect(rowText(paint(paintPayoff, SIZES[2], i * 3.6 + 0.5), 15).trim()).toBe(name));
  });

  test('a divider is one row', () => {
    const g = paint(paintDivider, SIZES[3], 5);
    expect(rowText(g, 0).trim()).toBe('');
    expect(rowText(g, 2).trim()).toBe('');
    expect(rowText(g, 1).trim()).not.toBe('');
  });
});
