import { LogOut, Moon, Sun, Wallet } from 'lucide-react';
import { config, isDemo } from '../lib/config';
import { href, TABS, type Tab } from '../hooks/useRoute';
import { useWallet } from '../hooks/useWallet';
import { useTheme } from '../theme';
import AgentBadge from './AgentBadge';
import FaucetButton from './FaucetButton';
import { Badge } from './ui';
import { Spinner, TabIcon } from './ascii';

/**
 * Two rows of cells divided by rules. The first holds the brand, the deployment's badges, the
 * theme switch and the wallet; the second holds the screens, each with its drawing. Both sit in
 * the page's frame (`.app-frame`, globals.css) and their rules run on to the window's edges.
 * `wide` is for the trade desk, whose frame is the whole window.
 */
export default function Header({ tab, wide = false }: { tab: Tab; wide?: boolean }) {
  const { t, mode, toggle } = useTheme();
  const { accountId, ready, signIn, signOut } = useWallet();
  const frame = wide ? 'app-frame wide' : 'app-frame';
  const rule = `1px solid ${t.LINE}`;
  const cell = { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, borderLeft: rule } as const;

  return (
    <header style={{ background: t.BG, flexShrink: 0, userSelect: 'none' }}>
      <div style={{ borderBottom: rule }}>
        <div className={frame} style={{ display: 'flex', alignItems: 'stretch', height: 48, whiteSpace: 'nowrap' }}>
          <a href={href('landing')} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 18px', flexShrink: 0, textDecoration: 'none' }}>
            <img src="/logo.png?v=green" alt="2Options" style={{ width: 26, height: 26, borderRadius: 3 }} />
            <span className="header-brand" style={{ fontFamily: t.SANS, fontSize: 18, fontWeight: 700, color: t.WHITE, letterSpacing: '-0.03em' }}>2Options</span>
          </a>

          <div style={{ flex: 1, minWidth: 8 }} />

          <div style={{ ...cell, padding: '0 14px' }}>
            <span className="header-net" style={{ display: 'flex' }}><Badge color={isDemo ? t.ORANGE : t.ACCENT}>{isDemo ? 'DEMO' : config.network.toUpperCase()}</Badge></span>
            <AgentBadge />
            <FaucetButton badge />
          </div>
          <button onClick={toggle} aria-label="Toggle theme" className="header-cell" style={{ ...cell, justifyContent: 'center', width: 48, background: 'transparent', borderTop: 'none', borderRight: 'none', borderBottom: 'none', padding: 0, color: t.GRAY, cursor: 'pointer' }}>
            {mode === 'light' ? <Moon size={15} /> : <Sun size={15} />}
          </button>
          {accountId ? (
            <div style={{ ...cell, padding: '0 16px' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: t.GREEN, boxShadow: `0 0 6px ${t.GREEN}` }} />
              <span className="header-account" style={{ fontFamily: t.MONO, fontSize: 11, color: t.WHITE, fontWeight: 600, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{accountId}</span>
              <button onClick={() => void signOut()} aria-label="Sign out" title="Sign out" style={{ display: 'flex', background: 'transparent', border: 'none', color: t.GRAY, cursor: 'pointer' }}>
                <LogOut size={13} />
              </button>
            </div>
          ) : (
            <button onClick={signIn} disabled={!ready} className="header-wallet" style={{
              ...cell, padding: '0 20px', borderTop: 'none', borderRight: 'none', borderBottom: 'none',
              fontFamily: t.SANS, fontSize: 13.5, fontWeight: 600, letterSpacing: '-0.01em',
              cursor: ready ? 'pointer' : 'default', background: ready ? t.PRIMARY_BG : 'transparent', color: ready ? t.PRIMARY_FG : t.DIM,
            }}>
              {!ready ? <><Spinner />Loading</> : <><Wallet size={15} strokeWidth={2} />{isDemo ? 'Use Demo Account' : 'Connect Wallet'}</>}
            </button>
          )}
        </div>
      </div>

      <div style={{ borderBottom: rule }}>
        <nav className={`${frame} header-tabs`} aria-label="Screens" style={{ display: 'flex', height: 42 }}>
          {TABS.map((x, i) => {
            const active = tab === x.id;
            return (
              <a key={x.id} href={href(x.id)} aria-current={active ? 'page' : undefined} className="header-tab" style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '0 22px', minWidth: 148,
                fontFamily: t.SANS, fontSize: 13.5, letterSpacing: '-0.01em',
                color: active ? t.ACTIVE_FG : t.GRAY, fontWeight: active ? 600 : 400, textDecoration: 'none', flexShrink: 0,
                borderLeft: i === 0 ? rule : 'none', borderRight: rule,
                background: active ? t.ACTIVE_BG : 'transparent',
                boxShadow: active ? `inset 0 -2px 0 ${t.ACTIVE_LINE}` : 'none',
              }}>
                <TabIcon name={x.id} ink={active ? t.ACTIVE_FG : t.GRAY} accent={active ? t.ACTIVE_FG : t.ACCENT} px={2} />
                {x.label}
              </a>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
