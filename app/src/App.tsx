import { useRef, useState } from 'react';
import AccountPanel from './components/AccountPanel';
import FundingPanel from './components/FundingPanel';
import FundsDialog, { type FundsMode } from './components/FundsDialog';
import Header, { type Tab } from './components/Header';
import OptionChain, { type Pick } from './components/OptionChain';
import Positions from './components/Positions';
import TradeTicket from './components/TradeTicket';
import VaultPage from './components/VaultPage';
import { Button, Note } from './components/ui';
import { config, isDemo } from './lib/config';
import { useProtocol } from './hooks/useProtocol';
import { useWallet } from './hooks/useWallet';
import { world } from './services';
import { useTheme } from './theme';

export default function App() {
  const { t } = useTheme();
  const { error, paused } = useProtocol();
  const initError = useWallet(s => s.initError);
  const [tab, setTab] = useState<Tab>('trade');
  const [pick, setPick] = useState<Pick | null>(null);
  const [size, setSize] = useState('1');
  const [funds, setFunds] = useState<FundsMode | null>(null);

  const ticketRef = useRef<HTMLDivElement>(null);
  // Single-column layouts put the ticket below the chain; bring it into view on a pick.
  const focusTicket = () => {
    if (window.innerWidth < 1024) setTimeout(() => ticketRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };
  const pickFromChain = (p: Pick) => {
    setPick(p);
    focusTicket();
  };
  const closePosition = (p: Pick, s: string) => {
    setPick(p);
    setSize(s);
    setTab('trade');
    focusTicket();
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header tab={tab} onTab={setTab} />
      {isDemo && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '6px 16px', background: t.MUTED, borderBottom: `1px solid ${t.BORDER}`, fontFamily: t.MONO, fontSize: 11, color: t.ORANGE }}>
          <span>Demo mode: the contract, agent and market are simulated in your browser. Funding settles every 2 minutes. Nothing touches a chain.</span>
          <Button variant="ghost" style={{ padding: '3px 10px', fontSize: 10 }} onClick={() => world?.reset()}>RESET DEMO</Button>
        </div>
      )}
      <main style={{ flex: 1, padding: 12, display: 'grid', gap: 12, alignContent: 'start', maxWidth: 1440, width: '100%', margin: '0 auto' }}>
        {error && <Note tone="error">Cannot reach {isDemo ? 'the demo contract' : `${config.contractId} via ${config.rpcUrl}`}: {error}</Note>}
        {initError && <Note tone="error">Wallet selector failed to start: {initError}</Note>}
        {paused && <Note tone="warn">Trading and deposits are paused by the operator. Withdrawals, LP claims and liquidations still work.</Note>}

        {tab === 'trade' && (
          <div className="trade-grid">
            <div style={{ display: 'grid', gap: 12, minWidth: 0, alignContent: 'start' }}>
              <OptionChain selected={pick} onPick={pickFromChain} />
              <Positions onClose={closePosition} />
            </div>
            <div style={{ display: 'grid', gap: 12, minWidth: 0, alignContent: 'start' }}>
              <AccountPanel onFunds={setFunds} />
              <div ref={ticketRef} style={{ scrollMarginTop: 12 }}>
                <TradeTicket pick={pick} onPick={setPick} size={size} onSize={setSize} />
              </div>
            </div>
          </div>
        )}
        {tab === 'vault' && <VaultPage onFunds={setFunds} />}
        {tab === 'funding' && (
          <div style={{ display: 'grid', gap: 12 }}>
            <FundingPanel />
            <Positions onClose={closePosition} />
          </div>
        )}
      </main>
      {funds && <FundsDialog mode={funds} onClose={() => setFunds(null)} />}
    </div>
  );
}
