import { useEffect, useState } from 'react';
import type { AgentHealth, Solvency } from '../backend/types';
import { useAgentTrust } from '../hooks/useAgentTrust';
import { useNow, useProtocol } from '../hooks/useProtocol';
import { config, isDemo, txUrl } from '../lib/config';
import { buildStatus, type Level, type Overall, type StatusReport } from '../lib/status';
import { agent, backend } from '../services';
import { useTheme } from '../theme';
import { Badge, Empty, Panel, Row } from './ui';

const POLL_MS = 5_000;

/**
 * The two reads only this page needs: the agent's /health and the contract's ledger check. They
 * stay out of the shared polling loop so every other screen keeps its RPC budget.
 */
function useStatusFeeds() {
  const [health, setHealth] = useState<AgentHealth | null>(null);
  const [solvency, setSolvency] = useState<Solvency | 'unavailable' | null>(backend.getSolvency ? null : 'unavailable');
  useEffect(() => {
    let live = true;
    const load = async () => {
      const [h, s] = await Promise.all([
        agent.health ? agent.health().catch(() => null) : Promise.resolve(null),
        backend.getSolvency ? backend.getSolvency().catch(() => null) : Promise.resolve('unavailable' as const),
      ]);
      if (!live) return;
      setHealth(h);
      setSolvency(s); // a failed read shows as unknown, never as the last good answer
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, []);
  return { health, solvency };
}

export default function StatusPage() {
  const p = useProtocol();
  const registered = useAgentTrust(s => s.registered);
  const { health, solvency } = useStatusFeeds();
  const now = useNow(1_000);
  const report = buildStatus({
    mode: isDemo ? 'demo' : 'chain', loaded: p.loaded, contractError: p.error, paused: p.paused, params: p.params,
    series: p.series, spots: p.spots, vault: p.vault, solvency, agentKind: agent.kind, agentError: p.agentError,
    quoted: p.chain.size, agentKeyRegistered: registered, health, hedge: p.hedge,
  }, now);
  return (
    <StatusView report={report} nowMs={now} liquidated={health?.keeper?.liquidated ?? []}
      deployment={isDemo ? null : { network: config.network, contractId: backend.contractId, usdcId: backend.usdcId, agentUrl: config.agentUrl, explorerUrl: config.explorerUrl }} />
  );
}

const LEVEL_LABEL: Record<Level, string> = { ok: 'OPERATIONAL', warn: 'DEGRADED', down: 'DOWN', off: 'OFF', unknown: 'CHECKING' };
const OVERALL_LABEL: Record<Overall, string> = {
  operational: 'OPERATIONAL', degraded: 'DEGRADED', outage: 'OUTAGE', checking: 'CHECKING',
};

export interface Deployment { network: string; contractId: string; usdcId: string; agentUrl: string; explorerUrl: string }

/** The page for a given report, with no data fetching of its own. */
export function StatusView({ report, nowMs, liquidated, deployment }: {
  report: StatusReport;
  nowMs: number;
  liquidated: { account: string; txHash: string; atMs: number }[];
  deployment: Deployment | null;
}) {
  const { t } = useTheme();
  const color = (l: Level) => (l === 'ok' ? t.GREEN : l === 'warn' ? t.ORANGE : l === 'down' ? t.RED : t.GRAY);
  const overall = report.overall === 'operational' ? t.GREEN : report.overall === 'degraded' ? t.ORANGE : report.overall === 'outage' ? t.RED : t.GRAY;
  const account = (id: string) => deployment
    ? <a href={`${deployment.explorerUrl}/address/${id}`} target="_blank" rel="noopener noreferrer" style={{ color: t.ACCENT }}>{id}</a>
    : id;

  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 980, width: '100%', margin: '0 auto' }}>
      <section role="status" aria-label="Overall status" style={{ border: `1px solid ${overall}`, background: t.PANEL, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span aria-hidden style={{ width: 12, height: 12, borderRadius: '50%', background: overall, boxShadow: `0 0 10px ${overall}`, flexShrink: 0 }} />
        <span style={{ fontFamily: t.MONO, fontSize: 12, fontWeight: 700, letterSpacing: '0.16em', color: overall }}>{OVERALL_LABEL[report.overall]}</span>
        <span style={{ fontFamily: t.MONO, fontSize: 13, color: t.WHITE, flex: 1, minWidth: 200 }}>{report.headline}</span>
        <span className="tabular-nums" style={{ fontFamily: t.MONO, fontSize: 10, color: t.DIM }}>checked {new Date(nowMs).toLocaleTimeString()}</span>
      </section>

      <Panel title="COMPONENTS" bodyStyle={{ padding: 0 }}>
        {report.checks.map(c => (
          <div key={c.id} style={{ display: 'grid', gridTemplateColumns: '112px minmax(0, 1fr)', gap: 12, padding: '10px 12px', borderBottom: `1px solid ${t.BORDER}`, alignItems: 'start' }}>
            <div><Badge color={color(c.level)}>{LEVEL_LABEL[c.level]}</Badge></div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: t.MONO, fontSize: 12, fontWeight: 600, color: t.WHITE }}>
                {c.label}
                {c.critical && <span style={{ fontWeight: 400, fontSize: 9, letterSpacing: '0.1em', color: t.DIM, marginLeft: 8 }}>NEEDED TO TRADE</span>}
              </div>
              <div style={{ fontFamily: t.MONO, fontSize: 11, lineHeight: 1.5, color: c.level === 'down' ? t.RED : c.level === 'warn' ? t.ORANGE : t.GRAY, overflowWrap: 'anywhere', marginTop: 2 }}>{c.summary}</div>
            </div>
          </div>
        ))}
      </Panel>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, alignItems: 'start' }}>
        <Panel title="RECENT LIQUIDATIONS">
          {liquidated.length === 0 ? <Empty>None since the agent started.</Empty> : liquidated.slice(0, 8).map(x => (
            <Row key={x.txHash} label={`${new Date(x.atMs).toLocaleTimeString()} · ${x.account}`}
              value={<a href={txUrl(x.txHash)} target="_blank" rel="noopener noreferrer" style={{ color: t.ACCENT }}>{`${x.txHash.slice(0, 8)}…`}</a>} />
          ))}
        </Panel>
        <Panel title="DEPLOYMENT">
          {deployment ? (
            <>
              <Row label="Network" value={`NEAR ${deployment.network}`} />
              <Row label="Contract" value={account(deployment.contractId)} />
              <Row label="USDC token" value={account(deployment.usdcId)} />
              <Row label="Agent" value={deployment.agentUrl || 'not configured'} />
            </>
          ) : <Empty>Demo mode: the contract, agent and market run in this browser.</Empty>}
        </Panel>
      </div>
      <div style={{ fontFamily: t.MONO, fontSize: 10, color: t.DIM, lineHeight: 1.6 }}>
        Read live from the contract and the agent every few seconds. A component marked NEEDED TO TRADE being down is an outage; anything else down or degraded leaves trading open.
      </div>
    </div>
  );
}
