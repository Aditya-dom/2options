import { useEffect } from 'react';

/**
 * Rule 4: One-time external sync on mount.
 * Wraps useEffect(..., []) with explicit intent — only for DOM integration,
 * third-party widget lifecycles, and browser API subscriptions.
 */
// eslint-disable-next-line react-hooks/exhaustive-deps
export function useMountEffect(callback: () => void | (() => void)) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(callback, []);
}
