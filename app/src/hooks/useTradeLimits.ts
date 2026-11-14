import { useEffect, useState } from 'react';
import type { TradeLimits } from '../lib/limits';
import { agent } from '../services';

let cached: Promise<TradeLimits | null> | null = null;

/** The agent's size limits, fetched once per page load. Null while loading or when there are none. */
export function useTradeLimits(): TradeLimits | null {
  const [limits, setLimits] = useState<TradeLimits | null>(null);
  useEffect(() => {
    cached ??= (agent.limits?.() ?? Promise.resolve(null)).catch(() => { cached = null; return null; });
    let live = true;
    void cached.then(l => { if (live) setLimits(l); });
    return () => { live = false; };
  }, []);
  return limits;
}
