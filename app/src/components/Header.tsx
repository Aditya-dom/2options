import { LogOut, Moon, Sun } from 'lucide-react';
import { config, isDemo } from '../lib/config';
import { fmtSpot } from '../lib/units';
import { useProtocol } from '../hooks/useProtocol';
import { useWallet } from '../hooks/useWallet';
import { useTheme } from '../theme';
import { fmtDuration, useFundingCountdown } from './FundingPanel';
import AgentBadge from './AgentBadge';
import { Badge } from './ui';

export type Tab = 'trade' | 'strategy' | 'vault' | 'funding';
const TABS: { id: Tab; label: string }[] = [
  { id: 'trade', label: 'TRADE' },
  { id: 'strategy', label: 'STRATEGY' },
  { id: 'vault', label: 'VAULT' },
  { id: 'funding', label: 'FUNDING' },
];

export default function Header({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const { t, mode, toggle } = useTheme();
  const { spots } = useProtocol();
  const { accountId, ready, signIn, signOut } = useWallet();
  const cd = useFundingCountdown();
  const eth = spots.ETH?.price;
  const cell = { display: 'flex', alignItems: 'center', padding: '0 12px', borderLeft: `1px solid ${t.BORDER}`, flexShrink: 0, gap: 8 } as const;

  return (
    <header style={{ background: t.PANEL, borderBottom: `1px solid ${t.BORDER}`, display: 'flex', alignItems: 'stretch', height: 44, overflowX: 'auto', whiteSpace: 'nowrap' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', flexShrink: 0 }}>
        <img src="/logo.svg" alt="" style={{ width: 22, height: 22, borderRadius: 3 }} />
        <span className="header-brand" style={{ fontFamily: t.MONO, fontSize: 13, fontWeight: 700, letterSpacing: '0.14em', color: t.WHITE }}>PERENNIA</span>
        <Badge color={isDemo ? t.ORANGE : t.ACCENT}>{isDemo ? 'DEMO' : config.network.toUpperCase()}</Badge>
        <AgentBadge />
      </div>
      {TABS.map(x => {
        const active = tab === x.id;
        return (
          <button key={x.id} onClick={() => onTab(x.id)} style={{
            fontFamily: t.MONO, fontSize: 11, letterSpacing: '0.08em', padding: '0 14px', flexShrink: 0,
            color: active ? t.ACCENT : t.GRAY, background: active ? t.ACCENT_BG : 'transparent', border: 'none',
            borderLeft: `1px solid ${t.BORDER}`, boxShadow: active ? `inset 0 -2px 0 ${t.ACCENT}` : 'none', cursor: 'pointer',
          }}>{x.label}</button>
        );
      })}
      <div style={{ flex: 1, minWidth: 8 }} />
      {eth != null && (
        <div style={cell}>
          <span style={{ fontFamily: t.MONO, fontSize: 10, color: t.DIM }}>ETH</span>
          <span className="tabular-nums" style={{ fontFamily: t.MONO, fontSize: 12, color: t.WHITE, fontWeight: 600 }}>{fmtSpot(eth)}</span>
        </div>
      )}
      {cd && (
        <div style={cell} title="Time to the next funding settlement">
          <span style={{ fontFamily: t.MONO, fontSize: 10, color: t.DIM }}>FUNDING</span>
          <span className="tabular-nums" style={{ fontFamily: t.MONO, fontSize: 12, color: t.ORANGE }}>{fmtDuration(cd.msLeft)}</span>
        </div>
      )}
      <div style={cell}>
        <button onClick={toggle} aria-label="Toggle theme" style={{ background: 'transparent', border: 'none', color: t.GRAY, cursor: 'pointer', display: 'flex' }}>
          {mode === 'light' ? <Moon size={14} /> : <Sun size={14} />}
        </button>
      </div>
      <div style={cell}>
        {accountId ? (
          <>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: t.GREEN, boxShadow: `0 0 6px ${t.GREEN}` }} />
            <span className="header-account" style={{ fontFamily: t.MONO, fontSize: 11, color: t.WHITE, fontWeight: 600, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{accountId}</span>
            <button onClick={() => void signOut()} aria-label="Sign out" title="Sign out" style={{ background: 'transparent', border: 'none', color: t.GRAY, cursor: 'pointer', display: 'flex' }}>
              <LogOut size={13} />
            </button>
          </>
        ) : (
          <button onClick={signIn} disabled={!ready} style={{
            fontFamily: t.MONO, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', padding: '5px 12px',
            color: t.ACCENT, background: t.ACCENT_BG, border: `1px solid ${t.ACCENT}`, borderRadius: 2, cursor: ready ? 'pointer' : 'default',
          }}>
            {!ready ? 'LOADING…' : isDemo ? 'USE DEMO ACCOUNT' : 'CONNECT WALLET'}
          </button>
        )}
      </div>
    </header>
  );
}
