import { useMemo, useState, type CSSProperties } from 'react';
import Activity from './components/Activity';
import ChartPanel from './components/ChartPanel';
import CrossChainDeposit from './components/CrossChainDeposit';
import FundingPanel from './components/FundingPanel';
import FundsDialog, { type FundsMode } from './components/FundsDialog';
import Header from './components/Header';
import OptionChain, { type Pick } from './components/OptionChain';
import Positions from './components/Positions';
import Splitter from './components/Splitter';
import StrategyBuilder from './components/StrategyBuilder';
import TradeTicket from './components/TradeTicket';
import VaultPage from './components/VaultPage';
import { Button } from './components/ui';
import LandingPage from './LandingPage';
import { config, isDemo } from './lib/config';
import { usePanelSize } from './hooks/usePanelSize';
import { useProtocol } from './hooks/useProtocol';
import { goTo, useRoute } from './hooks/useRoute';
import { useWallet } from './hooks/useWallet';
import { world } from './services';
import { useTheme } from './theme';

const SIDE_LIMITS = (): [number, number] => [280, Math.max(320, Math.floor(window.innerWidth * 0.5))];
const CHART_LIMITS = (): [number, number] => [120, Math.max(200, Math.floor(window.innerHeight * 0.6))];
const ACTIVITY_LIMITS = (): [number, number] => [60, Math.max(120, Math.floor(window.innerHeight * 0.7))];

/**
 * Landing page at `#/`, then the desk. The trade screen is edge to edge, as in the earlier
 * Pacifica frontend: chain and account activity on the left, chart and order panel on the right.
 */
export default function App() {
  const { t } = useTheme();
  const { error, paused, series, spots } = useProtocol();
  const initError = useWallet(s => s.initError);
  const accountId = useWallet(s => s.accountId);
  const route = useRoute();
  const [picked, setPick] = useState<Pick | null>(null);
  const [size, setSize] = useState('1');
  const [funds, setFunds] = useState<FundsMode | null>(null);
  const [bridge, setBridge] = useState(false);

  // Until the user clicks a price the order panel shows the at-the-money call, so it is never empty.
  const pick = useMemo<Pick | null>(() => {
    if (picked) return picked;
    const u = series[0]?.underlying;
    const spot = u && spots[u]?.price;
    if (!u || spot == null) return null;
    const dist = (k: bigint) => (k > spot ? k - spot : spot - k);
    const calls = series.filter(x => x.underlying === u && x.kind === 'Call' && x.active);
    const atm = calls.reduce<(typeof calls)[number] | null>((best, x) => (best == null || dist(x.strike) < dist(best.strike) ? x : best), null);
    return atm ? { series: atm.id, side: 'Buy' } : null;
  }, [picked, series, spots]);

  // Panel sizes the user can drag. Limits follow the window so a panel can never be squeezed out.
  const side = usePanelSize('side-w', 360, SIDE_LIMITS);
  const chart = usePanelSize('chart-h', 260, CHART_LIMITS);
  const activity = usePanelSize('activity-h', 220, ACTIVITY_LIMITS);

  if (route === 'landing') return <LandingPage />;

  const closePosition = (p: Pick, s: string) => {
    setPick(p);
    setSize(s);
    goTo('trade');
  };
  const strip = (color: string, bg: string) => ({
    background: bg, borderBottom: `1px solid ${color}`, padding: '4px 14px', fontFamily: t.MONO, fontSize: 11, color,
    letterSpacing: '0.05em', flexShrink: 0, overflowWrap: 'anywhere',
  } as const);
  const underlying = series[0]?.underlying ?? 'ETH';

  return (
    <div style={{ minHeight: '100vh', height: route === 'trade' ? '100vh' : undefined, display: 'flex', flexDirection: 'column', background: t.BG, color: t.WHITE, fontFamily: t.MONO }}>
      <Header tab={route} />
      {isDemo && (
        <div style={{ ...strip(t.ORANGE, 'rgba(255,160,0,0.08)'), display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span>Demo mode: the contract, agent and market are simulated in your browser. Nothing touches a chain.</span>
          <Button variant="ghost" style={{ padding: '2px 10px', fontSize: 10 }} onClick={() => world?.reset()}>RESET DEMO</Button>
        </div>
      )}
      {error && <div role="alert" style={strip(t.RED, t.RED_BG)}>ERROR: cannot reach {isDemo ? 'the demo contract' : config.contractId}: {error}</div>}
      {initError && <div role="alert" style={strip(t.RED, t.RED_BG)}>ERROR: wallet selector failed to start: {initError}</div>}
      {paused && <div role="status" style={strip(t.ORANGE, 'rgba(255,160,0,0.08)')}>Trading and deposits are paused by the operator. Withdrawals, LP claims and liquidations still work.</div>}

      {route === 'trade' && (
        <div className="desk" style={{ '--side-w': `${side.size}px`, '--chart-h': `${chart.size}px`, '--activity-h': `${activity.size}px` } as CSSProperties}>
          <div className="desk-main">
            <div className="desk-chain"><OptionChain selected={pick} onPick={setPick} /></div>
            <Splitter dir="v" label="Resize chain and activity" onDelta={d => activity.nudge(-d)} onReset={activity.reset} />
            <div className="desk-activity" style={{ borderTop: `1px solid ${t.LINE}` }}>
              <Activity onClose={closePosition} onFunds={setFunds} onBridge={() => setBridge(true)} />
            </div>
          </div>
          <Splitter dir="h" label="Resize chart and order panel" onDelta={d => side.nudge(-d)} onReset={side.reset} />
          <div className="desk-side">
            <div className="desk-chart" style={{ borderBottom: `1px solid ${t.LINE}` }}>
              <ChartPanel symbol={`${underlying}/USD`} />
            </div>
            <Splitter dir="v" label="Resize chart and order ticket" onDelta={d => chart.nudge(d)} onReset={chart.reset} />
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
              <TradeTicket pick={pick} onPick={setPick} size={size} onSize={setSize} onFunds={setFunds} />
            </div>
          </div>
        </div>
      )}

      {route !== 'trade' && (
        <main style={{ flex: 1, padding: 12, display: 'grid', gap: 12, alignContent: 'start' }}>
          {route === 'strategy' && <StrategyBuilder />}
          {route === 'vault' && <VaultPage onFunds={setFunds} />}
          {route === 'funding' && (
            <>
              <FundingPanel />
              <Positions onClose={closePosition} />
            </>
          )}
        </main>
      )}

      <footer style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 14px', borderTop: `1px solid ${t.LINE}`, fontFamily: t.MONO, fontSize: 10, color: t.GRAY, flexShrink: 0 }}>
        <span>© 2026 2options Protocol</span>
        <span>{isDemo ? 'Demo' : `NEAR ${config.network} · ${config.contractId}`}</span>
      </footer>
      {funds && <FundsDialog mode={funds} onClose={() => setFunds(null)} />}
      {bridge && accountId && <CrossChainDeposit onClose={() => setBridge(false)} />}
    </div>
  );
}
