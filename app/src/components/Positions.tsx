import { useMemo } from 'react';
import { accruedFunding, tradeCash } from '../lib/margin';
import { seriesLabel } from '../lib/contract';
import { fmtPremium, fmtSignedUsdc, fmtSize, formatUnits, SIZE_DECIMALS, SIZE_SCALE } from '../lib/units';
import { useProtocol } from '../hooks/useProtocol';
import { useWallet } from '../hooks/useWallet';
import { useTheme } from '../theme';
import { fundingPerHour, type Pick } from './OptionChain';
import { Empty, Panel } from './ui';

export default function Positions({ onClose, bare }: { onClose: (p: Pick, size: string) => void; bare?: boolean }) {
  const { t } = useTheme();
  const { account, series, chain } = useProtocol();
  const accountId = useWallet(s => s.accountId);
  const seriesMap = useMemo(() => new Map(series.map(s => [s.id, s])), [series]);
  const positions = account?.positions ?? [];
  const hasEntry = positions.some(p => p.entryIndex != null);

  const th = (label: string, align: 'left' | 'right' = 'right') => (
    <th style={{ fontFamily: t.MONO, fontSize: 9, letterSpacing: '0.12em', color: t.DIM, fontWeight: 500, padding: '6px 10px', textAlign: align, whiteSpace: 'nowrap', borderBottom: `1px solid ${t.BORDER}` }}>{label}</th>
  );
  const td = (v: string, color?: string, align: 'left' | 'right' = 'right') => (
    <td className="tabular-nums" style={{ fontFamily: t.MONO, fontSize: 11, color: color ?? t.WHITE, textAlign: align, padding: '7px 10px', whiteSpace: 'nowrap' }}>{v}</td>
  );

  return (
    <Panel bare={bare} title={`POSITIONS${positions.length ? ` · ${positions.length}` : ''}`} bodyStyle={{ padding: 0 }}>
      {!accountId ? <Empty>Connect a wallet to see positions.</Empty> : positions.length === 0 ? <Empty>No open positions.</Empty> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
            <thead>
              <tr>
                {th('SERIES', 'left')}{th('SIDE', 'left')}{th('SIZE')}{th('MARK')}{th('CLOSE VALUE')}{th('MARGIN VALUE')}{th('FUNDING/H')}{th('ACCRUED')}{th('')}
              </tr>
            </thead>
            <tbody>
              {positions.map(p => {
                const s = seriesMap.get(p.series);
                const row = chain.get(p.series);
                const long = p.size > 0n;
                const abs = long ? p.size : -p.size;
                const perHour = row ? (fundingPerHour(row) * p.size) / SIZE_SCALE : null;
                const accrued = s && p.entryIndex != null ? accruedFunding(p.size, s.fundingIndex, p.entryIndex) : null;
                // What closing at the agent's market would pay (long sells at bid, short buys at ask).
                const closeValue = row ? tradeCash(long ? 'Sell' : 'Buy', long ? row.bid : row.ask, abs) * (long ? 1n : -1n) : null;
                return (
                  <tr key={p.series} style={{ borderBottom: `1px solid ${t.BORDER}` }}>
                    {td(s ? seriesLabel(s) : p.series, t.WHITE, 'left')}
                    {td(long ? 'LONG' : 'SHORT', long ? t.GREEN : t.RED, 'left')}
                    {td(fmtSize(abs))}
                    {td(fmtPremium(row?.mark ?? p.mark))}
                    {td(closeValue == null ? '—' : fmtSignedUsdc(closeValue), closeValue == null ? t.DIM : closeValue >= 0n ? t.GREEN : t.RED)}
                    {td(fmtSignedUsdc(p.value), t.GRAY)}
                    {td(perHour == null ? '—' : fmtSignedUsdc(-perHour, 4), perHour == null ? t.DIM : perHour > 0n ? t.RED : t.GREEN)}
                    {td(accrued == null ? 'n/a' : fmtSignedUsdc(-accrued, 4), accrued == null ? t.DIM : accrued > 0n ? t.RED : t.GREEN)}
                    <td style={{ padding: '4px 10px', textAlign: 'right' }}>
                      <button
                        onClick={() => onClose({ series: p.series, side: long ? 'Sell' : 'Buy' }, formatUnits(abs, SIZE_DECIMALS))}
                        style={{ fontFamily: t.MONO, fontSize: 10, color: t.ACCENT, background: 'transparent', border: `1px solid ${t.BORDER}`, padding: '3px 8px', cursor: 'pointer' }}
                      >CLOSE</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {positions.length > 0 && (
        <div style={{ fontFamily: t.MONO, fontSize: 10, color: t.DIM, padding: '8px 10px', borderTop: `1px solid ${t.BORDER}`, lineHeight: 1.5 }}>
          CLOSE VALUE is what closing at the current bid or ask would pay. MARGIN VALUE is how the contract values the position for margin: longs at intrinsic only, shorts at the clamped mark. Funding settles into collateral the next time the account is touched.
          {!hasEntry && ' ACCRUED needs entry_index in the get_account view (requested).'}
        </div>
      )}
    </Panel>
  );
}
