import { useCallback, useEffect, useState } from 'react';

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const KEY = 'twooptions-panel-sizes';

function read(name: string): number | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}')[name];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch { return null; }
}

function write(name: string, value: number) {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    localStorage.setItem(KEY, JSON.stringify({ ...all, [name]: value }));
  } catch { /* storage unavailable: the size just resets on reload */ }
}

/**
 * A panel dimension in pixels that the user can change, remembered between visits.
 * `limits` may change with the window; the value is clamped when read, never stored out of range.
 */
export function usePanelSize(name: string, initial: number, limits: () => [number, number]) {
  const [raw, setRaw] = useState(() => read(name) ?? initial);
  const [lo, hi] = limits();
  const size = clamp(raw, lo, hi);

  /** Grow (positive) or shrink (negative) by `px`. Several calls between renders add up. */
  const nudge = useCallback((px: number) => {
    setRaw(prev => {
      const [a, b] = limits();
      return clamp(clamp(prev, a, b) + px, a, b);
    });
  }, [limits]);

  useEffect(() => { write(name, raw); }, [name, raw]);

  const reset = useCallback(() => setRaw(initial), [initial]);
  return { size, nudge, reset };
}
