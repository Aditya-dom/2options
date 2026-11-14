/**
 * Print the status page's verdict for a live deployment, from the command line:
 *
 *     cd app && bun scripts/live_status.ts
 *
 * Reads VITE_CONTRACT_ID, VITE_AGENT_URL and VITE_NEAR_RPC_URL (bun loads app/.env). It runs
 * the same rules as the page (src/lib/status.ts) on the same reads, so it doubles as a check of
 * the page against the real contract and agent. Exits 1 on an outage.
 *
 * Checked on Nov 14 by stopping the agent: "Outage: quote server" at once, and "Outage: price
 * feed, quote server" once the on-chain price passed its 30 s limit; operational again after a
 * restart.
 */

import { HttpAgent } from '../src/backend/agent';
import { viewCall } from '../src/backend/rpc';
import {
  parseParams, parseSeries, parseSpot, parseVault, type ParamsJson, type SeriesViewJson, type SpotPoint, type Underlying,
  type VaultViewJson,
} from '../src/lib/contract';
import { buildStatus } from '../src/lib/status';

const env = process.env;
const contract = env.VITE_CONTRACT_ID ?? '';
const agentUrl = (env.VITE_AGENT_URL ?? '').replace(/\/+$/, '');
const network = env.VITE_NEAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
// The app's own list (src/lib/config.ts): the configured endpoint, then a second provider. Public
// endpoints rate-limit, and one of them refusing a read is not an outage.
const rpc = [...new Set([
  env.VITE_NEAR_RPC_URL || (network === 'mainnet' ? 'https://free.rpc.fastnear.com' : 'https://test.rpc.fastnear.com'),
  network === 'mainnet' ? 'https://near.drpc.org' : 'https://near-testnet.drpc.org',
])];
if (!contract) { console.error('VITE_CONTRACT_ID is not set'); process.exit(2); }

const view = <T>(method: string, args: object = {}) => viewCall<T>(rpc, contract, method, args);
const agent = agentUrl ? new HttpAgent(agentUrl) : null;

let contractError: string | null = null;
const read = async <T>(p: Promise<T>): Promise<T | null> => p.catch(e => { contractError ??= e instanceof Error ? e.message : String(e); return null; });

const [paramsJ, seriesJ, vaultJ, paused, solv] = await Promise.all([
  read(view<ParamsJson>('get_params')), read(view<SeriesViewJson[]>('list_series')), read(view<VaultViewJson>('get_vault')),
  read(view<boolean>('is_paused')), read(view<{ ledger_total: string; net_inflow: string }>('get_solvency')),
]);
const series = (seriesJ ?? []).map(parseSeries);
const spots: Partial<Record<Underlying, SpotPoint>> = {};
for (const u of new Set(series.map(s => s.underlying))) {
  const sp = parseSpot(await read(view<[string, string] | null>('get_spot', { underlying: u })));
  if (sp) spots[u] = sp;
}
let agentError: string | null = null;
const chain = agent ? await agent.chain().catch(e => { agentError = e instanceof Error ? e.message : String(e); return []; }) : [];
const att = agent ? await agent.attestation().catch(() => null) : null;
const registered = att ? await view<boolean>('is_agent_key', { key: att.agent_public_key }).catch(() => null) : null;

const report = buildStatus({
  mode: 'chain', loaded: true, contractError, paused: paused ?? false, params: paramsJ ? parseParams(paramsJ) : null, series, spots,
  vault: vaultJ ? parseVault(vaultJ) : null,
  solvency: solv ? { ledgerTotal: BigInt(solv.ledger_total), netInflow: BigInt(solv.net_inflow) } : null,
  agentKind: agent ? 'http' : 'mock', agentError, quoted: chain.length, agentKeyRegistered: registered,
  health: agent ? await agent.health().catch(() => null) : null, hedge: agent ? await agent.hedge().catch(() => null) : null,
}, Date.now());

console.log(`${report.overall.toUpperCase()}: ${report.headline}   (${contract})`);
for (const c of report.checks) console.log(`  ${c.level.padEnd(7)} ${c.label.padEnd(19)} ${c.summary}`);
process.exit(report.overall === 'outage' ? 1 : 0);
