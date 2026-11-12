import { useState } from 'react';

export type Flash = { dir: 'up' | 'down' | null; key: number };

/**
 * Whether a cell should flash, and which way. Only a change in what the user can SEE counts:
 * a value that moved but still reads the same ($1.28 to $1.28) does not flash, and nothing
 * flashes when a value first appears or goes away.
 */
export function flashDecision(
  prev: { value: number | null; text: string },
  next: { value: number | null; text: string },
): 'up' | 'down' | null {
  if (next.text === prev.text) return null;
  if (prev.value == null || next.value == null || next.value === prev.value) return null;
  return next.value > prev.value ? 'up' : 'down';
}

/**
 * Direction of the last visible change, and a counter that increases on every flash so a keyed
 * element restarts its animation. Adapted from the earlier Pacifica frontend's `useFlash`.
 */
export function useFlash(value: number | null | undefined, text: string): Flash {
  const cur = value ?? null;
  const [s, setS] = useState<Flash & { value: number | null; text: string }>({ value: cur, text, dir: null, key: 0 });
  if (cur !== s.value || text !== s.text) {
    // Derived state: setting it during render re-renders immediately, before anything is drawn.
    const dir = flashDecision({ value: s.value, text: s.text }, { value: cur, text });
    setS(dir ? { value: cur, text, dir, key: s.key + 1 } : { ...s, value: cur, text });
  }
  return { dir: s.dir, key: s.key };
}

export const flashClass = (dir: Flash['dir']) => (dir === 'up' ? 'flash-up' : dir === 'down' ? 'flash-down' : '');
