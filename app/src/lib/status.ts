/**
 * Operational status: one verdict per moving part, from data the app already reads plus the
 * agent's /health. Pure, so every rule is unit-tested; the page only renders the result.
 *
 * A check is `critical` when trading cannot work without it. Any critical check that is down
 * makes the whole system an outage; anything else that is down or warning makes it degraded.
 */

import type { AgentHealth, HedgeStatus, Solvency } from '../backend/types';
import type { Params, Series, SpotPoint, Underlying, Vault } from './contract';
import { fmtUsdc, NS_PER_MS } from './units';

export type Level = 'ok' | 'warn' | 'down' | 'off' | 'unknown';
export type Overall = 'operational' | 'degraded' | 'outage' | 'checking';

export interface Check {
  id: 'contract' | 'spot' | 'funding' | 'vault' | 'solvency' | 'agent' | 'agent-key' | 'keeper' | 'hedger';
  label: string;
  level: Level;
  summary: string;
  critical: boolean;
}

export interface StatusReport {
  overall: Overall;
  headline: string;
  checks: Check[];
}

export interface StatusInput {
  mode: 'demo' | 'chain';
  /** False until the first poll of the contract has finished. */
  loaded: boolean;
  /** Why the contract could not be read, if it could not. */
  contractError: string | null;
  paused: boolean;
  params: Params | null;
  series: Series[];
  spots: Partial<Record<Underlying, SpotPoint>>;
  vault: Vault | null;
  /** Null while unknown; `'unavailable'` where the backend cannot report it (the demo). */
  solvency: Solvency | 'unavailable' | null;
  agentKind: 'http' | 'mock';
  agentError: string | null;
  /** Series the agent returned a price for on the last poll. */
  quoted: number;
  /** `is_agent_key` for the agent's key; null while unknown. */
  agentKeyRegistered: boolean | null;
  /** The agent's /health; null when it did not answer. */
  health: AgentHealth | null;
  hedge: HedgeStatus | null;
}

/** What the checks that depend on contract reads say when the contract cannot be read at all. */
const BLIND = 'Unknown while the contract cannot be read.';

/** The keeper reads an account with open positions every 15 s; this far behind, it has more of them than it can keep up with. */
const SCAN_LATE_S = 60;
/** The keeper settles one series per pass, a few seconds each, starting 15 s into the interval. */
const FUNDING_GRACE_MS = 5 * 60_000;
const HEDGE_STALE_MS = 60_000;
const secs = (ms: number) => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1_000))} s` : `${Math.round(ms / 60_000)} min`);
const x = (bps: bigint) => `${(Number(bps) / 10_000).toFixed(2)}×`;

function contract(i: StatusInput): Check {
  const base = { id: 'contract' as const, label: 'Contract', critical: true };
  if (i.contractError) return { ...base, level: 'down', summary: `Cannot be read: ${i.contractError}` };
  if (!i.loaded) return { ...base, level: 'unknown', summary: 'Reading the contract…' };
  if (i.paused) return { ...base, level: 'warn', summary: 'Trading and deposits are paused by the operator. Withdrawals, LP claims and liquidations still work.' };
  return { ...base, level: 'ok', summary: i.mode === 'demo' ? 'Simulated in this browser; trading is open.' : 'Reachable; trading and deposits are open.' };
}

function spot(i: StatusInput, nowMs: number): Check {
  const base = { id: 'spot' as const, label: 'Price feed', critical: true };
  // One cause, one alarm: an unreadable contract is not evidence that the price is missing.
  if (i.contractError) return { ...base, level: 'unknown', summary: BLIND };
  if (!i.params || !i.loaded) return { ...base, level: 'unknown', summary: 'Waiting for the contract…' };
  const wanted = [...new Set(i.series.map(s => s.underlying))].sort();
  if (wanted.length === 0) return { ...base, level: 'off', summary: 'No series are listed, so no price is needed.' };
  const maxMs = Number(i.params.max_spot_age_ns / NS_PER_MS);
  let level: Level = 'ok';
  const parts: string[] = [];
  for (const u of wanted) {
    const sp = i.spots[u];
    if (!sp) { level = 'down'; parts.push(`${u} has no price on chain`); continue; }
    const age = nowMs - Number(sp.tsNs / NS_PER_MS);
    if (age > maxMs) { level = 'down'; parts.push(`${u} is ${secs(age)} old`); }
    else if (age > maxMs / 2) { if (level === 'ok') level = 'warn'; parts.push(`${u} is ${secs(age)} old`); }
    else parts.push(`${u} ${secs(age)} old`);
  }
  const limit = `limit ${secs(maxMs)}`;
  if (level === 'down') return { ...base, level, summary: `${parts.join('; ')} (${limit}). The contract refuses trades and LP actions until a fresh price is posted.` };
  if (level === 'warn') return { ...base, level, summary: `${parts.join('; ')} (${limit}). Past half the limit the agent stops signing quotes.` };
  return { ...base, level, summary: `On-chain price is fresh: ${parts.join(', ')} (${limit}).` };
}

function funding(i: StatusInput, nowMs: number): Check {
  const base = { id: 'funding' as const, label: 'Funding settlement', critical: false };
  if (i.contractError) return { ...base, level: 'unknown', summary: BLIND };
  if (!i.params || !i.loaded) return { ...base, level: 'unknown', summary: 'Waiting for the contract…' };
  const active = i.series.filter(s => s.active);
  if (active.length === 0) return { ...base, level: 'off', summary: 'No active series.' };
  const interval = i.params.funding_interval_ns;
  const nowNs = BigInt(Math.floor(nowMs)) * NS_PER_MS;
  const epoch = nowNs / interval;
  const intoMs = Number((nowNs % interval) / NS_PER_MS);
  const intervalMs = Number(interval / NS_PER_MS);
  const current = active.filter(s => s.lastEpoch >= epoch).length;
  const missed = active.filter(s => s.lastEpoch + 1n < epoch);
  const every = `every ${secs(intervalMs)}`;
  if (missed.length > 0) {
    const never = missed.filter(s => s.lastEpoch === 0n).length;
    const worst = missed.reduce((m, s) => (s.lastEpoch !== 0n && epoch - s.lastEpoch > m ? epoch - s.lastEpoch : m), 0n);
    const what = never === missed.length
      ? `${never} of ${active.length} series have never been settled`
      : `${missed.length} of ${active.length} series missed a settlement (up to ${worst} intervals behind)`;
    return { ...base, level: 'down', summary: `${what}. Funding settles ${every}; until it does, longs are not charged and marks go stale.` };
  }
  if (current === active.length) return { ...base, level: 'ok', summary: `All ${active.length} series are settled for the current interval (${every}).` };
  const grace = Math.min(FUNDING_GRACE_MS, intervalMs * 0.75);
  const progress = `${current} of ${active.length} series settled, ${secs(intoMs)} into the interval`;
  if (intoMs <= grace) return { ...base, level: 'ok', summary: `Settling now: ${progress}.` };
  return { ...base, level: 'warn', summary: `Running late: ${progress} (${every}).` };
}

function vault(i: StatusInput): Check {
  const base = { id: 'vault' as const, label: 'LP vault', critical: false };
  const v = i.vault;
  if (i.contractError) return { ...base, level: 'unknown', summary: BLIND };
  if (!v || !i.params) return { ...base, level: 'unknown', summary: 'Waiting for the contract…' };
  if (v.cash + v.insurance < 0n) return { ...base, level: 'down', summary: 'Vault cash plus insurance is negative, so withdrawals and LP claims are halted until it is recapitalised.' };
  if (v.totalShares === 0n) return { ...base, level: 'warn', summary: 'No LP liquidity yet: the vault cannot be the counterparty to a trade.' };
  if (v.equity == null) return { ...base, level: 'unknown', summary: 'Equity cannot be computed while a price is stale.' };
  const min = i.params.vault_ratio_bps;
  const req = v.requirement ?? 0n;
  const ratio = req > 0n ? (v.equity * 10_000n) / req : null;
  const health = ratio == null ? 'no open risk' : `health ${x(ratio)} against a ${x(min)} minimum`;
  if (ratio != null && ratio < min) return { ...base, level: 'warn', summary: `At its risk limit (${health}): trades that add risk to the vault are refused.` };
  if (v.epochNetOutflow != null && v.epochStartCash != null) {
    const cap = (v.epochStartCash * i.params.max_epoch_outflow_bps) / 10_000n;
    if (cap > 0n && v.epochNetOutflow > 0n && v.epochNetOutflow * 100n >= cap * 80n) {
      return { ...base, level: 'warn', summary: `Has paid traders ${fmtUsdc(v.epochNetOutflow, 0)} of the ${fmtUsdc(cap, 0)} it may pay out this interval; sells to the vault are refused at the limit.` };
    }
  }
  if (ratio != null && ratio < (min * 5n) / 4n) return { ...base, level: 'warn', summary: `Close to its risk limit (${health}).` };
  return { ...base, level: 'ok', summary: `Equity ${fmtUsdc(v.equity, 0)}, ${health}.` };
}

function solvency(i: StatusInput): Check {
  const base = { id: 'solvency' as const, label: 'Ledger', critical: true };
  const s = i.solvency;
  if (s === 'unavailable') return { ...base, level: 'off', summary: 'Not tracked by the in-browser demo.' };
  if (!s) return { ...base, level: 'unknown', summary: 'Reading the ledger…' };
  if (s.ledgerTotal !== s.netInflow) {
    return { ...base, level: 'down', summary: `MISMATCH: balances add up to ${fmtUsdc(s.ledgerTotal)} but the contract has taken in ${fmtUsdc(s.netInflow)} net. This must never happen; stop trading and investigate.` };
  }
  return { ...base, level: 'ok', summary: `Every balance is backed: trader cash, vault cash, insurance and pending LP claims add up to the ${fmtUsdc(s.netInflow, 0)} of USDC received.` };
}

function agent(i: StatusInput): Check {
  const base = { id: 'agent' as const, label: 'Quote server', critical: true };
  if (i.mode === 'demo') return { ...base, level: 'off', summary: 'Prices are computed in this browser; no agent is involved.' };
  if (i.agentKind !== 'http') return { ...base, level: 'down', summary: 'No agent is configured (VITE_AGENT_URL), so nothing can sign quotes and trading is disabled.' };
  if (i.agentError) return { ...base, level: 'down', summary: `Not answering: ${i.agentError}. No quotes can be signed.` };
  if (!i.loaded) return { ...base, level: 'unknown', summary: 'Asking the agent…' };
  const listed = i.series.length;
  if (listed > 0 && i.quoted === 0) return { ...base, level: 'warn', summary: 'Answering, but pricing no series: it waits for a fresh on-chain price.' };
  return { ...base, level: 'ok', summary: `Answering and pricing ${i.quoted} of ${listed} series.` };
}

function agentKey(i: StatusInput): Check {
  const base = { id: 'agent-key' as const, label: 'Agent key', critical: true };
  if (i.mode === 'demo' || i.agentKind !== 'http') return { ...base, level: 'off', summary: 'No signed quotes in this mode.' };
  if (i.agentKeyRegistered === false) return { ...base, level: 'down', summary: "The agent's key is not registered on the contract, so every quote it signs is rejected." };
  if (i.agentKeyRegistered == null && i.agentError) return { ...base, level: 'unknown', summary: 'Unknown: the agent did not answer, so its key could not be read.' };
  if (i.agentKeyRegistered == null) return { ...base, level: 'unknown', summary: "Checking the agent's key against the contract…" };
  return { ...base, level: 'ok', summary: 'The key that signs quotes is registered on the contract.' };
}

function keeper(i: StatusInput, nowMs: number): Check {
  const base = { id: 'keeper' as const, label: 'Keeper', critical: false };
  if (i.mode === 'demo') return { ...base, level: 'off', summary: 'The demo posts its own prices and settles its own funding.' };
  if (i.agentKind !== 'http') return { ...base, level: 'off', summary: 'No agent is configured.' };
  if (!i.health) return { ...base, level: 'unknown', summary: 'Unknown: the agent did not answer /health.' };
  const k = i.health.keeper;
  if (!k) return { ...base, level: 'warn', summary: 'This agent runs without a keeper. Unless another process does the job, nothing posts prices, settles funding or liquidates.' };
  if (k.errors.spot) return { ...base, level: 'down', summary: `Price posts are failing: ${k.errors.spot}` };
  const failing = Object.entries(k.errors)[0];
  if (failing) return { ...base, level: 'warn', summary: `The ${failing[0]} job is failing: ${failing[1]}` };
  const held = Object.entries(k.spotHold)[0];
  if (held) return { ...base, level: 'warn', summary: `Holding back the ${held[0]} price instead of posting it: ${held[1]}` };
  if (k.watch && k.watch.behindS > SCAN_LATE_S) {
    return { ...base, level: 'warn', summary: `The liquidation scan is ${Math.round(k.watch.behindS)} s behind: ${k.watch.withPositions} accounts hold positions, more than it reads in time. An account that falls below its margin is closed later than it should be.` };
  }
  const last = Math.max(0, ...Object.values(k.lastSpotPostMs));
  const posted = last > 0 ? `last price sent ${secs(nowMs - last)} ago` : 'no price sent yet';
  const liq = k.liquidations === 1 ? '1 liquidation' : `${k.liquidations} liquidations`;
  const watching = k.watch ? `; watching ${k.watch.accounts === 1 ? '1 account' : `${k.watch.accounts} accounts`}` : '';
  return { ...base, level: 'ok', summary: `Running: ${posted}; ${liq} since it started${watching}.` };
}

function hedger(i: StatusInput, nowMs: number): Check {
  const base = { id: 'hedger' as const, label: 'Delta hedge', critical: false };
  if (i.mode === 'demo') return { ...base, level: 'off', summary: 'Not simulated in the demo.' };
  const h = i.hedge;
  if (!h) return { ...base, level: i.agentError || i.agentKind !== 'http' ? 'off' : 'unknown', summary: 'The agent reports no hedger.' };
  if (!h.enabled) return { ...base, level: 'off', summary: "Switched off: LPs carry the vault's net delta." };
  const where = `${h.venue ?? 'venue'} ${h.network ?? ''}`.trim();
  if (h.error) return { ...base, level: 'warn', summary: `Last pass failed, so no order was sent: ${h.error}` };
  if (h.updatedMs != null && nowMs - h.updatedMs > HEDGE_STALE_MS) return { ...base, level: 'warn', summary: `Has not reported for ${secs(nowMs - h.updatedMs)}; the position shown may be out of date.` };
  const held = h.rows.find(r => r.state === 'hold');
  if (held) return { ...base, level: 'warn', summary: `Holding ${held.underlying} unchanged: ${held.reason}.` };
  const pos = h.rows.map(r => `${r.underlying} position ${r.position ?? 0} against a target of ${r.target ?? 0}`).join(', ');
  return { ...base, level: 'ok', summary: `Running on ${where}${pos ? `: ${pos}` : ''}. The hedge is off chain, in an account the operator holds.` };
}

export function buildStatus(i: StatusInput, nowMs: number): StatusReport {
  const checks = [contract(i), spot(i, nowMs), solvency(i), agent(i), agentKey(i), keeper(i, nowMs), funding(i, nowMs), vault(i), hedger(i, nowMs)];
  const names = (cs: Check[]) => cs.map(c => c.label.toLowerCase()).join(', ');
  const outage = checks.filter(c => c.critical && c.level === 'down');
  const trouble = checks.filter(c => c.level === 'down' || c.level === 'warn');
  if (outage.length) return { overall: 'outage', headline: `Outage: ${names(outage)}`, checks };
  if (!i.loaded) return { overall: 'checking', headline: 'Checking…', checks };
  if (trouble.length) return { overall: 'degraded', headline: `Degraded: ${names(trouble)}`, checks };
  return { overall: 'operational', headline: i.mode === 'demo' ? 'Demo is running' : 'All systems operational', checks };
}
