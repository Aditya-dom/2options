/**
 * Trade history from chain. NEAR RPC cannot list past transactions, so this reads them from
 * NearBlocks (the explorer the app already links to): the account's transactions to the
 * contract, then the details of each successful `trade` call. A trade call carries the signed
 * quote, and the contract fills a quote in full or reverts, so one successful call is exactly
 * one fill at the quote's size and price. Past transactions never change, so details are cached.
 */

import type { NetworkId } from './config';
import type { Side } from './contract';
import { big } from './units';

export interface Fill {
  txHash: string;
  /** Position of the trade within its transaction (multi-leg strategies have several). */
  leg: number;
  atMs: number;
  series: string;
  side: Side;
  /** Size units, 1e6 per contract. */
  size: bigint;
  /** USDC micros per contract. */
  price: bigint;
}

const API: Record<NetworkId, string> = {
  testnet: 'https://api-testnet.nearblocks.io',
  mainnet: 'https://api.nearblocks.io',
};

/** One row of `/v3/accounts/{account}/txns` (the fields this reads). */
export interface TxListRow {
  transaction_hash: string;
  block_timestamp: string;
  actions: { action: string; method?: string | null }[];
  outcomes: { status: boolean };
}

/** `/v3/txns/{hash}` (the fields this reads). */
export interface TxDetail {
  transaction_hash: string;
  block_timestamp: string;
  actions: { action: string; method?: string | null; args?: { args_json?: unknown; args_base64?: string | null } | null }[];
  outcomes: { status: boolean };
}

/** Successful transactions that contain at least one `trade` call. */
export const tradeTxs = (rows: TxListRow[]) =>
  rows.filter(r => r.outcomes?.status && r.actions.some(a => a.action === 'FUNCTION_CALL' && a.method === 'trade'));

function tradeArgs(a: TxDetail['actions'][number]): { quote: { series: string; side: Side; size: string; price: string } } | null {
  const raw = a.args?.args_json ?? (a.args?.args_base64 ? JSON.parse(atob(a.args.args_base64)) : null);
  const args = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const q = (args as { quote?: Record<string, unknown> } | null)?.quote;
  if (!q || typeof q.series !== 'string' || (q.side !== 'Buy' && q.side !== 'Sell')) return null;
  return { quote: { series: q.series, side: q.side, size: String(q.size), price: String(q.price) } };
}

/** The fills in one transaction: one per `trade` action, in order. Nothing if it failed. */
export function fillsOf(tx: TxDetail): Fill[] {
  if (!tx.outcomes?.status) return [];
  const atMs = Number(big(tx.block_timestamp) / 1_000_000n);
  const out: Fill[] = [];
  let leg = 0;
  for (const a of tx.actions) {
    if (a.action !== 'FUNCTION_CALL' || a.method !== 'trade') continue;
    const t = tradeArgs(a);
    if (t) out.push({ txHash: tx.transaction_hash, leg: leg++, atMs, series: t.quote.series, side: t.quote.side, size: big(t.quote.size), price: big(t.quote.price) });
  }
  return out;
}

const CACHE_KEY = 'twooptions-fills-v1';
type Cache = Record<string, { s: string; d: Side; z: string; p: string; t: number; l: number }[]>;

function readCache(): Cache {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') as Cache; } catch { return {}; }
}
function writeCache(c: Cache) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch { /* storage unavailable: fetched again next time */ }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`NearBlocks: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Fills for `account` on `contract`, newest first. At most `maxNew` transactions are fetched in
 * detail per call (the free API is rate-limited); the rest arrive on later calls.
 */
export async function fetchFills(network: NetworkId, account: string, contract: string, maxNew = 8): Promise<Fill[]> {
  const base = API[network];
  const list = await getJson<{ data: TxListRow[] | null }>(
    `${base}/v3/accounts/${encodeURIComponent(account)}/txns?receiver=${encodeURIComponent(contract)}&limit=50`,
  );
  const txs = tradeTxs(list.data ?? []);
  const cache = readCache();
  let fetched = 0;
  for (const r of txs) {
    if (cache[r.transaction_hash] || fetched >= maxNew) continue;
    const d = await getJson<{ data: TxDetail | null }>(`${base}/v3/txns/${r.transaction_hash}`);
    fetched++;
    if (!d.data) continue;
    cache[r.transaction_hash] = fillsOf(d.data).map(f => ({ s: f.series, d: f.side, z: f.size.toString(), p: f.price.toString(), t: f.atMs, l: f.leg }));
  }
  if (fetched) writeCache(cache);
  return txs
    .flatMap(r => (cache[r.transaction_hash] ?? []).map(c => ({
      txHash: r.transaction_hash, leg: c.l, atMs: c.t, series: c.s, side: c.d, size: big(c.z), price: big(c.p),
    })))
    .sort((a, b) => b.atMs - a.atMs || a.leg - b.leg);
}
