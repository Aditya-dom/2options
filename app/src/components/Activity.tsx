import { useState } from 'react';
import { seriesLabel } from '../lib/contract';
import { fmtPremium } from '../lib/units';
import { useProtocol } from '../hooks/useProtocol';
import { useTheme } from '../theme';
import AccountPanel from './AccountPanel';
import type { FundsMode } from './FundsDialog';
import { fundingPerHour, type Pick } from './OptionChain';
import Positions from './Positions';

const TABS = ['Positions', 'Assets', 'Funding Rate'] as const;
type ActivityTab = (typeof TABS)[number];

/**
 * The tabbed panel under the chain: positions, account balances, and funding rates. Follows the
 * earlier Pacifica frontend's positions panel.
 */
export default function Activity({ onClose, onFunds, onBridge }: {
  onClose: (p: Pick, size: string) => void; onFunds: (m: FundsMode) => void; onBridge: () => void;
}) {
  const { t } = useTheme();
  const { series, chain, account } = useProtocol();
  const [tab, setTab] = useState<ActivityTab>('Positions');
  const count = account?.positions.length ?? 0;
  const cell = { fontFamily: t.MONO, fontSize: 11, padding: '6px 10px', textAlign: 'right', whiteSpace: 'nowrap' } as const;

  return (
    <section aria-label="Account activity" style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, minHeight: 0, background: t.BG }}>
      <div role="tablist" style={{ display: 'flex', gap: 4, padding: '0 10px', borderBottom: `1px solid ${t.BORDER}`, flexShrink: 0 }}>
        {TABS.map(x => (
          <button key={x} role="tab" aria-selected={tab === x} onClick={() => setTab(x)} style={{
            fontFamily: t.MONO, fontSize: 11, padding: '10px 10px 8px', cursor: 'pointer', border: 'none', background: 'transparent',
            color: tab === x ? t.WHITE : t.GRAY, fontWeight: tab === x ? 600 : 400,
            boxShadow: tab === x ? `inset 0 -2px 0 ${t.ACCENT}` : 'none',
          }}>{x}{x === 'Positions' && count > 0 ? ` (${count})` : ''}</button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'Positions' && <Positions bare onClose={onClose} />}
        {tab === 'Assets' && <div style={{ maxWidth: 460 }}><AccountPanel bare onFunds={onFunds} onBridge={onBridge} /></div>}
        {tab === 'Funding Rate' && (
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
            <thead>
              <tr>{['Series', 'Mark', 'Rate / h', 'Long pays / h', 'Index'].map((h, i) => (
                <th key={h} style={{ ...cell, fontSize: 10, fontWeight: 500, color: t.GRAY, textAlign: i === 0 ? 'left' : 'right', borderBottom: `1px solid ${t.BORDER}` }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {series.map(s => {
                const row = chain.get(s.id);
                return (
                  <tr key={s.id} style={{ borderBottom: `1px solid ${t.BORDER}` }}>
                    <td style={{ ...cell, textAlign: 'left', color: t.WHITE }}>{seriesLabel(s)}</td>
                    <td className="tabular-nums" style={{ ...cell, color: t.WHITE }}>{row ? fmtPremium(row.mark) : '—'}</td>
                    <td className="tabular-nums" style={{ ...cell, color: t.GRAY }}>{row ? `${(Number(row.fundingRateHourly) / 1e7).toFixed(3)}%` : '—'}</td>
                    <td className="tabular-nums" style={{ ...cell, color: t.ORANGE }}>{row ? fmtPremium(fundingPerHour(row)) : '—'}</td>
                    <td className="tabular-nums" style={{ ...cell, color: t.GRAY }}>{fmtPremium(s.fundingIndex)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
