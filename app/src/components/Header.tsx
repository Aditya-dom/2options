import { LogOut, Moon, Sun } from 'lucide-react';
import { config, isDemo } from '../lib/config';
import { href, TABS, type Tab } from '../hooks/useRoute';
import { useWallet } from '../hooks/useWallet';
import { useTheme } from '../theme';
import AgentBadge from './AgentBadge';
import FaucetButton from './FaucetButton';
import { Badge } from './ui';
import { Spinner } from './ascii';

/** Layout and styling follow the earlier Pacifica frontend's TradeHeader. */
export default function Header({ tab }: { tab: Tab }) {
  const { t, mode, toggle } = useTheme();
  const { accountId, ready, signIn, signOut } = useWallet();
  const cell = { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, borderLeft: `1px solid ${t.LINE}` } as const;

  return (
    <header style={{ background: t.PANEL, borderBottom: `1px solid ${t.LINE}`, flexShrink: 0, userSelect: 'none' }}>
      <div className="header-bar" style={{ display: 'flex', alignItems: 'stretch', height: 40, overflowX: 'auto', whiteSpace: 'nowrap' }}>
        <a href={href('landing')} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px', borderRight: `1px solid ${t.LINE}`,
          flexShrink: 0, background: t.SURFACE, textDecoration: 'none',
        }}>
          <img src="/logo.png?v=green" alt="2Options" style={{ width: 24, height: 24, borderRadius: 3 }} />
          <span className="header-brand" style={{ fontFamily: t.SANS, fontSize: 17, fontWeight: 700, color: t.WHITE, letterSpacing: '-0.03em' }}>2Options</span>
        </a>

        <nav className="header-tabs" style={{ display: 'flex' }} aria-label="Screens">
          {TABS.map(x => {
            const active = tab === x.id;
            return (
              <a key={x.id} href={href(x.id)} aria-current={active ? 'page' : undefined} style={{
                display: 'flex', alignItems: 'center', padding: '0 16px', fontFamily: t.SANS, fontSize: 13.5, letterSpacing: '-0.01em',
                color: active ? t.ACTIVE_FG : t.GRAY, fontWeight: active ? 600 : 400, textDecoration: 'none', flexShrink: 0, borderRight: `1px solid ${t.LINE}`,
                background: active ? t.ACTIVE_BG : 'transparent',
                boxShadow: active ? `inset 0 -2px 0 ${t.ACTIVE_LINE}` : 'none',
              }}>{x.label}</a>
            );
          })}
        </nav>

        <div style={{ flex: 1, minWidth: 8 }} />

        <div style={{ ...cell, padding: '0 10px' }}>
          <span className="header-net" style={{ display: 'flex' }}><Badge color={isDemo ? t.ORANGE : t.ACCENT}>{isDemo ? 'DEMO' : config.network.toUpperCase()}</Badge></span>
          <AgentBadge />
          <FaucetButton badge />
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
              cursor: ready ? 'pointer' : 'default', background: ready ? t.PRIMARY_BG : 'transparent', color: ready ? t.PRIMARY_FG : t.DIM,
              border: `1px solid ${ready ? t.PRIMARY_BORDER : t.BORDER}`,
            }}>
              {!ready ? <><Spinner style={{ marginRight: 6 }} />Loading</> : isDemo ? 'Use Demo Account' : 'Connect Wallet'}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
