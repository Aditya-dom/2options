import { LogOut, Moon, Sun } from 'lucide-react';
import { config, isDemo } from '../lib/config';
import { href, TABS, type Tab } from '../hooks/useRoute';
import { useWallet } from '../hooks/useWallet';
import { useTheme } from '../theme';
import AgentBadge from './AgentBadge';
import { Badge } from './ui';

/** Layout and styling follow the earlier Pacifica frontend's TradeHeader. */
export default function Header({ tab }: { tab: Tab }) {
  const { t, mode, toggle } = useTheme();
  const { accountId, ready, signIn, signOut } = useWallet();
  const cell = { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, borderLeft: `1px solid ${t.LINE}` } as const;

  return (
    <header style={{ background: t.PANEL, borderBottom: `1px solid ${t.LINE}`, flexShrink: 0, userSelect: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'stretch', height: 40, overflowX: 'auto', whiteSpace: 'nowrap' }}>
        <a href={href('landing')} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px', borderRight: `1px solid ${t.LINE}`,
          flexShrink: 0, background: t.SURFACE, textDecoration: 'none',
        }}>
          <img src="/logo.svg" alt="2options" style={{ width: 24, height: 24, borderRadius: 3 }} />
          <span className="header-brand" style={{ fontFamily: t.MONO, fontSize: 13, fontWeight: 700, color: t.WHITE, letterSpacing: '0.14em' }}>2OPTIONS</span>
        </a>

        <nav style={{ display: 'flex' }} aria-label="Screens">
          {TABS.map(x => {
            const active = tab === x.id;
            return (
              <a key={x.id} href={href(x.id)} aria-current={active ? 'page' : undefined} style={{
                display: 'flex', alignItems: 'center', padding: '0 14px', fontFamily: t.MONO, fontSize: 11, letterSpacing: '0.08em',
                color: active ? t.ACCENT : t.GRAY, textDecoration: 'none', flexShrink: 0, borderRight: `1px solid ${t.LINE}`,
                background: active ? 'linear-gradient(180deg, rgba(0,229,255,0.18), rgba(0,229,255,0.07))' : 'transparent',
                boxShadow: active ? 'inset 0 -2px 0 rgba(0,229,255,0.72)' : 'none',
              }}>{x.label}</a>
            );
          })}
        </nav>

        <div style={{ flex: 1, minWidth: 8 }} />

        <div style={{ ...cell, padding: '0 10px' }}>
          <Badge color={isDemo ? t.ORANGE : t.ACCENT}>{isDemo ? 'DEMO' : config.network.toUpperCase()}</Badge>
          <AgentBadge />
        </div>
        <div style={{ ...cell, padding: '0 8px' }}>
          <button onClick={toggle} aria-label="Toggle theme" style={{ display: 'flex', background: 'transparent', border: 'none', padding: 0, color: t.GRAY, cursor: 'pointer' }}>
            {mode === 'light' ? <Moon size={14} /> : <Sun size={14} />}
          </button>
        </div>
        <div style={{ ...cell, padding: '0 14px' }}>
          {accountId ? (
            <>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: t.GREEN, boxShadow: `0 0 6px ${t.GREEN}` }} />
              <span className="header-account" style={{ fontFamily: t.MONO, fontSize: 11, color: t.WHITE, fontWeight: 600, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{accountId}</span>
              <button onClick={() => void signOut()} aria-label="Sign out" title="Sign out" style={{ display: 'flex', background: 'transparent', border: 'none', color: t.GRAY, cursor: 'pointer' }}>
                <LogOut size={13} />
              </button>
            </>
          ) : (
            <button onClick={signIn} disabled={!ready} style={{
              fontFamily: t.MONO, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', padding: '5px 14px', borderRadius: 3,
              cursor: ready ? 'pointer' : 'default', background: 'rgba(0,229,255,0.08)', color: ready ? t.ACCENT : t.DIM,
              border: `1px solid ${ready ? 'rgba(0,229,255,0.3)' : t.BORDER}`,
            }}>
              {!ready ? 'Loading…' : isDemo ? 'Use Demo Account' : 'Connect Wallet'}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
