import { useEffect, useState, type ReactNode } from 'react';
import { seriesLabel } from '../lib/contract';
import { isDemo, txUrl } from '../lib/config';
import type { Fill } from '../lib/history';
import { fmtPremium, fmtSize, fmtUsdc, SIZE_SCALE } from '../lib/units';
import { useWallet } from '../hooks/useWallet';
import { backend } from '../services';
import { useProtocol } from '../hooks/useProtocol';
import { useTheme } from '../theme';
import AccountPanel from './AccountPanel';
import type { FundsMode } from './FundsDialog';
import { fundingPerHour, type Pick } from './OptionChain';
import Positions from './Positions';

const TABS = ['Positions', 'Trade History', 'Assets', 'Funding Rate'] as const;
const HISTORY_POLL_MS = 15_000;
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
  const accountId = useWallet(w => w.accountId);
  const [fills, setFills] = useState<Fill[] | null>(null);
  const [historyErr, setHistoryErr] = useState<string | null>(null);

  // Load the history while its tab is open; refresh it so new fills appear without a reload.
  useEffect(() => {
    if (tab !== 'Trade History' || !accountId) return;
    let live = true;
    const load = () => backend.tradeHistory(accountId)
      .then(f => { if (live) { setFills(f); setHistoryErr(null); } })
      .catch(e => { if (live) setHistoryErr(e instanceof Error ? e.message : String(e)); });
    void load();
    const timer = setInterval(load, HISTORY_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [tab, accountId]);
  useEffect(() => { setFills(null); }, [accountId]);
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
        {tab === 'Trade History' && (
          !accountId ? <Msg>Connect a wallet to see your trades.</Msg>
          : historyErr && !fills ? <Msg>Could not load trade history: {historyErr}</Msg>
          : fills == null ? <Msg>Loading…</Msg>
          : fills.length === 0 ? <Msg>No trades yet.</Msg>
          : (
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
              <thead>
                <tr>{['Time', 'Series', 'Side', 'Size', 'Price', 'Premium', isDemo ? '' : 'Transaction'].map((h, i) => (
                  <th key={h || i} style={{ ...cell, fontSize: 10, fontWeight: 500, color: t.GRAY, textAlign: i < 3 || i === 6 ? 'left' : 'right', borderBottom: `1px solid ${t.BORDER}` }}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {fills.map(f => {
                  const premium = (f.price * f.size) / SIZE_SCALE;
                  const s = series.find(x => x.id === f.series);
                  return (
                    <tr key={`${f.txHash}-${f.leg}`} style={{ borderBottom: `1px solid ${t.BORDER}` }}>
                      <td className="tabular-nums" style={{ ...cell, textAlign: 'left', color: t.GRAY }}>{new Date(f.atMs).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                      <td style={{ ...cell, textAlign: 'left', color: t.WHITE }}>{s ? seriesLabel(s) : f.series}</td>
                      <td style={{ ...cell, textAlign: 'left', color: f.side === 'Buy' ? t.GREEN : t.RED, fontWeight: 600 }}>{f.side.toUpperCase()}</td>
                      <td className="tabular-nums" style={{ ...cell, color: t.WHITE }}>{fmtSize(f.size)}</td>
                      <td className="tabular-nums" style={{ ...cell, color: t.WHITE }}>{fmtPremium(f.price)}</td>
                      <td className="tabular-nums" style={{ ...cell, color: f.side === 'Buy' ? t.RED : t.GREEN }}>{f.side === 'Buy' ? '−' : '+'}{fmtUsdc(premium)}</td>
                      <td style={{ ...cell, textAlign: 'left' }}>
                        {!isDemo && <a href={txUrl(f.txHash)} target="_blank" rel="noopener noreferrer" style={{ color: t.ACCENT, textDecoration: 'none' }}>{f.txHash.slice(0, 8)}…</a>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        )}
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

function Msg({ children }: { children: ReactNode }) {
  const { t } = useTheme();
  return <div style={{ fontFamily: t.MONO, fontSize: 11, color: t.DIM, textAlign: 'center', padding: '22px 0' }}>{children}</div>;
}
