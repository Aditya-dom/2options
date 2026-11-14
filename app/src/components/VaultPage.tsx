import { useMemo, useState } from 'react';
import { healthBps, seriesLabel, type Underlying } from '../lib/contract';
import { fmtFixed, fmtPremium, fmtSize, fmtUsdc, formatUnits, nowNs, NS_PER_MS, parseUnits, SIZE_SCALE } from '../lib/units';
import { useNow, useProtocol } from '../hooks/useProtocol';
import { useWallet } from '../hooks/useWallet';
import { useTheme } from '../theme';
import { fmtDuration } from './FundingPanel';
import type { FundsMode } from './FundsDialog';
import HedgePanel from './HedgePanel';
import { AmountInput, Button, Empty, Panel, Row, Stat } from './ui';

/** LP shares carry 6 implied decimals (the first deposit mints 1 share unit per USDC micro). */
const SHARE_DECIMALS = 6;

export default function VaultPage({ onFunds }: { onFunds: (m: FundsMode) => void }) {
  const { t } = useTheme();
  const { vault, params, series, chain, hedge, lpShares, lpClaim, send } = useProtocol();
  const accountId = useWallet(s => s.accountId);
  const signIn = useWallet(s => s.signIn);
  const now = useNow(1_000);
  const [redeem, setRedeem] = useState('');
  const [busy, setBusy] = useState(false);

  const exposure = useMemo(
    () => series.filter(s => s.netTraderSize !== 0n).map(s => {
      const row = chain.get(s.id);
      const vaultSize = -s.netTraderSize;
      return { s, vaultSize, delta: row ? (row.delta * Number(vaultSize)) / Number(SIZE_SCALE) : null };
    }),
    [series, chain],
  );
  const netDelta = useMemo(() => {
    const out: Partial<Record<Underlying, number>> = {};
    for (const e of exposure) if (e.delta != null) out[e.s.underlying] = (out[e.s.underlying] ?? 0) + e.delta;
    return out;
  }, [exposure]);

  if (!vault || !params) return <Panel title="LP VAULT"><Empty>Loading vault…</Empty></Panel>;

  const equity = vault.equity;
  const sharePrice = equity != null && vault.totalShares > 0n ? (equity * 1_000_000n) / vault.totalShares : null;
  const ratio = healthBps(vault.equity, vault.requirement);
  const myValue = equity != null && vault.totalShares > 0n ? (lpShares * equity) / vault.totalShares : null;
  const redeemUnits = parseUnits(redeem, SHARE_DECIMALS);
  const redeemErr = redeem === '' ? null : redeemUnits == null || redeemUnits === 0n ? 'Enter a share amount.' : redeemUnits > lpShares ? 'More shares than you hold.' : null;
  const redeemValue = redeemUnits != null && equity != null && vault.totalShares > 0n ? (redeemUnits * equity) / vault.totalShares : null;
  const claimReady = lpClaim != null && nowNs() >= lpClaim.unlockNs;

  const doRedeem = async () => {
    if (redeemUnits == null || redeemErr) return;
    setBusy(true);
    if (await send({ kind: 'lp_request_redeem', shares: redeemUnits }, `Redeem ${formatUnits(redeemUnits, SHARE_DECIMALS)} shares`)) setRedeem('');
    setBusy(false);
  };
  const doClaim = async () => {
    setBusy(true);
    await send({ kind: 'lp_claim' }, `Claim ${fmtUsdc(lpClaim!.amount)}`);
    setBusy(false);
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12, alignItems: 'start' }}>
      <div style={{ display: 'grid', gap: 12 }}>
        <Panel title="LP VAULT" info={<>
          The vault is the counterparty to every trade and earns the spread and hourly funding.{' '}
          {hedge?.enabled
            ? <>The agent hedges its net delta with a perp position off chain (Delta hedge, below); that hedge's profit and loss is <b>not</b> in the equity or share price here.</>
            : <>Its net delta is <b>not hedged</b>: LPs carry that price risk. The agent reports the perp position that would offset it.</>}
        </>}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 14 }}>
            <Stat label="Vault equity" value={equity != null ? fmtUsdc(equity, 0) : '—'} sub={equity == null ? 'spot stale' : undefined} />
            <Stat label="Share price" value={sharePrice != null ? fmtFixed(sharePrice, 6, 6) : '—'} sub="USDC per share" />
            <Stat label="Vault health" value={ratio != null ? `${(Number(ratio) / 10_000).toFixed(2)}×` : 'no open risk'}
              sub={`min ${(Number(params.vault_ratio_bps) / 10_000).toFixed(2)}×`}
              color={ratio == null ? t.GREEN : ratio < params.vault_ratio_bps * 3n / 2n ? t.ORANGE : t.GREEN} />
            {Object.entries(netDelta).map(([u, d]) => (
              <Stat key={u} label={`Net delta ${u}`} value={`${d! >= 0 ? '+' : ''}${d!.toFixed(2)}`} sub="before hedge" color={Math.abs(d!) > 5 ? t.ORANGE : t.WHITE} />
            ))}
          </div>
          <div style={{ marginTop: 12 }}>
            <Row label="Cash" value={fmtUsdc(vault.cash)} />
            <Row label="Margin requirement" value={vault.requirement != null ? fmtUsdc(vault.requirement) : '—'} />
            <Row label="Insurance fund" value={fmtUsdc(vault.insurance)} />
            <Row label="Pending LP claims" value={fmtUsdc(vault.pendingClaims)} />
            <Row label="Redeem cooldown" value={fmtDuration(Number(params.lp_cooldown_ns / NS_PER_MS))} />
            {vault.epochNetOutflow != null && vault.epochStartCash != null && (
              <Row label="Paid to traders this hour"
                value={`${fmtUsdc(vault.epochNetOutflow > 0n ? vault.epochNetOutflow : 0n)} of ${fmtUsdc((vault.epochStartCash * params.max_epoch_outflow_bps) / 10_000n)} limit`} />
            )}
          </div>
        </Panel>

        <HedgePanel />

        <Panel title="VAULT BOOK" bodyStyle={{ padding: 0 }}>
          {exposure.length === 0 ? <Empty>No open interest.</Empty> : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['SERIES', 'VAULT POSITION', 'MARK', 'DELTA'].map((h, i) => (
                    <th key={h} style={{ fontFamily: t.MONO, fontSize: 9, letterSpacing: '0.12em', color: t.DIM, fontWeight: 500, padding: '6px 10px', textAlign: i === 0 ? 'left' : 'right', borderBottom: `1px solid ${t.BORDER}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {exposure.map(({ s, vaultSize, delta }) => (
                  <tr key={s.id} style={{ borderBottom: `1px solid ${t.BORDER}` }}>
                    <td style={{ fontFamily: t.MONO, fontSize: 11, color: t.WHITE, padding: '6px 10px' }}>{seriesLabel(s)}</td>
                    <td className="tabular-nums" style={{ fontFamily: t.MONO, fontSize: 11, padding: '6px 10px', textAlign: 'right', color: vaultSize > 0n ? t.GREEN : t.RED }}>
                      {vaultSize > 0n ? '+' : '−'}{fmtSize(vaultSize > 0n ? vaultSize : -vaultSize)}
                    </td>
                    <td className="tabular-nums" style={{ fontFamily: t.MONO, fontSize: 11, padding: '6px 10px', textAlign: 'right', color: t.GRAY }}>{fmtPremium(s.lastMark)}</td>
                    <td className="tabular-nums" style={{ fontFamily: t.MONO, fontSize: 11, padding: '6px 10px', textAlign: 'right', color: t.GRAY }}>{delta != null ? (Math.abs(delta) < 0.005 ? '0.00' : delta.toFixed(2)) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <Panel title="YOUR LP POSITION" info="Deposit USDC for shares at the current share price. To leave, request a redemption: your shares burn now at the current price and the USDC unlocks after the cooldown, then claim it. Redemptions that would leave open risk under-collateralized are refused.">
        {!accountId ? (
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ fontFamily: t.MONO, fontSize: 11, color: t.GRAY }}>Connect a wallet to provide liquidity.</div>
            <Button onClick={signIn}>CONNECT WALLET</Button>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Stat label="Your shares" value={fmtFixed(lpShares, SHARE_DECIMALS, 2)} />
              <Stat label="Value" value={myValue != null ? fmtUsdc(myValue) : '—'} />
            </div>
            <Button onClick={() => onFunds('lp_deposit')}>DEPOSIT USDC</Button>

            <div style={{ borderTop: `1px solid ${t.BORDER}`, paddingTop: 12, display: 'grid', gap: 8 }}>
              <div style={{ fontFamily: t.MONO, fontSize: 9, letterSpacing: '0.14em', color: t.DIM }}>REDEEM</div>
              <AmountInput ariaLabel="Shares to redeem" value={redeem} onChange={setRedeem} suffix="shares"
                onMax={() => setRedeem(formatUnits(lpShares, SHARE_DECIMALS))} />
              {redeemErr ? <div style={{ fontFamily: t.MONO, fontSize: 10, color: t.RED }}>{redeemErr}</div>
                : redeemValue != null && <Row label="Claim at today's price" value={fmtUsdc(redeemValue)} />}
              <Button variant="ghost" onClick={doRedeem} disabled={busy || redeemUnits == null || redeemErr != null}>
                REQUEST REDEMPTION
              </Button>
            </div>

            {lpClaim && (
              <div style={{ borderTop: `1px solid ${t.BORDER}`, paddingTop: 12, display: 'grid', gap: 8 }}>
                <Row label="Pending claim" value={fmtUsdc(lpClaim.amount)} />
                <Row label="Unlocks" value={claimReady ? 'now' : `in ${fmtDuration(Number(lpClaim.unlockNs / NS_PER_MS) - now)}`} color={claimReady ? t.GREEN : t.ORANGE} />
                <Button variant="buy" onClick={doClaim} disabled={busy || !claimReady}>CLAIM</Button>
              </div>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
