import React from 'react';
import ReactDOM from 'react-dom/client';
import { Toaster } from 'sonner';
import App from './App';
import './globals.css';
import { ProtocolProvider } from './hooks/useProtocol';
import { loadAgentTrust } from './hooks/useAgentTrust';
import { initWallet } from './hooks/useWallet';
import { configErrors } from './lib/config';
import { ThemeSync, useTheme } from './theme';

function ConfigError({ errors }: { errors: string[] }) {
  const { t } = useTheme();
  return (
    <div style={{ padding: 24, fontFamily: t.MONO, fontSize: 12, color: t.RED, lineHeight: 1.6 }}>
      <div style={{ color: t.WHITE, marginBottom: 8 }}>Perennia is misconfigured. Fix app/.env and restart:</div>
      {errors.map(e => <div key={e}>• {e}</div>)}
    </div>
  );
}

function Root() {
  const { mode } = useTheme();
  const errors = configErrors();
  return (
    <>
      <ThemeSync />
      {errors.length ? <ConfigError errors={errors} /> : (
        <ProtocolProvider>
          <App />
        </ProtocolProvider>
      )}
      <Toaster theme={mode} position="bottom-right" richColors closeButton duration={6000} />
    </>
  );
}

void initWallet();
void loadAgentTrust();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
