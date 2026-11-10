import { useEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Tokens carried over from the Solana frontend (frontend/src/ThemeContext.tsx).
const DARK = {
  BG: '#000', SURFACE: '#0a0c10', PANEL: '#12151c',
  BORDER: '#2a2e38', BORDER2: '#363b48', MUTED: '#0e1016',
  WHITE: '#e8ecf4', GRAY: '#9aa3b8', DIM: '#5c6478',
  ACCENT: '#00e5ff', ACCENT_DIM: '#0a2e38', ACCENT_BG: 'rgba(0,229,255,0.12)',
  GREEN: '#00d492', GREEN_DIM: '#0a3324', GREEN_BG: 'rgba(0,212,146,0.12)',
  RED: '#ff5068', RED_DIM: '#3a1018', RED_BG: 'rgba(255,80,104,0.12)',
  ORANGE: '#f5a623', YELLOW: '#f0c000', PURPLE: '#9d99ff',
  MONO: "'JetBrains Mono', 'SFMono-Regular', 'Menlo', monospace",
  SANS: "'Outfit', system-ui, sans-serif",
};

const LIGHT: typeof DARK = {
  BG: '#fff', SURFACE: '#fff', PANEL: '#fafafa',
  BORDER: '#d0cdc5', BORDER2: '#c0bdb5', MUTED: '#f4f4f2',
  WHITE: '#111', GRAY: '#555', DIM: '#888',
  ACCENT: '#00a0b8', ACCENT_DIM: '#e0f5fa', ACCENT_BG: 'rgba(0,160,184,0.08)',
  GREEN: '#00956a', GREEN_DIM: '#d5f2e8', GREEN_BG: 'rgba(0,149,106,0.08)',
  RED: '#c8304a', RED_DIM: '#fce0e5', RED_BG: 'rgba(200,48,74,0.08)',
  ORANGE: '#c08000', YELLOW: '#a88800', PURPLE: '#6e6ac8',
  MONO: DARK.MONO,
  SANS: DARK.SANS,
};

export type ThemeTokens = typeof DARK;
export type ThemeMode = 'light' | 'dark';

const useThemeStore = create<{ mode: ThemeMode; toggle: () => void }>()(
  persist(
    set => ({ mode: 'dark', toggle: () => set(s => ({ mode: s.mode === 'light' ? 'dark' : 'light' })) }),
    { name: 'perennia-theme' },
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
    document.body.style.background = t.BG;
    document.body.style.color = t.WHITE;
  }, [mode, t]);
  return null;
}
