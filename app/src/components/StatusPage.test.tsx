import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHealth } from '../backend/agent';
import type { HealthJson } from '../backend/types';
import type { StatusReport } from '../lib/status';
import { StatusView, type Deployment } from './StatusPage';

const deployment: Deployment = {
  network: 'testnet', contractId: 'contract.example.testnet', usdcId: 'usdc.example.testnet',
  agentUrl: 'http://127.0.0.1:8787', explorerUrl: 'https://testnet.nearblocks.io',
};
const report = (over: Partial<StatusReport> = {}): StatusReport => ({
  overall: 'operational', headline: 'All systems operational',
  checks: [
    { id: 'contract', label: 'Contract', level: 'ok', summary: 'Reachable; trading and deposits are open.', critical: true },
    { id: 'hedger', label: 'Delta hedge', level: 'off', summary: "Switched off: LPs carry the vault's net delta.", critical: false },
  ],
  ...over,
});
const html = (r: StatusReport, d: Deployment | null = deployment, liquidated: { account: string; txHash: string; atMs: number }[] = []) =>
  renderToStaticMarkup(<StatusView report={r} nowMs={1_794_268_865_000} liquidated={liquidated} deployment={d} />);
const text = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

test('the banner, each component and the deployment are shown', () => {
  const out = html(report());
  const t = text(out);
  expect(t).toContain('OPERATIONAL All systems operational');
  expect(t).toContain('Contract NEEDED TO TRADE Reachable; trading and deposits are open.');
  expect(t).toContain("OFF Delta hedge Switched off: LPs carry the vault's net delta.");
  expect(t).not.toContain('Delta hedge NEEDED TO TRADE');
  expect(out).toContain('href="https://testnet.nearblocks.io/address/contract.example.testnet"');
  expect(t).toContain('NEAR testnet');
  expect(t).toContain('None since the agent started.');
});

test('an outage is labelled as one and names what is down', () => {
  const t = text(html(report({
    overall: 'outage', headline: 'Outage: price feed',
    checks: [{ id: 'spot', label: 'Price feed', level: 'down', summary: 'ETH is 8 min old (limit 30 s).', critical: true }],
  })));
  expect(t).toContain('OUTAGE Outage: price feed');
  expect(t).toContain('DOWN Price feed NEEDED TO TRADE ETH is 8 min old');
  expect(text(html(report({ overall: 'degraded', headline: 'Degraded: keeper' })))).toContain('DEGRADED Degraded: keeper');
  expect(text(html(report({ overall: 'checking', headline: 'Checking…' })))).toContain('CHECKING Checking…');
});

test('liquidations from the agent link to their transactions; demo mode shows no deployment', () => {
  // The shape the agent's /health really returns (agent/twooptions_agent/keeper.py).
  const health: HealthJson = {
    ok: true, paused: false, series: 10, spot_age_s: { ETH: 5.5 },
    keeper: {
      last_spot_post_ns: { ETH: '1794644705029680000' }, last_spot_hold: {}, last_funding_epoch: { 'ETH-1900-C': 9970248 },
      liquidations: 1,
      liquidated: [{ account: 'trader.testnet', liquidator: 'keeper.testnet', tx_hash: 'A1YzFhNkUxQwgVv2RFq8SnNeZRb9HR7KwHEp7DTbTRz6', ts_ns: '1794644907654000000' }],
      errors: {},
    },
    hedger: true,
  };
  const parsed = parseHealth(health);
  expect(parsed.keeper!.lastSpotPostMs).toEqual({ ETH: 1_794_644_705_029 });
  expect(parsed.keeper!.liquidated).toEqual([{ account: 'trader.testnet', txHash: 'A1YzFhNkUxQwgVv2RFq8SnNeZRb9HR7KwHEp7DTbTRz6', atMs: 1_794_644_907_654 }]);
  expect(parseHealth({ ...health, keeper: null, hedger: undefined })).toEqual({ keeper: null, hedger: false });

  const out = html(report(), deployment, parsed.keeper!.liquidated);
  expect(out).toContain('/txns/A1YzFhNkUxQwgVv2RFq8SnNeZRb9HR7KwHEp7DTbTRz6');
  expect(text(out)).toContain('trader.testnet');
  expect(text(html(report(), null))).toContain('Demo mode: the contract, agent and market run in this browser.');
});
