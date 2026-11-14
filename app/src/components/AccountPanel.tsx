import { useMemo } from 'react';
import { healthBps, healthTier, type HealthTier } from '../lib/contract';
import { maxWithdraw, pendingFunding } from '../lib/account';
import { fmtSignedUsdc, fmtUsdc } from '../lib/units';
import { useProtocol } from '../hooks/useProtocol';
import { useWallet } from '../hooks/useWallet';
import { useTheme } from '../theme';
import FaucetButton from './FaucetButton';
import type { FundsMode } from './FundsDialog';
import { Badge, Button, Note, Panel, Row, Stat } from './ui';

const TIER_LABEL: Record<HealthTier, string> = {
  healthy: 'HEALTHY', warning: 'BELOW INITIAL', 'close-only': 'CLOSE ONLY', liquidatable: 'LIQUIDATABLE',
};

export default function AccountPanel({ onFunds, onBridge, bare }: { onFunds: (m: FundsMode) => void; onBridge: () => void; bare?: boolean }) {
  const { t } = useTheme();
  const { account, params, series, usdc } = useProtocol();
  const accountId = useWallet(s => s.accountId);
  const signIn = useWallet(s => s.signIn);
  const seriesMap = useMemo(() => new Map(series.map(s => [s.id, s])), [series]);

  if (!accountId) {
    return (
      <Panel bare={bare} title="ACCOUNT">
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ fontFamily: t.MONO, fontSize: 11, color: t.GRAY, lineHeight: 1.5 }}>Connect a NEAR wallet to deposit USDC and trade.</div>
          <Button onClick={signIn}>CONNECT WALLET</Button>
        </div>
      </Panel>
    );
  }

  const ratio = account ? healthBps(account.equity, account.requirement) : null;
  const tier = ratio != null && params ? healthTier(ratio, params) : null;
  const tierColor = tier === 'healthy' ? t.GREEN : tier === 'warning' ? t.ORANGE : tier ? t.RED : t.GRAY;
  const owed = account ? pendingFunding(account, seriesMap) : null;
  const free = account && params ? maxWithdraw(account, seriesMap, params) : 0n;
  const stale = account != null && account.positions.length > 0 && account.equity == null;
  // The contract's second liquidation test: equity below zero once unsettled funding is charged.
  // It is how a long (which has no margin ratio) gets closed when its cash cannot pay funding.
  const underwater = account != null && account.positions.length > 0 && account.equity != null && owed != null && account.equity - owed < 0n;

  // Bar spans 1.0×–3.0×; ticks at the contract's liquidation / close-only / initial ratios.
  const pos = (bps: bigint) => Math.max(0, Math.min(100, ((Number(bps) / 10_000 - 1) / 2) * 100));

  return (
    <Panel bare={bare} title="ACCOUNT" right={tier && <Badge color={tierColor}>{TIER_LABEL[tier]}</Badge>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <Stat label="Equity" value={account?.equity != null ? fmtUsdc(account.equity) : account ? '—' : fmtUsdc(0n)} />
        <Stat label="Margin used" value={account?.requirement != null ? fmtUsdc(account.requirement) : '—'}
          sub={ratio != null ? `health ${(Number(ratio) / 10_000).toFixed(2)}×` : account?.positions.length ? undefined : 'no open shorts'} color={tierColor} />
      </div>
      {ratio != null && params && (
        <div style={{ position: 'relative', height: 6, background: t.MUTED, border: `1px solid ${t.BORDER}`, marginBottom: 12 }}>
          <div style={{ position: 'absolute', inset: 0, width: `${pos(ratio)}%`, background: tierColor }} />
          {[params.liquidation_ratio_bps, params.close_only_ratio_bps, params.initial_ratio_bps].map(b => (
            <div key={b.toString()} title={`${Number(b) / 10_000}×`} style={{ position: 'absolute', left: `${pos(b)}%`, top: -3, bottom: -3, width: 1, background: t.WHITE, opacity: 0.6 }} />
          ))}
        </div>
      )}
      {underwater && (
        <div style={{ marginBottom: 8 }}>
          <Note tone="error">Funding owed is more than this account can pay. Anyone can now close its positions at the mark. Deposit USDC to keep them.</Note>
        </div>
      )}
      {stale && <div style={{ fontFamily: t.MONO, fontSize: 10, color: t.ORANGE, marginBottom: 8 }}>Spot is stale; equity will show once the agent posts a fresh price.</div>}
      <Row label="Collateral (cash)" value={fmtUsdc(account?.collateral ?? 0n)} />
      {owed != null && owed !== 0n && <Row label="Unsettled funding" value={fmtSignedUsdc(-owed)} color={owed > 0n ? t.RED : t.GREEN} />}
      <Row label="Withdrawable" value={fmtUsdc(free)} />
      <Row label="USDC in wallet" value={usdc != null ? fmtUsdc(usdc) : '—'} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 12 }}>
        <Button onClick={() => onFunds('deposit')}>DEPOSIT</Button>
        <Button variant="ghost" onClick={() => onFunds('withdraw')} disabled={!account}>WITHDRAW</Button>
      </div>
      <Button variant="ghost" onClick={onBridge} style={{ width: '100%', marginTop: 6 }}>
        DEPOSIT FROM ANOTHER CHAIN
      </Button>
      <FaucetButton style={{ width: '100%', marginTop: 6 }} />
    </Panel>
  );
}
