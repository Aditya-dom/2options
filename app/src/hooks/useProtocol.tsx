/**
 * One polling loop for everything the screens read: market data from the contract and agent,
 * and the connected account's balances. Screens never fetch on their own, so a refresh after a
 * transaction updates every panel at once.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { Call, ChainRow, FaucetStatus, HedgeStatus } from '../backend/types';
import type { AccountState, LpClaim, Params, Series, SpotPoint, Underlying, Vault } from '../lib/contract';
import { isDemo, txUrl } from '../lib/config';
import { friendlyError } from '../lib/errors';
import { agent, backend, world } from '../services';
import { useWallet } from './useWallet';

// Chain mode makes about ten RPC calls per poll; free endpoints throttle anything much faster.
const POLL_MS = isDemo ? 1_000 : 5_000;
const MAX_FUNDING_EVENTS = 200;

export interface FundingEvent {
  atMs: number;
  series: string;
  epoch: bigint;
  /** Per-contract funding for the epoch, USDC micros. Positive means longs paid. */
  perContract: bigint;
  mark: bigint;
}

export interface ProtocolData {
  params: Params | null;
  series: Series[];
  spots: Partial<Record<Underlying, SpotPoint>>;
  vault: Vault | null;
  paused: boolean;
  chain: Map<string, ChainRow>;
  agentError: string | null;
  /** The agent's delta hedger; null in demo mode or when the agent does not report one. */
  hedge: HedgeStatus | null;
  account: AccountState | null;
  lpShares: bigint;
  lpClaim: LpClaim | null;
  usdc: bigint | null;
  usdcRegistered: boolean | null;
  /** The test token's faucet for the connected account; null on real USDC or when signed out. */
  faucet: FaucetStatus | null;
  fundingEvents: FundingEvent[];
  loaded: boolean;
  error: string | null;
}

interface ProtocolCtx extends ProtocolData {
  refresh: () => Promise<void>;
  /** Submit a call as the connected account; toasts the outcome and refreshes. */
  send: (call: Call, label: string) => Promise<boolean>;
}

const EMPTY: ProtocolData = {
  params: null, series: [], spots: {}, vault: null, paused: false, chain: new Map(), agentError: null, hedge: null,
  account: null, lpShares: 0n, lpClaim: null, usdc: null, usdcRegistered: null, faucet: null, fundingEvents: [],
  loaded: false, error: null,
};

/** Newest first, one row per (series, epoch). The first copy of a duplicate wins. */
export function mergeFundingEvents(events: FundingEvent[]): FundingEvent[] {
  const seen = new Set<string>();
  const out: FundingEvent[] = [];
  for (const e of events) {
    const key = `${e.series}-${e.epoch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.sort((a, b) => b.atMs - a.atMs);
}

const Ctx = createContext<ProtocolCtx | null>(null);

export function ProtocolProvider({ children }: { children: ReactNode }) {
  const accountId = useWallet(s => s.accountId);
  const [data, setData] = useState<ProtocolData>(EMPTY);
  const lastSeries = useRef<Map<string, Series>>(new Map());
  const inflight = useRef(false);
  const historyLoaded = useRef(false);

  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const [params, series, vault, paused] = await Promise.all([
        backend.getParams(), backend.listSeries(), backend.getVault(), backend.isPaused(),
      ]);
      const unique = [...new Set(series.map(s => s.underlying))];
      const spotList = await Promise.all(unique.map(u => backend.getSpot(u)));
      const spots: Partial<Record<Underlying, SpotPoint>> = {};
      unique.forEach((u, i) => { if (spotList[i]) spots[u] = spotList[i]!; });

      let chain = new Map<string, ChainRow>();
      let agentError: string | null = null;
      try {
        chain = new Map((await agent.chain()).map(r => [r.series, r]));
      } catch (e) {
        agentError = e instanceof Error ? e.message : String(e);
      }

      // Shown on the Vault page only; a failure here must not blank the rest of the app.
      const hedge = agent.hedge ? await agent.hedge().catch(() => null) : null;

      const acct = accountId
        ? await Promise.all([
            backend.getAccount(accountId), backend.getLpShares(accountId), backend.getLpClaim(accountId),
            backend.usdcBalance(accountId).catch(() => null), backend.usdcRegistered(accountId).catch(() => null),
            backend.faucetStatus?.(accountId).catch(() => null) ?? Promise.resolve(null),
          ])
        : null;

      // Funding settlements show up as a series' epoch advancing between polls.
      const now = Date.now();
      const fresh: FundingEvent[] = [];
      for (const s of series) {
        const prev = lastSeries.current.get(s.id);
        if (prev && s.lastEpoch > prev.lastEpoch) {
          fresh.push({ atMs: now, series: s.id, epoch: s.lastEpoch, perContract: s.fundingIndex - prev.fundingIndex, mark: s.lastMark });
        }
      }
      lastSeries.current = new Map(series.map(s => [s.id, s]));

      // The quote server keeps past settlements; load them once so the page is not empty on open.
      let history: FundingEvent[] = [];
      if (!historyLoaded.current && agent.fundingHistory) {
        try {
          history = await agent.fundingHistory(MAX_FUNDING_EVENTS);
          historyLoaded.current = true;
        } catch { /* retried on the next poll */ }
      }

      setData(d => ({
        params, series, spots, vault, paused, chain, agentError, hedge,
        account: acct?.[0] ?? null,
        lpShares: acct?.[1] ?? 0n,
        lpClaim: acct?.[2] ?? null,
        usdc: acct?.[3] ?? null,
        usdcRegistered: acct?.[4] ?? null,
        faucet: acct?.[5] ?? null,
        fundingEvents: fresh.length || history.length
          ? mergeFundingEvents([...fresh, ...d.fundingEvents, ...history]).slice(0, MAX_FUNDING_EVENTS)
          : d.fundingEvents,
        loaded: true,
        error: null,
      }));
    } catch (e) {
      setData(d => ({ ...d, loaded: true, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      inflight.current = false;
    }
  }, [accountId]);

  useEffect(() => {
    world?.start();
    void load();
    const t = setInterval(load, POLL_MS);
    return () => { clearInterval(t); };
  }, [load]);

  const send = useCallback(async (call: Call, label: string) => {
    if (!accountId) {
      toast.error('Connect a wallet first.');
      return false;
    }
    const id = toast.loading(`${label}…`);
    try {
      const res = await backend.submit(accountId, call);
      toast.success(label, {
        id,
        description: res.txHash ? 'Confirmed on chain.' : isDemo ? 'Demo contract updated.' : 'Submitted. Balances refresh shortly.',
        action: res.txHash ? { label: 'View', onClick: () => window.open(txUrl(res.txHash!), '_blank', 'noopener') } : undefined,
      });
      return true;
    } catch (e) {
      const hash = (e as { txHash?: string | null }).txHash;
      toast.error(`${label} failed`, {
        id,
        description: friendlyError(e),
        action: hash ? { label: 'View', onClick: () => window.open(txUrl(hash), '_blank', 'noopener') } : undefined,
      });
      return false;
    } finally {
      void load();
    }
  }, [accountId, load]);

  return <Ctx.Provider value={{ ...data, refresh: load, send }}>{children}</Ctx.Provider>;
}

export function useProtocol(): ProtocolCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useProtocol outside ProtocolProvider');
  return v;
}

/** Re-render every `ms` for countdowns. */
export function useNow(ms = 250): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
