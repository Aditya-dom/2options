import { useEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Tokens carried over from our earlier Solana frontend (gks2022004/nerf@00fe59b, frontend/src/ThemeContext.tsx).
const DARK = {
  BG: '#000', SURFACE: '#0a0c10', PANEL: '#12151c',
  BORDER: '#2a2e38', BORDER2: '#363b48', MUTED: '#0e1016',
  WHITE: '#e8ecf4', GRAY: '#9aa3b8', DIM: '#5c6478',
  // NEAR green. On black the mint reads as text too (about 14:1), not only as a fill.
  ACCENT: '#78f0a0', ACCENT_DIM: '#0d2a1b', ACCENT_BG: 'rgba(120,240,160,0.12)',
  GREEN: '#00d492', GREEN_DIM: '#0a3324', GREEN_BG: 'rgba(0,212,146,0.12)',
  RED: '#ff5068', RED_DIM: '#3a1018', RED_BG: 'rgba(255,80,104,0.12)',
  ORANGE: '#f5a623', YELLOW: '#f0c000', PURPLE: '#9d99ff',
  MONO: "'Geist Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace",
  SANS: "'Geist', system-ui, -apple-system, sans-serif",
  /** Hard rule between panels: white on dark, black on light. */
  LINE: '#fff',
  /** Brand fill and the ink that sits on it (active tab, primary buttons). */
  BRAND: '#78f0a0', BRAND_INK: '#172325',
  ACTIVE_BG: 'linear-gradient(180deg, rgba(120,240,160,0.2), rgba(120,240,160,0.07))',
  ACTIVE_FG: '#78f0a0', ACTIVE_LINE: '#78f0a0',
  PRIMARY_FG: '#172325', PRIMARY_BG: '#78f0a0', PRIMARY_BORDER: '#78f0a0',
};

const LIGHT: typeof DARK = {
  BG: '#fff', SURFACE: '#fff', PANEL: '#fff',
  BORDER: '#d0cdc5', BORDER2: '#c0bdb5', MUTED: '#fafafa',
  WHITE: '#111', GRAY: '#555', DIM: '#888',
  // NEAR green: the mint (#78f0a0) is a fill with dark ink on it; text and lines on white use a
  // darker shade of the same green (5.4:1 on white), since the mint itself is 1.4:1.
  ACCENT: '#117a45', ACCENT_DIM: '#e8fcef', ACCENT_BG: 'rgba(120,240,160,0.22)',
  GREEN: '#00956a', GREEN_DIM: '#d5f2e8', GREEN_BG: 'rgba(0,149,106,0.08)',
  RED: '#c8304a', RED_DIM: '#fce0e5', RED_BG: 'rgba(200,48,74,0.08)',
  ORANGE: '#c08000', YELLOW: '#a88800', PURPLE: '#6e6ac8',
  MONO: DARK.MONO,
  SANS: DARK.SANS,
  LINE: '#000',
  BRAND: '#78f0a0', BRAND_INK: '#172325',
  ACTIVE_BG: '#78f0a0', ACTIVE_FG: '#172325', ACTIVE_LINE: '#172325',
  PRIMARY_FG: '#172325', PRIMARY_BG: '#78f0a0', PRIMARY_BORDER: '#3fc97a',
};

export type ThemeTokens = typeof DARK;
export type ThemeMode = 'light' | 'dark';

export const useThemeStore = create<{ mode: ThemeMode; toggle: () => void }>()(
  persist(
    // Dark by default; the toggle in the header switches and the choice is remembered. The key
    // moved to v3 so earlier visitors, who were given light by default, start dark too.
    set => ({ mode: 'dark', toggle: () => set(s => ({ mode: s.mode === 'light' ? 'dark' : 'light' })) }),
    { name: 'twooptions-theme-v3' },
  ),
);

export function useTheme() {
  const mode = useThemeStore(s => s.mode);
  const toggle = useThemeStore(s => s.toggle);
  return { t: mode === 'light' ? LIGHT : DARK, mode, toggle };
}

export function ThemeSync() {
  const { t, mode } = useTheme();
  useEffect(() => {
    const r = document.documentElement.style;
    r.setProperty('--color-scheme', mode);
    r.setProperty('--bg', t.BG);
    r.setProperty('--panel', t.PANEL);
    r.setProperty('--border', t.BORDER);
    r.setProperty('--text', t.WHITE);
    r.setProperty('--accent', t.ACCENT);
    r.setProperty('--line', t.LINE);
    r.setProperty('--green', t.GREEN);
    r.setProperty('--red', t.RED);
    document.body.style.background = t.BG;
    document.body.style.color = t.WHITE;
  }, [mode, t]);
  return null;
}
