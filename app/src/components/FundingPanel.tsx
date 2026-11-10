import { useMemo } from 'react';
import { seriesLabel } from '../lib/contract';
import { fmtPremium, NS_PER_MS } from '../lib/units';
import { useNow, useProtocol } from '../hooks/useProtocol';
import { useTheme } from '../theme';
import { fundingPerHour } from './OptionChain';
import { Empty, Panel } from './ui';

export function useFundingCountdown(): { msLeft: number; intervalMs: number } | null {
  const { params } = useProtocol();
  const now = useNow(1_000);
  if (!params) return null;
  const intervalMs = Number(params.funding_interval_ns / NS_PER_MS);
  return { msLeft: intervalMs - (now % intervalMs), intervalMs };
}

export const fmtDuration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
};

export default function FundingPanel() {
  const { t } = useTheme();
  const { series, chain, fundingEvents } = useProtocol();
  const cd = useFundingCountdown();
  const seriesMap = useMemo(() => new Map(series.map(s => [s.id, s])), [series]);

  const th = (label: string, align: 'left' | 'right' = 'right') => (
    <th style={{ fontFamily: t.MONO, fontSize: 9, letterSpacing: '0.12em', color: t.DIM, fontWeight: 500, padding: '6px 10px', textAlign: align, borderBottom: `1px solid ${t.BORDER}`, whiteSpace: 'nowrap' }}>{label}</th>
  );
  const td = (v: string, color?: string, align: 'left' | 'right' = 'right') => (
    <td className="tabular-nums" style={{ fontFamily: t.MONO, fontSize: 11, color: color ?? t.WHITE, textAlign: align, padding: '6px 10px', whiteSpace: 'nowrap' }}>{v}</td>
  );

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Panel title="FUNDING" right={cd && <span style={{ color: t.WHITE, letterSpacing: 0 }}>next settlement in {fmtDuration(cd.msLeft)}</span>} bodyStyle={{ padding: 0 }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
            <thead><tr>{th('SERIES', 'left')}{th('MARK')}{th('RATE/H')}{th('LONG PAYS/H')}{th('LAST SETTLED MARK')}{th('FUNDING INDEX')}</tr></thead>
            <tbody>
              {series.map(s => {
                const row = chain.get(s.id);
                return (
                  <tr key={s.id} style={{ borderBottom: `1px solid ${t.BORDER}` }}>
                    {td(seriesLabel(s), t.WHITE, 'left')}
                    {td(row ? fmtPremium(row.mark) : '—')}
                    {td(row ? `${(Number(row.fundingRateHourly) / 1e7).toFixed(3)}%` : '—', t.GRAY)}
                    {td(row ? fmtPremium(fundingPerHour(row)) : '—', t.ORANGE)}
                    {td(fmtPremium(s.lastMark), t.GRAY)}
                    {td(fmtPremium(s.fundingIndex), t.GRAY)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ fontFamily: t.MONO, fontSize: 10, color: t.DIM, padding: '8px 10px', borderTop: `1px solid ${t.BORDER}`, lineHeight: 1.5 }}>
          Each settlement adds rate × mark to the series' cumulative index (capped at 4%/h). A position owes size × (index now − index at entry), applied on its next trade, withdrawal or liquidation.
        </div>
      </Panel>

      <Panel title="SETTLEMENTS SEEN THIS SESSION" bodyStyle={{ padding: 0 }}>
        {fundingEvents.length === 0 ? <Empty>No settlements since this page loaded.</Empty> : (
          <div style={{ overflowX: 'auto', maxHeight: 320 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 460 }}>
              <thead><tr>{th('TIME', 'left')}{th('SERIES', 'left')}{th('EPOCH')}{th('MARK')}{th('PER CONTRACT')}</tr></thead>
              <tbody>
                {fundingEvents.map(e => {
                  const s = seriesMap.get(e.series);
                  return (
                    <tr key={`${e.series}-${e.epoch}`} style={{ borderBottom: `1px solid ${t.BORDER}` }}>
                      {td(new Date(e.atMs).toLocaleTimeString(), t.GRAY, 'left')}
                      {td(s ? seriesLabel(s) : e.series, t.WHITE, 'left')}
                      {td(e.epoch.toString(), t.GRAY)}
                      {td(fmtPremium(e.mark))}
                      {td(fmtPremium(e.perContract), e.perContract >= 0n ? t.ORANGE : t.GREEN)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
